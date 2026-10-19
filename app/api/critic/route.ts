// app/api/critic/route.ts
// Runs the Critic council on its own so it can be tested before the
// Researcher and Strategist are wired in.
// POST body: { userGoal: string, research: any, plan: any, changedFacts?: string[] }

import { runCritic, type CriticInput } from "@/lib/agents/critic";

export const maxDuration = 120; // 6 model calls; allow time for web search

export async function POST(request: Request) {
  let body: CriticInput;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body?.userGoal || body.research === undefined || body.plan === undefined) {
    return Response.json(
      { error: "Required fields: userGoal, research, plan" },
      { status: 400 }
    );
  }

  const log: string[] = [];
  try {
    const result = await runCritic(body, { onProgress: (step) => log.push(step) });
    return Response.json({ ...result, log });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), log },
      { status: 500 }
    );
  }
}
