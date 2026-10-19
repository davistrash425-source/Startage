// POST { state, fact } → RunState re-run through the agents (the twist).
import { runFactUpdate } from "@/lib/agent-team";
import type { RunState } from "@/lib/agents/types";

export async function POST(request: Request) {
  const { state, fact } = (await request.json()) as { state: RunState; fact: string };
  if (!fact?.trim()) return Response.json({ error: "A fact is required" }, { status: 400 });
  try {
    return Response.json(await runFactUpdate(state, fact));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
