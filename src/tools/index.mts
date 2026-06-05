import {
  listDir,
  previewReplaceInFile,
  previewWriteFile,
  readFile,
  replaceInFile,
  searchFiles,
  writeFile,
} from "./filesystem.mjs";
import { rememberMemory, searchMemory, forgetMemory } from "./memory.mjs";
import { applyPatch, previewApplyPatch } from "./patch.mjs";
import { runShell } from "./shell.mjs";
import { runSandboxed, checkSandboxAvailability } from "./sandbox.mjs";
import { extractContent, fetchUrl, webSearch } from "./web.mjs";
import { listDocs, readDoc, searchDocs } from "./doc-index.mjs";
import type { CapabilityRegistryLike } from "../lib/capability-registry.mjs";

import type {
  CitationSummary,
  NetworkMode,
  RankingMode,
  JsonObject,
  SourceRecord,
  ToolDefinition,
  ToolMetadata,
  ToolRegistrySurface,
  WebSearchProvider,
} from "../types/contracts.js";

type ToolInput = JsonObject;
type ExecutionContext = JsonObject;

interface McpToolSpec extends ToolMetadata {
  name: string;
  serverId: string;
  serverName?: string;
  annotations?: Record<string, boolean | string | number | null | undefined>;
}

interface PluginToolSpec extends ToolMetadata {
  name: string;
}

interface PluginLoaderLike {
  registerCapabilities?(registry: CapabilityRegistryLike): void;
  getNormalizedToolSpecs?(): PluginToolSpec[];
  describeTool?(name: string): PluginToolSpec | null;
  hasTool?(name: string): boolean;
  invokeTool(name: string, input?: ToolInput, executionContext?: ExecutionContext): Promise<unknown>;
  previewTool(name: string, input?: ToolInput): Promise<unknown>;
}

interface McpRegistryLike {
  getNormalizedToolSpecs?(): McpToolSpec[];
  describeTool?(name: string): McpToolSpec | null;
  hasTool?(name: string): boolean;
  invokeTool(name: string, input?: ToolInput, executionContext?: ExecutionContext): Promise<unknown>;
}

interface ToolRegistryContext extends Record<string, unknown> {
  cwd: string;
  maxReadChars: number;
  maxOutputChars: number;
  docDirs?: string[];
  networkMode: NetworkMode;
  webAllowDomains: string[];
  webDenyDomains: string[];
  webCacheTtlMs: number;
  webMaxExtractChars: number;
  webMaxResults: number;
  webRankingMode: RankingMode;
  sandboxRuntime?: unknown;
  webRuntime: {
    requestText(input: {
      url: string;
      method: string;
      requestType: string;
      traceId?: string | null;
      onEvent?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
      cacheNamespace: string;
      cacheKey: string;
      cacheTtlMs: number;
      allowContentTypes: string[];
    }): Promise<{
      content: string;
      meta: {
        finalUrl: string;
        contentType: string | null;
        redirected: boolean;
        cacheHit: boolean;
      };
    }>;
  };
  sourceRegistry: {
    registerPack(
      entries: Array<Record<string, unknown>>,
      metadata?: Record<string, unknown>,
    ): Promise<{
      pack: {
        id: string;
        sourceIds: string[];
      };
      sources: SourceRecord[];
      citations: CitationSummary[];
    }>;
  };
  searchProvider: WebSearchProvider;
  capabilityRegistry?: CapabilityRegistryLike | null;
  mcpRegistry?: McpRegistryLike | null;
  pluginLoader?: PluginLoaderLike | null;
}

interface BuiltinToolDefinition extends ToolDefinition {
  handler: (input?: ToolInput, executionContext?: ExecutionContext) => Promise<unknown> | unknown;
  preview?: (input?: ToolInput) => Promise<unknown> | unknown;
}

