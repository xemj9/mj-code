import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  RankingMode,
  ResolvedConfig,
  WebSearchProviderName,
} from "./types/contracts.js";

type ConfigOverrides = Record<string, unknown>;
type ConfigObject = Record<string, unknown>;
type EnumValue = string | null;

export interface LoadedConfig extends ResolvedConfig {
  providerTimeoutMs: number | null;
  providerMaxRetries: number | null;
  providerRetryBudgetMs: number | null;
  webProviderApiKey: string | null;
  webTimeoutMs: number;
  webMaxRetries: number;
  webRetryBudgetMs: number;
  webCacheTtlMs: number;
  webMaxResults: number;
  webMaxBodyBytes: number;
  webMaxExtractChars: number;
  webRankingMode: RankingMode;
  webAllowDomains: string[];
  webDenyDomains: string[];
  webSearxngEndpoint: string | null;
  mcpEnabled: boolean;
  mcpTimeoutMs: number;
  mcpMaxRetries: number;
  mcpRetryBudgetMs: number;
  runtimeCircuitFailureThreshold: number;
  runtimeCircuitCooldownMs: number;
  runtimeCircuitHalfOpenMaxRequests: number;
  executionBoundaryMode: string;
  executionEnvAllowlist: string[];
  userPolicy: string;
  skillDirs: string[];
  pluginDirs: string[];
  skillsEnabled: string[];
  skillsDisabled: string[];
  pluginsEnabled: string[];
  pluginsDisabled: string[];
  hooks: unknown[];
  hookTimeoutMs: number;
  impactDeadlineMs: number;
  impactCacheTtlMs: number;
  userStateDir: string;
  extraHeaders: Record<string, unknown>;
  streamOutput: boolean;
  authMode: string;
  mcpServers?: Record<string, unknown>;
  mcpConfigPaths?: Array<{ path?: string } | string>;
}

interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: ConfigOverrides;
  configPath?: string | null;
}

interface RedactedConfig {
  [key: string]: unknown;
}

interface ConfigDefaults extends ConfigObject {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  authMode: string;
  streamOutput: boolean;
  permissionMode: LoadedConfig["permissionMode"];
  approvalPolicy: LoadedConfig["approvalPolicy"];
  providerTimeoutMs: number | null;
  providerMaxRetries: number | null;
  providerRetryBudgetMs: number | null;
  maxSteps: number;
  maxTokens: number;
  temperature: number;
  networkMode: LoadedConfig["networkMode"];
  webProvider: WebSearchProviderName;
  webProviderApiKey: string | null;
  webTimeoutMs: number;
  webMaxRetries: number;
  webRetryBudgetMs: number;
  webCacheTtlMs: number;
  webMaxResults: number;
  webMaxBodyBytes: number;
  webMaxExtractChars: number;
  webRankingMode: RankingMode;
  webAllowDomains: string[];
  webDenyDomains: string[];
  webSearxngEndpoint: string | null;
  mcpEnabled: boolean;
  mcpTimeoutMs: number;
  mcpMaxRetries: number;
  mcpRetryBudgetMs: number;
  runtimeCircuitFailureThreshold: number;
  runtimeCircuitCooldownMs: number;
  runtimeCircuitHalfOpenMaxRequests: number;
  executionBoundaryMode: string;
  executionEnvAllowlist: string[];
  userPolicy: string;
  skillDirs: string[];
  pluginDirs: string[];
  skillsEnabled: string[];
  skillsDisabled: string[];
  pluginsEnabled: string[];
  pluginsDisabled: string[];
  hooks: unknown[];
  hookTimeoutMs: number;
  shellTimeoutMs: number;
  shellBufferChars: number;
  maxOutputChars: number;
  maxReadChars: number;
  impactDeadlineMs: number;
  impactCacheTtlMs: number;
  extraHeaders: Record<string, unknown>;
}

