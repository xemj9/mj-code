import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import type { ExtensionStateStoreLike } from "./extension-state-store.mjs";
import type { LoadedConfig } from "../config.mjs";
import type {
  ExtensionExplicitState,
  JsonObject,
  PluginCapabilityManifestEntry,
  PluginInspectRecord,
  PluginListEntry,
  PluginManifestSummary,
  PluginToolSummary,
  PluginVariantSummary,
} from "../types/contracts.js";

type PluginHandler = (
  input?: Record<string, unknown>,
  executionContext?: Record<string, unknown>,
) => Promise<unknown> | unknown;

type PluginPreviewHandler = (
  input?: Record<string, unknown>,
) => Promise<unknown> | unknown;

interface PluginActivationConfig {
  cwd: string;
  permissionMode: string;
  approvalPolicy: string;
  networkMode: string;
}

interface PluginRegisterContext {
  plugin: {
    id: string;
    name: string;
    version: string;
    description: string;
  };
  cwd: string;
  projectStateDir: string;
  userStateDir: string;
  config: PluginActivationConfig;
}

interface PluginToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  preview?: PluginPreviewHandler | null;
  handler: PluginHandler;
  permissionsHints?: unknown[];
  riskCategory?: string;
  tags?: unknown[];
}

interface PluginRegisterPayload {
  tools?: PluginToolDefinition[];
}

interface PluginModule {
  register?: (context: PluginRegisterContext) => Promise<PluginRegisterPayload | PluginToolDefinition[]> | PluginRegisterPayload | PluginToolDefinition[];
  activate?: (context: PluginRegisterContext) => Promise<PluginRegisterPayload | PluginToolDefinition[]> | PluginRegisterPayload | PluginToolDefinition[];
  default?: (context: PluginRegisterContext) => Promise<PluginRegisterPayload | PluginToolDefinition[]> | PluginRegisterPayload | PluginToolDefinition[];
}

interface PluginToolRuntime extends PluginToolSummary {
  preview: PluginPreviewHandler | null;
  handler: PluginHandler;
}

interface LoadedPluginManifest extends PluginManifestSummary {}

interface ActivePluginRecord extends Omit<PluginInspectRecord, "tools"> {
  capabilities: PluginCapabilityManifestEntry[];
  tools: PluginToolRuntime[];
}

type PluginLoaderConfig = Pick<
  LoadedConfig,
  | "cwd"
  | "projectStateDir"
  | "userStateDir"
  | "permissionMode"
  | "approvalPolicy"
  | "networkMode"
> & {
  pluginDirs?: string[];
  pluginsEnabled?: string[];
  pluginsDisabled?: string[];
};

interface PluginLoaderOptions {
  stateStore?: ExtensionStateStoreLike | null;
}

interface PluginSource {
  scope: string;
  precedence: number;
  path: string;
}

interface ResolveExtensionStateInput {
  kind: "plugins";
  id: string;
  manifestEnabled: boolean;
  stateStore?: ExtensionStateStoreLike | null;
  config: PluginLoaderConfig;
}

export class PluginLoader {
  readonly config: PluginLoaderConfig;
  readonly stateStore: ExtensionStateStoreLike | null;
  plugins: ActivePluginRecord[];
  tools: Map<string, PluginToolRuntime>;

  constructor(config: PluginLoaderConfig, options: PluginLoaderOptions = {}) {
    this.config = config;
    this.stateStore = options.stateStore ?? null;
    this.plugins = [];
    this.tools = new Map();
  }

