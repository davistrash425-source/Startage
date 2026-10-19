// CRITIC AGENT. Owner: critic teammate.
// Pass 1, reviewIdea(): judges the idea from the research, before the user decides.
// Pass 2, reviewPlan(): checks the Strategist's plan against the research and the pass-1 risks.

import { zodTextFormat } from "openai/helpers/zod";
import { MODEL, openai, mocksEnabled } from "@/lib/openai";
import {
  type IdeaInput,
  type IdeaReview,
  IdeaReviewSchema,
  type Plan,
  type PlanReview,
  PlanReviewSchema,
  type Research,
} from "./types";

const IDEA_INSTRUCTIONS = `You are the Critic on a startup advisory team.
Review the business idea using ONLY the research provided.
- Challenge weak or low-confidence evidence and hidden assumptions.
- List concrete risks with ids (R1, R2, ...) and severities.
- Give a verdict: "promising", "risky" or "weak", with reasons.
- Suggest 2-3 pivots that address the biggest risks.`;

const PLAN_INSTRUCTIONS = `You are the Critic on a startup advisory team.
Check the Strategist's launch plan:
- Does every risk from the idea review have a mitigation?
- Is every launch step backed by research facts (basedOn)? Flag unsupported claims.
- Does the plan reflect any updatedFacts?
Set passed=false only for problems that would make the plan misleading or unworkable.`;

export async function reviewIdea(args: {
  input: IdeaInput;
  research: Research;
}): Promise<IdeaReview> {
  if (mocksEnabled()) return mockIdeaReview();

  const response = await openai().responses.parse({
    model: MODEL,
    instructions: IDEA_INSTRUCTIONS,
    input: JSON.stringify(args),
    text: { format: zodTextFormat(IdeaReviewSchema, "idea_review") },
  });
  if (!response.output_parsed) throw new Error("Critic returned no idea review");
  return response.output_parsed;
}

export async function reviewPlan(args: {
  research: Research;
  ideaReview: IdeaReview;
  plan: Plan;
  updatedFacts: string[];
}): Promise<PlanReview> {
  if (mocksEnabled()) return mockPlanReview(args.plan);

  const response = await openai().responses.parse({
    model: MODEL,
    instructions: PLAN_INSTRUCTIONS,
    input: JSON.stringify(args),
    text: { format: zodTextFormat(PlanReviewSchema, "plan_review") },
  });
  if (!response.output_parsed) throw new Error("Critic returned no plan review");
  return response.output_parsed;
}

function mockIdeaReview(): IdeaReview {
  return {
    verdict: "risky",
    reasons: ["Demand looks real, but the competitor data is low confidence."],
    risks: [
      { id: "R1", risk: "Customer acquisition cost is unknown", severity: "high" },
      { id: "R2", risk: "Competitor A could copy the idea quickly", severity: "medium" },
    ],
    openQuestions: ["Will customers switch from Competitor A?"],
    pivots: [
      { idea: "Target small businesses instead of consumers", why: "Higher willingness to pay" },
      { idea: "Start in one underserved city", why: "Avoids the big-city competitors" },
    ],
  };
}

function mockPlanReview(plan: Plan): PlanReview {
  const unbacked = plan.launchSteps.filter((s) => s.basedOn.length === 0);
  return {
    passed: unbacked.length === 0,
    summary: unbacked.length === 0 ? "Mock review: plan is backed by research." : "Mock review: some steps lack evidence.",
    issues: unbacked.map((s) => ({
      issue: `"${s.step}" is not backed by any research fact`,
      severity: "medium" as const,
      suggestion: "Cite a fact or mark it as an assumption",
    })),
  };
}
