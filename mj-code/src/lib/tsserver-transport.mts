import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

const require = createRequire(import.meta.url);

const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
const MAX_STDERR_TAIL = 4_000;
const MAX_EVENT_HISTORY = 200;
const TSSERVER_CONFIG_DIAGNOSTICS_COMMAND = "compilerOptionsDiagnostics-full";

interface TsServerProtocolMessage {
  type?: string;
}

interface TsServerProtocolResponse extends TsServerProtocolMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

interface TsServerProtocolEvent extends TsServerProtocolMessage {
  type: "event";
  event: string;
  body?: unknown;
}

interface TsServerLocation {
  line?: number;
  offset?: number;
}

interface TsServerDiagnosticRelatedInformation {
  category?: string;
  code?: number;
  message?: string;
  span?: {
    file?: string;
    start?: TsServerLocation;
    end?: TsServerLocation;
  };
}

interface TsServerDiagnosticBody {
  fileName?: string;
  message?: string;
  text?: string;
  category?: string;
  code?: number;
  source?: string;
  startLocation?: TsServerLocation;
  endLocation?: TsServerLocation;
  start?: TsServerLocation;
  end?: TsServerLocation;
  relatedInformation?: TsServerDiagnosticRelatedInformation[];
}

interface TsServerProjectInfoBody {
  configFileName?: string;
  fileNames?: string[];
  languageServiceDisabled?: boolean;
  configuredProjectInfo?: {
    defaultProject?: string;
  };
}

interface TsServerProtocolCodeEditBody {
  start?: TsServerLocation;
  end?: TsServerLocation;
  newText?: string;
}

interface TsServerProtocolFileCodeEditsBody {
  fileName?: string;
  textChanges?: TsServerProtocolCodeEditBody[];
  isNewFile?: boolean;
}

interface TsServerProtocolCodeFixBody {
  description?: string;
  changes?: TsServerProtocolFileCodeEditsBody[];
  fixName?: string;
  fixId?: unknown;
  fixAllDescription?: string;
}

interface TsServerQuickInfoBody {
  kind?: string;
  kindModifiers?: string;
  displayString?: string;
  documentation?: unknown;
  start?: TsServerLocation;
  end?: TsServerLocation;
}

interface TsServerDefinitionBody {
  file?: string;
  start?: TsServerLocation;
  end?: TsServerLocation;
  kind?: string;
  name?: string;
  containerName?: string;
}

interface TsServerImplementationBody {
  file?: string;
  start?: TsServerLocation;
  end?: TsServerLocation;
  contextStart?: TsServerLocation;
  contextEnd?: TsServerLocation;
}

interface TsServerReferenceBody {
  file?: string;
  start?: TsServerLocation;
  end?: TsServerLocation;
  lineText?: string;
  isDefinition?: boolean;
  isWriteAccess?: boolean;
}

interface TsServerReferencesBody {
  refs?: TsServerReferenceBody[];
}

interface TsServerTextSpanBody {
  start?: TsServerLocation;
  end?: TsServerLocation;
}

interface TsServerNavigationTreeBody {
  text?: string;
  kind?: string;
  kindModifiers?: string;
  spans?: TsServerTextSpanBody[];
  nameSpan?: TsServerTextSpanBody;
  childItems?: TsServerNavigationTreeBody[];
}

