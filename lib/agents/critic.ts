// lib/agents/critic.ts
// The Critic as a council, in exactly 6 API calls:
//   1-5. Five advisors review the idea INDEPENDENTLY (parallel calls, none sees the others).
//   6.   The chairman cross-examines their opinions (anonymized, shuffled) and
//        decides, explaining WHY with reasons tied to evidence.
// Tough but fair: a plan with no decision-changing problems is called "strong",
// even if it could still be improved.

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const client = new OpenAI(); // reads OPENAI_API_KEY on the server
const ADVISOR_MODEL = process.env.OPENAI_ADVISOR_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
const CHAIRMAN_MODEL = process.env.OPENAI_CHAIRMAN_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1";

// ---------- Input ----------
export type CriticInput = {
  userGoal: string;        // the original idea / goal
  research: unknown;       // researcher's JSON (facts, sources, unknowns)
  plan: unknown;           // strategist's JSON (proposed plan + reasoning)
  changedFacts?: string[]; // "the twist": facts that changed since research ran
};

export type CriticOptions = {
  onProgress?: (step: string) => void; // hook for your UI run log
};

// ---------- The five advisors ----------
// Two opposing pairs plus one neutral:
//   Prosecutor  vs Defense      (guilty vs worth saving)
//   Historian   vs Target User  (has it been done vs do people actually want it)
//   Auditor in the middle       (are the claims true, and does the math work?)
type AdvisorDef = { id: string; name: string; lens: string; webSearch: boolean };

const ADVISORS: AdvisorDef[] = [
  {
    id: "prosecutor",
    name: "The Prosecutor",
    lens: `You are building the case AGAINST this idea. Assume it has a fatal flaw and hunt for it:
the problem isn't real, the plan doesn't follow from the research, users won't care, it can't be
built, or it breaks under real conditions. If it looks solid, dig deeper into the assumptions.
But you are an honest prosecutor: if after real effort you cannot find a decision-changing flaw,
say "no fatal flaw found" and give a "strong" verdict. If changed_facts are given, check whether
the plan still rests on the old facts.`,
    webSearch: false,
  },
  {
    id: "defense",
    name: "The Defense Attorney",
    lens: `You are building the strongest honest case FOR this idea. What does it get right, and WHY
does that matter (profit, low cost, speed, low risk, real demand)? What is genuinely valuable or
overlooked? What happens if it works better than expected? Name the flaws you cannot defend, and
argue which criticisms are overblown and why.`,
    webSearch: false,
  },
  {
    id: "historian",
    name: "The Historian",
    lens: `Your questions: has this been done or tried before, what happened, and why NOW?
Use web search. Find existing products, open-source projects, and the workarounds people use today,
plus attempts that FAILED and why, and attempts that SUCCEEDED and why. Say exactly how this idea
differs and whether the difference is meaningful or cosmetic. Existing does not mean bad.
Then: what has changed that makes this possible or needed now, and could a big platform add it free?`,
    webSearch: true,
  },
  {
    id: "target_user",
    name: "The Target User",
    lens: `You ARE the person this is for. Answer in first person, from lived experience: what is
this, in your words? Do you actually have this problem, how often, and how do you handle it today?
Would you switch to this, what would make you try it, and what would make you quit after a week?
If you can't understand what it does from the description, say exactly where you got lost.`,
    webSearch: false,
  },
  {
    id: "auditor",
    name: "The Auditor",
    lens: `You have no opinion on whether the idea is good. You check two things: are the claims TRUE,
and does the MATH work? Check which claims have a source, which don't, which sources are weak or
outdated, and which facts contradict each other. Use web search to spot-check the most important
claims. Then the numbers: size of the need, cost to build and run, revenue or savings, time to a
first version. Show your arithmetic and label rough estimates.`,
    webSearch: true,
  },
];

