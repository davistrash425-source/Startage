// Minimal streaming client for the Claude Messages API, using plain fetch.
// No SDK needed. It rebuilds the full message from the stream so it can be
// sent back to the API unchanged (thinking signatures, search results, citations).

import { getConfig } from "./config";
import type { AgentHooks, ApiMessage, ContentBlock, MessageParam, ToolDefinition } from "./types";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export interface StreamRequest {
  system: string;
  messages: MessageParam[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export async function streamMessage(req: StreamRequest, hooks: AgentHooks = {}): Promise<ApiMessage> {
  const config = getConfig();
  if (!config.apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env.local and add your key.");
  }

  const body = JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens,
    stream: true,
    system: req.system,
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    // Deep thinking: the model decides how much to think; effort sets how hard it works overall.
    thinking: { type: "adaptive", display: config.showThinking ? "summarized" : "omitted" },
    output_config: { effort: config.effort },
  });

  const res = await fetchWithRetry(`${config.baseUrl}/v1/messages`, body, config.apiKey, req.signal);
  return readStream(res, hooks);
}

async function fetchWithRetry(url: string, body: string, apiKey: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
      signal,
    });
    if (res.ok) return res;

    const text = await res.text();
    if (RETRY_STATUSES.has(res.status) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(`Claude API error ${res.status}: ${message}`);
  }
}

type StreamEvent = { type: string; [key: string]: unknown };

async function readStream(res: Response, hooks: AgentHooks): Promise<ApiMessage> {
  if (!res.body) throw new Error("Claude API returned an empty response.");

  let message: ApiMessage | null = null;
  const toolJson = new Map<number, string>();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  const handle = (event: StreamEvent) => {
    switch (event.type) {
      case "message_start": {
        message = { ...(event.message as ApiMessage), content: [] };
        break;
      }
      case "content_block_start": {
        const index = event.index as number;
        const block = structuredClone(event.content_block as ContentBlock);
        message!.content[index] = block;
        if (block.type === "tool_use" || block.type === "server_tool_use") toolJson.set(index, "");
        if (block.type === "thinking") hooks.onThinkingStart?.();
        if (block.type === "web_search_tool_result") {
          const content = block.content as { error_code?: string } | unknown[];
          if (content && !Array.isArray(content) && content.error_code) hooks.onSearchError?.(content.error_code);
        }
        break;
      }
      case "content_block_delta": {
        const index = event.index as number;
        const block = message!.content[index];
        const delta = event.delta as Record<string, unknown> & { type: string };
        if (delta.type === "text_delta") {
          block.text = String(block.text ?? "") + delta.text;
          hooks.onText?.(delta.text as string);
        } else if (delta.type === "thinking_delta") {
          block.thinking = String(block.thinking ?? "") + delta.thinking;
          if (delta.thinking) hooks.onThinking?.(delta.thinking as string);
        } else if (delta.type === "signature_delta") {
          block.signature = delta.signature;
        } else if (delta.type === "input_json_delta") {
          toolJson.set(index, (toolJson.get(index) ?? "") + (delta.partial_json as string));
        } else if (delta.type === "citations_delta") {
          const list = Array.isArray(block.citations) ? (block.citations as unknown[]) : [];
          list.push(delta.citation);
          block.citations = list;
        }
        break;
      }
      case "content_block_stop": {
        const index = event.index as number;
        const block = message!.content[index];
        if (block.type === "thinking") hooks.onThinkingEnd?.();
        if (toolJson.has(index)) {
          const json = toolJson.get(index)!;
          if (json) {
            try {
              block.input = JSON.parse(json);
            } catch {
              block.input = {};
            }
          }
          toolJson.delete(index);
          hooks.onToolCall?.({
            name: String(block.name),
            input: (block.input ?? {}) as Record<string, unknown>,
            server: block.type === "server_tool_use",
          });
        }
        break;
      }
      case "message_delta": {
        const delta = event.delta as { stop_reason?: string };
        if (delta.stop_reason) message!.stop_reason = delta.stop_reason;
        if (event.usage) message!.usage = { ...(message!.usage ?? {}), ...(event.usage as object) };
        break;
      }
      case "error": {
        const error = event.error as { message?: string; type?: string } | undefined;
        throw new Error(`Claude API stream error: ${error?.message ?? error?.type ?? "unknown"}`);
      }
      // "ping" and "message_stop" need no handling.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // Normalize line endings on the whole buffer: a chunk can end between "\r" and "\n".
    buffer = (buffer + value).replace(/\r\n/g, "\n");
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) handle(JSON.parse(data) as StreamEvent);
    }
  }

  if (!message) throw new Error("Claude API stream ended before any message arrived.");
  return message;
}