interface PendingRequest {
  command: string;
  resolve: (body: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface TsServerTransportOptions {
  cwd?: string | null;
  serverPath?: string | null;
  command?: string | null;
  args?: string[];
  requestTimeoutMs?: number;
}

export interface TsServerTransportRequestOptions {
  timeoutMs?: number;
}

export interface TsServerTransportFailure extends Error {
  code: string;
  details: {
    command?: string | null;
    requestCommand?: string | null;
    serverPath?: string | null;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stderrTail?: string | null;
  };
}

export interface TsServerTransportEventRecord {
  index: number;
  event: string;
  receivedAt: string;
  body: unknown;
}

export interface TsServerProjectInfo {
  configFileName: string | null;
  isInferredProject: boolean;
  languageServiceEnabled: boolean;
  fileNames: string[];
  defaultProject: string | null;
}

export interface TsServerProtocolRelatedLocation {
  path: string | null;
  line: number | null;
  column: number | null;
  message: string | null;
  category: string | null;
  code: string | null;
}

export interface TsServerProtocolDiagnostic {
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  message: string;
  category: string;
  code: string | null;
  source: string | null;
  related: TsServerProtocolRelatedLocation[];
}

export interface TsServerConfigDiagnosticEvent {
  triggerFile: string;
  configFile: string;
  diagnostics: TsServerProtocolDiagnostic[];
}

export interface TsServerProtocolCodeFixChange {
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  newText: string;
}

export interface TsServerProtocolCodeFixFileChange {
  path: string | null;
  isNewFile: boolean;
  changeCount: number;
  changes: TsServerProtocolCodeFixChange[];
}

export interface TsServerProtocolCodeFix {
  description: string;
  fixName: string | null;
  fixId: string | null;
  fixAllDescription: string | null;
  changes: TsServerProtocolCodeFixFileChange[];
}

export interface TsServerProtocolQuickInfo {
  kind: string | null;
  kindModifiers: string | null;
  displayText: string | null;
  documentation: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
}

export interface TsServerProtocolDefinition {
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  kind: string | null;
  name: string | null;
  containerName: string | null;
}

export interface TsServerProtocolReference {
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  lineText: string | null;
  isDefinition: boolean;
  isWriteAccess: boolean;
}

export interface TsServerProtocolImplementation {
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  contextStartLine: number | null;
  contextStartColumn: number | null;
  contextEndLine: number | null;
  contextEndColumn: number | null;
}

export interface TsServerProtocolDocumentSymbol {
  path: string | null;
  name: string | null;
  kind: string | null;
  kindModifiers: string | null;
  containerName: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  depth: number;
  childCount: number;
}

export function resolveDefaultTsServerPath(): string | null {
  try {
    return require.resolve("typescript/lib/tsserver.js");
  } catch {
    return null;
  }
}

export function isTsServerTransportFailure(error: unknown): error is TsServerTransportFailure {
  return error instanceof Error && typeof (error as TsServerTransportFailure).code === "string";
}

export class TsServerTransport {
  readonly cwd: string;
  readonly serverPath: string | null;
  readonly command: string | null;
  readonly args: string[];
  readonly requestTimeoutMs: number;
  child: ChildProcessWithoutNullStreams | null;
  connected: boolean;
  closed: boolean;
  buffer: Buffer;
  pending: Map<number, PendingRequest>;
  requestSeq: number;
  stderrTail: string;
  eventLog: TsServerTransportEventRecord[];
  eventIndex: number;

  constructor(options: TsServerTransportOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.serverPath = options.serverPath ?? resolveDefaultTsServerPath();
    this.command = options.command ?? null;
    this.args = Array.isArray(options.args) ? [...options.args] : [];
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.child = null;
    this.connected = false;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.requestSeq = 1;
    this.stderrTail = "";
    this.eventLog = [];
    this.eventIndex = 0;
  }

  get available(): boolean {
    return Boolean(this.command || this.serverPath);
  }

  getEventCursor(): number {
    return this.eventIndex;
  }

  getEventsSince(cursor: number): TsServerTransportEventRecord[] {
    return this.eventLog
      .filter((entry) => entry.index > cursor)
      .map((entry) => ({
        index: entry.index,
        event: entry.event,
        receivedAt: entry.receivedAt,
        body: cloneEventBody(entry.body),
      }));
  }

  async connect(): Promise<void> {
    if (this.child && !this.closed && this.connected) {
      return;
    }

    const spawnCommand = this.command ?? process.execPath;
    const spawnArgs = this.command
      ? [...this.args]
      : buildDefaultSpawnArgs(this.serverPath, this.args);
    if (spawnArgs == null) {
      throw createTransportFailure(
        "transport_unavailable",
        "TypeScript tsserver transport is unavailable because tsserver.js could not be resolved.",
        {
          command: spawnCommand,
          serverPath: this.serverPath,
        },
      );
    }

    this.child = spawn(spawnCommand, spawnArgs, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    maybeUnrefHandle(this.child);
    maybeUnrefHandle(this.child.stdout);
    maybeUnrefHandle(this.child.stderr);
    this.closed = false;
    this.connected = true;
    this.buffer = Buffer.alloc(0);

    const child = this.child;
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).catch((error) => {
        this.failAllPending(error);
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = `${chunk}`;
      this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_TAIL);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.connected = false;
      this.closed = true;
      this.failAllPending(
        createTransportFailure(
          "transport_spawn_failed",
          `tsserver transport failed to spawn: ${error.message}`,
          {
            command: spawnCommand,
            serverPath: this.serverPath,
            stderrTail: this.stderrTail || null,
          },
        ),
      );
    });
    child.on("exit", (code, signal) => {
      this.connected = false;
      this.closed = true;
      this.failAllPending(
        createTransportFailure(
          "transport_exited",
          `tsserver transport exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
          {
            command: spawnCommand,
            serverPath: this.serverPath,
            exitCode: code,
            signal,
            stderrTail: this.stderrTail || null,
          },
        ),
      );
    });
  }

  async openFile(input: {
    filePath: string;
    fileContent: string;
    projectRootPath?: string | null;
    scriptKindName?: "TS" | "JS" | "TSX" | "JSX";
  }): Promise<void> {
    await this.request("open", {
      file: path.resolve(input.filePath),
      fileContent: input.fileContent,
      projectRootPath: input.projectRootPath ? path.resolve(input.projectRootPath) : undefined,
      scriptKindName: input.scriptKindName,
    });
  }

  async closeFile(filePath: string): Promise<void> {
    await this.request("close", {
      file: path.resolve(filePath),
    }, {
      timeoutMs: Math.min(this.requestTimeoutMs, 2_000),
    });
  }

  async getProjectInfo(filePath: string): Promise<TsServerProjectInfo> {
    const body = await this.request<TsServerProjectInfoBody>("projectInfo", {
      file: path.resolve(filePath),
      needFileNameList: true,
      needDefaultConfiguredProjectInfo: true,
    });
    const configFileName = typeof body?.configFileName === "string" && body.configFileName.length > 0
      ? body.configFileName
      : null;
    return {
      configFileName,
      isInferredProject: isInferredProjectName(configFileName),
      languageServiceEnabled: body?.languageServiceDisabled !== true,
      fileNames: Array.isArray(body?.fileNames)
        ? body.fileNames
            .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
            .map((entry) => path.resolve(entry))
        : [],
      defaultProject:
        typeof body?.configuredProjectInfo?.defaultProject === "string" &&
        body.configuredProjectInfo.defaultProject.length > 0
          ? body.configuredProjectInfo.defaultProject
          : null,
    };
  }

  async getSyntacticDiagnostics(filePath: string): Promise<TsServerProtocolDiagnostic[]> {
    const body = await this.request<TsServerDiagnosticBody[]>("syntacticDiagnosticsSync", {
      file: path.resolve(filePath),
      includeLinePosition: true,
    });
    return normalizeProtocolDiagnostics(body, path.resolve(filePath));
  }

  async getSemanticDiagnostics(filePath: string): Promise<TsServerProtocolDiagnostic[]> {
    const body = await this.request<TsServerDiagnosticBody[]>("semanticDiagnosticsSync", {
      file: path.resolve(filePath),
      includeLinePosition: true,
    });
    return normalizeProtocolDiagnostics(body, path.resolve(filePath));
  }

  async getSuggestionDiagnostics(filePath: string): Promise<TsServerProtocolDiagnostic[]> {
    const body = await this.request<TsServerDiagnosticBody[]>("suggestionDiagnosticsSync", {
      file: path.resolve(filePath),
      includeLinePosition: true,
    });
    return normalizeProtocolDiagnostics(body, path.resolve(filePath));
  }

  async getCompilerOptionsDiagnostics(projectFileName: string): Promise<TsServerProtocolDiagnostic[]> {
    const body = await this.request<TsServerDiagnosticBody[]>(TSSERVER_CONFIG_DIAGNOSTICS_COMMAND, {
      projectFileName: path.resolve(projectFileName),
    });
    return normalizeProtocolDiagnostics(body, path.resolve(projectFileName));
  }

  async getCodeFixes(input: {
    filePath: string;
    startLine: number;
    startOffset: number;
    endLine: number;
    endOffset: number;
    errorCodes: number[];
  }): Promise<TsServerProtocolCodeFix[]> {
    const body = await this.request<TsServerProtocolCodeFixBody[]>("getCodeFixes", {
      file: path.resolve(input.filePath),
      startLine: input.startLine,
      startOffset: input.startOffset,
      endLine: input.endLine,
      endOffset: input.endOffset,
      errorCodes: input.errorCodes,
    });
    return normalizeProtocolCodeFixes(body);
  }

  async getQuickInfo(input: {
    filePath: string;
    line: number;
    offset: number;
  }): Promise<TsServerProtocolQuickInfo | null> {
    const body = await this.request<TsServerQuickInfoBody | null>("quickinfo", {
      file: path.resolve(input.filePath),
      line: input.line,
      offset: input.offset,
    });
    return normalizeProtocolQuickInfo(body);
  }

  async getDefinitions(input: {
    filePath: string;
    line: number;
    offset: number;
  }): Promise<TsServerProtocolDefinition[]> {
    const body = await this.request<TsServerDefinitionBody[]>("definition", {
      file: path.resolve(input.filePath),
      line: input.line,
      offset: input.offset,
    });
    return normalizeProtocolDefinitions(body);
  }

  async getReferences(input: {
    filePath: string;
    line: number;
    offset: number;
  }): Promise<TsServerProtocolReference[]> {
    const body = await this.request<TsServerReferenceBody[] | TsServerReferencesBody>("references", {
      file: path.resolve(input.filePath),
      line: input.line,
      offset: input.offset,
    });
    return normalizeProtocolReferencesBody(body);
  }

  async getImplementations(input: {
    filePath: string;
    line: number;
    offset: number;
  }): Promise<TsServerProtocolImplementation[]> {
    const body = await this.request<TsServerImplementationBody[]>("implementation", {
      file: path.resolve(input.filePath),
      line: input.line,
      offset: input.offset,
    });
    return normalizeProtocolImplementations(body);
  }

  async getDocumentSymbols(filePath: string): Promise<TsServerProtocolDocumentSymbol[]> {
    const resolvedPath = path.resolve(filePath);
    const body = await this.request<TsServerNavigationTreeBody | null>("navtree", {
      file: resolvedPath,
    });
    return normalizeProtocolDocumentSymbols(body, resolvedPath);
  }

  async request<T>(command: string, args: Record<string, unknown>, options: TsServerTransportRequestOptions = {}): Promise<T> {
    await this.connect();
    const child = this.requireChild();
    const seq = this.requestSeq++;
    const timeoutMs = Number(options.timeoutMs ?? this.requestTimeoutMs);
    const message = JSON.stringify({
      seq,
      type: "request" as const,
      command,
      arguments: args,
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(createTransportFailure(
          "transport_timeout",
          `tsserver request "${command}" timed out after ${timeoutMs}ms.`,
          {
            requestCommand: command,
            command: this.command ?? process.execPath,
            serverPath: this.serverPath,
            stderrTail: this.stderrTail || null,
          },
        ));
      }, timeoutMs);
      timer.unref();

      this.pending.set(seq, {
        command,
        resolve: (body: unknown) => {
          clearTimeout(timer);
          resolve(body as T);
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });

      try {
        // tsserver accepts newline-delimited JSON requests and emits Content-Length framed responses.
        child.stdin.write(`${message}\n`);
      } catch (error) {
        this.pending.delete(seq);
        clearTimeout(timer);
        reject(createTransportFailure(
          "transport_write_failed",
          `tsserver request "${command}" could not be written: ${toErrorMessage(error)}`,
          {
            requestCommand: command,
            command: this.command ?? process.execPath,
            serverPath: this.serverPath,
            stderrTail: this.stderrTail || null,
          },
        ));
      }
    });
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) {
      return;
    }
    this.closed = true;
    this.connected = false;
    const child = this.child;
    if (child.exitCode != null || child.killed) {
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify({
        seq: this.requestSeq++,
        type: "request",
        command: "exit",
      })}\n`);
    } catch {
      // ignore and proceed with shutdown
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 300).unref();
      }, 250);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child || this.closed) {
      throw createTransportFailure(
        "transport_unavailable",
        "tsserver transport is not connected.",
        {
          command: this.command ?? process.execPath,
          serverPath: this.serverPath,
          stderrTail: this.stderrTail || null,
        },
      );
    }
    return this.child;
  }

