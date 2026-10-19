// Shared handoff contracts between the agents. Owned by the whole team:
// change a schema only after agreeing with the other agent owners.
//
// These Zod schemas double as OpenAI structured-output formats, so every
// field must be required (use .nullable() instead of .optional()).

import { z } from "zod";

export const IdeaInputSchema = z.object({
  idea: z.string(),
  context: z.string(), // optional free text: target customer, location, budget, timeline
});
export type IdeaInput = z.infer<typeof IdeaInputSchema>;

const Confidence = z.enum(["low", "medium", "high"]);

// ---- Researcher → Critic, Strategist ----
export const ResearchSchema = z.object({
  summary: z.string(),
  targetCustomer: z.string(),
  marketSummary: z.string(),
  facts: z.array(
    z.object({
      id: z.string(), // e.g. "F1", referenced by Strategist plan steps
      claim: z.string(),
      source: z.string(), // URL or "unknown"
      confidence: Confidence,
    }),
  ),
  competitors: z.array(z.object({ name: z.string(), notes: z.string() })),
  trends: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type Research = z.infer<typeof ResearchSchema>;

// ---- Critic pass 1 (idea review) → user + Strategist ----
export const IdeaReviewSchema = z.object({
  verdict: z.enum(["promising", "risky", "weak"]),
  reasons: z.array(z.string()),
  risks: z.array(
    z.object({
      id: z.string(), // e.g. "R1", referenced by Strategist riskMitigations
      risk: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  openQuestions: z.array(z.string()),
  pivots: z.array(z.object({ idea: z.string(), why: z.string() })),
});
export type IdeaReview = z.infer<typeof IdeaReviewSchema>;

// ---- Strategist → Critic pass 2 + user ----
export const PlanSchema = z.object({
  positioning: z.string(),
  targetCustomer: z.string(),
  mvp: z.string(),
  pricing: z.string(),
  launchSteps: z.array(
    z.object({
      step: z.string(),
      timeframe: z.string(),
      rationale: z.string(),
      basedOn: z.array(z.string()), // research fact ids
    }),
  ),
  budget: z.string(),
  successMetrics: z.array(z.string()),
  riskMitigations: z.array(z.object({ riskId: z.string(), mitigation: z.string() })),
  researchGaps: z.array(z.string()),
  confidence: Confidence,
  changesFromPrevious: z.array(z.string()), // empty on the first plan
});
export type Plan = z.infer<typeof PlanSchema>;

// ---- Critic pass 2 (plan check) → Strategist (on fail) + user ----
export const PlanReviewSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  issues: z.array(
    z.object({
      issue: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      suggestion: z.string(),
    }),
  ),
});
export type PlanReview = z.infer<typeof PlanReviewSchema>;

// ---- Agent inputs ----
export type ResearcherInput = {
  input: IdeaInput;
  previousResearch: Research | null; // set when re-running after a fact update
  updatedFacts: string[];
};

export type StrategistInput = {
  input: IdeaInput;
  research: Research;
  ideaReview: IdeaReview;
  previousPlan: Plan | null; // set when revising
  planFeedback: PlanReview | null; // Critic issues to fix on a revision
  updatedFacts: string[];
};

// ---- Run state (held by the client between API calls) ----
export type AgentName = "researcher" | "critic" | "strategist" | "system";

export type LogEntry = {
  at: string;
  agent: AgentName;
  message: string;
};

export type RunState = {
  input: IdeaInput;
  research: Research | null;
  ideaReview: IdeaReview | null;
  plan: Plan | null;
  planReview: PlanReview | null;
  previousPlan: Plan | null; // the plan before the last fact update, for the before/after view
  updatedFacts: string[];
  log: LogEntry[];
};