const SHARED_RULES = `
You are one of five independent advisors on a review council. You have not seen the other
advisors' views. Stay inside your own lens; other advisors cover the rest.

Be objective and fair:
- Steelman first: the strongest honest case FOR the idea from your lens.
- Give reasons, not labels. Every reason for or against says WHY it matters (money, time, risk,
  demand, trust) and points to the evidence behind it.
- At most 3 concerns, all from your lens. For each, decide honestly: would fixing it CHANGE THE
  DECISION (what to do, or whether to do it)? Things that would only make a sound plan better
  go in "improvements", not "concerns".
- Do not invent problems to look tough. Do not soften a real flaw to be nice.
- Every plan can be improved. That alone is never a reason to withhold "strong".
- Separate "not proven yet" (ask for evidence) from "wrong" (explain why).
- Tag every piece of evidence with where it came from:
  case_file = stated in the research or plan; opened_page = a web page you actually read;
  search_result_only = you saw only a title or snippet; model_knowledge = your own knowledge.

VERDICT RUBRIC:
- strong: the problem is real, the plan follows from the evidence, and no concern changes the
  decision. Remaining items are improvements.
- promising_needs_fixes: the core is sound, but at least one fixable concern changes the decision.
- weak: the problem is unproven, the plan doesn't follow from the evidence, or the idea mostly
  exists already with no meaningful difference.
- do_not_pursue: no real problem, or a critical flaw with no reasonable fix.
`.trim();

// ---------- Schemas ----------
const Severity = z.enum(["critical", "major", "minor"]);
const Verdict = z.enum(["strong", "promising_needs_fixes", "weak", "do_not_pursue"]);
const Confidence = z.enum(["high", "medium", "low"]);
const SourceType = z.enum(["case_file", "opened_page", "search_result_only", "model_knowledge"]);

const Reason = z.object({
  point: z.string().describe("The claim, e.g. 'Automating first is cheaper than hiring'"),
  because: z.string().describe("Why it matters: money, time, risk, demand, trust. Include numbers when you have them"),
  evidence: z.string().describe("The specific fact or finding this rests on"),
  source_type: SourceType,
  source: z.string().describe("Where: case-file field, URL, or 'model knowledge - verify'"),
});

const AdvisorOpinion = z.object({
  answer_to_my_question: z.string().describe("Direct answer to your lens question, 2-4 sentences"),
  steelman: z.string(),
  reasons_for: z.array(Reason).describe("Up to 3 reasons this is good, each with why and evidence"),
  reasons_against: z.array(Reason).describe("Up to 3 reasons this is bad, each with why and evidence"),
  concerns: z.array(
    z.object({
      severity: Severity,
      issue: z.string(),
      changes_decision: z.boolean().describe("True only if fixing this would change what to do or whether to do it"),
      evidence: z.string(),
      source_type: SourceType,
      fix: z.string(),
    })
  ).describe("At most 3, all from your lens"),
  improvements: z.array(z.string()).describe("Nice-to-have changes that don't change the decision"),
  existing_solutions: z.array(
    z.object({
      name: z.string(),
      how_this_idea_differs: z.string(),
      source_type: SourceType,
      source: z.string(),
    })
  ).describe("Mainly the Historian fills this; others may return []"),
  missing_information: z.array(z.string()),
  verdict: Verdict,
  confidence: Confidence,
});
type AdvisorOpinion = z.infer<typeof AdvisorOpinion>;

