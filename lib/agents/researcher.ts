// RESEARCHER AGENT. Owner: research teammate.
// Receives the idea (plus any corrected facts) and returns structured market research.
// Uses a web search tool, which covers the challenge's "at least one tool" rule.
//
// Which engine runs (checked in this order):
//   1. ANTHROPIC_API_KEY set  -> the Claude Researcher in ./claude-researcher (web search + estimate math)
//   2. OPENAI_API_KEY set     -> the OpenAI web_search call below
//   3. neither, or MOCK_AGENTS=true -> the mock, so the whole flow runs without a key

import { zodTextFormat } from "openai/helpers/zod";
import { MODEL, openai, mocksEnabled } from "@/lib/openai";
import { claudeResearcherEnabled, runClaudeResearcher } from "./claude-researcher/pipeline";
import { type Research, type ResearcherInput, ResearchSchema } from "./types";

const INSTRUCTIONS = `You are the Researcher on a startup advisory team.
Research the market for the user's business idea using web search: target customers,
market size and demand, competitors, pricing benchmarks, and trends.
- Give every fact an id (F1, F2, ...), a source URL (or "unknown"), and an honest confidence.
- Put anything you could not verify in "unknowns". Never invent numbers or sources.
- If "updatedFacts" are given, they override anything that contradicts them: revise the
  affected facts, keep the rest, and lower confidence where the update creates doubt.`;

export async function runResearcher(args: ResearcherInput): Promise<Research> {
  if (claudeResearcherEnabled()) return runClaudeResearcher(args);
  if (mocksEnabled()) return mockResearch(args);

  const response = await openai().responses.parse({
    model: MODEL,
    instructions: INSTRUCTIONS,
    tools: [{ type: "web_search" }],
    input: JSON.stringify(args),
    text: { format: zodTextFormat(ResearchSchema, "research") },
  });
  if (!response.output_parsed) throw new Error("Researcher returned no structured output");
  return response.output_parsed;
}

function mockResearch({ input, updatedFacts }: ResearcherInput): Research {
  return {
    summary: `Mock research for "${input.idea}".`,
    targetCustomer: "Busy urban professionals aged 25-40",
    marketSummary: "Growing niche market with a few established competitors.",
    facts: [
      { id: "F1", claim: "The market grew about 12% last year.", source: "unknown", confidence: "medium" },
      { id: "F2", claim: "Customers pay $10-20/month for similar services.", source: "unknown", confidence: "medium" },
      { id: "F3", claim: "Most competitors only serve large cities.", source: "unknown", confidence: "low" },
      ...updatedFacts.map((fact, i) => ({
        id: `U${i + 1}`,
        claim: fact,
        source: "user update",
        confidence: "high" as const,
      })),
    ],
    competitors: [
      { name: "Competitor A", notes: "Market leader, premium pricing" },
      { name: "Competitor B", notes: "Cheap but poor reviews" },
    ],
    trends: ["Subscription models are rising", "Demand for local options"],
    unknowns: ["Customer acquisition cost", "Regulatory requirements"],
  };
}
