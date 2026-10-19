import OpenAI from "openai";

// Server-only. Never import this from a client component.

export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

// With no API key, every agent returns its mock output so the whole flow
// still runs. Set MOCK_AGENTS=true to force mocks even with a key.
export function mocksEnabled(): boolean {
  return !process.env.OPENAI_API_KEY || process.env.MOCK_AGENTS === "true";
}

let client: OpenAI | null = null;
export function openai(): OpenAI {
  client ??= new OpenAI();
  return client;
}