const DEFAULTS: ConfigDefaults = {
  provider: null,
  model: null,
  baseUrl: null,
  apiKey: null,
  authMode: "auto",
  streamOutput: true,
  permissionMode: "workspace-write",
  approvalPolicy: "on-write",
  providerTimeoutMs: null,
  providerMaxRetries: null,
  providerRetryBudgetMs: null,
  maxSteps: 100,
  maxTokens: 80000,
  temperature: 0.2,
  networkMode: "open-web",
  webProvider: "fallback",
  webProviderApiKey: null,
  webTimeoutMs: 15000,
  webMaxRetries: 3,
  webRetryBudgetMs: 20000,
  webCacheTtlMs: 3600000,
  webMaxResults: 10,
  webMaxBodyBytes: 1500000,
  webMaxExtractChars: 32000,
  webRankingMode: "balanced",
  webAllowDomains: [],
  webDenyDomains: [],
  webSearxngEndpoint: null,
  mcpEnabled: true,
  mcpTimeoutMs: 10000,
  mcpMaxRetries: 1,
  mcpRetryBudgetMs: 4000,
  runtimeCircuitFailureThreshold: 5,
  runtimeCircuitCooldownMs: 10000,
  runtimeCircuitHalfOpenMaxRequests: 2,
  executionBoundaryMode: "workspace",
  executionEnvAllowlist: [],
  userPolicy: "",
  skillDirs: [],
  pluginDirs: [],
  skillsEnabled: [],
  skillsDisabled: [],
  pluginsEnabled: [],
  pluginsDisabled: [],
  hooks: [],
  hookTimeoutMs: 5000,
  shellTimeoutMs: 30000,
  shellBufferChars: 24000,
  maxOutputChars: 12000,
  maxReadChars: 20000,
  impactDeadlineMs: 250,
  impactCacheTtlMs: 30000,
  extraHeaders: {},
};

const SUPPORTED_PERMISSION_MODES = new Set<LoadedConfig["permissionMode"]>([
  "read-only",
  "workspace-write",
  "full-access",
]);
const SUPPORTED_APPROVAL_POLICIES = new Set<LoadedConfig["approvalPolicy"]>([
  "always",
  "on-write",
  "never",
]);
const SUPPORTED_PROVIDERS = new Set(["mock", "openai-compatible", "anthropic-compatible"]);
const SUPPORTED_NETWORK_MODES = new Set<LoadedConfig["networkMode"]>(["off", "docs-only", "open-web"]);
const SUPPORTED_WEB_PROVIDERS = new Set<WebSearchProviderName>(["fallback", "brave", "searxng"]);
const SUPPORTED_WEB_RANKING_MODES = new Set<RankingMode>(["balanced", "docs-first", "official-first"]);
const SUPPORTED_EXECUTION_BOUNDARY_MODES = new Set(["off", "workspace", "strict-policy"]);

