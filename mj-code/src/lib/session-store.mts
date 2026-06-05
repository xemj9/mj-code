import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  RepairLoopRecord,
  SessionEventRecord,
  SessionIndexEntry,
  SessionLineageEntry,
  SessionReplay,
  VerifierRunRecord,
} from "../types/contracts.js";

type SessionPayload = Record<string, unknown>;

interface SessionStartMetadata extends SessionPayload {
  provider?: string | null;
  model?: string | null;
  cwd?: string | null;
  networkMode?: string | null;
  webProvider?: string | null;
  parentSessionId?: string | null;
  branchType?: string | null;
  resumedAt?: string | null;
  resumedFromSnapshot?: string | null;
}

interface SessionResumeResult {
  filePath: string;
  sessionId: string;
  parentSessionId: string;
  parentSessionPath: string;
  resumedAt: string;
}

type SessionEvent = SessionEventRecord<SessionPayload>;
type BaseSessionIndexEntry = Omit<SessionIndexEntry, "children" | "branchDepth" | "rootSessionId">;

export class SessionStore {
  readonly sessionDir: string;
  filePath: string | null;
  sessionId: string | null;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
    this.filePath = null;
    this.sessionId = null;
  }

  async start(metadata: SessionStartMetadata = {}): Promise<string> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const id = crypto.randomUUID().slice(0, 8);
    this.sessionId = `${stamp}-${id}`;
    this.filePath = path.join(this.sessionDir, `${this.sessionId}.jsonl`);
    await fs.writeFile(this.filePath, "");
    await this.append("session_started", metadata);
    return this.filePath;
  }

  async resume(reference: string, metadata: SessionStartMetadata = {}): Promise<SessionResumeResult> {
    const parentSessionPath = await this.resolveSessionPath(reference);
    const parentSessionId = path.basename(parentSessionPath, ".jsonl");
    const resumedAt = new Date().toISOString();
    const sessionFilePath = await this.start({
      ...metadata,
      parentSessionId,
      branchType: "resume",
      resumedAt,
      resumedFromSnapshot: toStringOrNull(metadata.resumedFromSnapshot),
    });

    await this.append("session_resumed", {
      parentSessionId,
      parentSessionPath,
      resumedAt,
      resumedFromSnapshot: toStringOrNull(metadata.resumedFromSnapshot),
    });

    return {
      filePath: sessionFilePath,
      sessionId: this.sessionId ?? path.basename(sessionFilePath, ".jsonl"),
      parentSessionId,
      parentSessionPath,
      resumedAt,
    };
  }

  async append(type: string, payload: SessionPayload): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      type,
      payload,
    });

    await fs.appendFile(this.filePath, `${line}\n`);
  }

  async listSessions(limit = 20): Promise<SessionIndexEntry[]> {
    const sessions = await this.loadSessionIndex();
    return sessions.slice(0, limit);
  }

  async loadEvents(reference: string): Promise<SessionEvent[]> {
    const filePath = await this.resolveSessionPath(reference);
    return this.readEventsFromPath(filePath);
  }

  async buildReplay(reference: string): Promise<SessionReplay> {
    const sessions = await this.loadSessionIndex();
    const session = await this.resolveSessionInfo(reference, sessions);
    const events = await this.readEventsFromPath(session.filePath);

    return {
      session: {
        id: session.id,
        provider: session.provider,
        model: session.model,
        cwd: session.cwd,
        networkMode: session.networkMode,
        webProvider: session.webProvider,
        parentSessionId: session.parentSessionId,
        branchType: session.branchType,
      },
      lineage: buildLineage(session, sessions),
      branchEventsSessionId: session.id,
      prompts: events
        .filter((event) => event.type === "user")
        .map((event) => ({
          timestamp: event.timestamp,
          content: toStringOrNull(event.payload.content),
        })),
      context: events
        .filter((event) => event.type === "context_prepared")
        .map((event) => ({
          timestamp: event.timestamp,
          meta: event.payload,
        })),
      approvals: events
        .filter((event) => event.type === "tool_approval")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
      toolCalls: events
        .filter((event) => ["tool_result", "tool_error", "tool_denied"].includes(event.type))
        .map((event) => ({
          timestamp: event.timestamp,
          type: event.type,
          ...event.payload,
        })),
      webEvents: events
        .filter((event) => event.type === "web_event")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
      mcpEvents: events
        .filter((event) => event.type === "mcp_event")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
      hookEvents: events
        .filter((event) => event.type === "hook_event")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
      boundaryDecisions: events
        .filter((event) => event.type === "execution_boundary_decision")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
      sourcePacks: events
        .filter((event) => event.type === "source_pack")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
      changes: events
        .filter((event) => ["change_preview", "change_applied", "rollback"].includes(event.type))
        .map((event) => ({
          timestamp: event.timestamp,
          type: event.type,
          ...event.payload,
        })),
      verifierRuns: events
        .filter((event) => event.type === "verifier_run")
        .map((event) => ({
          timestamp: event.timestamp,
          run: asVerifierRunRecord(event.payload.run),
        })),
      repairLoops: events
        .filter((event) => event.type === "repair_loop")
        .map((event) => ({
          timestamp: event.timestamp,
          loop: asRepairLoopRecord(event.payload.loop),
        })),
      finals: events
        .filter((event) => event.type === "final")
        .map((event) => ({
          timestamp: event.timestamp,
          ...event.payload,
        })),
    };
  }

  async resolveSessionPath(reference: string): Promise<string> {
    const normalized = `${reference ?? ""}`.trim();
    if (!normalized) {
      throw new Error("Missing session reference.");
    }

    await fs.mkdir(this.sessionDir, { recursive: true });
    const directPath = path.join(
      this.sessionDir,
      normalized.endsWith(".jsonl") ? normalized : `${normalized}.jsonl`,
    );
    try {
      await fs.access(directPath);
      return directPath;
    } catch {}

    const entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name === normalized ||
          name === `${normalized}.jsonl` ||
          name.startsWith(normalized) ||
          name.endsWith(`${normalized}.jsonl`),
      );

    if (matches.length === 1) {
      return path.join(this.sessionDir, matches[0]);
    }

    throw new Error(`Could not resolve session "${reference}".`);
  }

  async resolveSessionInfo(
    reference: string,
    sessions: SessionIndexEntry[] | null = null,
  ): Promise<SessionIndexEntry> {
    const targetId = path.basename(await this.resolveSessionPath(reference), ".jsonl");
    const allSessions = sessions ?? (await this.loadSessionIndex());
    const session = allSessions.find((entry) => entry.id === targetId);
    if (!session) {
      throw new Error(`Could not load session metadata for "${reference}".`);
    }
    return session;
  }

  async loadSessionIndex(): Promise<SessionIndexEntry[]> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
    const sessionFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    const rawSessions: BaseSessionIndexEntry[] = [];
    for (const fileName of sessionFiles) {
      const filePath = path.join(this.sessionDir, fileName);
      const events = await this.readEventsFromPath(filePath);
      const sessionStarted = events.find((event) => event.type === "session_started");
      const finalEvent = [...events].reverse().find((event) => event.type === "final");
      const metadata = toSessionMetadata(sessionStarted?.payload);
      rawSessions.push({
        id: path.basename(fileName, ".jsonl"),
        filePath,
        eventCount: events.length,
        startedAt: sessionStarted?.timestamp ?? events[0]?.timestamp ?? null,
        lastUpdatedAt: events.at(-1)?.timestamp ?? null,
        provider: toStringOrNull(metadata.provider),
        model: toStringOrNull(metadata.model),
        cwd: toStringOrNull(metadata.cwd),
        networkMode: toStringOrNull(metadata.networkMode),
        webProvider: toStringOrNull(metadata.webProvider),
        finalContent: toStringOrNull(finalEvent?.payload.content),
        parentSessionId: toStringOrNull(metadata.parentSessionId),
        branchType: toStringOrNull(metadata.branchType) ?? "root",
        resumedAt: toStringOrNull(metadata.resumedAt),
        resumedFromSnapshot: toStringOrNull(metadata.resumedFromSnapshot),
      });
    }

    const byParent = new Map<string, string[]>();
    for (const session of rawSessions) {
      if (!session.parentSessionId) {
        continue;
      }
      const children = byParent.get(session.parentSessionId) ?? [];
      children.push(session.id);
      byParent.set(session.parentSessionId, children);
    }

    const byId = new Map<string, BaseSessionIndexEntry>(
      rawSessions.map((entry) => [entry.id, entry]),
    );
    const depthCache = new Map<string, number>();
    const rootCache = new Map<string, string>();

    return rawSessions.map((session) => ({
      ...session,
      children: [...(byParent.get(session.id) ?? [])].sort(),
      branchDepth: getBranchDepth(session.id, byId, depthCache),
      rootSessionId: getRootSessionId(session.id, byId, rootCache),
    }));
  }

  async readEventsFromPath(filePath: string): Promise<SessionEvent[]> {
    const contents = await fs.readFile(filePath, "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => parseSessionEvent(line));
  }
}