  private async handleStdout(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(headerText);
      if (contentLength == null) {
        throw createTransportFailure(
          "transport_protocol_error",
          "tsserver transport emitted a message without a valid Content-Length header.",
          {
            command: this.command ?? process.execPath,
            serverPath: this.serverPath,
            stderrTail: this.stderrTail || null,
          },
        );
      }
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) {
        return;
      }
      const payload = this.buffer.subarray(headerEnd + 4, totalLength);
      this.buffer = this.buffer.subarray(totalLength);
      const message = parseProtocolMessage(payload);
      this.handleMessage(message);
    }
  }

  private handleMessage(message: TsServerProtocolMessage): void {
    if (message.type === "response") {
      const response = message as TsServerProtocolResponse;
      const pending = this.pending.get(response.request_seq);
      if (!pending) {
        return;
      }
      this.pending.delete(response.request_seq);
      if (!response.success) {
        pending.reject(createTransportFailure(
          "transport_request_failed",
          response.message || `tsserver request "${pending.command}" failed.`,
          {
            requestCommand: pending.command,
            command: this.command ?? process.execPath,
            serverPath: this.serverPath,
            stderrTail: this.stderrTail || null,
          },
        ));
        return;
      }
      pending.resolve(response.body);
      return;
    }

    if (message.type === "event") {
      const event = message as TsServerProtocolEvent;
      this.eventIndex += 1;
      this.eventLog.push({
        index: this.eventIndex,
        event: event.event,
        receivedAt: new Date().toISOString(),
        body: cloneEventBody(event.body),
      });
      if (this.eventLog.length > MAX_EVENT_HISTORY) {
        this.eventLog.splice(0, this.eventLog.length - MAX_EVENT_HISTORY);
      }
    }
  }

  private failAllPending(error: unknown): void {
    for (const [seq, pending] of this.pending.entries()) {
      this.pending.delete(seq);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function extractConfigFileDiagnosticEvents(
  events: TsServerTransportEventRecord[],
): TsServerConfigDiagnosticEvent[] {
  return events
    .filter((entry) => entry.event === "configFileDiag")
    .map((entry) => normalizeConfigFileDiagEvent(entry.body))
    .filter((entry): entry is TsServerConfigDiagnosticEvent => entry != null);
}

function normalizeConfigFileDiagEvent(body: unknown): TsServerConfigDiagnosticEvent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as {
    triggerFile?: unknown;
    configFile?: unknown;
    diagnostics?: unknown;
  };
  if (typeof record.triggerFile !== "string" || typeof record.configFile !== "string") {
    return null;
  }
  return {
    triggerFile: path.resolve(record.triggerFile),
    configFile: path.resolve(record.configFile),
    diagnostics: normalizeProtocolDiagnostics(
      Array.isArray(record.diagnostics) ? record.diagnostics as TsServerDiagnosticBody[] : [],
      path.resolve(record.configFile),
    ),
  };
}

function buildDefaultSpawnArgs(serverPath: string | null, args: string[]): string[] | null {
  if (!serverPath) {
    return null;
  }
  return [
    serverPath,
    "--disableAutomaticTypingAcquisition",
    ...args,
  ];
}

function parseContentLength(headerText: string): number | null {
  const match = /Content-Length:\s*(\d+)/i.exec(headerText);
  return match ? Number(match[1]) : null;
}

function parseProtocolMessage(payload: Buffer): TsServerProtocolMessage {
  let messageText = payload.toString("utf8");
  if (messageText.endsWith("\n")) {
    messageText = messageText.slice(0, -1);
  }
  if (messageText.endsWith("\r")) {
    messageText = messageText.slice(0, -1);
  }
  try {
    const parsed = JSON.parse(messageText) as TsServerProtocolMessage;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("tsserver message payload was not an object.");
    }
    return parsed;
  } catch (error) {
    throw createTransportFailure(
      "transport_protocol_error",
      `tsserver transport emitted invalid JSON: ${toErrorMessage(error)}`,
      {
        stderrTail: messageText.slice(0, 500),
      },
    );
  }
}