  async initialize(): Promise<void> {
    this.plugins = await loadPlugins(this.config, this.stateStore);
    this.tools = new Map();
    for (const plugin of this.plugins) {
      if (!plugin.active) {
        continue;
      }
      for (const tool of plugin.tools) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  listPlugins(): PluginListEntry[] {
    return this.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      scope: plugin.scope,
      enabled: plugin.enabled,
      active: plugin.active,
      explicitState: plugin.explicitState,
      status: plugin.status,
      permissionsHints: plugin.permissionsHints,
      originPath: plugin.originPath,
      entryPath: plugin.entryPath,
      sourceQualifiedName: plugin.sourceQualifiedName,
      toolCount: plugin.tools.length,
      toolNames: plugin.tools.map((tool) => tool.name),
      loadError: plugin.loadError,
      variants: plugin.variants,
    }));
  }

  inspectPlugin(idOrName: string): PluginInspectRecord | null {
    const plugin = this.resolvePlugin(idOrName);
    if (!plugin) {
      return null;
    }
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      scope: plugin.scope,
      enabled: plugin.enabled,
      active: plugin.active,
      explicitState: plugin.explicitState,
      status: plugin.status,
      permissionsHints: [...plugin.permissionsHints],
      originPath: plugin.originPath,
      entryPath: plugin.entryPath,
      sourceQualifiedName: plugin.sourceQualifiedName,
      toolCount: plugin.tools.length,
      toolNames: plugin.tools.map((tool) => tool.name),
      loadError: plugin.loadError,
      variants: structuredClone(plugin.variants),
      capabilities: structuredClone(plugin.capabilities),
      tools: plugin.tools.map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchema),
        source: "plugin",
        type: "plugin-tool",
        pluginId: tool.pluginId,
        pluginName: tool.pluginName,
        permissionsHints: [...tool.permissionsHints],
        riskCategory: tool.riskCategory,
        originPath: tool.originPath,
        sourceQualifiedName: tool.sourceQualifiedName,
        tags: [...tool.tags],
      })),
    };
  }

  getNormalizedToolSpecs(): PluginToolSummary[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      description: `[Plugin:${tool.pluginId}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      source: "plugin",
      type: "plugin-tool",
      pluginId: tool.pluginId,
      pluginName: tool.pluginName,
      permissionsHints: tool.permissionsHints,
      riskCategory: tool.riskCategory,
      originPath: tool.originPath,
      sourceQualifiedName: tool.sourceQualifiedName,
      tags: tool.tags,
    }));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  describeTool(name: string): PluginToolSummary | null {
    const tool = this.tools.get(name);
    return tool
      ? {
          name: tool.name,
          displayName: tool.displayName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          source: "plugin",
          type: "plugin-tool",
          pluginId: tool.pluginId,
          pluginName: tool.pluginName,
          permissionsHints: tool.permissionsHints,
          riskCategory: tool.riskCategory,
          originPath: tool.originPath,
          sourceQualifiedName: tool.sourceQualifiedName,
          tags: tool.tags,
        }
      : null;
  }

  async invokeTool(
    name: string,
    input: Record<string, unknown> = {},
    executionContext: Record<string, unknown> = {},
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown plugin tool "${name}".`);
    }
    return tool.handler(input, executionContext);
  }

  async previewTool(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool || typeof tool.preview !== "function") {
      return null;
    }
    return tool.preview(input);
  }

  async enablePlugin(idOrName: string): Promise<PluginInspectRecord | null> {
    const plugin = this.resolvePlugin(idOrName);
    if (!plugin) {
      throw new Error(`Unknown plugin "${idOrName}".`);
    }
    await this.stateStore?.setEnabled("plugins", plugin.id, true);
    await this.initialize();
    return this.inspectPlugin(plugin.id);
  }

  async disablePlugin(idOrName: string): Promise<PluginInspectRecord | null> {
    const plugin = this.resolvePlugin(idOrName);
    if (!plugin) {
      throw new Error(`Unknown plugin "${idOrName}".`);
    }
    await this.stateStore?.setEnabled("plugins", plugin.id, false);
    await this.initialize();
    return this.inspectPlugin(plugin.id);
  }

  registerCapabilities(capabilityRegistry: CapabilityRegistryLike): void {
    capabilityRegistry.replaceGroup(
      "plugin-tools",
      this.plugins.flatMap((plugin) => {
        const byDisplayName = new Map(plugin.tools.map((tool) => [tool.displayName, tool]));
        const declared = plugin.capabilities.map((capability) => {
          const activeTool = byDisplayName.get(capability.name);
          return {
            id: `plugin-tool:${plugin.id}:${capability.name}`,
            name: activeTool?.name ?? normalizePluginToolName(plugin.id, capability.name),
            displayName: capability.name,
            type: "plugin-tool",
            source: `plugin:${plugin.id}`,
            enabled: plugin.enabled,
            active: plugin.active && Boolean(activeTool),
            riskCategory: activeTool?.riskCategory ?? capability.riskCategory ?? "external",
            provenance: {
              pluginId: plugin.id,
              pluginName: plugin.name,
              permissionsHints: activeTool?.permissionsHints ?? capability.permissionsHints ?? plugin.permissionsHints,
            },
            description: activeTool?.description ?? capability.description ?? plugin.description,
            inputSchema: activeTool?.inputSchema ?? capability.inputSchema ?? null,
            tags: activeTool?.tags ?? capability.tags ?? [],
            scope: plugin.scope,
            originPath: activeTool?.originPath ?? plugin.originPath,
            sourceQualifiedName:
              activeTool?.sourceQualifiedName ?? `plugin:${plugin.id}:${capability.name}`,
          };
        });
        const extras = plugin.tools
          .filter((tool) => !plugin.capabilities.some((entry) => entry.name === tool.displayName))
          .map((tool) => ({
            id: `plugin-tool:${plugin.id}:${tool.displayName}`,
            name: tool.name,
            displayName: tool.displayName,
            type: "plugin-tool",
            source: `plugin:${plugin.id}`,
            enabled: plugin.enabled,
            active: plugin.active,
            riskCategory: tool.riskCategory,
            provenance: {
              pluginId: plugin.id,
              pluginName: plugin.name,
              permissionsHints: tool.permissionsHints,
            },
            description: tool.description,
            inputSchema: tool.inputSchema,
            tags: tool.tags,
            scope: plugin.scope,
            originPath: tool.originPath,
            sourceQualifiedName: tool.sourceQualifiedName,
          }));
        return [...declared, ...extras];
      }),
    );
  }

  resolvePlugin(idOrName: string | null | undefined): ActivePluginRecord | null {
    if (!idOrName) {
      return null;
    }
    return this.plugins.find((plugin) =>
      plugin.id === idOrName ||
      plugin.name === idOrName ||
      plugin.sourceQualifiedName === idOrName,
    ) ?? null;
  }
}

