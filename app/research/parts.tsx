"use client";

import { useEffect, useRef, useState } from "react";
import type { Fact, QuestionSet, Visual } from "@/lib/agents/claude-researcher/types";

// ---------- Activity log ----------

export type ActivityIcon = "search" | "estimate" | "visual" | "warning";
export interface Activity {
  id: number;
  icon: ActivityIcon;
  text: string;
}

function Icon({ name }: { name: ActivityIcon }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true };
  switch (name) {
    case "search":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" strokeLinecap="round" />
        </svg>
      );
    case "estimate":
      return (
        <svg {...common}>
          <path d="M2.5 13.5 6 8l3 3 4.5-7" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2.2 2" />
        </svg>
      );
    case "visual":
      return (
        <svg {...common}>
          <path d="M3 13V8M8 13V3M13 13V6" strokeLinecap="round" />
        </svg>
      );
    case "warning":
      return (
        <svg {...common}>
          <path d="M8 2.5 14 13H2L8 2.5Z" strokeLinejoin="round" />
          <path d="M8 6.5v3M8 11.3v.2" strokeLinecap="round" />
        </svg>
      );
  }
}

export function ActivityList({ items }: { items: Activity[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="rs-activity" aria-label="What the Researcher did">
      {items.map((item) => (
        <li key={item.id} className={`rs-activity-item rs-activity-${item.icon}`}>
          <Icon name={item.icon} />
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- Visuals ----------

export function VisualFrame({ visual }: { visual: Visual }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; height?: number };
      if (data?.type === "visual-height" && typeof data.height === "number") {
        setHeight(Math.min(Math.max(data.height, 200), 1400));
      }
    };
    window.addEventListener("message", onMessage);
    // The frame may have loaded before this listener existed, so ask it for its height.
    frame.current?.contentWindow?.postMessage({ type: "visual-ping" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const openFullPage = () => {
    const url = URL.createObjectURL(new Blob([visual.html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <figure className="rs-visual">
      <iframe
        ref={frame}
        title={visual.title}
        srcDoc={visual.html}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        style={{ height }}
        onLoad={(e) => e.currentTarget.contentWindow?.postMessage({ type: "visual-ping" }, "*")}
      />
      <figcaption>
        <span>{visual.title}</span>
        <button type="button" className="rs-link-button" onClick={openFullPage}>
          Open full page
        </button>
      </figcaption>
    </figure>
  );
}

// ---------- Questions ----------

export function QuestionForm({
  questionSet,
  disabled,
  onSubmit,
}: {
  questionSet: QuestionSet;
  disabled: boolean;
  onSubmit: (answers: string[]) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => questionSet.questions.map(() => ""));
  const setAnswer = (i: number, value: string) => setAnswers((prev) => prev.map((a, n) => (n === i ? value : a)));

  return (
    <form
      className="rs-questions"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(answers);
      }}
    >
      <p className="rs-questions-intro">
        {questionSet.intro || "A few questions before I start, so the research fits your idea."}
      </p>
      <ol>
        {questionSet.questions.map((q, i) => (
          <li key={i}>
            <label htmlFor={`rs-q-${i}`} className="rs-question">
              {q.question}
            </label>
            {q.why && <p className="rs-question-why">{q.why}</p>}
            {q.examples && q.examples.length > 0 && (
              <div className="rs-examples" role="group" aria-label="Example answers">
                {q.examples.map((ex) => (
                  <button key={ex} type="button" className="rs-chip" disabled={disabled} onClick={() => setAnswer(i, ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            )}
            <textarea
              id={`rs-q-${i}`}
              rows={2}
              value={answers[i]}
              disabled={disabled}
              placeholder="Type your answer, pick an example, or leave blank"
              onChange={(e) => setAnswer(i, e.target.value)}
            />
          </li>
        ))}
      </ol>
      <div className="rs-actions">
        <button type="submit" className="rs-button" disabled={disabled}>
          Send answers
        </button>
        <button type="button" className="rs-button rs-button-quiet" disabled={disabled} onClick={() => onSubmit(answers.map(() => ""))}>
          Skip and let it choose
        </button>
      </div>
      {questionSet.dropped > 0 && (
        <p className="rs-note">The Researcher wanted to ask {questionSet.dropped} more, but it is limited to 5 questions.</p>
      )}
    </form>
  );
}

// ---------- Facts ledger ----------

const confidenceClass = (c: string | null) =>
  c?.startsWith("HIGH") ? "rs-conf-high" : c?.startsWith("MEDIUM") ? "rs-conf-medium" : c?.startsWith("LOW") ? "rs-conf-low" : "";

export function FactsLedger({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return <p className="rs-note">No numbered facts in this brief.</p>;
  return (
    <ol className="rs-ledger">
      {facts.map((f) => (
        <li key={`${f.id}-${f.status ?? ""}`} className={f.status === "REMOVED" ? "rs-fact-removed" : undefined}>
          <span className="rs-fact-id">{f.id}</span>
          <div className="rs-fact-body">
            <p>
              <span className={f.type === "ESTIMATED" ? "rs-highlight" : undefined}>{f.fact}</span>
            </p>
            <p className="rs-fact-meta">
              {f.confidence && <span className={`rs-conf ${confidenceClass(f.confidence)}`}>{f.confidence.toLowerCase()} confidence</span>}
              {f.type === "ESTIMATED" && <span>estimate</span>}
              {f.status && <span className="rs-fact-status">{f.status.toLowerCase()}</span>}
            </p>
            {f.formula && <p className="rs-fact-formula">{f.formula}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
