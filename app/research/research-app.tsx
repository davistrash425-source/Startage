"use client";

// The Researcher page: send an idea, watch the agent work, answer its
// questions, read the report, and download the research brief.

import { useRef, useState } from "react";
import { briefJson } from "@/lib/agents/claude-researcher/report";
import type {
  QuestionSet,
  ResearchEvent,
  ResearchReport,
  ResearcherInput,
  ResearcherState,
  Visual,
} from "@/lib/agents/claude-researcher/types";
import { Markdown } from "./markdown";
import { ActivityList, FactsLedger, QuestionForm, VisualFrame, type Activity } from "./parts";

type UserEntry = { id: number; role: "user"; kind: ResearcherInput["kind"]; text: string };
type AgentEntry = {
  id: number;
  role: "agent";
  status: "working" | "questions" | "done" | "error";
  thinking: string;
  activity: Activity[];
  liveText: string;
  visuals: Visual[];
  questionSet?: QuestionSet;
  report?: ResearchReport;
  saved?: string[];
  error?: string;
};
type Entry = UserEntry | AgentEntry;

const EXAMPLES = [
  "A mobile car detailing subscription for apartment complexes in Memphis, TN. Budget about $3,000.",
  "Matching high school students with college tutors for SAT prep in Alpharetta, GA.",
  "A used-textbook swap app for gap-year students in Jerusalem.",
];

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ResearchApp() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [agentState, setAgentState] = useState<ResearcherState | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [latest, setLatest] = useState<{ report: ResearchReport; idea: string | null } | null>(null);
  const [lastAgentId, setLastAgentId] = useState<number | null>(null);
  const nextId = useRef(1);
  const lastRequest = useRef<{ input: ResearcherInput; state: ResearcherState | null; agentId: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const newId = () => nextId.current++;
  const started = entries.length > 0;
  // A conversation exists once the Researcher has answered at least once.
  const hasConversation = agentState !== null;

  const updateAgent = (id: number, update: (e: AgentEntry) => AgentEntry) =>
    setEntries((prev) => prev.map((e) => (e.id === id && e.role === "agent" ? update(e) : e)));

  function applyEvent(agentId: number, event: ResearchEvent) {
    switch (event.type) {
      case "thinking_start":
        updateAgent(agentId, (e) => ({ ...e, thinking: e.thinking ? e.thinking + "\n\n" : e.thinking }));
        break;
      case "thinking":
        updateAgent(agentId, (e) => ({ ...e, thinking: e.thinking + event.text }));
        break;
      case "text":
        updateAgent(agentId, (e) => ({ ...e, liveText: e.liveText + event.text }));
        break;
      case "activity":
        updateAgent(agentId, (e) => ({ ...e, activity: [...e.activity, { id: newId(), icon: event.icon, text: event.text }] }));
        break;
      case "visual":
        updateAgent(agentId, (e) => ({ ...e, visuals: [...e.visuals, event.visual] }));
        break;
      case "questions":
        setAgentState(event.state);
        updateAgent(agentId, (e) => ({ ...e, status: "questions", questionSet: event.questionSet }));
        break;
      case "report":
        setAgentState(event.state);
        if (event.report.brief) setLatest({ report: event.report, idea: event.state.idea });
        updateAgent(agentId, (e) => ({ ...e, status: "done", report: event.report, saved: event.saved }));
        break;
      case "error":
        updateAgent(agentId, (e) => ({ ...e, status: "error", error: event.message }));
        break;
    }
  }

  async function run(input: ResearcherInput, state: ResearcherState | null, agentId: number) {
    lastRequest.current = { input, state, agentId };
    setLastAgentId(agentId);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let finished = false;

    try {
      const res = await fetch("/api/researcher", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, input }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        let message = text || `The server answered ${res.status}.`;
        try {
          message = JSON.parse(text).error ?? message;
        } catch {
          /* plain text */
        }
        throw new Error(message);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as ResearchEvent;
          if (event.type === "questions" || event.type === "report" || event.type === "error") finished = true;
          applyEvent(agentId, event);
        }
      }
      if (!finished) throw new Error("The connection closed before the Researcher finished.");
    } catch (err) {
      const message =
        (err as Error).name === "AbortError" ? "Stopped." : (err as Error).message || "Could not reach the Researcher.";
      updateAgent(agentId, (e) => ({ ...e, status: "error", error: message }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  function startRequest(input: Exclude<ResearcherInput, { kind: "answers" }>) {
    const text = input.text.trim();
    if (!text || busy) return;
    const agentId = newId();
    setEntries((prev) => [
      ...prev,
      { id: newId(), role: "user", kind: input.kind, text },
      { id: agentId, role: "agent", status: "working", thinking: "", activity: [], liveText: "", visuals: [] },
    ]);
    setDraft("");
    void run({ ...input, text }, agentState, agentId);
  }

  function answer(agentId: number, answers: string[]) {
    if (busy) return;
    updateAgent(agentId, (e) => ({ ...e, status: "working", liveText: "" }));
    void run({ kind: "answers", answers }, agentState, agentId);
  }

  function retry() {
    const last = lastRequest.current;
    if (!last || busy) return;
    updateAgent(last.agentId, (e) => ({
      ...e,
      status: "working",
      error: undefined,
      liveText: "",
      thinking: "",
      activity: [],
      visuals: [],
    }));
    void run(last.input, last.state, last.agentId);
  }

  const awaitingAnswers = entries.some((e) => e.role === "agent" && e.status === "questions");

  return (
    <div className="rs-page">
      <header className="rs-header">
        <p className="rs-brand">
          Startage <span>Researcher</span>
        </p>
        <ol className="rs-pipeline" aria-label="The three agents">
          <li aria-current="step">
            <strong>Researcher</strong> finds the facts
          </li>
          <li>
            <strong>Critic</strong> tests the idea
          </li>
          <li>
            <strong>Strategist</strong> plans the launch
          </li>
        </ol>
      </header>

      <div className={`rs-layout${latest ? " rs-layout-split" : ""}`}>
        <main className="rs-main">
          {!started && (
            <section className="rs-intro">
              <h1>What business do you want to start?</h1>
              <p>
                Describe the idea in a sentence or two. Say where it is, who it is for, and your budget if you know them. The
                Researcher checks the facts on the web, asks if anything important is missing, and explains what it finds.
              </p>
            </section>
          )}

          <div className="rs-thread">
            {entries.map((entry) =>
              entry.role === "user" ? (
                <div key={entry.id} className={`rs-user rs-user-${entry.kind}`}>
                  <p className="rs-user-label">
                    {entry.kind === "idea" ? "Your idea" : entry.kind === "twist" ? "What changed" : "You asked"}
                  </p>
                  <p>{entry.text}</p>
                </div>
              ) : (
                <AgentBlock
                  key={entry.id}
                  entry={entry}
                  busy={busy}
                  canRetry={entry.id === lastAgentId}
                  onAnswer={answer}
                  onRetry={retry}
                />
              )
            )}
          </div>

          {!awaitingAnswers && (
            <form
              className="rs-composer"
              onSubmit={(e) => {
                e.preventDefault();
                startRequest({ kind: hasConversation ? "reply" : "idea", text: draft });
              }}
            >
              <label htmlFor="rs-draft" className="rs-visually-hidden">
                {started ? "Ask a follow-up or report a change" : "Your business idea"}
              </label>
              <textarea
                id="rs-draft"
                rows={started ? 2 : 4}
                value={draft}
                disabled={busy}
                placeholder={
                  started
                    ? "Ask a follow-up question, or describe something that changed"
                    : "Example: A mobile car detailing subscription for apartment complexes in Memphis, TN. Budget about $3,000."
                }
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                }}
              />
              <div className="rs-actions">
                {busy ? (
                  <button type="button" className="rs-button rs-button-quiet" onClick={() => abort.current?.abort()}>
                    Stop
                  </button>
                ) : started ? (
                  <>
                    <button type="submit" className="rs-button" disabled={!draft.trim()}>
                      Ask follow-up
                    </button>
                    <button
                      type="button"
                      className="rs-button rs-button-quiet"
                      disabled={!draft.trim() || !hasConversation}
                      onClick={() => startRequest({ kind: "twist", text: draft })}
                    >
                      Report a change
                    </button>
                  </>
                ) : (
                  <button type="submit" className="rs-button" disabled={!draft.trim()}>
                    Research this idea
                  </button>
                )}
              </div>
              {!started && (
                <div className="rs-examples" role="group" aria-label="Example ideas">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} type="button" className="rs-chip" onClick={() => setDraft(ex)}>
                      {ex}
                    </button>
                  ))}
                </div>
              )}
              {started && !busy && (
                <p className="rs-note">
                  Use “Report a change” when a fact is different now, like a smaller budget or a new competitor. The Researcher
                  updates only what is affected.
                </p>
              )}
            </form>
          )}
        </main>

        {latest && (
          <aside className="rs-side" aria-label="Research brief">
            <h2>Research brief</h2>
            <p className="rs-note">
              Numbered facts, the same kind the Critic and Strategist cite in the full flow. <span className="rs-highlight">Highlighted</span> facts are estimates.
            </p>
            <FactsLedger facts={latest.report.facts} />
            <div className="rs-downloads">
              <button
                type="button"
                className="rs-button"
                onClick={() => download("research-brief.md", latest.report.brief ?? "", "text/markdown")}
              >
                Download brief
              </button>
              <button
                type="button"
                className="rs-button rs-button-quiet"
                onClick={() =>
                  download("research-brief.json", JSON.stringify(briefJson(latest.report, latest.idea), null, 2), "application/json")
                }
              >
                Download as JSON
              </button>
            </div>
            {latest.report.sources.length > 0 && (
              <>
                <h3>Sources</h3>
                <ul className="rs-sources">
                  {latest.report.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function AgentBlock({
  entry,
  busy,
  canRetry,
  onAnswer,
  onRetry,
}: {
  entry: AgentEntry;
  busy: boolean;
  canRetry: boolean;
  onAnswer: (agentId: number, answers: string[]) => void;
  onRetry: () => void;
}) {
  const working = entry.status === "working";
  const report = entry.report;
  const savedBrief = entry.saved?.find((p) => p.endsWith("latest-brief.md"));
  const reportParts = report ? splitAfterVisualsSection(report.ownerReport || report.fullText) : ["", ""];
  const visuals =
    entry.visuals.length > 0 ? (
      <div className="rs-visuals">
        {entry.visuals.map((v) => (
          <VisualFrame key={v.id} visual={v} />
        ))}
      </div>
    ) : null;

  return (
    <article className="rs-agent" aria-busy={working}>
      {working && (
        <p className="rs-working" role="status">
          <span className="rs-pulse" aria-hidden="true" />
          {entry.activity.length ? entry.activity[entry.activity.length - 1].text : "Reading your idea"}
        </p>
      )}

      <ActivityList items={entry.activity} />

      {entry.thinking && (
        <details className="rs-thinking">
          <summary>{working ? "Thinking" : "How it thought about this"}</summary>
          <p>{entry.thinking}</p>
        </details>
      )}

      {entry.status === "questions" && entry.questionSet && (
        <>
          {entry.liveText.trim() && <Markdown source={entry.liveText} className="rs-prose" />}
          <QuestionForm questionSet={entry.questionSet} disabled={busy} onSubmit={(answers) => onAnswer(entry.id, answers)} />
        </>
      )}

      {working && entry.liveText && (
        <Markdown source={entry.liveText.split(/^#{1,3}\s*RESEARCH BRIEF/im)[0]} className="rs-prose rs-prose-live" />
      )}

      {!report && visuals}

      {report && (
        <>
          <Markdown source={reportParts[0]} className="rs-prose" />
          {visuals}
          {reportParts[1] && <Markdown source={reportParts[1]} className="rs-prose" />}
          {report.brief && (
            <details className="rs-brief">
              <summary>Research brief (full text)</summary>
              <Markdown source={report.brief} className="rs-prose rs-prose-small" />
            </details>
          )}
          {savedBrief && <p className="rs-note">Saved at {savedBrief}</p>}
        </>
      )}

      {entry.status === "error" && (
        <div className="rs-error" role="alert">
          <p>{entry.error}</p>
          {canRetry && (
            <button type="button" className="rs-button rs-button-quiet" onClick={onRetry} disabled={busy}>
              Try again
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** Split the report right after its "Your visuals" section, so the visuals appear there. */
function splitAfterVisualsSection(text: string): [string, string] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{1,4}\s*your visuals\b/i.test(l));
  if (start === -1) return [text, ""];
  const level = lines[start].match(/^#+/)![0].length;
  const next = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  if (next === -1) return [text, ""];
  return [lines.slice(0, next).join("\n"), lines.slice(next).join("\n")];
}
