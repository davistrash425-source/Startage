// POST { idea, context } → RunState with research + ideaReview (steps 2-3).
import { runResearchPhase } from "@/lib/agent-team";
import { IdeaInputSchema } from "@/lib/agents/types";

export async function POST(request: Request) {
  const parsed = IdeaInputSchema.safeParse(await request.json());
  if (!parsed.success || !parsed.data.idea.trim()) {
    return Response.json({ error: "An idea is required" }, { status: 400 });
  }
  try {
    return Response.json(await runResearchPhase(parsed.data));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