export function createToolRegistry(context: ToolRegistryContext): ToolRegistrySurface {
  const registry: Record<string, BuiltinToolDefinition> = {
    pwd: {
      description: "Return the current working directory.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ cwd: context.cwd }),
    },
    list_dir: {
      description: "List files and directories at a path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
      handler: (input) => listDir(input, context),
    },
    read_file: {
      description: "Read text from a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
        },
        required: ["path"],
      },
      handler: (input) => readFile(input, context),
    },
    search_files: {
      description: "Search for text across files.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
        },
        required: ["query"],
      },
      handler: (input) => searchFiles(input, context),
    },
    remember_memory: {
      description: "Persist a structured memory item in session, project, user, or failure memory.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["session", "project", "user", "failure"] },
          kind: { type: "string", enum: ["episodic", "semantic", "policy"] },
          key: { type: "string" },
          text: { type: "string" },
          summary: { type: "string" },
          source: { type: "string" },
          confidence: { type: "number" },
          importance: { type: "number" },
          expiresInDays: { type: "integer" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["scope", "text"],
      },
      handler: (input) => rememberMemory(input, context),
    },
    search_memory: {
      description: "Search stored memories using relevance, recency, importance, and certainty.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          scopes: {
            type: "array",
            items: { type: "string", enum: ["session", "project", "user", "failure"] },
          },
          limit: { type: "integer" },
        },
        required: ["query"],
      },
      handler: (input) => searchMemory(input, context),
    },
    forget_memory: {
      description: "Forget (invalidate) a stored memory item by id or key. Use this to remove outdated or incorrect memories.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["session", "project", "user", "failure"] },
          id: { type: "string", description: "The memory item id to forget." },
          key: { type: "string", description: "Forget all active memories matching this key in the scope." },
        },
        required: ["scope"],
      },
      handler: (input) => forgetMemory(input, context),
    },
    web_search: {
      description: "Search the web and return ranked results with source metadata and citations.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "integer" },
          rankingMode: { type: "string", enum: ["balanced", "docs-first", "official-first"] },
        },
        required: ["query"],
      },
      handler: (input, executionContext) => webSearch(input, context, executionContext),
    },
    fetch_url: {
      description: "Fetch a URL with cache, policy checks, and source registration.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          query: { type: "string" },
        },
        required: ["url"],
      },
      handler: (input, executionContext) => fetchUrl(input, context, executionContext),
    },
    extract_content: {
      description: "Fetch a URL and extract readable content with citations.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          query: { type: "string" },
        },
        required: ["url"],
      },
      handler: (input, executionContext) => extractContent(input, context, executionContext),
    },
    write_file: {
      description: "Write a complete file. Creates parent directories if needed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      preview: (input) => previewWriteFile(input, context),
      handler: (input) => writeFile(input, context),
    },
    replace_in_file: {
      description: "Replace text in a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          search: { type: "string" },
          replace: { type: "string" },
          all: { type: "boolean" },
        },
        required: ["path", "search", "replace"],
      },
      preview: (input) => previewReplaceInFile(input, context),
      handler: (input) => replaceInFile(input, context),
    },
    apply_patch: {
      description: "Apply a structured patch for targeted file edits, adds, deletes, or renames.",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string" },
        },
        required: ["patch"],
      },
      preview: (input) => previewApplyPatch(input, context),
      handler: (input) => applyPatch(input, context),
    },
    run_shell: {
      description: "Run a shell command.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          shell: { type: "string" },
          timeoutMs: { type: "integer" },
          background: { type: "boolean" },
          stream: { type: "boolean" },
          pty: { type: "boolean" },
        },
        required: ["command"],
      },
      handler: (input, executionContext) => runShell(input, context, executionContext),
    },
    run_sandbox: {
      description: "Run a shell command inside an OS-level sandbox. Filesystem writes are restricted to workspace paths, network access is blocked by default, and environment is filtered. Use this for untrusted or high-risk commands.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run inside the sandbox." },
          cwd: { type: "string", description: "Working directory for the command (defaults to workspace root)." },
          shell: { type: "string", description: "Shell to use (defaults to $SHELL)." },
          timeoutMs: { type: "integer", description: "Timeout in milliseconds." },
          allowNetwork: { type: "boolean", description: "Allow network access inside the sandbox (default: false)." },
          allowedWritePaths: {
            type: "array",
            items: { type: "string" },
            description: "Additional paths the sandboxed command may write to.",
          },
          env: {
            type: "object",
            description: "Additional environment variables for the sandboxed command.",
          },
        },
        required: ["command"],
      },
      handler: (input) => runSandboxed(input, context),
    },
    check_sandbox: {
      description: "Check what sandbox isolation mechanisms are available on the current platform.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: (input) => checkSandboxAvailability(input, context),
    },
    list_docs: {
      description: "List documentation files from configured doc directories (e.g. .qoder/). Returns file names, summaries, sizes, and line counts.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Document directory relative to cwd (default: .qoder)" },
          query: { type: "string", description: "Filter files by name or content" },
          limit: { type: "integer", description: "Max number of results (default 50, max 200)" },
        },
      },
      handler: (input = {}) => listDocs(input as import("./doc-index.mts").ListDocsInput, context),
    },
    read_doc: {
      description: "Read a documentation file from a doc directory. Supports line range. Searches .qoder/ and docs/ directories.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to doc directory or absolute path" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
        },
        required: ["path"],
      },
      handler: (input = {}) => readDoc(input as unknown as import("./doc-index.mts").ReadDocInput, context),
    },
    search_docs: {
      description: "Search for text across all documentation files in a doc directory.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text" },
          dir: { type: "string", description: "Document directory (default: .qoder)" },
          maxResults: { type: "integer", description: "Max matches (default 30, max 100)" },
        },
        required: ["query"],
      },
      handler: (input = {}) => searchDocs(input as unknown as import("./doc-index.mts").SearchDocsInput, context),
    },
  };

  function syncCapabilities(): void {
    context.capabilityRegistry?.replaceGroup(
      "builtin-tools",
      Object.entries(registry).map(([name, value]) => ({
        id: `tool:${name}`,
        name,
        displayName: name,
        type: classifyToolType(name),
        source: classifyToolSource(name),
        enabled: true,
        active: true,
        riskCategory: classifyRiskCategory(name),
        provenance: {
          source: classifyToolSource(name),
        },
        description: value.description,
        inputSchema: value.inputSchema,
        tags: classifyToolTags(name),
        scope: "runtime",
        sourceQualifiedName: `${classifyToolSource(name)}:${name}`,
      })),
    );

    context.capabilityRegistry?.replaceGroup(
      "mcp-tools",
      (context.mcpRegistry?.getNormalizedToolSpecs?.() ?? []).map((tool) => ({
        id: `mcp-tool:${tool.serverId}:${tool.name}`,
        name: tool.name,
        displayName: tool.toolName ?? tool.name,
        type: "mcp-tool",
        source: `mcp:${tool.serverId}`,
        enabled: true,
        active: true,
        riskCategory: tool.annotations?.readOnlyHint ? "read" : "external",
        provenance: {
          serverId: tool.serverId,
          serverName: tool.serverName,
          annotations: tool.annotations ?? {},
        },
        description: tool.description,
        inputSchema: tool.inputSchema,
        tags: ["mcp", tool.serverId].filter(Boolean),
        scope: "external",
        sourceQualifiedName: `mcp:${tool.serverId}:${tool.toolName ?? tool.name}`,
      })),
    );

    if (context.capabilityRegistry) {
      context.pluginLoader?.registerCapabilities?.(context.capabilityRegistry);
    }
  }

  return {
    getToolSpecs(): ToolMetadata[] {
      syncCapabilities();
      const localTools: ToolMetadata[] = Object.entries(registry).map(([name, value]) => ({
        name,
        displayName: name,
        description: value.description,
        inputSchema: value.inputSchema,
        source: classifyToolSource(name),
        type: classifyToolType(name),
        riskCategory: classifyRiskCategory(name),
        sourceQualifiedName: `${classifyToolSource(name)}:${name}`,
      }));
      const pluginTools = context.pluginLoader?.getNormalizedToolSpecs?.() ?? [];
      const mcpTools = context.mcpRegistry?.getNormalizedToolSpecs?.() ?? [];
      return [...localTools, ...pluginTools, ...mcpTools];
    },

    describe(name: string): ToolMetadata | null {
      const tool = registry[name];
      if (tool) {
        return {
          name,
          displayName: name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          source: classifyToolSource(name),
          type: classifyToolType(name),
          riskCategory: classifyRiskCategory(name),
          sourceQualifiedName: `${classifyToolSource(name)}:${name}`,
        };
      }

      const pluginTool = context.pluginLoader?.describeTool?.(name);
      if (pluginTool) {
        return {
          ...pluginTool,
          source: "plugin",
          type: "plugin-tool",
        };
      }

      const mcpTool = context.mcpRegistry?.describeTool?.(name);
      if (mcpTool) {
        return {
          ...mcpTool,
          source: "mcp",
          type: "mcp-tool",
          riskCategory: mcpTool.annotations?.readOnlyHint ? "read" : "external",
          sourceQualifiedName: `mcp:${mcpTool.serverId}:${mcpTool.name}`,
        };
      }

      return null;
    },

    async execute(
      name: string,
      input: ToolInput = {},
      executionContext: ExecutionContext = {},
    ): Promise<unknown> {
      const tool = registry[name];
      if (tool) {
        return tool.handler(input, executionContext);
      }

      if (context.pluginLoader?.hasTool?.(name)) {
        return context.pluginLoader.invokeTool(name, input, executionContext);
      }

      if (context.mcpRegistry?.hasTool?.(name)) {
        return context.mcpRegistry.invokeTool(name, input, executionContext);
      }

      throw new Error(`Unknown tool "${name}".`);
    },

    async preview(name: string, input: ToolInput = {}): Promise<unknown> {
      const tool = registry[name];
      if (!tool) {
        if (context.pluginLoader?.hasTool?.(name)) {
          return context.pluginLoader.previewTool(name, input);
        }
        throw new Error(`Unknown tool "${name}".`);
      }

      if (typeof tool.preview !== "function") {
        return null;
      }

      return tool.preview(input);
    },
  };
}

