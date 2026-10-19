// STRATEGIST AGENT. Owner: strategist lead.
// Runs only after the user chooses "Continue". Turns the research and the Critic's
// idea review into a launch plan, and revises it after Critic feedback or a fact update.
//
// Three layers:
//   1. checkInputs()  - code checks the research before the model sees it (bad-handoff test)
//   2. the model call - prompt + structured output
//   3. enforcePlan()  - code checks the plan the model returned (no invented fact ids,
//                       every Critic risk mitigated, gaps carried through)

import { zodTextFormat } from "openai/helpers/zod";
import { MODEL, openai, mocksEnabled } from "@/lib/openai";
import { type Plan, PlanSchema, type StrategistInput } from "./types";

const INSTRUCTIONS = `You are the Strategist on a startup advisory team (Researcher → Critic → you → Critic).
The founder has read the research and the Critic's review and chose to go ahead.
Write the launch plan a first-time founder could start on Monday.

EVIDENCE
- Use ONLY the facts in "research". Never invent numbers, competitors or sources.
- Every launch step lists the fact ids it relies on in "basedOn", using ids that exist in research.facts.
  A step backed by no fact is allowed only if its rationale starts with "Assumption:".
- If you rely on a low-confidence fact or on something in research.unknowns, add it to "researchGaps".

USE THE CRITIC'S REVIEW
- Write one mitigation for EVERY risk in ideaReview.risks (riskMitigations.riskId = that risk's id).
  Handle high-severity risks in the launch steps themselves, not only in the mitigation text.
- Match the plan to the verdict:
  "promising" → build toward launch;
  "risky" → the first steps must be cheap tests of the riskiest assumptions, before real spending;
  "weak" → plan a small, time-boxed validation experiment with clear go/no-go criteria, not a full launch.
- Answer ideaReview.openQuestions with a step that would find the answer, where possible.

THE PLAN
- Respect any budget, timeline or location in input.context. If none is given, assume a solo founder
  with a small budget and say so in "researchGaps".
- 4-7 launch steps in time order, each a concrete action ("Interview 10 dog owners in Leeds"),
  not a goal ("Understand customers"). Timeframes are relative ("Week 1-2", "Month 2").
- "mvp": the smallest version that tests the core value. "pricing": a number with the reason, tied to facts.
- "successMetrics": measurable targets with numbers and deadlines.
- "confidence": "high" only if the key steps rest on medium/high-confidence facts and no high-severity
  risk is unmitigated; "low" if the research is thin or the inputWarnings are serious.

INPUT WARNINGS
- "inputWarnings" lists problems the system found in the research. Do not ignore them:
  reflect each one in "researchGaps" and in your confidence.

REVISIONS
- If "previousPlan" is set, you are revising it. Keep the parts that still hold.
  Fix every issue in "planFeedback". Apply every "updatedFacts" item: updated facts override older
  research. Find each step whose basedOn facts changed and rework it.
- List every change in "changesFromPrevious" as "<what changed> because <which feedback or fact>".
- On a first plan, "changesFromPrevious" is empty.`;

export async function runStrategist(args: StrategistInput): Promise<Plan> {
  const inputWarnings = checkInputs(args);
  if (mocksEnabled()) return enforcePlan(mockPlan(args), args, inputWarnings);

  const response = await openai().responses.parse({
    model: MODEL,
    instructions: INSTRUCTIONS,
    input: JSON.stringify({ ...args, inputWarnings }),
    text: { format: zodTextFormat(PlanSchema, "plan") },
  });
  if (!response.output_parsed) throw new Error("Strategist returned no structured output");
  return enforcePlan(response.output_parsed, args, inputWarnings);
}

// Bad-handoff check: spot weak research in code instead of trusting the model to notice.
export function checkInputs({ research, ideaReview }: StrategistInput): string[] {
  const warnings: string[] = [];
  const facts = research.facts;
  const solid = facts.filter((f) => f.confidence !== "low");

  if (facts.length < 3) warnings.push(`Research has only ${facts.length} fact(s); the plan rests on very little evidence.`);
  if (facts.length > 0 && solid.length === 0) warnings.push("Every research fact is low confidence.");
  if (facts.length > 0 && facts.every((f) => !f.source || f.source === "unknown")) warnings.push("No research fact has a source.");
  if (!research.targetCustomer.trim()) warnings.push("The research did not identify a target customer.");
  if (research.competitors.length === 0) warnings.push("No competitors were found; competition is unverified, not absent.");
  if (ideaReview.risks.length === 0) warnings.push("The Critic listed no risks; the review may be incomplete.");
  return warnings;
}

// Guardrails on the model's output. Fixes what code can fix and flags the rest in researchGaps.
function enforcePlan(plan: Plan, { research, ideaReview }: StrategistInput, inputWarnings: string[]): Plan {
  const factIds = new Set(research.facts.map((f) => f.id));
  const gaps = [...inputWarnings, ...plan.researchGaps];

  const launchSteps = plan.launchSteps.map((s) => {
    const invented = s.basedOn.filter((id) => !factIds.has(id));
    if (invented.length) gaps.push(`"${s.step}" cited fact ids that don't exist (${invented.join(", ")}); removed.`);
    return { ...s, basedOn: s.basedOn.filter((id) => factIds.has(id)) };
  });

  const mitigated = new Set(plan.riskMitigations.map((m) => m.riskId));
  const unmitigated = ideaReview.risks.filter((r) => !mitigated.has(r.id));
  for (const r of unmitigated) gaps.push(`No mitigation for Critic risk ${r.id}: ${r.risk}`);

  // Thin research or an unmitigated high-severity risk caps confidence.
  let confidence = plan.confidence;
  if (inputWarnings.length >= 2 || unmitigated.some((r) => r.severity === "high")) confidence = "low";
  else if (inputWarnings.length === 1 && confidence === "high") confidence = "medium";

  return { ...plan, launchSteps, confidence, researchGaps: [...new Set(gaps)] };
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