export async function loadConfig({
  cwd,
  env = process.env,
  overrides = {},
  configPath = null,
}: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const workingDirectory = path.resolve(cwd ?? process.cwd());
  const homeConfigPath = path.join(os.homedir(), ".mj-code", "config.json");

  const fileConfig = await readFirstConfigFile([
    configPath,
    path.join(workingDirectory, "mjcode.config.json"),
    env.MJ_CODE_CONFIG,
    homeConfigPath,
  ]);

  const config = {
    ...DEFAULTS,
    ...fileConfig,
    ...configFromEnvironment(env, fileConfig),
    ...overrides,
  } as LoadedConfig;

  config.cwd = path.resolve(
    toStringOrNull(overrides.cwd) ?? toStringOrNull(fileConfig.cwd) ?? workingDirectory,
  );
  config.provider = normalizeProvider(
    toStringOrNull(config.provider),
    toStringOrNull(config.baseUrl),
    env,
  );
  config.baseUrl = normalizeBaseUrl(config.provider, toStringOrNull(config.baseUrl));
  config.permissionMode = normalizeEnum(
    toStringOrNull(config.permissionMode),
    SUPPORTED_PERMISSION_MODES,
    DEFAULTS.permissionMode,
    "permission mode",
  ) as LoadedConfig["permissionMode"];
  config.approvalPolicy = normalizeEnum(
    toStringOrNull(config.approvalPolicy),
    SUPPORTED_APPROVAL_POLICIES,
    DEFAULTS.approvalPolicy,
    "approval policy",
  ) as LoadedConfig["approvalPolicy"];
  config.networkMode = normalizeEnum(
    toStringOrNull(config.networkMode),
    SUPPORTED_NETWORK_MODES,
    DEFAULTS.networkMode,
    "network mode",
  ) as LoadedConfig["networkMode"];
  config.webProvider = normalizeEnum(
    toStringOrNull(config.webProvider),
    SUPPORTED_WEB_PROVIDERS,
    DEFAULTS.webProvider,
    "web provider",
  ) as LoadedConfig["webProvider"];
  config.webRankingMode = normalizeEnum(
    toStringOrNull(config.webRankingMode),
    SUPPORTED_WEB_RANKING_MODES,
    DEFAULTS.webRankingMode,
    "web ranking mode",
  ) as LoadedConfig["webRankingMode"];
  config.executionBoundaryMode = normalizeEnum(
    toStringOrNull(config.executionBoundaryMode),
    SUPPORTED_EXECUTION_BOUNDARY_MODES,
    DEFAULTS.executionBoundaryMode,
    "execution boundary mode",
  ) as string;

  if (!SUPPORTED_PROVIDERS.has(`${config.provider}`)) {
    throw new Error(`Unsupported provider "${config.provider}".`);
  }

  config.projectStateDir = path.resolve(config.cwd, ".mj-code");
  config.userStateDir = path.resolve(
    toStringOrNull(config.userStateDir) ||
      env.MJ_CODE_HOME ||
      path.join(os.homedir(), ".codex", "memories", "mj-code"),
  );
  config.sessionDir = path.resolve(config.projectStateDir, "sessions");
  config.checkpointDir = path.resolve(config.projectStateDir, "checkpoints");
  config.journalDir = path.resolve(config.projectStateDir, "journal");
  config.webCacheDir = path.resolve(config.projectStateDir, "web-cache");
  config.sourceDir = path.resolve(config.projectStateDir, "sources");
  config.extraHeaders = isObject(config.extraHeaders) ? config.extraHeaders : {};
  config.webAllowDomains = normalizeStringArray(config.webAllowDomains);
  config.webDenyDomains = normalizeStringArray(config.webDenyDomains);
  config.userPolicy = typeof config.userPolicy === "string" ? config.userPolicy.trim() : "";
  config.executionEnvAllowlist = normalizeStringArray(config.executionEnvAllowlist);
  config.skillDirs = normalizePathArray(config.skillDirs, [
    path.join(config.projectStateDir, "skills"),
    path.join(config.userStateDir, "skills"),
  ]);
  config.pluginDirs = normalizePathArray(config.pluginDirs, [
    path.join(config.projectStateDir, "plugins"),
    path.join(config.userStateDir, "plugins"),
  ]);
  config.skillsEnabled = normalizeStringArray(config.skillsEnabled);
  config.skillsDisabled = normalizeStringArray(config.skillsDisabled);
  config.pluginsEnabled = normalizeStringArray(config.pluginsEnabled);
  config.pluginsDisabled = normalizeStringArray(config.pluginsDisabled);
  config.hooks = Array.isArray(config.hooks) ? config.hooks : [];

  return config;
}

