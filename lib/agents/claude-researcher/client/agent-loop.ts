// Agent loop for the Claude-powered Researcher (the Strategist and Critic use OpenAI).
//
// One "turn" = the agent keeps working until it has a final answer:
//   - it may think (adaptive thinking = the "deep think" skill)
//   - it may call server tools that Anthropic runs (web_search)
//   - it may call our own tools, which this file runs and answers
//
// A tool can also PAUSE the turn (the Researcher's ask_user does this): the loop
// stops, the app shows the questions, and resumeTurn() continues once the
// owner answers. That works the same way in the web app and in the terminal.

import { streamMessage } from "./anthropic";
import type { AgentHooks, ContentBlock, MessageParam, ToolDefinition, ToolResultBlock } from "./types";

const PAUSE = Symbol("pause");

export interface PauseSignal<T = unknown> {
  [PAUSE]: true;
  payload: T;
}

/** Return this from a tool handler to stop the turn and wait for the user. */
export function pauseForUser<T>(payload: T): PauseSignal<T> {
  return { [PAUSE]: true, payload };
}

function isPause(value: unknown): value is PauseSignal {
  return typeof value === "object" && value !== null && PAUSE in value;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

export interface PendingTool<T = unknown> {
  toolUseId: string;
  name: string;
  payload: T;
}

export type TurnOutcome =
  | { status: "done"; stopReason: string | null }
  | { status: "paused"; pending: PendingTool[]; finishedResults: ToolResultBlock[] };

export interface RunTurnOptions {
  system: string;
  tools: ToolDefinition[];
  toolHandlers: Record<string, ToolHandler>;
  /** Conversation so far. New messages are pushed onto this array. */
  messages: MessageParam[];
  hooks?: AgentHooks;
  /** When resuming after a pause: every tool_result for the paused assistant message. */
  resumeWith?: ToolResultBlock[];
  maxSteps?: number;
  signal?: AbortSignal;
  /**
   * Checked after each round of tool calls. When it returns true the turn ends right away,
   * without sending the tool results back (used when a tool hands over the final structured answer).
   */
  isFinished?: () => boolean;
}

export async function runAgentTurn(opts: RunTurnOptions): Promise<TurnOutcome> {
  const { system, tools, toolHandlers, messages, hooks = {}, maxSteps = 30, signal } = opts;

  if (opts.resumeWith) {
    // This message must contain ONLY tool_result blocks.
    messages.push({ role: "user", content: opts.resumeWith as unknown as ContentBlock[] });
  }

  for (let step = 0; step < maxSteps; step++) {
    const message = await streamMessage({ system, tools, messages, signal }, hooks);

    // Always send the assistant's content back exactly as received.
    messages.push({ role: "assistant", content: message.content });

    // A long web-search turn can pause. Sending the conversation back resumes it.
    if (message.stop_reason === "pause_turn") continue;

    if (message.stop_reason === "tool_use") {
      const calls = message.content.filter((block) => block.type === "tool_use");
      if (calls.length === 0) continue;

      const finished: ToolResultBlock[] = [];
      const pending: PendingTool[] = [];

      for (const call of calls) {
        const id = String(call.id);
        const name = String(call.name);
        const handler = toolHandlers[name];
        try {
          if (!handler) throw new Error(`Unknown tool: ${name}`);
          const output = await handler((call.input ?? {}) as Record<string, unknown>);
          if (isPause(output)) {
            pending.push({ toolUseId: id, name, payload: output.payload });
            continue;
          }
          const content = typeof output === "string" ? output : JSON.stringify(output, null, 2);
          finished.push({ type: "tool_result", tool_use_id: id, content });
        } catch (err) {
          finished.push({ type: "tool_result", tool_use_id: id, content: `Error: ${(err as Error).message}`, is_error: true });
        }
      }

      if (pending.length > 0) return { status: "paused", pending, finishedResults: finished };
      if (opts.isFinished?.()) return { status: "done", stopReason: "tool_use" };

      messages.push({ role: "user", content: finished as unknown as ContentBlock[] });
      continue;
    }

    if (message.stop_reason === "max_tokens") {
      hooks.onWarning?.("The answer hit the MAX_TOKENS limit and may be cut off. Raise MAX_TOKENS in .env.local.");
    } else if (message.stop_reason === "refusal") {
      hooks.onWarning?.("The model declined this request.");
    }
    return { status: "done", stopReason: message.stop_reason };
  }

  throw new Error(`Agent stopped after ${maxSteps} steps without finishing.`);
}

/** Plain text of an assistant message. */
export function textOf(message: MessageParam | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}
