// CRITIC AGENT. Owner: critic teammate.
// Pass 1, reviewIdea(): judges the idea from the research, before the user decides.
// Pass 2, reviewPlan(): checks the Strategist's plan against the research and the pass-1 risks.
//
// Both passes run a review COUNCIL instead of a single call:
//   1-5. Five advisors review independently, in parallel; none sees the others:
//        Prosecutor vs Defense (against vs for), Historian vs Target User
//        (has it been done vs do people want it), Auditor (are claims true, does the math work).
//   6.   A chairman cross-examines their anonymized opinions, decides, and explains WHY,
//        with reasons for and against tied to research fact ids.
// The council's output is mapped onto the team's shared IdeaReview / PlanReview types,
// so nothing outside this file changes.

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { MODEL, openai, mocksEnabled } from "@/lib/openai";
import type { IdeaInput, IdeaReview, Plan, PlanReview, Research } from "./types";

// Optional: cheaper model for the 5 advisors, stronger one for the chairman.
const ADVISOR_MODEL = process.env.OPENAI_ADVISOR_MODEL ?? MODEL;
const CHAIRMAN_MODEL = process.env.OPENAI_CHAIRMAN_MODEL ?? MODEL;

// ---------------------------------------------------------------------------
// Public API (contract used by lib/agent-team.ts)
// ---------------------------------------------------------------------------

export async function reviewIdea(args: {
  input: IdeaInput;
  research: Research;
}): Promise<IdeaReview> {
  if (mocksEnabled()) return mockIdeaReview();

  const v = await runCouncil("idea", {
    idea: args.input.idea,
    context: args.input.context,
    research: args.research,
  });
  return toIdeaReview(v);
}

export async function reviewPlan(args: {
  research: Research;
  ideaReview: IdeaReview;
  plan: Plan;
  updatedFacts: string[];
}): Promise<PlanReview> {
  if (mocksEnabled()) return mockPlanReview(args.plan);

  const v = await runCouncil("plan", {
    research: args.research,
    idea_review: args.ideaReview,
    plan: args.plan,
    updated_facts: args.updatedFacts,
  });
  return toPlanReview(v);
}

// ---------------------------------------------------------------------------
// The advisors
// ---------------------------------------------------------------------------

type Mode = "idea" | "plan";
type AdvisorDef = { id: string; name: string; lens: string; webSearch: boolean };

const ADVISORS: AdvisorDef[] = [
  {
    id: "prosecutor",
    name: "The Prosecutor",
    lens: `You are building the case AGAINST this. Assume it has a fatal flaw and hunt for it:
the problem isn't real, the conclusion doesn't follow from the research, customers won't care,
it can't be done, or it breaks under real conditions. If it looks solid, dig into the assumptions.
But you are an honest prosecutor: if after real effort you find no decision-changing flaw,
say "no fatal flaw found" and give a "strong" verdict. If updated_facts are given, check whether
anything still rests on the old facts.`,
    webSearch: false,
  },
  {
    id: "defense",
    name: "The Defense Attorney",
    lens: `You are building the strongest honest case FOR this. What does it get right, and WHY does
that matter (profit, low cost, speed, low risk, real demand)? What is genuinely valuable or
overlooked? What happens if it works better than expected? Name the flaws you cannot defend,
and argue which criticisms are overblown and why.`,
    webSearch: false,
  },
  {
    id: "historian",
    name: "The Historian",
    lens: `Your questions: has this been done or tried before, what happened, and why NOW?
Find existing products and the workarounds people use today, plus attempts that FAILED and why,
and attempts that SUCCEEDED and why. Say exactly how this differs and whether the difference is
meaningful or cosmetic. Existing does not mean bad. Then: what has changed that makes this
possible or needed now, and could a big platform add it for free?`,
    webSearch: true,
  },
  {
    id: "target_user",
    name: "The Target User",
    lens: `You ARE the customer this is for. Answer in first person, from lived experience: what is
this, in your words? Do you actually have this problem, how often, and how do you handle it today?
Would you switch to this, what would make you try it, and what would make you quit after a week?
If you can't understand what it does, say exactly where you got lost.`,
    webSearch: false,
  },
  {
    id: "auditor",
    name: "The Auditor",
    lens: `You have no opinion on whether this is good. You check two things: are the claims TRUE,
and does the MATH work? Check which claims have a source, which rely on low-confidence facts,
and which facts contradict each other. Spot-check the most important claims. Then the numbers:
size of the need, cost to build and run, revenue, time to a first version. Show your arithmetic
and label rough estimates.`,
    webSearch: true,
  },
];

