// Settings for every agent, read from .env.local (see .env.example).
// Read at call time so changes to .env.local apply after a restart of `npm run dev`.

export function getConfig() {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
    effort: process.env.RESEARCH_EFFORT || "high",
    maxTokens: Number(process.env.MAX_TOKENS || 32000),
    maxSearches: Number(process.env.MAX_SEARCHES || 20),
    disableSearch: process.env.DISABLE_SEARCH === "true",
    showThinking: process.env.SHOW_THINKING !== "false",
    outputDir: process.env.OUTPUT_DIR || "output",
  };
}

export type AgentConfig = ReturnType<typeof getConfig>;
