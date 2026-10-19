// POST RunState → RunState with plan + planReview (steps 6-7, after the user picks "Continue").
import { runPlanPhase } from "@/lib/agent-team";
import type { RunState } from "@/lib/agents/types";

export async function POST(request: Request) {
  const state = (await request.json()) as RunState;
  try {
    return Response.json(await runPlanPhase(state));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