export function redactConfig(config: LoadedConfig): RedactedConfig {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    authMode: config.authMode,
    streamOutput: config.streamOutput,
    permissionMode: config.permissionMode,
    approvalPolicy: config.approvalPolicy,
    providerTimeoutMs: config.providerTimeoutMs,
    providerMaxRetries: config.providerMaxRetries,
    providerRetryBudgetMs: config.providerRetryBudgetMs,
    maxSteps: config.maxSteps,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    networkMode: config.networkMode,
    webProvider: config.webProvider,
    webTimeoutMs: config.webTimeoutMs,
    webMaxRetries: config.webMaxRetries,
    webRetryBudgetMs: config.webRetryBudgetMs,
    webCacheTtlMs: config.webCacheTtlMs,
    webMaxResults: config.webMaxResults,
    webMaxBodyBytes: config.webMaxBodyBytes,
    webMaxExtractChars: config.webMaxExtractChars,
    webRankingMode: config.webRankingMode,
    webAllowDomains: config.webAllowDomains,
    webDenyDomains: config.webDenyDomains,
    mcpEnabled: config.mcpEnabled,
    mcpTimeoutMs: config.mcpTimeoutMs,
    mcpMaxRetries: config.mcpMaxRetries,
    mcpRetryBudgetMs: config.mcpRetryBudgetMs,
    runtimeCircuitFailureThreshold: config.runtimeCircuitFailureThreshold,
    runtimeCircuitCooldownMs: config.runtimeCircuitCooldownMs,
    runtimeCircuitHalfOpenMaxRequests: config.runtimeCircuitHalfOpenMaxRequests,
    executionBoundaryMode: config.executionBoundaryMode,
    executionEnvAllowlist: config.executionEnvAllowlist,
    hasUserPolicy: Boolean(config.userPolicy),
    skillDirs: config.skillDirs,
    pluginDirs: config.pluginDirs,
    skillsEnabled: config.skillsEnabled,
    skillsDisabled: config.skillsDisabled,
    pluginsEnabled: config.pluginsEnabled,
    pluginsDisabled: config.pluginsDisabled,
    hookCount: Array.isArray(config.hooks) ? config.hooks.length : 0,
    hookTimeoutMs: config.hookTimeoutMs,
    hasInlineMcpServers: Boolean(config.mcpServers && Object.keys(config.mcpServers).length > 0),
    mcpConfigPaths: Array.isArray(config.mcpConfigPaths)
      ? config.mcpConfigPaths.map((entry) =>
        typeof entry === "string" ? entry : (entry.path ?? null)
      )
      : undefined,
    shellTimeoutMs: config.shellTimeoutMs,
    shellBufferChars: config.shellBufferChars,
    maxOutputChars: config.maxOutputChars,
    maxReadChars: config.maxReadChars,
    impactDeadlineMs: config.impactDeadlineMs,
    impactCacheTtlMs: config.impactCacheTtlMs,
    cwd: config.cwd,
    projectStateDir: config.projectStateDir,
    userStateDir: config.userStateDir,
    sessionDir: config.sessionDir,
    checkpointDir: config.checkpointDir,
    journalDir: config.journalDir,
    webCacheDir: config.webCacheDir,
    sourceDir: config.sourceDir,
    hasApiKey: Boolean(config.apiKey),
    hasWebProviderApiKey: Boolean(config.webProviderApiKey),
    extraHeaders: Object.keys(config.extraHeaders),
  };
}

async function readFirstConfigFile(candidates: Array<string | null | undefined>): Promise<ConfigObject> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const contents = await fs.readFile(candidate, "utf8");
      const parsed = JSON.parse(contents) as ConfigObject;
      return isObject(parsed) ? parsed : {};
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT") {
        continue;
      }

      throw new Error(`Failed to read config file "${candidate}": ${getErrorMessage(error)}`);
    }
  }

  return {};
}

