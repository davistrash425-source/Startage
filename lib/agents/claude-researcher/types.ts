// Researcher types. This file has no Node-only imports, so the web page can use it too.

import type { MessageParam, ToolResultBlock } from "./client/types";

export const MAX_QUESTIONS = 5;

export interface Question {
  question: string;
  why?: string;
  examples?: string[];
}

export interface QuestionSet {
  intro?: string;
  questions: Question[];
  /** How many extra questions were cut by the 5-question limit. */
  dropped: number;
}

export interface Visual {
  id: string;
  title: string;
  html: string;
  /** Where it was saved on disk, if saving worked. */
  file?: string;
}

export interface Fact {
  id: string;
  /** REVISED or REMOVED after a twist. */
  status: string | null;
  fact: string;
  type: "VERIFIED" | "ESTIMATED" | null;
  confidence: string | null;
  source: string | null;
  formula: string | null;
}

export interface Source {
  title: string;
  url: string;
}

export interface ResearchReport {
  fullText: string;
  /** Part 1, written for the owner. */
  ownerReport: string;
  /** Part 2, the RESEARCH BRIEF (null if this answer had none). */
  brief: string | null;
  facts: Fact[];
  sources: Source[];
  visuals: Array<{ id: string; title: string; file?: string }>;
}

/**
 * Everything needed to continue a research conversation.
 * The web page keeps this and sends it back with each request.
 */
export interface ResearcherState {
  messages: MessageParam[];
  idea: string | null;
  /** Index in messages where the current request began. */
  turnStart: number;
  questionsAsked: number;
  visuals: Array<{ id: string; title: string; file?: string }>;
  pending: null | {
    toolUseId: string;
    questionSet: QuestionSet;
    finishedResults: ToolResultBlock[];
  };
}

export type ResearcherInput =
  | { kind: "idea"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "twist"; text: string }
  | { kind: "answers"; answers: string[] };

export type StepResult = { kind: "questions"; questionSet: QuestionSet } | { kind: "report"; report: ResearchReport };

/** Events streamed from the API route to the page, one JSON object per line. */
export type ResearchEvent =
  | { type: "thinking_start" }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "activity"; icon: "search" | "estimate" | "visual" | "warning"; text: string }
  | { type: "visual"; visual: Visual }
  | { type: "questions"; questionSet: QuestionSet; state: ResearcherState }
  | { type: "report"; report: ResearchReport; state: ResearcherState; saved: string[] }
  | { type: "error"; message: string };

export function emptyResearcherState(): ResearcherState {
  return { messages: [], idea: null, turnStart: 0, questionsAsked: 0, visuals: [], pending: null };
}
