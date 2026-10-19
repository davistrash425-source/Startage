// Orchestration: the order of agent calls and what each one hands to the next.
// Shared file. Agent owners should only need to edit their own lib/agents/*.ts.

import { reviewIdea, reviewPlan } from "./agents/critic";
import { runResearcher } from "./agents/researcher";
import { runStrategist } from "./agents/strategist";
import type { AgentName, IdeaInput, LogEntry, RunState } from "./agents/types";

function logger(log: LogEntry[]) {
  return (agent: AgentName, message: string) =>
    log.push({ at: new Date().toISOString(), agent, message });
}

// Steps 2-3: Researcher → Critic (idea review). Also reused by the fact-update flow.
export async function runResearchPhase(
  input: IdeaInput,
  previous?: RunState,
  updatedFacts: string[] = [],
): Promise<RunState> {
  const log = [...(previous?.log ?? [])];
  const say = logger(log);

  say("researcher", updatedFacts.length ? "Re-researching with updated facts" : `Researching "${input.idea}"`);
  const research = await runResearcher({
    input,
    previousResearch: previous?.research ?? null,
    updatedFacts,
  });
  say("researcher", `Handed ${research.facts.length} facts, ${research.competitors.length} competitors, ${research.unknowns.length} unknowns to the Critic`);

  say("critic", "Reviewing the idea against the research");
  const ideaReview = await reviewIdea({ input, research });
  say("critic", `Verdict: ${ideaReview.verdict}, with ${ideaReview.risks.length} risks`);

  return {
    input,
    research,
    ideaReview,
    plan: previous?.plan ?? null,
    planReview: previous?.planReview ?? null,
    previousPlan: previous?.previousPlan ?? null,
    updatedFacts,
    log,
  };
}

// Steps 6-7: Strategist → Critic (plan check), with one revision if the check fails.
export async function runPlanPhase(state: RunState): Promise<RunState> {
  const { input, research, ideaReview, updatedFacts } = state;
  if (!research || !ideaReview) throw new Error("Run the research phase before planning");
  const log = [...state.log];
  const say = logger(log);

  const previousPlan = state.plan;
  say("strategist", previousPlan ? "Revising the plan with the updated research" : "Drafting the launch plan from the research and the critique");
  let plan = await runStrategist({ input, research, ideaReview, previousPlan, planFeedback: null, updatedFacts });
  say("strategist", `Handed a plan with ${plan.launchSteps.length} steps to the Critic`);

  say("critic", "Checking the plan");
  let planReview = await reviewPlan({ research, ideaReview, plan, updatedFacts });
  say("critic", planReview.passed ? "Plan passed" : `Plan failed with ${planReview.issues.length} issues; sending back to the Strategist`);

  if (!planReview.passed) {
    plan = await runStrategist({ input, research, ideaReview, previousPlan: plan, planFeedback: planReview, updatedFacts });
    say("strategist", "Revised the plan to address the Critic's issues");
    planReview = await reviewPlan({ research, ideaReview, plan, updatedFacts });
    say("critic", planReview.passed ? "Revised plan passed" : "Revised plan still has issues (shown to the user)");
  }

  return { ...state, plan, planReview, previousPlan, log };
}

// Twist: a corrected fact flows Researcher → Critic → (Strategist → Critic if a plan exists).
export async function runFactUpdate(state: RunState, fact: string): Promise<RunState> {
  const updatedFacts = [...state.updatedFacts, fact];
  const withLog = { ...state, log: [...state.log] };
  logger(withLog.log)("system", `Fact update: "${fact}"`);

  const researched = await runResearchPhase(state.input, withLog, updatedFacts);
  return state.plan ? runPlanPhase(researched) : researched;
}