function configFromEnvironment(env: NodeJS.ProcessEnv, fileConfig: ConfigObject): ConfigObject {
  const provider = env.MJ_CODE_PROVIDER || toStringOrNull(fileConfig.provider) || null;

  return {
    provider,
    model:
      env.MJ_CODE_MODEL ||
      toStringOrNull(fileConfig.model) ||
      env.OPENAI_MODEL ||
      env.ANTHROPIC_MODEL ||
      null,
    baseUrl:
      env.MJ_CODE_BASE_URL ||
      toStringOrNull(fileConfig.baseUrl) ||
      env.OPENAI_BASE_URL ||
      env.ANTHROPIC_BASE_URL ||
      null,
    apiKey:
      env.MJ_CODE_API_KEY ||
      toStringOrNull(fileConfig.apiKey) ||
      env.OPENAI_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN ||
      null,
    authMode: env.MJ_CODE_AUTH_MODE || toStringOrNull(fileConfig.authMode) || DEFAULTS.authMode,
    streamOutput: normalizeBoolean(env.MJ_CODE_STREAM, fileConfig.streamOutput, DEFAULTS.streamOutput),
    providerTimeoutMs: normalizeNumber(env.MJ_CODE_PROVIDER_TIMEOUT_MS, fileConfig.providerTimeoutMs, DEFAULTS.providerTimeoutMs),
    providerMaxRetries: normalizeNumber(env.MJ_CODE_PROVIDER_MAX_RETRIES, fileConfig.providerMaxRetries, DEFAULTS.providerMaxRetries),
    providerRetryBudgetMs: normalizeNumber(env.MJ_CODE_PROVIDER_RETRY_BUDGET_MS, fileConfig.providerRetryBudgetMs, DEFAULTS.providerRetryBudgetMs),
    networkMode: env.MJ_CODE_NETWORK_MODE || toStringOrNull(fileConfig.networkMode) || DEFAULTS.networkMode,
    webProvider: env.MJ_CODE_WEB_PROVIDER || toStringOrNull(fileConfig.webProvider) || DEFAULTS.webProvider,
    webProviderApiKey:
      env.MJ_CODE_WEB_PROVIDER_API_KEY ||
      env.BRAVE_SEARCH_API_KEY ||
      toStringOrNull(fileConfig.webProviderApiKey) ||
      DEFAULTS.webProviderApiKey,
    webTimeoutMs: normalizeNumber(env.MJ_CODE_WEB_TIMEOUT_MS, fileConfig.webTimeoutMs, DEFAULTS.webTimeoutMs),
    webMaxRetries: normalizeNumber(env.MJ_CODE_WEB_MAX_RETRIES, fileConfig.webMaxRetries, DEFAULTS.webMaxRetries),
    webRetryBudgetMs: normalizeNumber(env.MJ_CODE_WEB_RETRY_BUDGET_MS, fileConfig.webRetryBudgetMs, DEFAULTS.webRetryBudgetMs),
    webCacheTtlMs: normalizeNumber(env.MJ_CODE_WEB_CACHE_TTL_MS, fileConfig.webCacheTtlMs, DEFAULTS.webCacheTtlMs),
    webMaxResults: normalizeNumber(env.MJ_CODE_WEB_MAX_RESULTS, fileConfig.webMaxResults, DEFAULTS.webMaxResults),
    webMaxBodyBytes: normalizeNumber(env.MJ_CODE_WEB_MAX_BODY_BYTES, fileConfig.webMaxBodyBytes, DEFAULTS.webMaxBodyBytes),
    webMaxExtractChars: normalizeNumber(env.MJ_CODE_WEB_MAX_EXTRACT_CHARS, fileConfig.webMaxExtractChars, DEFAULTS.webMaxExtractChars),
    webRankingMode: env.MJ_CODE_WEB_RANKING_MODE || toStringOrNull(fileConfig.webRankingMode) || DEFAULTS.webRankingMode,
    webAllowDomains: env.MJ_CODE_WEB_ALLOW_DOMAINS || fileConfig.webAllowDomains || DEFAULTS.webAllowDomains,
    webDenyDomains: env.MJ_CODE_WEB_DENY_DOMAINS || fileConfig.webDenyDomains || DEFAULTS.webDenyDomains,
    webSearxngEndpoint: env.MJ_CODE_SEARXNG_ENDPOINT || toStringOrNull(fileConfig.webSearxngEndpoint) || DEFAULTS.webSearxngEndpoint,
    mcpEnabled: normalizeBoolean(env.MJ_CODE_MCP_ENABLED, fileConfig.mcpEnabled, DEFAULTS.mcpEnabled),
    mcpTimeoutMs: normalizeNumber(env.MJ_CODE_MCP_TIMEOUT_MS, fileConfig.mcpTimeoutMs, DEFAULTS.mcpTimeoutMs),
    mcpMaxRetries: normalizeNumber(env.MJ_CODE_MCP_MAX_RETRIES, fileConfig.mcpMaxRetries, DEFAULTS.mcpMaxRetries),
    mcpRetryBudgetMs: normalizeNumber(env.MJ_CODE_MCP_RETRY_BUDGET_MS, fileConfig.mcpRetryBudgetMs, DEFAULTS.mcpRetryBudgetMs),
    runtimeCircuitFailureThreshold: normalizeNumber(
      env.MJ_CODE_CIRCUIT_FAILURE_THRESHOLD,
      fileConfig.runtimeCircuitFailureThreshold,
      DEFAULTS.runtimeCircuitFailureThreshold,
    ),
    runtimeCircuitCooldownMs: normalizeNumber(
      env.MJ_CODE_CIRCUIT_COOLDOWN_MS,
      fileConfig.runtimeCircuitCooldownMs,
      DEFAULTS.runtimeCircuitCooldownMs,
    ),
    runtimeCircuitHalfOpenMaxRequests: normalizeNumber(
      env.MJ_CODE_CIRCUIT_HALF_OPEN_MAX_REQUESTS,
      fileConfig.runtimeCircuitHalfOpenMaxRequests,
      DEFAULTS.runtimeCircuitHalfOpenMaxRequests,
    ),
    executionBoundaryMode:
      env.MJ_CODE_EXECUTION_BOUNDARY_MODE ||
      toStringOrNull(fileConfig.executionBoundaryMode) ||
      DEFAULTS.executionBoundaryMode,
    executionEnvAllowlist:
      env.MJ_CODE_EXECUTION_ENV_ALLOWLIST ||
      fileConfig.executionEnvAllowlist ||
      DEFAULTS.executionEnvAllowlist,
    hookTimeoutMs: normalizeNumber(env.MJ_CODE_HOOK_TIMEOUT_MS, fileConfig.hookTimeoutMs, DEFAULTS.hookTimeoutMs),
    shellBufferChars: normalizeNumber(env.MJ_CODE_SHELL_BUFFER_CHARS, fileConfig.shellBufferChars, DEFAULTS.shellBufferChars),
    impactDeadlineMs: normalizeNumber(env.MJ_CODE_IMPACT_DEADLINE_MS, fileConfig.impactDeadlineMs, DEFAULTS.impactDeadlineMs),
    impactCacheTtlMs: normalizeNumber(env.MJ_CODE_IMPACT_CACHE_TTL_MS, fileConfig.impactCacheTtlMs, DEFAULTS.impactCacheTtlMs),
  };
}