function normalizeProtocolDiagnostics(
  diagnostics: TsServerDiagnosticBody[] | undefined,
  fallbackPath: string | null,
): TsServerProtocolDiagnostic[] {
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics.map((diagnostic) => {
    const start = readLocation(diagnostic.startLocation ?? diagnostic.start);
    const end = readLocation(diagnostic.endLocation ?? diagnostic.end);
    return {
      path: typeof diagnostic.fileName === "string" && diagnostic.fileName.length > 0
        ? path.resolve(diagnostic.fileName)
        : fallbackPath,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      message: diagnostic.message ?? diagnostic.text ?? "Unknown tsserver diagnostic.",
      category: typeof diagnostic.category === "string" && diagnostic.category.length > 0
        ? diagnostic.category
        : "error",
      code: diagnostic.code != null ? `${diagnostic.code}` : null,
      source: typeof diagnostic.source === "string" && diagnostic.source.length > 0
        ? diagnostic.source
        : null,
      related: Array.isArray(diagnostic.relatedInformation)
        ? diagnostic.relatedInformation.map((entry) => ({
            path: typeof entry.span?.file === "string" && entry.span.file.length > 0
              ? path.resolve(entry.span.file)
              : null,
            line: readLocation(entry.span?.start).line,
            column: readLocation(entry.span?.start).column,
            message: typeof entry.message === "string" ? entry.message : null,
            category: typeof entry.category === "string" ? entry.category : null,
            code: entry.code != null ? `${entry.code}` : null,
          }))
        : [],
    };
  });
}