const MODE_TASK: Record<Mode, string> = {
  idea: `TASK: There is no plan yet. Judge the IDEA itself, using the research: is the problem real,
is there demand, does it already exist, can it work? "plan" in your lens means the idea.`,
  plan: `TASK: Judge the Strategist's PLAN. Does it follow from the research? Does every risk in
idea_review have a real mitigation? Is each launch step backed by research fact ids (basedOn)?
Does it reflect every item in updated_facts? Work from the research given; do not re-research.`,
};

const SHARED_RULES = `
You are one of five independent advisors on a review council. You have not seen the other
advisors' views. Stay inside your own lens; other advisors cover the rest.

Be objective and fair:
- Steelman first: the strongest honest case FOR it from your lens.
- Give reasons, not labels. Every reason for or against says WHY it matters (money, time, risk,
  demand, trust) and points to the evidence behind it.
- At most 3 concerns, all from your lens. For each, decide honestly: would fixing it CHANGE THE
  DECISION (what to do, or whether to do it)? Things that would only make a sound idea or plan
  better go in "improvements", not "concerns".
- Do not invent problems to look tough. Do not soften a real flaw to be nice.
- Every idea and plan can be improved. That alone is never a reason to withhold "strong".
- Separate "not proven yet" (ask for evidence) from "wrong" (explain why).
- Tag every piece of evidence with where it came from:
  case_file = in the research/plan (cite the fact id, e.g. "F2", as the source when there is one);
  opened_page = a web page you actually read; search_result_only = only a title or snippet;
  model_knowledge = your own knowledge.

VERDICT RUBRIC:
- strong: the problem is real, it follows from the evidence, and no concern changes the decision.
- promising_needs_fixes: the core is sound, but at least one fixable concern changes the decision.
- weak: the problem is unproven, it doesn't follow from the evidence, or it mostly exists already
  with no meaningful difference.
- do_not_pursue: no real problem, or a critical flaw with no reasonable fix.
`.trim();

// ---------------------------------------------------------------------------
// Schemas (internal to the critic; the team contract lives in types.ts)
// ---------------------------------------------------------------------------

const Severity = z.enum(["critical", "major", "minor"]);
const Verdict = z.enum(["strong", "promising_needs_fixes", "weak", "do_not_pursue"]);
const Confidence = z.enum(["high", "medium", "low"]);
const SourceType = z.enum(["case_file", "opened_page", "search_result_only", "model_knowledge"]);

const Reason = z.object({
  point: z.string().describe("The claim, e.g. 'Demand is proven'"),
  because: z.string().describe("Why it matters: money, time, risk, demand, trust. Numbers when available"),
  evidence: z.string().describe("The specific fact or finding it rests on"),
  source_type: SourceType,
  source: z.string().describe("Research fact id (F1), URL, or 'model knowledge - verify'"),
});
type Reason = z.infer<typeof Reason>;

const AdvisorOpinion = z.object({
  answer_to_my_question: z.string().describe("Direct answer to your lens question, 2-4 sentences"),
  steelman: z.string(),
  reasons_for: z.array(Reason).describe("Up to 3"),
  reasons_against: z.array(Reason).describe("Up to 3"),
  concerns: z
    .array(
      z.object({
        severity: Severity,
        issue: z.string(),
        changes_decision: z.boolean().describe("True only if fixing this changes what to do or whether to do it"),
        evidence: z.string(),
        source_type: SourceType,
        fix: z.string(),
      }),
    )
    .describe("At most 3, all from your lens"),
  improvements: z.array(z.string()).describe("Nice-to-haves that don't change the decision"),
  existing_solutions: z
    .array(
      z.object({
        name: z.string(),
        how_this_differs: z.string(),
        source_type: SourceType,
        source: z.string(),
      }),
    )
    .describe("Mainly the Historian fills this; others may return []"),
  missing_information: z.array(z.string()),
  verdict: Verdict,
  confidence: Confidence,
});
type AdvisorOpinion = z.infer<typeof AdvisorOpinion>;

