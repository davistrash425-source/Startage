"use client";

import { useState } from "react";
import type { Plan, RunState } from "@/lib/agents/types";

type Busy = null | "research" | "plan" | "update";

async function post(url: string, body: unknown): Promise<RunState> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function Home() {
  const [idea, setIdea] = useState("");
  const [context, setContext] = useState("");
  const [fact, setFact] = useState("");
  const [state, setState] = useState<RunState | null>(null);
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: Exclude<Busy, null>, call: () => Promise<RunState>) {
    setBusy(kind);
    setError(null);
    try {
      setState(await call());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  const research = (nextIdea = idea) => {
    setIdea(nextIdea);
    setStopped(false);
    run("research", () => post("/api/research", { idea: nextIdea, context }));
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold">Startage</h1>
        <p className="text-zinc-500">Research, critique and plan your startup idea with a team of three AI agents.</p>
      </header>

      {/* Step 1: idea input */}
      <section className="flex flex-col gap-3">
        <textarea
          className="min-h-24 rounded-lg border border-zinc-300 bg-transparent p-3 dark:border-zinc-700"
          placeholder="Describe your business idea…"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
        />
        <input
          className="rounded-lg border border-zinc-300 bg-transparent p-3 dark:border-zinc-700"
          placeholder="Optional context: target customer, location, budget, timeline"
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
        <button className="btn self-start" disabled={!idea.trim() || busy !== null} onClick={() => research()}>
          {busy === "research" ? "Researching…" : state ? "Re-run research" : "Research my idea"}
        </button>
      </section>

      {error && <p className="rounded-lg bg-red-100 p-3 text-red-800">{error}</p>}

      {/* Step 4: viability report */}
      {state?.research && state.ideaReview && (
        <section className="card">
          <h2 className="text-xl font-semibold">
            Viability report <Verdict verdict={state.ideaReview.verdict} />
          </h2>
          <p>{state.research.summary}</p>
          <p><b>Target customer:</b> {state.research.targetCustomer}</p>
          <p><b>Market:</b> {state.research.marketSummary}</p>
          <List title="Key findings" items={state.research.facts.map((f) => `[${f.id}] ${f.claim} (${f.confidence} confidence, ${f.source})`)} />
          <List title="Competitors" items={state.research.competitors.map((c) => `${c.name}: ${c.notes}`)} />
          <List title="Critic's reasons" items={state.ideaReview.reasons} />
          <List title="Risks" items={state.ideaReview.risks.map((r) => `[${r.id}] ${r.risk} (${r.severity})`)} />
          <List title="Unknowns" items={[...state.research.unknowns, ...state.ideaReview.openQuestions]} />

          {/* Step 5: decision gate */}
          {!state.plan && !stopped && (
            <div className="flex flex-wrap gap-2 pt-2">
              <button className="btn" disabled={busy !== null} onClick={() => run("plan", () => post("/api/plan", state))}>
                {busy === "plan" ? "Planning…" : "Continue: build a plan"}
              </button>
              <button className="btn-secondary" disabled={busy !== null} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
                Revise idea
              </button>
              <button className="btn-secondary" disabled={busy !== null} onClick={() => setStopped(true)}>
                Stop
              </button>
            </div>
          )}

          {stopped && (
            <div className="flex flex-col gap-2 pt-2">
              <h3 className="font-semibold">Pivots suggested by the Critic</h3>
              {state.ideaReview.pivots.map((p) => (
                <button key={p.idea} className="btn-secondary text-left" disabled={busy !== null} onClick={() => research(p.idea)}>
                  <b>{p.idea}</b>: {p.why}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Step 8: final plan */}
      {state?.plan && state.planReview && (
        <section className="card">
          <h2 className="text-xl font-semibold">Launch plan</h2>
          <PlanView plan={state.plan} />
          <p className={state.planReview.passed ? "text-green-700" : "text-amber-700"}>
            <b>Critic check: {state.planReview.passed ? "passed" : "issues found"}.</b> {state.planReview.summary}
          </p>
          <List title="Critic issues" items={state.planReview.issues.map((i) => `${i.issue} (${i.severity}): ${i.suggestion}`)} />
          {state.previousPlan && (
            <details>
              <summary className="cursor-pointer font-semibold">Plan before the last fact update</summary>
              <PlanView plan={state.previousPlan} />
            </details>
          )}
        </section>
      )}

      {/* Twist: fact update */}
      {state?.research && (
        <section className="card">
          <h2 className="text-xl font-semibold">Update a fact</h2>
          <p className="text-zinc-500">Correct something the agents got wrong. It goes back through the Researcher, the Critic and, if a plan exists, the Strategist.</p>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-zinc-300 bg-transparent p-3 dark:border-zinc-700"
              placeholder='e.g. "The budget is now $500, not $2,000"'
              value={fact}
              onChange={(e) => setFact(e.target.value)}
            />
            <button
              className="btn"
              disabled={!fact.trim() || busy !== null}
              onClick={() => run("update", () => post("/api/update-fact", { state, fact })).then(() => setFact(""))}
            >
              {busy === "update" ? "Updating…" : "Apply"}
            </button>
          </div>
          <List title="Facts applied so far" items={state.updatedFacts} />
        </section>
      )}

      {/* Agent activity log: shows each handoff */}
      {state && (
        <section className="card">
          <h2 className="text-xl font-semibold">Agent activity</h2>
          <ol className="flex flex-col gap-1 font-mono text-sm">
            {state.log.map((entry, i) => (
              <li key={i}>
                <span className="text-zinc-500">{new Date(entry.at).toLocaleTimeString()}</span>{" "}
                <b className="uppercase">{entry.agent}</b> {entry.message}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="flex flex-col gap-2">
      <p><b>Positioning:</b> {plan.positioning}</p>
      <p><b>Target customer:</b> {plan.targetCustomer}</p>
      <p><b>MVP:</b> {plan.mvp}</p>
      <p><b>Pricing:</b> {plan.pricing}</p>
      <p><b>Budget:</b> {plan.budget}</p>
      <p><b>Confidence:</b> {plan.confidence}</p>
      <List title="Launch steps" items={plan.launchSteps.map((s) => `${s.timeframe}: ${s.step}. ${s.rationale} [${s.basedOn.join(", ") || "no evidence"}]`)} />
      <List title="Risk mitigations" items={plan.riskMitigations.map((m) => `[${m.riskId}] ${m.mitigation}`)} />
      <List title="Success metrics" items={plan.successMetrics} />
      <List title="Research gaps" items={plan.researchGaps} />
      <List title="Changes from previous plan" items={plan.changesFromPrevious} />
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <ul className="list-disc pl-5">
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const color = { promising: "bg-green-600", risky: "bg-amber-500", weak: "bg-red-600" }[verdict] ?? "bg-zinc-500";
  return <span className={`ml-2 rounded-full px-2 py-0.5 text-sm text-white ${color}`}>{verdict}</span>;
}