function normalizeProtocolCodeFixes(
  fixes: TsServerProtocolCodeFixBody[] | undefined,
): TsServerProtocolCodeFix[] {
  if (!Array.isArray(fixes)) {
    return [];
  }
  return fixes
    .map((fix) => ({
      description: typeof fix.description === "string" && fix.description.length > 0
        ? fix.description
        : "Unknown tsserver code fix.",
      fixName: typeof fix.fixName === "string" && fix.fixName.length > 0
        ? fix.fixName
        : null,
      fixId: serializeProtocolFixId(fix.fixId),
      fixAllDescription: typeof fix.fixAllDescription === "string" && fix.fixAllDescription.length > 0
        ? fix.fixAllDescription
        : null,
      changes: Array.isArray(fix.changes)
        ? fix.changes.map((change) => ({
            path: typeof change.fileName === "string" && change.fileName.length > 0
              ? path.resolve(change.fileName)
              : null,
            isNewFile: change.isNewFile === true,
            changeCount: Array.isArray(change.textChanges) ? change.textChanges.length : 0,
            changes: Array.isArray(change.textChanges)
              ? change.textChanges.map((edit) => ({
                  startLine: readLocation(edit.start).line,
                  startColumn: readLocation(edit.start).column,
                  endLine: readLocation(edit.end).line,
                  endColumn: readLocation(edit.end).column,
                  newText: typeof edit.newText === "string" ? edit.newText : "",
                }))
              : [],
          }))
        : [],
    }))
    .filter((fix) => fix.changes.length > 0);
}