const CouncilVerdict = z.object({
  cross_examination: z.array(
    z.object({
      advisor_label: z.string(),
      strongest_point: z.string(),
      weakest_point: z.string().describe("Unsupported claim, unfair harshness or softness, or blind spot"),
      weight: z.enum(["high", "medium", "low"]),
    }),
  ),
  missed_by_everyone: z.array(z.string()),

  verdict: Verdict,
  confidence: Confidence,
  summary_for_user: z
    .string()
    .describe("3-5 plain sentences: the verdict, the main reasons it is good or bad, and what to do"),
  reasons_for: z.array(Reason).describe("Why it is good, strongest first"),
  reasons_against: z.array(Reason).describe("Why it is bad or risky, strongest first"),
  what_would_change_the_verdict: z.array(z.string()),

  risks: z
    .array(z.object({ risk: z.string(), severity: z.enum(["low", "medium", "high"]) }))
    .describe("Idea mode: the 2-5 risks the Strategist must mitigate. Plan mode: []"),
  decision_changing_issues: z
    .array(z.object({ severity: Severity, issue: z.string(), fix: z.string() }))
    .describe("Only issues that change the decision. Empty means it can go ahead as is"),
  improvements: z.array(z.string()).describe("Worth doing, but not blocking"),
  open_questions: z.array(z.string()).describe("Questions the research could not answer"),
  pivots: z
    .array(z.object({ idea: z.string(), why: z.string() }))
    .describe("Idea mode: 2-3 pivots that address the biggest risks. Plan mode: []"),
});
type CouncilVerdict = z.infer<typeof CouncilVerdict>;

// ---------------------------------------------------------------------------
// Running the council: 6 calls
// ---------------------------------------------------------------------------

const CHAIRMAN_INSTRUCTIONS = `You are the Chairman of a five-advisor review council. You did not
write any opinion; stay neutral. The opinions are anonymized as Advisor A-E and were written
independently. One argues against, one argues for, one checks history and prior art, one speaks
as the target customer, and one checks facts and numbers.

Step 1, cross-examine: for each advisor, name its strongest point and its weakest point (an
unsupported claim, unfair harshness, unfair softness, or a blind spot), and decide its weight.
List anything important that every advisor missed.

Step 2, decide:
- Weigh arguments by evidence, not by how many advisors said them or how harsh they sound.
  case_file and opened_page evidence outweighs search_result_only and model_knowledge.
- Trust the facts-and-numbers advisor over the others on what is actually true.
- Sort every issue: does it CHANGE THE DECISION, or only make a sound idea or plan better?
  Only decision-changing issues go in decision_changing_issues; the rest go in improvements.
- Rubric: strong = real problem, follows from the evidence, decision_changing_issues is empty.
  promising_needs_fixes = sound core, at least one fixable decision-changing issue.
  weak = problem unproven, doesn't follow from evidence, or mostly exists with no real difference.
  do_not_pursue = no real problem, or a critical flaw with no reasonable fix.
- Every idea and plan can be improved. Do NOT withhold "strong" because improvements exist or
  because advisors listed concerns; judge whether those concerns actually change the decision.
  Calling a good idea mediocre is as much a failure as calling a bad idea good.

Step 3, explain to the user:
- summary_for_user: 3-5 plain sentences with the verdict and WHY, then what to do.
- reasons_for / reasons_against: each says the point, WHY it matters (profit, cost, time, risk,
  demand, trust, with numbers when available), the evidence, and its source (cite fact ids like F2).
- what_would_change_the_verdict: the specific evidence that would move it up or down.`;

const CHAIRMAN_MODE: Record<Mode, string> = {
  idea: `MODE: idea review (before any plan exists). Fill "risks" with the 2-5 risks the Strategist
must mitigate, and "pivots" with 2-3 pivots that address the biggest risks.`,
  plan: `MODE: plan check. A plan only fails if it is misleading or unworkable: a pass-1 risk with no
real mitigation, a key step with no research behind it, or a step that ignores updated_facts.
Return "risks" and "pivots" as [].`,
};

