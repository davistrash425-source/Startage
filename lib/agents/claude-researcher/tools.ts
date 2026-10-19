// Researcher tools: definitions (what the model sees) and handlers (what our code does).

import { pauseForUser, type ToolHandler } from "./client/agent-loop";
import { getConfig } from "./client/config";
import type { ToolDefinition } from "./client/types";
import { interpolate } from "./interpolate";
import { saveVisualFile } from "./save";
import { MAX_QUESTIONS, type Question, type QuestionSet, type Visual } from "./types";
import { renderVisualHtml, validateVisual } from "./visual-html";

// ---------- Definitions ----------

export function webSearchTool(): ToolDefinition {
  return {
    type: "web_search_20250305", // run by Anthropic's servers; results come back with citations
    name: "web_search",
    max_uses: getConfig().maxSearches,
  };
}

const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    "Ask the business owner clarifying questions and wait for their answers. Use it before researching when a missing detail " +
    "(location, target customer, what is sold, how it makes money) would change what you search for. " +
    `Ask at most ${MAX_QUESTIONS} questions per request, all in one call. Give each question a one-sentence reason and 2-3 example answers.`,
  input_schema: {
    type: "object",
    properties: {
      intro: { type: "string", description: "One friendly sentence telling the owner why you are asking before you start." },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, in plain language." },
            why: { type: "string", description: "One sentence on how the answer changes the research." },
            examples: { type: "array", items: { type: "string" }, maxItems: 3, description: "2-3 short example answers." },
          },
          required: ["question", "why"],
        },
      },
    },
    required: ["questions"],
  },
};

export const interpolateTool: ToolDefinition = {
  name: "interpolate_data",
  description:
    "Calculate an estimate from related data when the exact number is not published. Methods: " +
    "'scale' (base_value x ratio_low..ratio_high, e.g. national market x city population share), " +
    "'linear' (estimate y at target_x from known points, e.g. a missing year), " +
    "'summarize' (range, median and mean of values, e.g. competitor prices), " +
    "'project_growth' (start_value grown at growth_rate_low..growth_rate_high per year for years). " +
    "Returns a low-high range, a one-line formula, and the maximum confidence the estimate may be given.",
  input_schema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["scale", "linear", "summarize", "project_growth"] },
      label: { type: "string", description: "What is being estimated, e.g. 'Memphis car detailing market'." },
      unit: { type: "string", description: "Unit for the result, e.g. 'USD/year' or 'customers'." },
      base_value: { type: "number", description: "scale: the known number to scale." },
      ratio_low: { type: "number", description: "scale: low ratio, e.g. 0.004 for 0.4%." },
      ratio_high: { type: "number", description: "scale: high ratio (optional)." },
      points: {
        type: "array",
        description: "linear: known data points.",
        items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
      },
      target_x: { type: "number", description: "linear: the x value to estimate, e.g. a year." },
      uncertainty_pct: { type: "number", description: "linear: +/- percent band (default 10, or 25 if extrapolating)." },
      values: { type: "array", items: { type: "number" }, description: "summarize: the numbers to summarize." },
      start_value: { type: "number", description: "project_growth: starting value." },
      growth_rate_low: { type: "number", description: "project_growth: low annual rate as a decimal, e.g. 0.04." },
      growth_rate_high: { type: "number", description: "project_growth: high annual rate (optional)." },
      years: { type: "number", description: "project_growth: number of years." },
    },
    required: ["method", "label"],
  },
};

const createVisualTool: ToolDefinition = {
  name: "create_visual",
  description:
    "Show the owner one visual. Types: bar_chart, line_chart (fill 'chart'), table (fill 'table'), customer_profile (fill 'profile'). " +
    "One main point per visual. Mark estimated data so it is drawn differently, and list sources.",
  input_schema: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Short kebab-case name, e.g. 'competitor-prices'." },
      title: { type: "string" },
      key_takeaway: { type: "string", description: "One sentence: the main point of this visual." },
      visual_type: { type: "string", enum: ["bar_chart", "line_chart", "table", "customer_profile"] },
      chart: {
        type: "object",
        properties: {
          labels: { type: "array", items: { type: "string" }, description: "X-axis labels / categories." },
          y_axis_label: { type: "string" },
          series: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                values: { type: "array", items: { type: ["number", "null"] }, description: "One value per label; null for unknown." },
                estimated: { type: "boolean", description: "true if these values are estimates." },
              },
              required: ["name", "values"],
            },
          },
        },
      },
      table: {
        type: "object",
        properties: {
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          estimated_row_indexes: { type: "array", items: { type: "integer" }, description: "0-based rows that contain estimates." },
        },
      },
      profile: {
        type: "object",
        properties: {
          name: { type: "string", description: "Persona name, e.g. 'Busy apartment commuter'." },
          summary: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { type: "string" }, estimated: { type: "boolean" } },
              required: ["label", "value"],
            },
          },
        },
      },
      contains_estimates: { type: "boolean" },
      notes: { type: "array", items: { type: "string" } },
      sources: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title"] },
      },
    },
    required: ["filename", "title", "visual_type"],
  },
};

export function researcherTools(): ToolDefinition[] {
  // DISABLE_SEARCH=true removes web search so you can demo the "tool fails" fallback.
  const tools = [askUserTool, interpolateTool, createVisualTool];
  return getConfig().disableSearch ? tools : [webSearchTool(), ...tools];
}

// ---------- Handlers ----------

export interface ToolContext {
  /** Questions already asked in this request (the limit is MAX_QUESTIONS). */
  questionsAsked: number;
  onVisual: (visual: Visual) => void;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "visual";

export function researcherHandlers(ctx: ToolContext): Record<string, ToolHandler> {
  return {
    ask_user(input) {
      const remaining = MAX_QUESTIONS - ctx.questionsAsked;
      if (remaining <= 0) {
        return `Question limit reached (${MAX_QUESTIONS} per request). Do not ask more. Continue with reasonable defaults and state which ones you chose.`;
      }
      const all = (Array.isArray(input.questions) ? input.questions : []) as Question[];
      const questions = all.filter((q) => q && q.question).slice(0, remaining);
      if (questions.length === 0) return "No valid questions were provided. Continue with reasonable defaults.";

      ctx.questionsAsked += questions.length;
      const questionSet: QuestionSet = {
        intro: typeof input.intro === "string" ? input.intro : undefined,
        questions,
        dropped: all.length - questions.length,
      };
      return pauseForUser(questionSet); // the app shows the questions and resumes with the answers
    },

    interpolate_data(input) {
      return interpolate(input);
    },

    async create_visual(input) {
      const spec = validateVisual(input);
      const html = renderVisualHtml(spec, new Date().toLocaleString("en-US"));
      const slug = slugify(String(spec.filename || spec.title));
      const file = await saveVisualFile(slug, html);
      ctx.onVisual({ id: `${slug}-${Date.now().toString(36)}`, title: spec.title, html, file });
      return `Shown to the owner: "${spec.title}".${file ? ` Saved to ${file}.` : ""}`;
    },
  };
}

/** Turn the owner's answers into the ask_user tool result. */
export function formatAnswers(questionSet: QuestionSet, answers: string[]): string {
  const lines = questionSet.questions.map((q, i) => {
    const a = (answers[i] ?? "").trim();
    return `Q${i + 1}: ${q.question}\nA${i + 1}: ${a || "(skipped - choose a reasonable default and say which one you chose)"}`;
  });
  if (questionSet.dropped > 0) {
    lines.push(`(Only ${questionSet.questions.length} questions were asked because of the ${MAX_QUESTIONS}-question limit.)`);
  }
  return lines.join("\n\n");
}