function normalizeProtocolQuickInfo(
  body: TsServerQuickInfoBody | null | undefined,
): TsServerProtocolQuickInfo | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const start = readLocation(body.start);
  const end = readLocation(body.end);
  return {
    kind: typeof body.kind === "string" && body.kind.length > 0 ? body.kind : null,
    kindModifiers: typeof body.kindModifiers === "string" && body.kindModifiers.length > 0
      ? body.kindModifiers
      : null,
    displayText: typeof body.displayString === "string" && body.displayString.length > 0
      ? body.displayString
      : null,
    documentation: normalizeProtocolText(body.documentation),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function normalizeProtocolDefinitions(
  definitions: TsServerDefinitionBody[] | undefined,
): TsServerProtocolDefinition[] {
  if (!Array.isArray(definitions)) {
    return [];
  }
  return definitions.map((definition) => {
    const start = readLocation(definition.start);
    const end = readLocation(definition.end);
    return {
      path: typeof definition.file === "string" && definition.file.length > 0
        ? path.resolve(definition.file)
        : null,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      kind: typeof definition.kind === "string" && definition.kind.length > 0
        ? definition.kind
        : null,
      name: typeof definition.name === "string" && definition.name.length > 0
        ? definition.name
        : null,
      containerName: typeof definition.containerName === "string" && definition.containerName.length > 0
        ? definition.containerName
        : null,
    };
  });
}

function normalizeProtocolReferences(
  references: TsServerReferenceBody[] | undefined,
): TsServerProtocolReference[] {
  if (!Array.isArray(references)) {
    return [];
  }
  return references.map((reference) => {
    const start = readLocation(reference.start);
    const end = readLocation(reference.end);
    return {
      path: typeof reference.file === "string" && reference.file.length > 0
        ? path.resolve(reference.file)
        : null,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      lineText: typeof reference.lineText === "string" && reference.lineText.length > 0
        ? reference.lineText
        : null,
      isDefinition: reference.isDefinition === true,
      isWriteAccess: reference.isWriteAccess === true,
    };
  });
}

function normalizeProtocolReferencesBody(
  body: TsServerReferenceBody[] | TsServerReferencesBody | undefined,
): TsServerProtocolReference[] {
  if (Array.isArray(body)) {
    return normalizeProtocolReferences(body);
  }
  if (body && typeof body === "object" && Array.isArray(body.refs)) {
    return normalizeProtocolReferences(body.refs);
  }
  return [];
}

function normalizeProtocolImplementations(
  implementations: TsServerImplementationBody[] | undefined,
): TsServerProtocolImplementation[] {
  if (!Array.isArray(implementations)) {
    return [];
  }
  return implementations.map((implementation) => {
    const start = readLocation(implementation.start);
    const end = readLocation(implementation.end);
    const contextStart = readLocation(implementation.contextStart);
    const contextEnd = readLocation(implementation.contextEnd);
    return {
      path: typeof implementation.file === "string" && implementation.file.length > 0
        ? path.resolve(implementation.file)
        : null,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      contextStartLine: contextStart.line,
      contextStartColumn: contextStart.column,
      contextEndLine: contextEnd.line,
      contextEndColumn: contextEnd.column,
    };
  });
}

function normalizeProtocolDocumentSymbols(
  body: TsServerNavigationTreeBody | null | undefined,
  filePath: string,
): TsServerProtocolDocumentSymbol[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const items = Array.isArray(body.childItems) ? body.childItems : [];
  if (items.length === 0) {
    return [];
  }
  const symbols: TsServerProtocolDocumentSymbol[] = [];
  for (const item of items) {
    collectProtocolDocumentSymbols(symbols, item, filePath, 0, null);
  }
  return symbols;
}

function collectProtocolDocumentSymbols(
  output: TsServerProtocolDocumentSymbol[],
  item: TsServerNavigationTreeBody,
  filePath: string,
  depth: number,
  containerName: string | null,
): void {
  const primarySpan = Array.isArray(item.spans) && item.spans.length > 0
    ? item.spans[0]
    : null;
  if (primarySpan) {
    const start = readLocation(primarySpan.start);
    const end = readLocation(primarySpan.end);
    output.push({
      path: filePath,
      name: typeof item.text === "string" && item.text.length > 0 ? item.text : null,
      kind: typeof item.kind === "string" && item.kind.length > 0 ? item.kind : null,
      kindModifiers: typeof item.kindModifiers === "string" && item.kindModifiers.length > 0
        ? item.kindModifiers
        : null,
      containerName,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      depth,
      childCount: Array.isArray(item.childItems) ? item.childItems.length : 0,
    });
  }
  for (const child of Array.isArray(item.childItems) ? item.childItems : []) {
    collectProtocolDocumentSymbols(
      output,
      child,
      filePath,
      depth + 1,
      typeof item.text === "string" && item.text.length > 0 ? item.text : containerName,
    );
  }
}

function readLocation(location: TsServerLocation | undefined): {
  line: number | null;
  column: number | null;
} {
  return {
    line: typeof location?.line === "number" ? location.line : null,
    column: typeof location?.offset === "number" ? location.offset : null,
  };
}

function serializeProtocolFixId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value == null) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "null" ? serialized : null;
  } catch {
    return null;
  }
}

function normalizeProtocolText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    const texts = value
      .map((entry) => normalizeProtocolText(entry))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  if (value && typeof value === "object") {
    if ("text" in value && typeof value.text === "string" && value.text.length > 0) {
      return value.text;
    }
    if ("name" in value && typeof value.name === "string" && value.name.length > 0) {
      return value.name;
    }
  }
  return null;
}

function isInferredProjectName(configFileName: string | null): boolean {
  if (!configFileName) {
    return true;
  }
  return configFileName.startsWith("/dev/null/")
    || configFileName.includes("inferredProject")
    || configFileName.endsWith("*");
}

function createTransportFailure(
  code: string,
  message: string,
  details: TsServerTransportFailure["details"],
): TsServerTransportFailure {
  const error = new Error(message) as TsServerTransportFailure;
  error.name = "TsServerTransportError";
  error.code = code;
  error.details = details;
  return error;
}

function cloneEventBody<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function maybeUnrefHandle(handle: object | null | undefined): void {
  if (handle && "unref" in handle && typeof handle.unref === "function") {
    handle.unref();
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}
