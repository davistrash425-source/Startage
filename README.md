# Startage

Three AI agents that help a new business owner vet a startup idea and turn it into a launch plan:

```
Owner's idea ──► Researcher ──► Critic ──► (owner decides) ──► Strategist ──► Critic
                 facts + sources  verdict                       launch plan    plan check
```

The agreed flow, code layout and team rules are in [CLAUDE.md](CLAUDE.md). This README covers setup and the **Researcher**.

## Setup

1. Install [Node.js](https://nodejs.org) 20.6 or newer, then run `npm install`.
2. Copy `.env.example` to `.env.local` and add the keys you have (see [Keys and engines](#keys-and-engines)). With no keys at all the app still runs, on mock data.
3. `npm run dev`, then open http://localhost:3000.

## Keys and engines

Each agent decides for itself which engine to use:

| Agent | Engine |
|---|---|
| Critic, Strategist | OpenAI when `OPENAI_API_KEY` is set, otherwise mocks |
| Researcher | **Claude** when `ANTHROPIC_API_KEY` is set, else OpenAI when `OPENAI_API_KEY` is set, else mock |

`MOCK_AGENTS=true` forces every agent to its mock, even with keys set.

## The Researcher

Two ways to use it, both built on the same Claude engine in `lib/agents/claude-researcher/`:

**1. Inside the 3-agent flow (the main page at `/`).** `runResearcher()` in `lib/agents/researcher.ts` runs the Claude Researcher unattended: it can't ask questions or draw visuals, and it ends by calling a `submit_research` tool. That tool's input schema is generated from the team's `ResearchSchema`, so what the Critic and Strategist receive is validated against the shared contract (a bad submission is sent back to the model to fix). Code also enforces a few rules the prompt asks for:

- `source` is one real URL or `"unknown"`, never a name or prose.
- Estimates (claims starting `ESTIMATED:`) are never rated `high`.
- If web search is off (`DISABLE_SEARCH=true`), every model fact becomes `low` / `unknown` and `unknowns` says so. If search errors mid-run, `unknowns` says that instead.

On a fact update (the twist) it receives the previous research plus the owner's facts, keeps unchanged facts and their ids, and adds the owner's facts as `U1`, `U2`, ...

**2. Standalone, interactive (`/research` and `npm run researcher`).** The full experience: it asks up to 5 clarifying questions, shows visuals, streams its thinking, and writes a plain-language report with a learning list plus a numbered research brief. Run it when you want to explore an idea in depth or demo the Researcher alone.

### What it can do

| Skill | How it works | Code |
|---|---|---|
| Web search | Anthropic's `web_search` tool. Results come back with citations. | `claude-researcher/tools.ts` |
| Deep thinking | Adaptive thinking plus an effort level. The summary streams into the page. | `claude-researcher/client/anthropic.ts` |
| Interpolate data | `interpolate_data` tool: the model sends the numbers it found and our code does the math (scale, linear, summarize, project_growth). Estimates are capped at MEDIUM confidence. | `claude-researcher/interpolate.ts` |
| Visuals *(standalone only)* | `create_visual` tool: bar charts, line charts, tables, customer profiles, saved as HTML pages. | `claude-researcher/visual-html.ts` |
| Ask questions *(standalone only)* | `ask_user` tool: up to **5 questions** per request, enforced in code. | `claude-researcher/tools.ts` |
| Learning resources *(standalone only)* | 4-6 real articles from its searches, under "Learn more". | `claude-researcher/prompt.ts` |

To change how it behaves, edit `claude-researcher/prompt.ts`. It exports two prompts that share the same search, estimate and confidence rules: `RESEARCHER_PROMPT` (interactive) and `PIPELINE_PROMPT` (inside the flow).

### Using the standalone Researcher

- Type the idea. Where, who it's for, and the budget all help.
- If something important is missing, it asks up to 5 questions. You can skip any of them.
- You get the report, the visuals, and a research brief: numbered facts with confidence levels, estimates highlighted.
- **Ask follow-up** for questions, or **Report a change** for the twist (for example, "the budget is cut to $1,500"). It updates only the affected facts and marks them revised or removed. In the terminal: type a question, `twist: <what changed>`, or `exit`.

Each finished run is also saved under `output/researcher/` (git-ignored): `latest-brief.md`, `latest-brief.json` (facts parsed into objects), `latest-report.md`, a timestamped copy of every report, and `visuals/*.html`. These files are for reading and demos. The 3-agent flow does not use them; it passes data through `RunState`.

## Project layout (Researcher parts)

```
lib/agents/researcher.ts           the team's entry point: runResearcher() picks the engine
lib/agents/claude-researcher/      the Claude engine
  pipeline.ts                      unattended run → shared Research (used by the 3-agent flow)
  session.ts                       interactive run with questions (used by /research and the terminal)
  prompt.ts  tools.ts  interpolate.ts  visual-html.ts  report.ts  save.ts  types.ts
  client/                          Claude Messages API over fetch (no SDK): anthropic.ts, agent-loop.ts, config.ts
app/research/                      the /research page
app/api/researcher/route.ts        streams the interactive Researcher to that page
scripts/researcher.ts              the terminal version
```

Note the two routes: `/api/research` is the team's shared route (runs Researcher → Critic for the main page); `/api/researcher` is the standalone Researcher's streaming route.

## Settings (`.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Turns on the Claude Researcher |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model for the Claude Researcher |
| `RESEARCH_EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max` |
| `MAX_SEARCHES` | `20` | Web search cap per request |
| `DISABLE_SEARCH` | `false` | Removes web search, to demo the "tool fails" fallback |
| `MAX_TOKENS` | `32000` | Output cap (thinking + answer) |
| `SHOW_THINKING` | `true` | Stream the thinking summary (standalone) |
| `OUTPUT_DIR` | `output` | Where the standalone Researcher saves files |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | | Critic, Strategist, and the Researcher's fallback |
| `MOCK_AGENTS` | | `true` forces every agent to its mock |

**Cost and speed:** Sonnet 5.5 is $2 per million input tokens and $10 per million output tokens. Web search is $10 per 1,000 searches, and results count as input tokens. In the 3-agent flow the owner waits for the Researcher, so lower `RESEARCH_EFFORT` or `MAX_SEARCHES` for faster, cheaper runs.

## Demo tips for the twist

- On the main page, submit a corrected fact and show the research, critique and plan updating. In the standalone Researcher, click **Report a change** and show the ledger marking facts revised or removed.
- Set `DISABLE_SEARCH=true`, restart, and show facts coming back `low` with "search unavailable".

## Good to know

- The standalone conversation lives in the browser tab; refreshing starts over. The main page keeps its state in the tab too.
- Charts load Chart.js from a CDN. If it can't load, each chart shows its numbers as a table instead.
- Long research runs may hit serverless time limits on hosts like Vercel, and saving to `output/` is skipped on read-only disks. Run locally for demos.
