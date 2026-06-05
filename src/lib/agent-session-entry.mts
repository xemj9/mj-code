import path from "node:path";

import { bootstrapRuntime } from "./agent-runtime.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";

import type { LoadedConfig } from "../config.mjs";
import type { ProviderAdapter } from "../providers/index.mjs";
import type { AgentBootstrapOptions, AgentTerminalUi } from "../types/agent-facade.js";
import type { InstructionPack } from "../types/contracts.js";
import type { RuntimeHealth } from "./runtime-health.mjs";

type ProviderLike = ProviderAdapter;

interface SessionStoreLike {
  sessionId: string | null;
  start(metadata?: Record<string, unknown>): Promise<string>;
  resolveSessionPath(reference: string): Promise<string>;
  resume(reference: string, metadata?: Record<string, unknown>): Promise<{
    filePath: string;
    sessionId: string;
    parentSessionId: string | null;
  }>;
  append(type: string, payload?: unknown): Promise<unknown>;
}

interface SourceRegistryLike {
  initialize(sessionId: string): Promise<void>;
}

interface MemoryStoreLike {
  initialize(input: {
    sessionFilePath: string;
    projectInstructions?: { files?: string[] } | null;
  }): Promise<void>;
  listSnapshot(): Promise<unknown>;
  attachSessionFilePath(sessionFilePath: string): void;
}

type ExecutionJournalLike = Pick<
  SharedExecutionJournalLike,
  "start" | "loadLatestSnapshot" | "recordPhase"
>;

interface SessionSnapshotTarget {
  traceId: string | null;
  phase: string;
  stepId: string | number;
  outputSummary: string;
}

export type AgentSessionEntryBootstrapArgs = [
  config: LoadedConfig,
  ui: AgentTerminalUi,
  provider: ProviderLike,
  projectInstructions: InstructionPack,
  runtimeHealth: RuntimeHealth | null,
];

export interface AgentSessionEntryLike {
  config: LoadedConfig;
  sessionStore: SessionStoreLike;
  sourceRegistry: SourceRegistryLike;
  memoryStore: MemoryStoreLike;
  executionJournal: ExecutionJournalLike;
  sessionFilePath: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  resumedFromSessionId: string | null;
  resumeSnapshotPath: string | null;
  projectInstructions: InstructionPack;
  initializeStores(): Promise<void>;
  bindRuntimeSession(): Promise<void>;
  captureStateSnapshot(input: SessionSnapshotTarget): Promise<unknown>;
  hydrateFromSnapshot(snapshot: Record<string, unknown>): void;
  afterSessionEntry?(trigger: "create" | "resume"): Promise<void> | void;
}

export interface AgentSessionEntryConstructor<T extends AgentSessionEntryLike> {
  new(...args: AgentSessionEntryBootstrapArgs): T;
}

export async function createAgentSessionEntry<TConstructor extends AgentSessionEntryConstructor<AgentSessionEntryLike>>(
  AgentClass: TConstructor,
  options: AgentBootstrapOptions,
  ui: AgentTerminalUi,
): Promise<InstanceType<TConstructor>> {
  const runtime = await bootstrapRuntime(options as Record<string, unknown>);
  const agent = new AgentClass(
    runtime.config,
    ui,
    runtime.provider,
    runtime.projectInstructions,
    runtime.runtimeHealth,
  ) as InstanceType<TConstructor>;
  await agent.initializeStores();
  agent.sessionFilePath = await agent.sessionStore.start({
    provider: runtime.config.provider,
    model: runtime.config.model,
    cwd: runtime.config.cwd,
    permissionMode: runtime.config.permissionMode,
    approvalPolicy: runtime.config.approvalPolicy,
    networkMode: runtime.config.networkMode,
    webProvider: runtime.config.webProvider,
  });
  agent.sessionId = agent.sessionStore.sessionId;
  if (agent.sessionId) {
    await agent.sourceRegistry.initialize(agent.sessionId);
  }
  await agent.memoryStore.initialize({
    sessionFilePath: agent.sessionFilePath,
    projectInstructions: runtime.projectInstructions,
  });
  await agent.sessionStore.append("memory_initialized", await agent.memoryStore.listSnapshot());
  if (agent.sessionId) {
    await agent.executionJournal.start(agent.sessionId, {
      provider: runtime.config.provider,
      model: runtime.config.model,
      cwd: runtime.config.cwd,
    });
  }
  await agent.bindRuntimeSession();
  await agent.captureStateSnapshot({
    phase: "planning",
    stepId: "bootstrap",
    traceId: null,
    outputSummary: "New session initialized.",
  });
  await agent.afterSessionEntry?.("create");
  return agent;
}

