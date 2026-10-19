// Saves the Researcher's work to disk (server and terminal only).
//
//   output/researcher/latest-brief.md    <- the brief as text
//   output/researcher/latest-brief.json  <- same brief, facts parsed into objects
//   output/researcher/latest-report.md   <- the full answer
//   output/researcher/report-<time>.md   <- a copy of every run
//   output/researcher/visuals/*.html     <- charts, tables, profiles
//
// Saving is best-effort: on hosts with a read-only disk (like Vercel) it is skipped.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./client/config";
import { briefJson } from "./report";
import type { ResearchReport } from "./types";

const dir = () => path.join(getConfig().outputDir, "researcher");

export async function saveVisualFile(slug: string, html: string): Promise<string | undefined> {
  try {
    const visualsDir = path.join(dir(), "visuals");
    await mkdir(visualsDir, { recursive: true });
    const file = path.join(visualsDir, `${slug}.html`);
    await writeFile(file, html, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

/** Returns the paths that were written. */
export async function saveReport(report: ResearchReport, idea: string | null): Promise<string[]> {
  try {
    await mkdir(dir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const sourceList = report.sources.length
      ? `\n\n---\n### Sources cited\n${report.sources.map((s) => `- [${s.title}](${s.url})`).join("\n")}\n`
      : "";
    const visualList = report.visuals.length
      ? `\n### Visuals\n${report.visuals.map((v) => `- ${v.title}${v.file ? `: ${v.file}` : ""}`).join("\n")}\n`
      : "";
    const reportMd = `${report.fullText}${sourceList}${visualList}`;

    const written = [path.join(dir(), `report-${stamp}.md`), path.join(dir(), "latest-report.md")];
    for (const file of written) await writeFile(file, reportMd, "utf8");

    // Only replace the saved brief when this answer contained a new brief.
    if (report.brief) {
      const md = path.join(dir(), "latest-brief.md");
      const json = path.join(dir(), "latest-brief.json");
      await writeFile(md, report.brief, "utf8");
      await writeFile(json, JSON.stringify(briefJson(report, idea), null, 2), "utf8");
      written.push(md, json);
    }
    return written;
  } catch {
    return [];
  }
}
