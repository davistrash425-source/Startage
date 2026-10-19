// The RESEARCHER agent (owner: Sam). One function drives it from the web page and the terminal:
//
//   let state = emptyResearcherState();
//   const step = await runResearcherStep(state, { kind: "idea", text: "Mobile detailing in Memphis..." }, hooks);
//   state = step.state;
//   if (step.result.kind === "questions")  -> show questions, then call again with { kind: "answers", answers }
//   if (step.result.kind === "report")     -> show the report; follow up with { kind: "reply" } or { kind: "twist" }

import { runAgentTurn } from "./client/agent-loop";
import type { AgentHooks, ToolResultBlock } from "./client/types";
import { RESEARCHER_PROMPT } from "./prompt";
import { extractReport } from "./report";
import { saveReport } from "./save";
import { formatAnswers, researcherHandlers, researcherTools } from "./tools";
import type { ResearcherInput, ResearcherState, StepResult, Visual } from "./types";

export interface ResearcherHooks extends AgentHooks {
  onVisual?: (visual: Visual) => void;
}

export async function runResearcherStep(
  previous: ResearcherState,
  input: ResearcherInput,
  hooks: ResearcherHooks = {},
  signal?: AbortSignal
): Promise<{ state: ResearcherState; result: StepResult; saved: string[] }> {
  const state: ResearcherState = structuredClone(previous);
  let resumeWith: ToolResultBlock[] | undefined;

  if (input.kind === "answers") {
    if (!state.pending) throw new Error("There are no questions waiting for answers.");
    const { toolUseId, questionSet, finishedResults } = state.pending;
    resumeWith = [...finishedResults, { type: "tool_result", tool_use_id: toolUseId, content: formatAnswers(questionSet, input.answers) }];
    state.pending = null;
  } else {
    if (state.pending) throw new Error("Answer the Researcher's questions first.");
    const text = input.text.trim();
    if (!text) throw new Error("Please type a message.");
    if (input.kind === "idea") state.idea = text;
    const prefix = input.kind === "idea" ? "BUSINESS IDEA FROM THE OWNER:\n" : input.kind === "twist" ? "TWIST UPDATE: " : "";
    // A new request: reset the per-request question limit and visuals.
    state.turnStart = state.messages.length;
    state.questionsAsked = 0;
    state.visuals = [];
    state.messages.push({ role: "user", content: prefix + text });
  }

  const ctx = {
    questionsAsked: state.questionsAsked,
    onVisual: (visual: Visual) => {
      state.visuals.push({ id: visual.id, title: visual.title, file: visual.file });
      hooks.onVisual?.(visual);
    },
  };

  const outcome = await runAgentTurn({
    system: RESEARCHER_PROMPT,
    tools: researcherTools(),
    toolHandlers: researcherHandlers(ctx),
    messages: state.messages,
    hooks,
    resumeWith,
    signal,
  });
  state.questionsAsked = ctx.questionsAsked;

  if (outcome.status === "paused") {
    const ask = outcome.pending[0];
    // Any other paused calls in the same message (rare) get a "skipped" result.
    const extra: ToolResultBlock[] = outcome.pending.slice(1).map((p) => ({
      type: "tool_result",
      tool_use_id: p.toolUseId,
      content: "Skipped: only one set of questions can be asked at a time. Use reasonable defaults.",
    }));
    state.pending = {
      toolUseId: ask.toolUseId,
      questionSet: ask.payload as NonNullable<ResearcherState["pending"]>["questionSet"],
      finishedResults: [...outcome.finishedResults, ...extra],
    };
    return { state, result: { kind: "questions", questionSet: state.pending.questionSet }, saved: [] };
  }

  const report = extractReport(state.messages.slice(state.turnStart), state.visuals);
  const saved = await saveReport(report, state.idea);
  return { state, result: { kind: "report", report }, saved };
}