function classifyToolSource(name: string): string {
  if (["web_search", "fetch_url", "extract_content"].includes(name)) {
    return "web";
  }
  if (["list_docs", "read_doc", "search_docs"].includes(name)) {
    return "docs";
  }
  if (["run_sandbox", "check_sandbox"].includes(name)) {
    return "sandbox";
  }
  return "builtin";
}

function classifyToolType(name: string): string {
  const source = classifyToolSource(name);
  if (source === "web") return "web-tool";
  if (source === "docs") return "doc-tool";
  if (source === "sandbox") return "sandbox-tool";
  return "builtin-tool";
}

function classifyRiskCategory(name: string): string {
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) {
    return "write";
  }
  if (name === "run_shell") {
    return "exec";
  }
  if (name === "run_sandbox") {
    return "exec";
  }
  if (name === "check_sandbox") {
    return "read";
  }
  if (["web_search", "fetch_url", "extract_content"].includes(name)) {
    return "network";
  }
  if (["remember_memory", "search_memory"].includes(name)) {
    return "state";
  }
  if (name === "forget_memory") {
    return "destructive";
  }
  if (["list_docs", "read_doc", "search_docs"].includes(name)) {
    return "read";
  }
  return "read";
}

function classifyToolTags(name: string): string[] {
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) {
    return ["filesystem", "write"];
  }
  if (["read_file", "list_dir", "search_files", "pwd"].includes(name)) {
    return ["filesystem", "read"];
  }
  if (["web_search", "fetch_url", "extract_content"].includes(name)) {
    return ["web", "network"];
  }
  if (["remember_memory", "search_memory"].includes(name)) {
    return ["memory"];
  }
  if (name === "forget_memory") {
    return ["memory", "destructive"];
  }
  if (["list_docs", "read_doc", "search_docs"].includes(name)) {
    return ["docs", "read"];
  }
  if (name === "run_shell") {
    return ["shell", "exec"];
  }
  if (name === "run_sandbox") {
    return ["shell", "exec", "sandbox"];
  }
  if (name === "check_sandbox") {
    return ["sandbox", "read"];
  }
  return [];
}