export const CouncilVerdict = z.object({
  // Cross-examination (replaces a separate peer-review round)
  cross_examination: z.array(
    z.object({
      advisor_label: z.string(),
      strongest_point: z.string(),
      weakest_point: z.string().describe("Unsupported claim, unfair harshness or softness, or blind spot"),
      weight: z.enum(["high", "medium", "low"]),
    })
  ),
  missed_by_everyone: z.array(z.string()),

  // What the idea is
  what_it_does: z.string(),
  problem_solved: z.string().describe("The specific problem, or 'none identified'"),
  who_has_the_problem: z.string(),
  already_exists: z.enum(["yes", "partly", "no", "unknown"]),
  real_differentiator: z.string(),

  // THE DECISION, explained
  verdict: Verdict,
  confidence: Confidence,
  explanation: z.object({
    summary_for_user: z.string().describe(
      "3-5 plain sentences to the user: the verdict, the main reasons it is good or bad, and what to do. No jargon."
    ),
    reasons_for: z.array(Reason).describe("Why this is good, strongest first. Each says WHY with evidence"),
    reasons_against: z.array(Reason).describe("Why this is bad or risky, strongest first. Each says WHY with evidence"),
    what_would_change_the_verdict: z.array(z.string()).describe("Evidence that would move the verdict up or down"),
  }),

  // How the council saw it
  consensus: z.array(z.string()),
  disagreements: z.array(
    z.object({
      topic: z.string(),
      positions: z.string(),
      chairman_call: z.string(),
    })
  ),
  minority_warnings: z.array(z.string()),

  // Work items
  decision_changing_issues: z.array(
    z.object({ severity: Severity, issue: z.string(), fix: z.string(), raised_by: z.array(z.string()) })
  ).describe("Only issues that change the decision. Empty means the plan can go ahead as is"),
  improvements: z.array(z.string()).describe("Worth doing, but the plan can proceed without them"),
  stale_facts_found: z.array(z.string()).describe("ONLY plan content that relies on facts listed in changed_facts. [] if changed_facts is empty"),
  unverified_claims: z.array(z.string()).describe("Claims resting on search_result_only or model_knowledge that matter to the decision"),

  scores: z.object({
    real_need: z.number().int().min(1).max(5).describe("1 = no real need, 5 = clear, proven need"),
    originality: z.number().int().min(1).max(5).describe("1 = copy of existing, 5 = clearly new"),
    feasibility: z.number().int().min(1).max(5).describe("1 = can't be done, 5 = easy to do"),
    user_value: z.number().int().min(1).max(5).describe("1 = no value, 5 = high value"),
    evidence_support: z.number().int().min(1).max(5).describe("1 = no evidence, 5 = well evidenced"),
  }),
  risk_level: z.enum(["low", "medium", "high"]),

  what_to_do_next: z.array(z.string()),

  // Routing for the orchestrator (normalized in code after parsing)
  needs_revision: z.boolean(),
  send_back_to: z.enum(["researcher", "strategist", "none"]),
  questions_for_researcher: z.array(z.string()),
  revision_instructions: z.string(),
});
export type CouncilVerdict = z.infer<typeof CouncilVerdict>;

export type CriticResult = {
  verdict: CouncilVerdict;
  advisors: { id: string; name: string; label: string; opinion: AdvisorOpinion }[];
};

