// The Researcher as the 3-agent flow uses it (lib/agent-team.ts): one unattended call
// that takes the shared ResearcherInput and returns the shared `Research` handoff.
//
// It reuses the same Claude engine as the interactive Researcher (web search, estimate math,
// deep thinking) but cannot ask the owner questions or draw visuals. It ends by calling
// `submit_research`, whose input schema is generated from ResearchSchema, so the handoff is
// checked against the team's contract instead of being parsed out of prose.

import { z } from "zod";
import { ResearchSchema, type Research, type ResearcherInput } from "../types";
import { runAgentTurn } from "./client/agent-loop";
import { getConfig } from "./client/config";
import type { MessageParam, ToolDefinition } from "./client/types";
import { interpolate } from "./interpolate";
import { PIPELINE_PROMPT } from "./prompt";
import { interpolateTool, webSearchTool } from "./tools";

/** The Claude Researcher runs when an Anthropic key is set, unless MOCK_AGENTS=true forces the mocks. */
export function claudeResearcherEnabled(): boolean {
  return Boolean(getConfig().apiKey) && process.env.MOCK_AGENTS !== "true";
}

const researchJsonSchema: Record<string, unknown> = z.toJSONSchema(ResearchSchema);
delete researchJsonSchema.$schema; // the Messages API wants a bare object schema

const submitResearchTool: ToolDefinition = {
  name: "submit_research",
  description:
    "Hand your finished research to the Critic and Strategist. Call it exactly once, as your last action. " +
    "If it returns an error, fix the problems it lists and call it again.",
  input_schema: researchJsonSchema,
};

/** The task as the model sees it: idea, owner context, and (on a fact update) the research to revise. */
function buildRequest({ input, previousResearch, updatedFacts }: ResearcherInput): string {
  const parts = [`BUSINESS IDEA FROM THE OWNER:\n${input.idea.trim()}`, `OWNER CONTEXT:\n${input.context.trim() || "(none given)"}`];
  if (previousResearch) parts.push(`PREVIOUS RESEARCH (revise this, do not start over):\n${JSON.stringify(previousResearch, null, 2)}`);
  if (updatedFacts.length) {
    parts.push(`UPDATED FACTS FROM THE OWNER (these override anything that contradicts them):\n${updatedFacts.map((f, i) => `U${i + 1}: ${f}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function runClaudeResearcher(args: ResearcherInput, signal?: AbortSignal): Promise<Research> {
  const config = getConfig();
  const submitted: { research: Research | null } = { research: null };
  let searchError: string | null = null;

  const messages: MessageParam[] = [{ role: "user", content: buildRequest(args) }];
  const turn = () =>
    runAgentTurn({
      system: PIPELINE_PROMPT,
      tools: [...(config.disableSearch ? [] : [webSearchTool()]), interpolateTool, submitResearchTool],
      toolHandlers: {
        interpolate_data: (input) => interpolate(input),
        submit_research(input) {
          const parsed = ResearchSchema.safeParse(input);
          if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
          submitted.research = parsed.data;
          return "Research received.";
        },
      },
      messages,
      hooks: { onSearchError: (code) => (searchError = code) },
      isFinished: () => submitted.research !== null,
      signal,
    });

  await turn();
  if (!submitted.research) {
    // The model wrote an answer instead of calling the tool. Nudge it once.
    messages.push({ role: "user", content: "You have not called submit_research yet. Call it now with your finished research." });
    await turn();
  }
  if (!submitted.research) throw new Error("The Researcher finished without submitting its research.");

  return finalize(submitted.research, { searchDisabled: config.disableSearch, searchError });
}

/** Code-level guards for rules the prompt asks for, so the Critic and Strategist can trust the fields. */
function finalize(research: Research, ctx: { searchDisabled: boolean; searchError: string | null }): Research {
  const facts = research.facts.map((fact) => {
    const isOwnerFact = fact.source === "user update";
    // The handoff promises "URL or unknown": keep the first real link, drop names and prose.
    const url = fact.source.match(/https?:\/\/[^\s)>\]"']+/)?.[0]?.replace(/[.,;]+$/, "");
    let source = isOwnerFact ? fact.source : (url ?? "unknown");
    let confidence = fact.confidence;
    // Estimates are never rated "high".
    if (/^\s*estimat/i.test(fact.claim) && confidence === "high") confidence = "medium";
    // With search turned off nothing was checked, so nothing from the model may claim to be sourced.
    if (ctx.searchDisabled && !isOwnerFact) {
      source = "unknown";
      confidence = "low";
    }
    return { ...fact, source, confidence };
  });

  const unknowns = [...research.unknowns];
  if (ctx.searchDisabled) {
    unknowns.unshift("Web search was turned off for this run, so every finding comes from general knowledge and is unverified.");
  } else if (ctx.searchError) {
    unknowns.unshift(`Web search hit a problem (${ctx.searchError}) during this run, so some findings may rest on general knowledge. Check low-confidence facts.`);
  }
  return { ...research, facts, unknowns };
}
