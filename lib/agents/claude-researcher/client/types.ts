// Types for the Claude Messages API client and agent loop used by the Researcher.

/** A content block from the Claude API. Kept loose so new block types pass through untouched. */
export type ContentBlock = { type: string; [key: string]: unknown };

export type MessageParam =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[] };

export interface ApiMessage {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: Record<string, unknown>;
}

export type ToolDefinition = Record<string, unknown>;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Live progress callbacks. Every one is optional. */
export interface AgentHooks {
  onThinkingStart?: () => void;
  onThinking?: (text: string) => void;
  onThinkingEnd?: () => void;
  onText?: (text: string) => void;
  /** server = true for tools Anthropic runs (web_search). */
  onToolCall?: (call: { name: string; input: Record<string, unknown>; server: boolean }) => void;
  onSearchError?: (errorCode: string) => void;
  onWarning?: (message: string) => void;
}
