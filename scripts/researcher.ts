// Chat with the Researcher in the VS Code terminal:  npm run researcher
// Same agent as the /research page, just without the browser.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getConfig } from "../lib/agents/claude-researcher/client/config";
import { runResearcherStep, type ResearcherHooks } from "../lib/agents/claude-researcher/session";
import { emptyResearcherState, type QuestionSet, type ResearcherInput, type StepResult } from "../lib/agents/claude-researcher/types";

const color = (code: string) => (s: string) => (output.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = color("2");
const bold = color("1");
const cyan = color("36");
const yellow = color("33");
const green = color("32");

let lastKind: "thinking" | "text" | "status" | null = null;

function status(line: string) {
  if (lastKind === "text" || lastKind === "thinking") output.write("\n");
  output.write(`${line}\n`);
  lastKind = "status";
}

const hooks: ResearcherHooks = {
  onThinkingStart: () => {
    if (getConfig().showThinking) status(dim("🧠 Thinking..."));
  },
  onThinking: (text) => {
    output.write(dim(text));
    lastKind = "thinking";
  },
  onText: (text) => {
    if (lastKind !== "text") output.write("\n");
    output.write(text);
    lastKind = "text";
  },
  onToolCall: ({ name, input: toolInput }) => {
    if (name === "web_search") status(cyan(`🔎 Searching: ${String(toolInput.query ?? "")}`));
    else if (name === "interpolate_data") status(cyan(`🧮 Estimating: ${String(toolInput.label ?? "")}`));
    else if (name === "create_visual") status(cyan(`📊 Building visual: ${String(toolInput.title ?? "")}`));
  },
  onSearchError: (code) => status(yellow(`⚠️  Search problem: ${code}`)),
  onWarning: (message) => status(yellow(`⚠️  ${message}`)),
  onVisual: (visual) => {
    if (visual.file) status(green(`   Saved visual: ${visual.file}`));
  },
};

async function askQuestions(rl: readline.Interface, set: QuestionSet): Promise<string[]> {
  status("");
  status(bold(yellow("❓ The Researcher has some questions")));
  if (set.intro) status(set.intro);
  status(dim("Press Enter to skip a question.\n"));
  const answers: string[] = [];
  for (const [i, q] of set.questions.entries()) {
    status(bold(`${i + 1}. ${q.question}`));
    if (q.why) status(dim(`   Why: ${q.why}`));
    if (q.examples?.length) status(dim(`   e.g. ${q.examples.join(" / ")}`));
    answers.push(await rl.question("   > "));
    lastKind = "status";
  }
  status(dim("\nThanks! Researching now...\n"));
  return answers;
}

function printSummary(result: Extract<StepResult, { kind: "report" }>, saved: string[]) {
  const { report } = result;
  status("");
  status(green("─".repeat(60)));
  if (report.visuals.length) {
    status(bold("📊 Visuals (open in a browser):"));
    for (const v of report.visuals) status(`   ${v.title}: ${v.file ?? "(not saved)"}`);
  }
  if (saved.length) {
    status(bold("📁 Saved:"));
    for (const file of saved) status(`   ${file}`);
  }
  if (report.brief) status(dim(`   ${report.facts.length} facts in the brief, ${report.sources.length} sources cited`));
  status(green("─".repeat(60)));
}

async function main() {
  const config = getConfig();
  if (!config.apiKey) {
    console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env.local and add your key.");
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  status(bold("\n🚀 Startage — Researcher agent"));
  status(dim(`Model: ${config.model}, effort: ${config.effort}, up to ${config.maxSearches} searches per request\n`));

  let state = emptyResearcherState();

  // Runs one request, answering questions as many times as the agent asks.
  async function run(first: ResearcherInput) {
    let next: ResearcherInput = first;
    while (true) {
      const step = await runResearcherStep(state, next, hooks);
      state = step.state;
      if (step.result.kind === "questions") {
        next = { kind: "answers", answers: await askQuestions(rl, step.result.questionSet) };
        continue;
      }
      printSummary(step.result, step.saved);
      return;
    }
  }

  let idea = "";
  while (!idea.trim()) {
    idea = await rl.question(bold("Describe the business idea (location, customer and budget help):\n> "));
  }
  try {
    await run({ kind: "idea", text: idea });
  } catch (err) {
    status(yellow(`Error: ${(err as Error).message}`));
  }

  while (true) {
    const line = (await rl.question(bold("\nFollow-up question, 'twist: <what changed>', or 'exit'\n> "))).trim();
    if (!line) continue;
    if (/^(exit|quit)$/i.test(line)) break;
    const twist = line.match(/^twist:\s*(.+)$/i);
    try {
      await run(twist ? { kind: "twist", text: twist[1] } : { kind: "reply", text: line });
    } catch (err) {
      status(yellow(`Error: ${(err as Error).message}`));
    }
  }
  rl.close();
}

main();
