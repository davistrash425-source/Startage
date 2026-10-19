// Reads the Researcher's final answer: splits Part 1 from the RESEARCH BRIEF,
// parses the numbered facts, and collects cited sources.
// No Node-only imports, so the web page can use parseFacts() too.

import type { MessageParam } from "./client/types";
import type { Fact, ResearchReport, Source } from "./types";

/**
 * Build the report from the messages of the current request.
 * Text written before an ask_user call is just a lead-in, so it is dropped.
 */
export function extractReport(turnMessages: MessageParam[], visuals: ResearchReport["visuals"]): ResearchReport {
  let parts: string[] = [];
  const sources = new Map<string, string>();

  for (const msg of turnMessages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "ask_user") parts = [];
      if (block.type === "text") {
        parts.push(String(block.text ?? ""));
        const citations = Array.isArray(block.citations) ? (block.citations as Array<{ url?: string; title?: string }>) : [];
        for (const c of citations) {
          if (c.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
        }
      }
    }
  }

  const fullText = parts.join("").trim();
  const split = fullText.search(/^#{1,3}\s*RESEARCH BRIEF\b/im);
  const ownerReport = split === -1 ? fullText : fullText.slice(0, split).trim();
  const brief = split === -1 ? null : fullText.slice(split).trim();

  return {
    fullText,
    ownerReport: ownerReport.replace(/^\s*PART 1[^\n]*\n/i, "").replace(/\n\s*PART 2[^\n]*\s*$/i, "").trim(),
    brief,
    facts: brief ? parseFacts(brief) : [],
    sources: [...sources].map(([url, title]): Source => ({ title, url })),
    visuals,
  };
}

/** Turn "- F1 | fact | VERIFIED | Confidence: HIGH | Source: ... | formula" lines into objects. */
export function parseFacts(brief: string): Fact[] {
  const facts: Fact[] = [];
  for (const line of brief.split("\n")) {
    const m = line.match(/^\s*[-*]?\s*\**(F\d+)\**\s*(?:\(([A-Z]+)\))?\s*\|(.*)$/);
    if (!m) continue;
    const cells = m[3].split("|").map((c) => c.trim());
    const find = (re: RegExp) => cells.find((c) => re.test(c)) ?? "";
    const type = find(/^\**(VERIFIED|ESTIMATED)\**$/i).replace(/\*/g, "").toUpperCase();
    facts.push({
      id: m[1],
      status: m[2] ?? null,
      fact: cells[0] ?? "",
      type: type === "VERIFIED" || type === "ESTIMATED" ? type : null,
      confidence: find(/confidence/i).replace(/.*confidence:\s*/i, "").replace(/\*/g, "").toUpperCase() || null,
      source: find(/^source/i).replace(/^source:\s*/i, "") || null,
      formula: cells.slice(4).join(" | ") || null,
    });
  }
  return facts;
}

/** The brief as JSON. Used for latest-brief.json and the web page's download button. */
export function briefJson(report: ResearchReport, idea: string | null) {
  return {
    agent: "researcher",
    createdAt: new Date().toISOString(),
    idea,
    facts: report.facts,
    sources: report.sources,
    visuals: report.visuals.map((v) => ({ title: v.title, file: v.file })),
    brief: report.brief,
  };
}