function getBranchDepth(
  sessionId: string,
  byId: Map<string, BaseSessionIndexEntry>,
  cache: Map<string, number>,
): number {
  const cached = cache.get(sessionId);
  if (cached != null) {
    return cached;
  }

  const session = byId.get(sessionId);
  if (!session?.parentSessionId) {
    cache.set(sessionId, 0);
    return 0;
  }

  const depth = getBranchDepth(session.parentSessionId, byId, cache) + 1;
  cache.set(sessionId, depth);
  return depth;
}

function getRootSessionId(
  sessionId: string,
  byId: Map<string, BaseSessionIndexEntry>,
  cache: Map<string, string>,
): string {
  const cached = cache.get(sessionId);
  if (cached) {
    return cached;
  }

  const session = byId.get(sessionId);
  if (!session?.parentSessionId || !byId.has(session.parentSessionId)) {
    cache.set(sessionId, sessionId);
    return sessionId;
  }

  const rootId = getRootSessionId(session.parentSessionId, byId, cache);
  cache.set(sessionId, rootId);
  return rootId;
}

function buildLineage(
  session: SessionIndexEntry,
  sessions: SessionIndexEntry[],
): SessionReplay["lineage"] {
  const byId = new Map<string, SessionIndexEntry>(sessions.map((entry) => [entry.id, entry]));
  const ancestors: SessionLineageEntry[] = [];
  let currentParentId = session.parentSessionId;

  while (currentParentId) {
    const parent = byId.get(currentParentId);
    if (!parent) {
      break;
    }
    ancestors.push(minifySession(parent));
    currentParentId = parent.parentSessionId;
  }

  return {
    rootSessionId: session.rootSessionId,
    parentSessionId: session.parentSessionId,
    branchDepth: session.branchDepth,
    branchType: session.branchType,
    resumedAt: session.resumedAt,
    resumedFromSnapshot: session.resumedFromSnapshot,
    ancestors,
    children: session.children
      .map((childId) => byId.get(childId))
      .filter((child): child is SessionIndexEntry => Boolean(child))
      .map((child) => minifySession(child)),
  };
}