// ---------- Helpers ----------
async function callStructured<T extends z.ZodTypeAny>(opts: {
  model: string;
  instructions: string;
  input: unknown;
  schema: T;
  name: string;
  webSearch?: boolean;
}): Promise<z.infer<T>> {
  const res = await client.responses.parse({
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.webSearch ? [{ type: "web_search" }] : [],
    input: [{ role: "user", content: JSON.stringify(opts.input, null, 2) }],
    text: { format: zodTextFormat(opts.schema, opts.name) },
  });
  if (!res.output_parsed) throw new Error(`${opts.name}: no structured output`);
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

// Enforce the length limits the prompt asks for, in case the model goes over.
function trimOpinion(o: AdvisorOpinion): AdvisorOpinion {
  return {
    ...o,
    reasons_for: o.reasons_for.slice(0, 3),
    reasons_against: o.reasons_against.slice(0, 3),
    concerns: o.concerns.slice(0, 3),
  };
}

// Keep verdict and routing consistent no matter what the model wrote.
function normalize(v: CouncilVerdict, hasChangedFacts: boolean): CouncilVerdict {
  const out = { ...v };
  if (!hasChangedFacts) out.stale_facts_found = [];
  if (out.verdict === "strong") {
    out.needs_revision = false;
    out.send_back_to = "none";
    out.revision_instructions = "";
  } else {
    out.needs_revision = true;
    if (out.send_back_to === "none") out.send_back_to = "strategist";
  }
  return out;
}

const CHAIRMAN_INSTRUCTIONS = `You are the Chairman of a five-advisor review council. You did not
write any opinion; stay neutral. The opinions are anonymized as Advisor A-E and were written
independently. One argues against the idea, one argues for it, one checks history and prior art,
one speaks as the target user, and one checks facts and numbers.

Step 1, cross-examine: for each advisor, name its strongest point and its weakest point (an
unsupported claim, unfair harshness, unfair softness, or a blind spot), and decide how much
weight it deserves. List anything important that every advisor missed.

Step 2, decide:
- Weigh arguments by evidence, not by how many advisors said them or how harsh they sound.
  case_file and opened_page evidence outweighs search_result_only and model_knowledge.
- Trust the fact-and-numbers advisor over the others on what is actually true.
- Sort every issue: does it CHANGE THE DECISION, or does it only make a sound plan better?
  Only decision-changing issues go in decision_changing_issues; the rest go in improvements.
- Use this rubric exactly:
  strong = real problem, plan follows from the evidence, decision_changing_issues is empty.
  promising_needs_fixes = sound core, but at least one fixable decision-changing issue.
  weak = problem unproven, plan doesn't follow from evidence, or idea mostly exists with no real difference.
  do_not_pursue = no real problem, or a critical flaw with no reasonable fix.
- Every plan can be improved. Do NOT withhold "strong" because improvements exist or because
  some advisors listed concerns; judge whether those concerns actually change the decision.
  Calling a good plan mediocre is as much a failure as calling a bad plan good.

Step 3, explain to the user:
- summary_for_user: 3-5 plain sentences. Say the verdict and WHY, using the strongest reasons
  for and against, then what to do.
- reasons_for / reasons_against: each reason says the point, WHY it matters (profit, cost, time,
  risk, demand, trust, with numbers when available), the evidence, and its source type.
  Example: point "Automating first is the right order", because "68% of messages are 4 repeat
  questions, so free saved replies remove most of the load before paying $30-75/week for a VA",
  evidence "owner's tag of 200 messages", source_type "case_file".
- what_would_change_the_verdict: the specific evidence that would move it up or down.

Rules for other fields:
- stale_facts_found: ONLY plan content relying on facts in changed_facts. Empty if none.
- unverified_claims: decision-relevant claims resting only on search_result_only or model_knowledge.
- send_back_to: "researcher" when facts are missing or stale, "strategist" when the plan is the problem,
  "none" when the verdict is strong.`;

// ---------- The council: 6 calls ----------
export async function runCritic(
  input: CriticInput,
  options: CriticOptions = {}
): Promise<CriticResult> {
  const { onProgress = () => {} } = options;
  const caseFile = {
    user_goal: input.userGoal,
    research: input.research,
    plan: input.plan,
    changed_facts: input.changedFacts ?? [],
  };

  // Calls 1-5: independent opinions, in parallel. One failed advisor doesn't sink the council.
  onProgress(`Council: ${ADVISORS.length} advisors reviewing independently`);
  const settled = await Promise.allSettled(
    ADVISORS.map((a) =>
      callStructured({
        model: ADVISOR_MODEL,
        instructions: `You are ${a.name}.\n\n${a.lens}\n\n${SHARED_RULES}`,
        input: caseFile,
        schema: AdvisorOpinion,
        name: a.id,
        webSearch: a.webSearch,
      })
    )
  );
  const succeeded = ADVISORS.flatMap((a, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") return [{ id: a.id, name: a.name, opinion: trimOpinion(r.value) }];
    onProgress(`Advisor failed: ${a.name} (${String(r.reason)})`);
    return [];
  });
  if (succeeded.length < 3) throw new Error("Council needs at least 3 advisors; too many failed");

  // Shuffled anonymous labels so the chairman judges reasoning, not seat or position.
  const advisors = shuffle(succeeded).map((a, i) => ({ ...a, label: `Advisor ${"ABCDE"[i]}` }));

  // Call 6: chairman cross-examines, decides and explains.
  onProgress("Council: chairman deciding and explaining");
  const raw = await callStructured({
    model: CHAIRMAN_MODEL,
    instructions: CHAIRMAN_INSTRUCTIONS,
    input: {
      case: caseFile,
      opinions: advisors.map((a) => ({ label: a.label, opinion: a.opinion })),
    },
    schema: CouncilVerdict,
    name: "council_verdict",
  });

  const verdict = normalize(raw, (input.changedFacts ?? []).length > 0);
  return { verdict, advisors };
}