async function callStructured<T extends z.ZodTypeAny>(opts: {
  model: string;
  instructions: string;
  input: unknown;
  schema: T;
  name: string;
  webSearch: boolean;
}): Promise<z.infer<T>> {
  const res = await openai().responses.parse({
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.webSearch ? [{ type: "web_search" }] : [],
    input: JSON.stringify(opts.input),
    text: { format: zodTextFormat(opts.schema, opts.name) },
  });
  if (!res.output_parsed) throw new Error(`Critic council: ${opts.name} returned no structured output`);
  return res.output_parsed as z.infer<T>;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function runCouncil(mode: Mode, caseFile: Record<string, unknown>): Promise<CouncilVerdict> {
  // Calls 1-5: independent opinions in parallel. One failed advisor doesn't sink the council.
  // Web search only on the idea pass; the plan pass works from the research already gathered.
  const settled = await Promise.allSettled(
    ADVISORS.map((a) =>
      callStructured({
        model: ADVISOR_MODEL,
        instructions: `You are ${a.name}.\n\n${a.lens}\n\n${MODE_TASK[mode]}\n\n${SHARED_RULES}`,
        input: caseFile,
        schema: AdvisorOpinion,
        name: a.id,
        webSearch: a.webSearch && mode === "idea",
      }),
    ),
  );
  const opinions: AdvisorOpinion[] = settled.flatMap((r) =>
    r.status === "fulfilled"
      ? [{ ...r.value, concerns: r.value.concerns.slice(0, 3), reasons_for: r.value.reasons_for.slice(0, 3), reasons_against: r.value.reasons_against.slice(0, 3) }]
      : [],
  );
  if (opinions.length < 3) {
    const firstError = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    throw new Error(`Critic council: too many advisors failed (${String(firstError?.reason)})`);
  }

  // Call 6: chairman. Shuffled anonymous labels so it judges reasoning, not seat or position.
  const labeled = shuffle(opinions).map((opinion, i) => ({ label: `Advisor ${"ABCDE"[i]}`, opinion }));
  return callStructured({
    model: CHAIRMAN_MODEL,
    instructions: `${CHAIRMAN_INSTRUCTIONS}\n\n${CHAIRMAN_MODE[mode]}`,
    input: { case: caseFile, opinions: labeled },
    schema: CouncilVerdict,
    name: "council_verdict",
    webSearch: false,
  });
}

// ---------------------------------------------------------------------------
// Mapping the council onto the team's shared types
// ---------------------------------------------------------------------------

function formatReason(r: Reason, kind: "For" | "Against"): string {
  const src = r.source_type === "model_knowledge" ? "unverified" : r.source;
  const because = r.because.charAt(0).toLowerCase() + r.because.slice(1);
  return `${kind}: ${r.point}, because ${because} (evidence: ${r.evidence}; source: ${src})`;
}

const SEVERITY_MAP = { critical: "high", major: "medium", minor: "low" } as const;

function toIdeaReview(v: CouncilVerdict): IdeaReview {
  const verdict: IdeaReview["verdict"] =
    v.verdict === "strong" ? "promising" : v.verdict === "promising_needs_fixes" ? "risky" : "weak";
  return {
    verdict,
    // The UI lists these under "Critic's reasons": the plain summary first, then the why.
    reasons: [
      v.summary_for_user,
      ...v.reasons_for.map((r) => formatReason(r, "For")),
      ...v.reasons_against.map((r) => formatReason(r, "Against")),
    ],
    risks: v.risks.map((r, i) => ({ id: `R${i + 1}`, risk: r.risk, severity: r.severity })),
    openQuestions: [...v.open_questions, ...v.what_would_change_the_verdict.map((w) => `Would change the verdict: ${w}`)],
    pivots: v.pivots,
  };
}

function toPlanReview(v: CouncilVerdict): PlanReview {
  const passed = v.verdict === "strong" && v.decision_changing_issues.length === 0;
  return {
    passed,
    summary: v.summary_for_user,
    issues: [
      ...v.decision_changing_issues.map((i) => ({
        issue: i.issue,
        severity: SEVERITY_MAP[i.severity],
        suggestion: i.fix,
      })),
      // Non-blocking improvements, shown as low severity.
      ...v.improvements.slice(0, 3).map((imp) => ({
        issue: imp,
        severity: "low" as const,
        suggestion: "Optional improvement; does not block the plan",
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Mocks (used when OPENAI_API_KEY is unset or MOCK_AGENTS=true)
// ---------------------------------------------------------------------------

function mockIdeaReview(): IdeaReview {
  return {
    verdict: "risky",
    reasons: [
      "Mock council summary: demand looks real, but the competitor data is low confidence, so validate before building.",
      "For: Demand is real, because the market grew about 12% last year (evidence: F1; source: F1)",
      "Against: Competitors are unproven, because the competitor facts are low confidence (evidence: F3; source: F3)",
    ],
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
    summary:
      unbacked.length === 0 ? "Mock review: plan is backed by research." : "Mock review: some steps lack evidence.",
    issues: unbacked.map((s) => ({
      issue: `"${s.step}" is not backed by any research fact`,
      severity: "medium" as const,
      suggestion: "Cite a fact or mark it as an assumption",
    })),
  };
}