function normalizeProvider(provider: string | null, baseUrl: string | null, env: NodeJS.ProcessEnv): string {
  if (provider) {
    return provider;
  }

  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    return "anthropic-compatible";
  }

  if (env.OPENAI_API_KEY) {
    return "openai-compatible";
  }

  if (typeof baseUrl === "string" && baseUrl.includes("anthropic")) {
    return "anthropic-compatible";
  }

  if (provider === "mock") {
    return "mock";
  }

  return "openai-compatible";
}

function normalizeBaseUrl(provider: string | null, baseUrl: string | null): string | null {
  if (baseUrl) {
    return baseUrl;
  }

  if (provider === "mock") {
    return null;
  }

  return provider === "anthropic-compatible" ? "https://api.anthropic.com" : "https://api.openai.com";
}

function normalizeEnum(
  value: EnumValue,
  allowedValues: Set<string>,
  fallback: string,
  label: string,
): string {
  if (value && allowedValues.has(value)) {
    return value;
  }

  if (value == null) {
    return fallback;
  }

  throw new Error(`Unsupported ${label}: "${value}".`);
}

function isObject(value: unknown): value is ConfigObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoolean(envValue: unknown, configValue: unknown, fallback: boolean): boolean {
  const value = envValue ?? configValue;
  if (value == null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = `${value}`.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeNumber(envValue: unknown, configValue: unknown, fallback: number | null): number | null {
  const value = envValue ?? configValue;
  if (value == null) {
    return fallback;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => `${entry}`.trim()).filter(Boolean))];
  }

  if (typeof value === "string") {
    return [...new Set(value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean))];
  }

  return [];
}

function normalizePathArray(value: unknown, fallbacks: string[]): string[] {
  const normalized = normalizeStringArray(value);
  if (normalized.length > 0) {
    return normalized.map((entry) => path.resolve(entry));
  }

  return normalizeStringArray(fallbacks).map((entry) => path.resolve(entry));
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? `${(error as { code?: unknown }).code ?? ""}`
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error ?? ""}`;
}
