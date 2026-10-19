# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev`: dev server at http://localhost:3000
- `npm run build`: production build (also the main type check, since there is no separate `tsc` script)
- `npm run lint`: ESLint (flat config, `eslint-config-next` core-web-vitals + typescript)

No test runner is set up yet.

## Stack notes

- Next.js 16.4.2 App Router, React 19.3, TypeScript strict, Tailwind CSS v4. Path alias `@/*` maps to the repo root.
- `next.config.ts` turns on `cacheComponents`, `partialPrefetching` and `experimental.agentFeedback`. Tailwind runs through the `@tailwindcss/turbopack` loader for `*.css`, not PostCSS. Check the bundled docs in `node_modules/next/dist/docs/` before relying on older Next.js caching or data-fetching patterns.

## What this project is

This is a team entry for the Aardvark "3-Agent Challenge", Startup Squad track. Three specialized agents work in sequence: a **Researcher** (facts, sources, unknowns), a **Strategist** (a launch plan built from the research) and a **Critic** (gaps, risks, fixes). They must pass structured output to each other, at least one agent must use a tool or external data, and the system must revise its result when a key fact changes mid-run (the "twist"). The brief and build guide are PDFs in `../instructions/`, outside this repo.

The app helps founders vet a startup idea and, if they choose to go ahead, turns it into a plan of action. The repo is still the Create Next App starter. The flow below is the agreed design.

## App flow

1. **Idea input.** The user enters their business idea, plus optional context: target customer, location, budget, timeline.
2. **Researcher** (has a web search tool; this meets the challenge's tool requirement). Researches the market, customers, competitors and trends. Returns structured JSON: `facts` (each with an `id`, `source` and `confidence`), `competitors`, `marketSummary` and `unknowns`.
3. **Critic, pass 1 (idea review).** Receives the idea and the research. Challenges weak evidence and assumptions, and lists risks. Returns a verdict (`promising` / `risky` / `weak`), its reasons, and the questions the research couldn't answer.
4. **Viability report.** The UI shows the research and the critique as a readable summary: verdict, key findings, top risks, unknowns and sources. The UI renders the structured JSON directly; no extra agent call is needed.
5. **Decision gate.** The user picks one of:
   - **Continue.** Go to step 6.
   - **Revise idea.** Edit the idea and rerun from step 2.
   - **Stop.** The Critic suggests 2–3 pivots based on the risks it found. The user can pick one, which reruns from step 2, or end with the report.
6. **Strategist.** Receives the idea, the research and the critique. Returns a launch plan: positioning, target customer, MVP, pricing, launch steps with timeframes, rough budget, success metrics, and a mitigation for each risk the Critic raised. Each step lists the research fact ids it relies on in `basedOn`. Gaps in the research are stated, not made up.
7. **Critic, pass 2 (plan check).** Checks that the plan addresses the pass-1 risks and doesn't make unsupported claims. Returns pass or fail with issues. On fail, the Strategist revises once and the Critic checks again.
8. **Final plan.** Shown together with an agent activity log, so each handoff between agents is visible.

**Twist / fact update:** at any point after research, the user can submit a corrected fact. The fact goes to the Researcher first, which updates the research. The Critic then re-reviews it. If a plan already exists, the Strategist revises it and returns `changesFromPrevious`, and the Critic checks it again. The UI shows what changed. The update never goes straight to the Strategist, because the challenge forbids having one agent rewrite the answer.

## Code layout

Because the decision gate is a human step, the workflow is split across separate server calls. The client (`app/page.tsx`) keeps the full `RunState` and posts it back with each request.

- `app/api/research/route.ts`: `POST {idea, context}`. Runs steps 2–3.
- `app/api/plan/route.ts`: `POST RunState`. Runs steps 6–7.
- `app/api/update-fact/route.ts`: `POST {state, fact}`. Runs the twist flow.
- `lib/agent-team.ts`: orchestration. It controls the order of agent calls, the handoffs, the one-retry plan revision and the run log. The routes are thin wrappers around it.
- `lib/agents/types.ts`: shared Zod schemas and types for every handoff. They double as OpenAI structured-output formats, so every field must be required (use `.nullable()`, not `.optional()`).
- `lib/agents/researcher.ts` → `runResearcher()` (uses the `web_search` tool), `critic.ts` → `reviewIdea()` and `reviewPlan()`, `strategist.ts` → `runStrategist()`. Each file holds its agent's prompt, its OpenAI call and a mock.
- `lib/openai.ts`: the shared client and `MODEL` (from `OPENAI_MODEL`). `mocksEnabled()` is true when `OPENAI_API_KEY` is unset or `MOCK_AGENTS=true`. In that case every agent returns its mock, so the whole flow runs without a key.

## Team ownership

Each agent file belongs to one person, who works on their own branch: researcher.ts (`research-branch`), critic.ts, and strategist.ts (`strategist-branch`). Change `types.ts`, `agent-team.ts`, the routes or `page.tsx` only with the team's agreement, because those changes cause merge conflicts for everyone.

## Setup

Copy `.env.example` to `.env.local` and set `OPENAI_API_KEY`. Without a key, the app runs on mock data.

## Workflow

Each agent's owner works on their own branch (for example `research-branch` and `strategist-branch`) and merges into `main`. The remote is https://github.com/davistrash425-source/Startage.
