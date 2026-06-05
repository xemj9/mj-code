import type {
  ExtractedAction,
  JsonObject,
  JsonValue,
  SystemPromptInput,
  ToolFeedbackPayload,
} from "../types/contracts.js";
import { buildAgentAttributionPolicyLine } from "./agent-branding.mjs";
import { getEffortLevel } from "./enhanced-ui.mjs";

export function buildSystemPrompt({
  tools,
  config,
  projectInstructions,
  nativeToolCalling = false,
  policyStack = null,
}: SystemPromptInput): string {
  const toolLines = tools
    .map((tool) =>
      [
        `- ${tool.name}`,
        tool.displayName && tool.displayName !== tool.name ? ` (${tool.displayName})` : "",
        tool.source ? ` [${tool.source}]` : "",
        `: ${tool.description}. Input: ${JSON.stringify(tool.inputSchema)}`,
      ].join("")
    )
    .join("\n");

  const effortLevel = getEffortLevel();
  const effortDescription: Record<string, string> = {
    low: "You are in LOW effort mode. Respond with minimal, concise answers. Skip detailed explanations unless explicitly requested. Prefer quick, direct responses.",
    medium: "You are in MEDIUM effort mode. Provide balanced responses with moderate detail. Include enough context to be helpful but avoid excessive elaboration.",
    high: "You are in HIGH effort mode. Provide thorough, detailed responses. Consider edge cases, provide comprehensive explanations, and verify your work carefully.",
    max: "You are in MAX effort mode. Provide maximum capability with deepest reasoning. Be exhaustive, consider all possibilities, provide the most thorough analysis possible, and double-check everything.",
  };

  const effectivePolicy = policyStack?.renderPromptSections?.() ??
    [
      nativeToolCalling
        ? [
            "You are MJ Code, a terminal coding agent.",
            `Current working directory: ${config.cwd}`,
            `Permission mode: ${config.permissionMode}`,
            `Approval policy: ${config.approvalPolicy}`,
            `Network mode: ${config.networkMode}`,
            `Effort level: ${effortLevel}`,
            effortDescription[effortLevel],
            "Use the provided tools whenever they are useful.",
            "IMPORTANT: Do not pretend to run tools or describe tool results in plain text. If a tool is needed, call it.",
            "Some tools may come from MCP servers. Treat them as external capabilities with real side effects and use them only when appropriate.",
            "",
            "## When to use web tools",
            "- When the user asks about current events, news, or recent information → use web_search",
            "- When the user asks to search the internet or look something up online → use web_search",
            "- When you need to verify a fact with a web source → use web_search or fetch_url",
            "- When the user provides a URL and asks about its content → use fetch_url or extract_content",
            "- When you need official documentation for an API or library → use web_search with query like 'official docs for X'",
            "",
            "Prefer apply_patch for surgical multi-line edits when possible.",
            "Use remember_memory only for durable facts, preferences, project conventions, or failure learnings that will matter later.",
            "Use search_memory before repeating work if prior context may exist.",
            "If you use web-derived sources in the final answer, cite them with markers like [S1] and only cite source ids returned by tools.",
            "Prefer small, verifiable steps and short status updates.",
            "If the user asks for a plan, include it in your final answer.",
            buildAgentAttributionPolicyLine(),
          ]
        : [
            "You are MJ Code, a terminal coding agent.",
            `Current working directory: ${config.cwd}`,
            `Permission mode: ${config.permissionMode}`,
            `Approval policy: ${config.approvalPolicy}`,
            `Network mode: ${config.networkMode}`,
            `Effort level: ${effortLevel}`,
            effortDescription[effortLevel],
            "You may inspect code, edit files, and run commands only through the available tools listed below.",
            "IMPORTANT: You MUST use tools to take actions. Never claim you ran a tool or describe what a tool would do — actually call the tool.",
            "Some tools may come from MCP servers. Treat them as external capabilities with real side effects and use them only when appropriate.",
            "",
            "## Response Format",
            "When you need to call a tool, respond with exactly one JSON object and nothing else:",
            '{"type":"tool_call","tool":"TOOL_NAME","input":{"param":"value"}}',
            "When you are done and have a final answer, respond with exactly one JSON object and nothing else:",
            '{"type":"final","content":"Your concise answer here."}',
            "",
            "## Critical Rules",
            "- Do NOT write plain text explanations when a tool call is needed. Call the tool.",
            "- Do NOT output multiple JSON objects. Exactly ONE per response.",
            "- Do NOT wrap the JSON in markdown code fences.",
            "- When the user asks to search the web, call web_search immediately.",
            "- When the user asks to read a file, call read_file immediately.",
            "- When the user asks to edit code, call apply_patch or replace_in_file immediately.",
            "- When the user asks to run a command, call run_shell immediately.",
            "- Only respond with {\"type\":\"final\",...} when you have fully answered the user's question.",
            "",
            "Prefer apply_patch for surgical multi-line edits when possible.",
            "Use remember_memory only for durable facts, preferences, project conventions, or failure learnings that will matter later.",
            "Use search_memory before repeating work if prior context may exist.",
            "Use web_search, fetch_url, or extract_content when the user needs current information, official docs, or verifiable links.",
            "If you use web-derived sources in the final answer, cite them with markers like [S1] and only cite source ids returned by tools.",
            "If the user asks for a plan, include the plan in the final content.",
            "Prefer small, verifiable steps.",
            buildAgentAttributionPolicyLine(),
          ],
      projectInstructions ? `Project instructions:\n${projectInstructions}` : null,
    ]
      .flat()
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");

  return [
    effectivePolicy,
    "Available tools:",
    toolLines,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function extractAction(text: string | null | undefined): ExtractedAction | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();

  // Strategy 1: Look for JSON inside code fences
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fencedMatches.reverse()) {
    const parsed = parseActionObject(match[1]);
    if (parsed) {
      return parsed;
    }
  }

  // Strategy 2: Look for the first complete JSON object in the text
  // This handles cases where the LLM outputs explanation text followed by JSON
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    // Find the matching closing brace
    const jsonCandidate = extractBalancedJson(trimmed, jsonStart);
    if (jsonCandidate) {
      const parsed = parseActionObject(jsonCandidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  // Strategy 3: Direct parse attempt on the full text
  return parseActionObject(trimmed);
}

/**
 * Extract a balanced JSON object from text starting at the given position.
 * Handles nested braces.
 */
function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Unbalanced — try the whole thing from start
  if (depth > 0) {
    return text.slice(start);
  }

  return null;
}

export function formatToolFeedback(
  toolName: string,
  payload: ToolFeedbackPayload,
): string {
  // For successful web searches, provide a cleaner, more actionable format
  if (payload.ok && toolName === "web_search") {
    const result = payload.result as Record<string, unknown> | undefined;
    const results = Array.isArray(result?.results) ? result.results as Array<Record<string, unknown>> : [];
    if (results.length > 0) {
      const summaryLines = results.slice(0, 6).map((r: Record<string, unknown>, i: number) => {
        const title = r.title ?? "No title";
        const url = r.url ?? "";
        const snippet = r.snippet ?? "";
        const sourceId = r.sourceId ?? "";
        const citation = sourceId ? ` [S${i + 1}]` : "";
        return `${i + 1}. ${title}${citation}\n   ${url}\n   ${snippet}`;
      });
      return [
        `Tool result for "web_search": ${results.length} result(s) found.`,
        summaryLines.join("\n"),
        "",
        "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
      ].join("\n");
    }
  }

  // For successful fetch/extract, provide a truncated preview
  if (payload.ok && (toolName === "fetch_url" || toolName === "extract_content")) {
    const result = payload.result as Record<string, unknown> | undefined;
    const extracted = result?.extracted as Record<string, unknown> | undefined;
    const preview = typeof result?.bodyPreview === "string"
      ? (result.bodyPreview as string).slice(0, 3000)
      : typeof extracted?.readableText === "string"
        ? (extracted.readableText as string).slice(0, 3000)
        : JSON.stringify(payload.result, null, 2).slice(0, 3000);
    return [
      `Tool result for "${toolName}":`,
      preview,
      "",
      "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
    ].join("\n");
  }

  // Default format
  const serialized = JSON.stringify(payload, null, 2);
  const truncated = serialized.length > 6000 ? serialized.slice(0, 6000) + "\n...<truncated>" : serialized;
  return [
    `Tool result for "${toolName}":`,
    truncated,
    "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
  ].join("\n");
}

function parseActionObject(rawText: string): ExtractedAction | null {
  const candidate = rawText.trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as unknown;
    return normalizeAction(parsed);
  } catch {
    return null;
  }
}

function normalizeAction(value: unknown): ExtractedAction | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const inferredType =
    value.type ?? (typeof value.tool === "string" ? "tool_call" : "final");

  if (inferredType === "tool_call") {
    if (typeof value.tool !== "string" || !value.tool) {
      return null;
    }

    return {
      type: "tool_call",
      tool: value.tool,
      input: isJsonObject(value.input) ? value.input : {},
    };
  }

  if (typeof value.content !== "string") {
    return null;
  }

  return {
    type: "final",
    content: value.content,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isJsonValue(entry));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.values(value).every((entry) => isJsonValue(entry));
}