export async function inspectAgentSessionEntry<TConstructor extends AgentSessionEntryConstructor<AgentSessionEntryLike>>(
  AgentClass: TConstructor,
  options: AgentBootstrapOptions,
  ui: AgentTerminalUi,
): Promise<InstanceType<TConstructor>> {
  const runtime = await bootstrapRuntime(options as Record<string, unknown>);
  const agent = new AgentClass(
    runtime.config,
    ui,
    runtime.provider,
    runtime.projectInstructions,
    runtime.runtimeHealth,
  ) as InstanceType<TConstructor>;
  agent.memoryStore.attachSessionFilePath(
    path.join(runtime.config.sessionDir, "_inspect.jsonl"),
  );
  await agent.initializeStores();
  return agent;
}

export async function resumeAgentSessionEntry<TConstructor extends AgentSessionEntryConstructor<AgentSessionEntryLike>>(
  AgentClass: TConstructor,
  options: AgentBootstrapOptions,
  ui: AgentTerminalUi,
  sessionReference: string,
): Promise<InstanceType<TConstructor>> {
  const runtime = await bootstrapRuntime(options as Record<string, unknown>);
  const agent = new AgentClass(
    runtime.config,
    ui,
    runtime.provider,
    runtime.projectInstructions,
    runtime.runtimeHealth,
  ) as InstanceType<TConstructor>;
  await agent.initializeStores();
  const parentSessionId = path.basename(
    await agent.sessionStore.resolveSessionPath(sessionReference),
    ".jsonl",
  );
  const snapshot = await agent.executionJournal.loadLatestSnapshot(parentSessionId);
  const branch = await agent.sessionStore.resume(sessionReference, {
    provider: runtime.config.provider,
    model: runtime.config.model,
    cwd: runtime.config.cwd,
    permissionMode: runtime.config.permissionMode,
    approvalPolicy: runtime.config.approvalPolicy,
    networkMode: runtime.config.networkMode,
    webProvider: runtime.config.webProvider,
    resumedFromSnapshot: snapshot?.filePath ?? null,
  });
  agent.sessionFilePath = branch.filePath;
  agent.sessionId = branch.sessionId;
  agent.parentSessionId = branch.parentSessionId;
  agent.resumedFromSessionId = branch.parentSessionId;
  agent.resumeSnapshotPath = snapshot?.filePath ?? null;
  if (agent.sessionId) {
    await agent.sourceRegistry.initialize(agent.sessionId);
  }
  await agent.memoryStore.initialize({
    sessionFilePath: agent.sessionFilePath,
    projectInstructions: runtime.projectInstructions,
  });
  if (agent.sessionId) {
    await agent.executionJournal.start(agent.sessionId, {
      provider: runtime.config.provider,
      model: runtime.config.model,
      cwd: runtime.config.cwd,
      parentSessionId: branch.parentSessionId,
      resumedFromSnapshot: snapshot?.filePath ?? null,
    });
  }
  await agent.bindRuntimeSession();
  if (snapshot?.state) {
    agent.hydrateFromSnapshot(snapshot.state);
    await agent.sessionStore.append("resume_state_loaded", {
      parentSessionId: branch.parentSessionId,
      snapshot: snapshot.filePath,
    });
    await agent.executionJournal.recordPhase({
      traceId: null,
      stepId: "resume",
      phase: "planning",
      outputSummary: `Resumed from snapshot ${path.basename(snapshot.filePath)}.`,
      snapshot: snapshot.filePath,
    });
  }
  await agent.captureStateSnapshot({
    traceId: null,
    phase: "planning",
    stepId: "resume",
    outputSummary: "Resumed session initialized.",
  });
  await agent.afterSessionEntry?.("resume");
  return agent;
}