function minifySession(session: SessionIndexEntry): SessionLineageEntry {
  return {
    id: session.id,
    parentSessionId: session.parentSessionId,
    branchType: session.branchType,
    startedAt: session.startedAt,
    lastUpdatedAt: session.lastUpdatedAt,
    finalContent: session.finalContent,
  };
}

function parseSessionEvent(line: string): SessionEvent {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  return {
    timestamp: toStringOrNull(parsed.timestamp) ?? new Date(0).toISOString(),
    sessionId: toStringOrNull(parsed.sessionId) ?? "unknown",
    type: toStringOrNull(parsed.type) ?? "unknown",
    payload: toRecord(parsed.payload),
  };
}

function toSessionMetadata(value: unknown): SessionStartMetadata {
  return toRecord(value) as SessionStartMetadata;
}

function toRecord(value: unknown): SessionPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SessionPayload)
    : {};
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asVerifierRunRecord(value: unknown): VerifierRunRecord {
  return value && typeof value === "object"
    ? structuredClone(value) as VerifierRunRecord
    : {
        traceId: null,
        step: null,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(0).toISOString(),
        plan: {
          required: false,
          trigger: "none",
          reason: "Unavailable verifier payload.",
          checks: [],
        },
        checks: [],
        summary: {
          status: "unavailable",
          passed: false,
          totalChecks: 0,
          passedChecks: 0,
          failedChecks: 0,
          skippedChecks: 0,
          findings: 0,
          failureCategories: ["unavailable"],
          summary: "Verifier payload was unavailable.",
          durationMs: 0,
        },
      };
}

function asRepairLoopRecord(value: unknown): RepairLoopRecord {
  return value && typeof value === "object"
    ? structuredClone(value) as RepairLoopRecord
    : {
        traceId: null,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(0).toISOString(),
        maxAttempts: 0,
        initialVerifierStartedAt: new Date(0).toISOString(),
        initialVerifierStep: null,
        initialFailureCategories: [],
        attempts: [],
        summary: {
          status: "stopped",
          attemptsUsed: 0,
          maxAttempts: 0,
          attemptsRemaining: 0,
          lastDecision: null,
          stopReason: "no_actionable_findings",
          triggeredByVerifierStartedAt: null,
          latestProgress: "none",
          progressTrend: "none",
          resolvedAttemptCount: 0,
          improvedAttemptCount: 0,
          unchangedAttemptCount: 0,
          regressedAttemptCount: 0,
          notApplicableAttemptCount: 0,
          resolvedDiagnosticCount: 0,
          persistedDiagnosticCount: 0,
          introducedDiagnosticCount: 0,
          codeActionAppliedCount: 0,
          codeActionBlockedCount: 0,
          latestCodeActionStatus: "none",
          summary: "Repair payload was unavailable.",
        },
      };
}
