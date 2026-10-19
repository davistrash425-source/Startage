// STRATEGIST AGENT. Owner: strategist lead.
// Runs only after the user chooses "Continue". Turns the research and the Critic's
// idea review into a launch plan, and revises it after Critic feedback or a fact update.

import { zodTextFormat } from "openai/helpers/zod";
import { MODEL, openai, mocksEnabled } from "@/lib/openai";
import { type Plan, PlanSchema, type StrategistInput } from "./types";

const INSTRUCTIONS = `You are the Strategist on a startup advisory team.
Turn the research and the Critic's idea review into a concrete launch plan.
- Use ONLY the research provided. Every launch step lists the fact ids it relies on in "basedOn".
- Give a mitigation for every risk in the idea review (riskMitigations.riskId = the risk id).
- If the research is thin or a step relies on low-confidence facts or unknowns, say so in
  "researchGaps" and lower "confidence". Do not invent facts.
- If "previousPlan" is given, you are revising: keep what still holds, fix every issue in
  "planFeedback", apply every "updatedFacts" item, and list each change in "changesFromPrevious".
  On a first plan, "changesFromPrevious" is empty.`;

export async function runStrategist(args: StrategistInput): Promise<Plan> {
  if (mocksEnabled()) return mockPlan(args);

  const response = await openai().responses.parse({
    model: MODEL,
    instructions: INSTRUCTIONS,
    input: JSON.stringify(args),
    text: { format: zodTextFormat(PlanSchema, "plan") },
  });
  if (!response.output_parsed) throw new Error("Strategist returned no structured output");
  return response.output_parsed;
}

function mockPlan({ input, research, ideaReview, previousPlan, updatedFacts }: StrategistInput): Plan {
  const factIds = research.facts.map((f) => f.id);
  return {
    positioning: `Mock plan: "${input.idea}" as the affordable, local alternative.`,
    targetCustomer: research.targetCustomer,
    mvp: "A simple landing page plus a manual concierge version of the service.",
    pricing: "$12/month introductory price",
    launchSteps: [
      { step: "Validate demand with a landing page", timeframe: "Week 1-2", rationale: "Cheap test of interest", basedOn: factIds.slice(0, 1) },
      { step: "Run 10 customer interviews", timeframe: "Week 2-3", rationale: "Confirm willingness to pay", basedOn: factIds.slice(1, 2) },
      { step: "Launch a paid pilot in one city", timeframe: "Month 2", rationale: "Avoid big-city competitors", basedOn: factIds.slice(2, 3) },
    ],
    budget: "About $2,000 for the first two months",
    successMetrics: ["100 signups", "20 paying pilot customers"],
    riskMitigations: ideaReview.risks.map((r) => ({ riskId: r.id, mitigation: `Mock mitigation for: ${r.risk}` })),
    researchGaps: research.unknowns,
    confidence: "medium",
    changesFromPrevious: previousPlan ? updatedFacts.map((f) => `Revised plan to account for: ${f}`) : [],
  };
}
