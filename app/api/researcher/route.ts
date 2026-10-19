// POST /api/researcher
// Runs one step of the Researcher and streams progress back as NDJSON
// (one JSON event per line). The page sends { state, input } and gets
// events ending with "questions", "report" or "error".

import { runResearcherStep, type ResearcherHooks } from "@/lib/agents/claude-researcher/session";
import {
  emptyResearcherState,
  type ResearchEvent,
  type ResearcherInput,
  type ResearcherState,
} from "@/lib/agents/claude-researcher/types";

function readInput(value: unknown): ResearcherInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if ((input.kind === "idea" || input.kind === "reply" || input.kind === "twist") && typeof input.text === "string") {
    return { kind: input.kind, text: input.text };
  }
  if (input.kind === "answers" && Array.isArray(input.answers)) {
    return { kind: "answers", answers: input.answers.map((a) => String(a ?? "")) };
  }
  return null;
}

export async function POST(request: Request) {
  let body: { state?: ResearcherState; input?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The request body must be JSON." }, { status: 400 });
  }

  const input = readInput(body.input);
  if (!input) return Response.json({ error: "Missing or invalid input." }, { status: 400 });
  const state = body.state ?? emptyResearcherState();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ResearchEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The page closed the connection; nothing left to send to.
        }
      };

      const hooks: ResearcherHooks = {
        onThinkingStart: () => send({ type: "thinking_start" }),
        onThinking: (text) => send({ type: "thinking", text }),
        onText: (text) => send({ type: "text", text }),
        onToolCall: ({ name, input: toolInput }) => {
          if (name === "web_search") send({ type: "activity", icon: "search", text: `Searched: ${String(toolInput.query ?? "")}` });
          if (name === "interpolate_data") send({ type: "activity", icon: "estimate", text: `Estimated: ${String(toolInput.label ?? "")}` });
          if (name === "create_visual") send({ type: "activity", icon: "visual", text: `Built a visual: ${String(toolInput.title ?? "")}` });
        },
        onSearchError: (code) => send({ type: "activity", icon: "warning", text: `Search problem (${code}). Continuing without it.` }),
        onWarning: (message) => send({ type: "activity", icon: "warning", text: message }),
        onVisual: (visual) => send({ type: "visual", visual }),
      };

      try {
        const step = await runResearcherStep(state, input, hooks, request.signal);
        if (step.result.kind === "questions") {
          send({ type: "questions", questionSet: step.result.questionSet, state: step.state });
        } else {
          send({ type: "report", report: step.result.report, state: step.state, saved: step.saved });
        }
      } catch (err) {
        send({ type: "error", message: (err as Error).message || "Something went wrong." });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