async function loadPlugins(
  config: PluginLoaderConfig,
  stateStore: ExtensionStateStoreLike | null,
): Promise<ActivePluginRecord[]> {
  const sources = buildPluginSources(config);
  const variantsById = new Map<string, LoadedPluginManifest[]>();

  for (const source of sources) {
    const manifestPaths = await discoverManifestPaths(source.path, "plugin.json");
    for (const manifestPath of manifestPaths) {
      const loaded = await loadPluginManifest(manifestPath, source);
      if (!loaded) {
        continue;
      }
      const variants = variantsById.get(loaded.id) ?? [];
      variants.push(loaded);
      variantsById.set(loaded.id, variants);
    }
  }

  const resolved: ActivePluginRecord[] = [];
  for (const variants of variantsById.values()) {
    variants.sort((left, right) => left.precedence - right.precedence);
    const selected = variants.at(-1);
    if (!selected) {
      continue;
    }
    const state = resolveExtensionState({
      kind: "plugins",
      id: selected.id,
      manifestEnabled: selected.manifestEnabled,
      stateStore,
      config,
    });
    const enabled = state.enabled;
    const plugin = await activatePlugin(selected, {
      enabled,
      explicitState: state.explicitState,
      config,
      variants,
    });
    resolved.push(plugin);
  }

  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

async function activatePlugin(
  plugin: LoadedPluginManifest,
  {
    enabled,
    explicitState,
    config,
    variants,
  }: {
    enabled: boolean;
    explicitState: ExtensionExplicitState;
    config: PluginLoaderConfig;
    variants: LoadedPluginManifest[];
  },
): Promise<ActivePluginRecord> {
  const base: ActivePluginRecord = {
    ...plugin,
    enabled,
    active: enabled,
    explicitState,
    toolCount: 0,
    toolNames: [],
    variants: variants.map((entry) => ({
      scope: entry.scope,
      originPath: entry.originPath,
      precedence: entry.precedence,
    })),
    tools: [],
    status: enabled ? "active" : "disabled",
    loadError: null,
  };

  if (!enabled) {
    return base;
  }

  try {
    const module = await import(pathToFileURL(plugin.entryPath).href) as PluginModule;
    const register = module.register ?? module.activate ?? module.default;
    if (typeof register !== "function") {
      throw new Error(`Plugin entry "${plugin.entryPath}" must export register(), activate(), or default.`);
    }

    const registration = await register({
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
      },
      cwd: config.cwd,
      projectStateDir: config.projectStateDir,
      userStateDir: config.userStateDir,
      config: {
        cwd: config.cwd,
        permissionMode: config.permissionMode,
        approvalPolicy: config.approvalPolicy,
        networkMode: config.networkMode,
      },
    });

    const registeredTools = Array.isArray(registration)
      ? registration
      : Array.isArray(registration?.tools)
        ? registration.tools
        : [];

    const tools = registeredTools
      .map((tool) => normalizePluginTool(tool, plugin))
      .filter((tool): tool is PluginToolRuntime => tool != null);

    return {
      ...base,
      tools,
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.name),
      status: "active",
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      active: false,
      tools: [],
      loadError: error instanceof Error ? error.message : `${error ?? "Unknown plugin load error"}`,
    };
  }
}

function normalizePluginTool(
  tool: PluginToolDefinition,
  plugin: LoadedPluginManifest,
): PluginToolRuntime | null {
  if (!tool || typeof tool.name !== "string" || typeof tool.handler !== "function") {
    return null;
  }

  const declared = plugin.capabilities.find((entry) => entry.name === tool.name);
  const displayName = tool.name;
  return {
    name: normalizePluginToolName(plugin.id, displayName),
    displayName,
    description: tool.description ?? declared?.description ?? displayName,
    inputSchema: tool.inputSchema ?? declared?.inputSchema ?? { type: "object", properties: {} },
    preview: typeof tool.preview === "function" ? tool.preview : null,
    handler: tool.handler,
    source: "plugin",
    type: "plugin-tool",
    pluginId: plugin.id,
    pluginName: plugin.name,
    originPath: plugin.originPath,
    permissionsHints: normalizeStringArray(tool.permissionsHints ?? declared?.permissionsHints ?? plugin.permissionsHints),
    riskCategory: tool.riskCategory ?? declared?.riskCategory ?? "external",
    tags: normalizeStringArray(tool.tags ?? declared?.tags),
    sourceQualifiedName: `plugin:${plugin.id}:${displayName}`,
  };
}

