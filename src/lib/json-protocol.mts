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
    low: "You are in LOW effort mode. Respond with minimal, concise answers. Skip detailed explanations unless explicitly requested. Prefer quick, direct responses. Still use tools when needed — do not fabricate information.",
    medium: "You are in MEDIUM effort mode. Provide balanced responses with moderate detail. Include enough context to be helpful but avoid excessive elaboration. Always use tools for file operations and web searches.",
    high: "You are in HIGH effort mode. Provide thorough, detailed responses. Consider edge cases, provide comprehensive explanations, and verify your work carefully. Always use tools rather than guessing file contents or command outputs.",
    max: "You are in MAX effort mode. Provide maximum capability with deepest reasoning. Be exhaustive, consider all possibilities, provide the most thorough analysis possible, and double-check everything. Always use tools to verify facts rather than relying on memory.",
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
            "",
            "## CRITICAL: Tool Usage Rules",
            "You MUST use tools to take actions. NEVER pretend to run a tool, describe what a tool would do, or fabricate tool output.",
            "- When you need to read a file → call read_file (NEVER guess file contents)",
            "- When you need to edit a file → call apply_patch, replace_in_file, or write_file",
            "- When you need to list files → call list_dir",
            "- When you need to search files → call search_files",
            "- When you need to run a command → call run_shell",
            "- When you need to search the web → call web_search",
            "- When you need to fetch a URL → call fetch_url",
            "- When you need to extract readable content from a URL → call extract_content",
            "- When you need to save a fact for later → call remember_memory",
            "- When you need to recall saved facts → call search_memory",
            "- When you need to list project documentation → call list_docs",
            "- When you need to read documentation → call read_doc",
            "- When you need to search documentation → call search_docs",
            "You may only respond with plain text when you have a final answer that does NOT require any tool usage.",
            "",
            "Some tools may come from MCP servers. Treat them as external capabilities with real side effects and use them only when appropriate.",
            "",
            "## When to use web tools",
            "- When the user asks about current events, news, or recent information → use web_search",
            "- When the user asks to search the internet or look something up online → use web_search",
            "- When you need to verify a fact with a web source → use web_search or fetch_url",
            "- When the user provides a URL and asks about its content → use fetch_url or extract_content",
            "- When you need official documentation for an API or library → use web_search with query like 'official docs for X'",
            "- When the user asks about papers or research → use web_search then extract_content on the results",
            "- After web_search returns results, use extract_content on the most relevant URL to get full details",
            "- If web_search returns no results, try a different query with simpler or more specific terms",
            "- For academic papers, try queries like 'arxiv X' or 'paper about X site:arxiv.org'",
            "",
            "Prefer apply_patch for surgical multi-line edits when possible.",
            "Use remember_memory only for durable facts, preferences, project conventions, or failure learnings that will matter later.",
            "Use search_memory before repeating work if prior context may exist.",
            "If you use web-derived sources in the final answer, cite them with markers like [S1] and only cite source ids returned by tools.",
            "Prefer small, verifiable steps and short status updates.",
            "If the user asks for a plan, include it in your final answer.",
            "",
            "## Important Behavior Guidelines",
            "- Be concise in your final answers. Avoid repeating the user's question back to them.",
            "- When reading files, only read what you need. Don't read entire large files if you only need a specific section.",
            "- When running shell commands, prefer targeted commands over broad ones.",
            "- After making file edits, verify your changes by reading back the edited section or running tests.",
            "- If a tool call fails, analyze the error and try a different approach rather than repeating the same call.",
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
            "",
            "## CRITICAL: Tool Usage Rules",
            "You MUST use tools to take actions. NEVER claim you ran a tool or describe what a tool would do — actually call the tool.",
            "- When you need to read a file → call read_file (NEVER guess file contents)",
            "- When you need to edit a file → call apply_patch, replace_in_file, or write_file",
            "- When you need to list files → call list_dir",
            "- When you need to search files → call search_files",
            "- When you need to run a command → call run_shell",
            "- When you need to search the web → call web_search",
            "- When you need to fetch a URL → call fetch_url",
            "- When you need to extract readable content from a URL → call extract_content",
            "- When you need to save a fact for later → call remember_memory",
            "- When you need to recall saved facts → call search_memory",
            "- When you need to list project documentation → call list_docs",
            "- When you need to read documentation → call read_doc",
            "- When you need to search documentation → call search_docs",
            "",
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
            "- Only respond with {\"type\":\"final\",...} when you have fully answered the user's question and no further tool calls are needed.",
            "",
            "Prefer apply_patch for surgical multi-line edits when possible.",
            "Use remember_memory only for durable facts, preferences, project conventions, or failure learnings that will matter later.",
            "Use search_memory before repeating work if prior context may exist.",
            "Use web_search, fetch_url, or extract_content when the user needs current information, official docs, or verifiable links.",
            "After web_search returns results, use extract_content on the most relevant URL to get full details.",
            "If web_search returns no results, try a different query with simpler or more specific terms.",
            "For academic papers, try queries like 'arxiv X' or 'paper about X site:arxiv.org'.",
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
      const summaryLines = results.slice(0, 10).map((r: Record<string, unknown>, i: number) => {
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
  // Prefer readableText (clean extracted text) over bodyPreview (may be raw HTML)
  if (payload.ok && (toolName === "fetch_url" || toolName === "extract_content")) {
    const result = payload.result as Record<string, unknown> | undefined;
    const extracted = result?.extracted as Record<string, unknown> | undefined;
    const preview = typeof result?.readableText === "string" && (result.readableText as string).length > 0
      ? (result.readableText as string).slice(0, 5000)
      : typeof extracted?.readableText === "string"
        ? (extracted.readableText as string).slice(0, 5000)
        : typeof result?.bodyPreview === "string"
          ? (result.bodyPreview as string).slice(0, 5000)
          : JSON.stringify(payload.result, null, 2).slice(0, 5000);
    return [
      `Tool result for "${toolName}":`,
      preview,
      "",
      "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
    ].join("\n");
  }

  // For successful read_file, provide the file content directly
  if (payload.ok && toolName === "read_file") {
    const result = payload.result as Record<string, unknown> | undefined;
    const content = typeof result?.content === "string" ? result.content : "";
    const path = typeof result?.path === "string" ? result.path : "file";
    const lines = typeof result?.lineCount === "number" ? ` (${result.lineCount} lines)` : "";
    return [
      `Tool result for "read_file": ${path}${lines}`,
      content.slice(0, 8000),
      content.length > 8000 ? "\n...<truncated>" : "",
      "",
      "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
    ].join("\n");
  }

  // For successful list_dir, format entries cleanly
  if (payload.ok && toolName === "list_dir") {
    const result = payload.result as Record<string, unknown> | undefined;
    const entries = Array.isArray(result?.entries) ? (result?.entries as Array<Record<string, unknown>>) : [];
    const path = typeof result?.path === "string" ? result.path : "directory";
    if (entries.length > 0) {
      const entryLines = entries.slice(0, 50).map((e) => {
        const kind = e.kind === "directory" ? "📁" : "📄";
        return `${kind} ${e.name ?? "unknown"}`;
      });
      return [
        `Tool result for "list_dir": ${path} (${entries.length} entries)`,
        entryLines.join("\n"),
        entries.length > 50 ? `\n...${entries.length - 50} more entries` : "",
        "",
        "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
      ].join("\n");
    }
  }

  // For successful search_files, format matches clearly
  if (payload.ok && toolName === "search_files") {
    const result = payload.result as Record<string, unknown> | undefined;
    const matches = Array.isArray(result?.matches) ? (result?.matches as Array<Record<string, unknown>>) : [];
    if (matches.length > 0) {
      const matchLines = matches.slice(0, 20).map((m) =>
        `${m.path}:${m.line ?? "?"} ${m.preview ?? ""}`
      );
      return [
        `Tool result for "search_files": ${matches.length} match(es)`,
        matchLines.join("\n"),
        matches.length > 20 ? `\n...${matches.length - 20} more matches` : "",
        "",
        "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
      ].join("\n");
    }
  }

  // For successful run_shell, format the output clearly
  if (payload.ok && toolName === "run_shell") {
    const result = payload.result as Record<string, unknown> | undefined;
    const stdout = typeof result?.stdout === "string" ? result.stdout : "";
    const stderr = typeof result?.stderr === "string" ? result.stderr : "";
    const exitCode = result?.exitCode ?? result?.exit_code ?? null;
    const status = exitCode === 0 ? "success" : `exit=${exitCode}`;
    const parts = [
      `Tool result for "run_shell": ${status}`,
    ];
    if (stdout.trim()) {
      parts.push(stdout.slice(0, 5000));
    }
    if (stderr.trim()) {
      parts.push(`STDERR:\n${stderr.slice(0, 2000)}`);
    }
    parts.push("", "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.");
    return parts.join("\n");
  }

  // For write/edit operations, confirm success
  if (payload.ok && ["write_file", "replace_in_file", "apply_patch"].includes(toolName)) {
    const result = payload.result as Record<string, unknown> | undefined;
    const path = typeof result?.path === "string" ? result.path : "file";
    const bytesWritten = result?.bytesWritten;
    return [
      `Tool result for "${toolName}": Successfully wrote ${path}${bytesWritten ? ` (${bytesWritten} bytes)` : ""}.`,
      "",
      "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
    ].join("\n");
  }

  // For memory operations
  if (payload.ok && ["remember_memory", "search_memory"].includes(toolName)) {
    const result = payload.result as Record<string, unknown> | undefined;
    const serialized = JSON.stringify(result, null, 2);
    const truncated = serialized.length > 2000 ? serialized.slice(0, 2000) + "\n...<truncated>" : serialized;
    return [
      `Tool result for "${toolName}":`,
      truncated,
      "",
      "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
    ].join("\n");
  }

  // For MCP tools, format content blocks cleanly
  if (payload.ok && toolName.startsWith("mcp__")) {
    const result = payload.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object") {
      const content = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
      if (content.length > 0) {
        const textParts = content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string);
        if (textParts.length > 0) {
          const combined = textParts.join("\n");
          return [
            `Tool result for "${toolName}":`,
            combined.slice(0, 8000),
            combined.length > 8000 ? "\n...<truncated>" : "",
            "",
            "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
          ].join("\n");
        }
      }
      if (typeof result.summary === "string") {
        return [
          `Tool result for "${toolName}": ${result.summary.slice(0, 4000)}`,
          "",
          "IMPORTANT: Continue by calling another tool or respond with {\"type\":\"final\",\"content\":\"...\"}.",
        ].join("\n");
      }
    }
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