async function loadPluginManifest(
  manifestPath: string,
  source: PluginSource,
): Promise<LoadedPluginManifest | null> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const id = normalizeIdentifier(raw.id ?? raw.name);
  if (!id) {
    return null;
  }

  const manifestDir = path.dirname(manifestPath);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    version: typeof raw.version === "string" ? raw.version : "0.0.0",
    description: typeof raw.description === "string" ? raw.description : "",
    scope: source.scope,
    precedence: source.precedence,
    sourceQualifiedName: `${source.scope}:${id}`,
    originPath: manifestPath,
    entryPath: path.resolve(manifestDir, typeof raw.entry === "string" ? raw.entry : "index.mjs"),
    manifestEnabled: raw.enabled !== false,
    permissionsHints: normalizeStringArray(raw.permissionsHints),
    capabilities: normalizePluginCapabilities(raw.capabilities),
  };
}

function buildPluginSources(config: PluginLoaderConfig): PluginSource[] {
  const configured = Array.isArray(config.pluginDirs) ? config.pluginDirs : [];
  const rawSources: PluginSource[] = [
    { scope: "project", precedence: 200, path: path.join(config.projectStateDir, "plugins") },
    { scope: "local", precedence: 300, path: path.join(config.userStateDir, "plugins") },
    ...configured.map((entry, index) => ({
      scope: inferConfiguredScope(entry, config),
      precedence: inferConfiguredScope(entry, config) === "project" ? 200 + index : 300 + index,
      path: entry,
    })),
  ];

  const seen = new Set<string>();
  return rawSources.filter((entry) => {
    const resolved = path.resolve(entry.path);
    if (seen.has(resolved)) {
      return false;
    }
    seen.add(resolved);
    entry.path = resolved;
    return true;
  });
}

function inferConfiguredScope(entry: string, config: PluginLoaderConfig): string {
  const resolved = path.resolve(entry);
  if (resolved === path.resolve(path.join(config.projectStateDir, "plugins"))) {
    return "project";
  }
  return "local";
}

async function discoverManifestPaths(rootDir: string, manifestBasename: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const manifests: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory()) {
        manifests.push(path.join(rootDir, entry.name, manifestBasename));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        manifests.push(path.join(rootDir, entry.name));
      }
    }
    return manifests;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function normalizePluginCapabilities(value: unknown): PluginCapabilityManifestEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      type: typeof entry.type === "string" ? entry.type : "plugin-tool",
      name: normalizeIdentifier(entry.name) ?? "",
      description: typeof entry.description === "string" ? entry.description : "",
      inputSchema: isJsonObject(entry.inputSchema) ? entry.inputSchema : null,
      riskCategory: typeof entry.riskCategory === "string" ? entry.riskCategory : "external",
      tags: normalizeStringArray(entry.tags),
      permissionsHints: normalizeStringArray(entry.permissionsHints),
    }))
    .filter((entry) => Boolean(entry.name));
}

function normalizePluginToolName(pluginId: string, toolName: string): string {
  return `plugin__${sanitizeToken(pluginId)}__${sanitizeToken(toolName)}`;
}

function sanitizeToken(value: string): string {
  return `${value}`.trim().replace(/[^a-zA-Z0-9_]+/g, "_");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => `${entry}`).map((entry) => entry.trim()).filter(Boolean))].sort();
}

function normalizeIdentifier(value: unknown): string | null {
  const normalized = `${value ?? ""}`.trim();
  return normalized || null;
}

function resolveExtensionState({
  kind,
  id,
  manifestEnabled,
  stateStore,
  config,
}: ResolveExtensionStateInput): {
  enabled: boolean;
  explicitState: ExtensionExplicitState;
} {
  if (Array.isArray(config?.pluginsEnabled) && config.pluginsEnabled.includes(id)) {
    return {
      enabled: true,
      explicitState: "enabled",
    };
  }

  if (Array.isArray(config?.pluginsDisabled) && config.pluginsDisabled.includes(id)) {
    return {
      enabled: false,
      explicitState: "disabled",
    };
  }

  const resolved = stateStore?.resolve(kind, id, manifestEnabled);
  if (resolved) {
    return {
      enabled: resolved.enabled,
      explicitState:
        resolved.explicitState === "enabled" || resolved.explicitState === "disabled"
          ? resolved.explicitState
          : null,
    };
  }

  return {
    enabled: manifestEnabled !== false,
    explicitState: null,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
