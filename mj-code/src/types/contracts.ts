export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface ResolvedConfig {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  authMode: string;
  streamOutput: boolean;
  permissionMode: "read-only" | "workspace-write" | "full-access";
  approvalPolicy: "always" | "on-write" | "never";
  networkMode: NetworkMode;
  webProvider: WebSearchProviderName;
  maxSteps: number;
  maxTokens: number;
  temperature: number;
  cwd: string;
  projectStateDir: string;
  sessionDir: string;
  checkpointDir: string;
  journalDir: string;
  webCacheDir: string;
  sourceDir: string;
  userStateDir: string;
  shellTimeoutMs: number;
  shellBufferChars: number;
  maxOutputChars: number;
  maxReadChars: number;
  availableModels?: string[];
  mcpEnabled?: boolean;
  [key: string]: unknown;
}

export type InstructionLayer =
  | "user-global"
  | "workspace-root"
  | "project-overlay"
  | "local-override";

export interface InstructionRuleEntry {
  id: string;
  name: string;
  value: string;
  layer: InstructionLayer;
  order: number;
  originPath: string;
  sourceQualifiedName: string;
  importedFrom: string | null;
}

export interface InstructionEntry {
  id: string;
  layer: InstructionLayer;
  order: number;
  scope: "user" | "project";
  title: string;
  originPath: string;
  relativePath: string;
  sourceQualifiedName: string;
  importedFrom: string | null;
  importDepth: number;
  importRequests: string[];
  content: string;
  renderedContent: string;
  rules: InstructionRuleEntry[];
}

export interface InstructionPack {
  files: string[];
  content: string;
  entries: InstructionEntry[];
  rules: InstructionRuleEntry[];
}

export interface InstructionPackSummaryEntry {
  id: string;
  layer: InstructionLayer;
  order: number;
  scope: "user" | "project";
  title: string;
  originPath: string;
  relativePath: string;
  sourceQualifiedName: string;
  importedFrom: string | null;
  importDepth: number;
  imports: string[];
  rules: Array<{
    id: string;
    name: string;
    value: string;
  }>;
  content?: string;
  renderedContent?: string;
}

export interface InstructionPackSummaryRule {
  id: string;
  layer: InstructionLayer;
  order: number;
  originPath: string;
  importedFrom: string | null;
  name: string;
  value: string;
  sourceQualifiedName: string;
}

export interface InstructionPackSummary {
  files: string[];
  entryCount: number;
  ruleCount: number;
  entries: InstructionPackSummaryEntry[];
  rules: InstructionPackSummaryRule[];
  content?: string;
}

export interface InstructionHierarchySummary {
  entryCount: number;
  ruleCount: number;
  layers: InstructionLayer[];
  files: string[];
}

export type PolicyContributionLayer =
  | "core-system"
  | "project-instruction"
  | "skill"
  | "user-preference"
  | "runtime";

export interface PolicyContribution {
  id: string;
  layer: PolicyContributionLayer | string;
  priority: number;
  title: string | null;
  source: string;
  originPath: string | null;
  content: string;
  metadata: Record<string, unknown>;
}

export interface PolicySourceSummary {
  id: string;
  layer: PolicyContributionLayer | string;
  priority: number;
  title: string | null;
  source: string;
  originPath: string | null;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface EffectivePolicy {
  text: string;
  contributions: PolicyContribution[];
  sources: PolicySourceSummary[];
}

export interface ToolSpec {
  name: string;
  displayName?: string;
  description: string;
  inputSchema: JsonObject;
  source: string;
  type: string;
  riskCategory?: string;
  sourceQualifiedName?: string;
}

export interface ToolMetadata extends ToolSpec {
  serverId?: string;
  serverName?: string;
  toolName?: string;
  pluginId?: string;
  pluginName?: string;
  permissionsHints?: string[];
  annotations?: Record<string, boolean | string | number | null | undefined>;
}

export interface ToolDefinition {
  description: string;
  inputSchema: JsonObject;
  handler: (input?: JsonObject, executionContext?: JsonObject) => Promise<unknown> | unknown;
  preview?: (input?: JsonObject) => Promise<unknown> | unknown;
}

export interface ToolRegistrySurface {
  getToolSpecs(): ToolMetadata[];
  describe(name: string): ToolMetadata | null;
  execute(name: string, input?: JsonObject, executionContext?: JsonObject): Promise<unknown>;
  preview(name: string, input?: JsonObject): Promise<unknown>;
}

export interface ToolPromptSpec {
  name: string;
  displayName?: string;
  source?: string;
  description: string;
  inputSchema: JsonObject;
}

export interface SystemPromptConfig {
  cwd: string;
  permissionMode: ResolvedConfig["permissionMode"] | string;
  approvalPolicy: ResolvedConfig["approvalPolicy"] | string;
  networkMode: NetworkMode;
}

export interface SystemPromptPolicyStack {
  renderPromptSections?(): string | null | undefined;
}

export interface SystemPromptInput {
  tools: ToolPromptSpec[];
  config: SystemPromptConfig;
  projectInstructions?: string | null;
  nativeToolCalling?: boolean;
  policyStack?: SystemPromptPolicyStack | null;
}

export interface ExtractedToolCallAction {
  type: "tool_call";
  tool: string;
  input: JsonObject;
}

export interface ExtractedFinalAction {
  type: "final";
  content: string;
}

export type ExtractedAction =
  | ExtractedToolCallAction
  | ExtractedFinalAction;

export interface ToolFeedbackPayload {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolFeedbackMessage {
  role: "user";
  content: string;
}

export type VerifierKind = "file_parse" | "command" | "targeted_command" | "diagnostics";
export type VerifierStatus = "passed" | "failed" | "skipped" | "unavailable";
export type VerifierSeverity = "error" | "warning" | "info";
export type VerifierFailureCategory =
  | "syntax_error"
  | "diagnostic_error"
  | "config_error"
  | "command_failed"
  | "unsupported_file"
  | "unavailable"
  | "timeout"
  | "internal_error";

export interface VerifierFinding {
  kind: VerifierKind;
  status: VerifierStatus;
  severity: VerifierSeverity;
  message: string;
  category?: VerifierFailureCategory | null;
  path?: string | null;
  line?: number | null;
  column?: number | null;
  code?: string | null;
  source?: string | null;
  scope?: string | null;
  rule?: string | null;
  related?: Array<{
    path?: string | null;
    line?: number | null;
    column?: number | null;
    message?: string | null;
  }> | null;
  excerpt?: string | null;
  meta?: JsonObject | null;
}

export type DiagnosticSource = "typescript" | "tsconfig" | "jsconfig";
export type DiagnosticScope = "file" | "project" | "config" | "fallback";
export type DiagnosticEngine = "tsserver" | "compiler_api";
export type FixHintSource = "tsserver" | "unavailable";
export type FixHintKind = "quickfix" | "fix_all";
export type CodeActionSource = "tsserver" | "unavailable";
export type CodeActionKind = "quickfix" | "fix_all";
export type ProjectContextSource = "tsserver" | "unavailable";
export type CodeActionBlockedReason =
  | "unsupported_source"
  | "fix_all_not_allowed"
  | "not_recommended"
  | "multi_file_edit"
  | "new_file_edit"
  | "missing_edit_path"
  | "too_many_changes"
  | "edit_too_large"
  | "not_allowlisted";
export type CodeActionApplyBlockedReason =
  | CodeActionBlockedReason
  | "approval_denied"
  | "permission_denied"
  | "execution_failed"
  | "candidate_unavailable";
export type CodeActionApplyStatus =
  | "applied"
  | "blocked"
  | "failed"
  | "unavailable";
export type CodeActionApplyApprovalStatus =
  | "not_required"
  | "approved"
  | "denied"
  | "blocked";

export interface DiagnosticRelatedLocation {
  path: string | null;
  line: number | null;
  column: number | null;
  message: string | null;
}

export interface FixHintEditChangePreview {
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  newTextPreview: string;
  newTextLength: number;
}

export interface FixHintEditPreview {
  path: string | null;
  isNewFile: boolean;
  changeCount: number;
  changes: FixHintEditChangePreview[];
}

export interface FixHint {
  id: string;
  source: "tsserver";
  title: string;
  kind: FixHintKind;
  reason: string | null;
  recommended: boolean;
  diagnosticFingerprints: string[];
  filePaths: string[];
  edits: FixHintEditPreview[];
  fixName: string | null;
  fixId: string | null;
}

export interface FixHintAvailability {
  available: boolean;
  source: FixHintSource;
  reason: string | null;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface FixHintSummary {
  total: number;
  recommendedCount: number;
  fileCount: number;
  available: boolean;
  source: FixHintSource;
  reason: string | null;
}

export interface FixHintCollection {
  availability: FixHintAvailability;
  hints: FixHint[];
  summary: FixHintSummary;
}

export interface CodeActionEditChange {
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  newText: string | null;
  newTextPreview: string;
  newTextLength: number;
  textTruncated: boolean;
}

export interface CodeActionEdit {
  path: string | null;
  isNewFile: boolean;
  changeCount: number;
  changes: CodeActionEditChange[];
}

export interface CodeActionCandidate {
  id: string;
  source: "tsserver";
  title: string;
  kind: CodeActionKind;
  reason: string | null;
  recommended: boolean;
  diagnosticFingerprints: string[];
  filePaths: string[];
  edits: CodeActionEdit[];
  fixName: string | null;
  fixId: string | null;
  allowlisted: boolean;
  allowlistRule: string | null;
  blockedReason: CodeActionBlockedReason | null;
}

export interface CodeActionAvailability {
  available: boolean;
  source: CodeActionSource;
  reason: string | null;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface CodeActionSummary {
  total: number;
  allowlistedCount: number;
  blockedCount: number;
  fileCount: number;
  available: boolean;
  source: CodeActionSource;
  reason: string | null;
}

export interface CodeActionCollection {
  availability: CodeActionAvailability;
  actions: CodeActionCandidate[];
  summary: CodeActionSummary;
}

export interface ProjectContextLocation {
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
}

export interface ProjectContextQuickInfo extends ProjectContextLocation {
  kind: string | null;
  kindModifiers: string | null;
  displayText: string | null;
  documentation: string | null;
}

export interface ProjectContextDefinition extends ProjectContextLocation {
  kind: string | null;
  name: string | null;
  containerName: string | null;
}

export interface ProjectContextImplementation extends ProjectContextLocation {
  contextStartLine: number | null;
  contextStartColumn: number | null;
  contextEndLine: number | null;
  contextEndColumn: number | null;
}

export interface ProjectContextReference extends ProjectContextLocation {
  isDefinition: boolean;
  isWriteAccess: boolean;
  lineText: string | null;
}

export interface ProjectContextDocumentSymbol extends ProjectContextLocation {
  name: string | null;
  kind: string | null;
  kindModifiers: string | null;
  containerName: string | null;
  depth: number;
  childCount: number;
}

export interface DiagnosticProjectContext {
  diagnosticFingerprint: string;
  path: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  message: string;
  source: string | null;
  scope: string | null;
  quickInfo: ProjectContextQuickInfo | null;
  definitions: ProjectContextDefinition[];
  implementations: ProjectContextImplementation[];
  implementationCount: number;
  implementationsTruncated: boolean;
  references: ProjectContextReference[];
  referenceCount: number;
  referencesTruncated: boolean;
  enclosingSymbol: ProjectContextDocumentSymbol | null;
  documentSymbols: ProjectContextDocumentSymbol[];
  documentSymbolCount: number;
  documentSymbolsTruncated: boolean;
}

export interface ProjectContextAvailability {
  available: boolean;
  source: ProjectContextSource;
  reason: string | null;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface ProjectContextSummary {
  total: number;
  diagnosticCoverageCount: number;
  quickInfoCount: number;
  definitionCount: number;
  implementationCount: number;
  referenceCount: number;
  documentSymbolCount: number;
  fileCount: number;
  available: boolean;
  source: ProjectContextSource;
  reason: string | null;
}

export interface ProjectContextCollection {
  availability: ProjectContextAvailability;
  items: DiagnosticProjectContext[];
  summary: ProjectContextSummary;
}

export interface DiagnosticRecord {
  path: string | null;
  line: number | null;
  column: number | null;
  severity: VerifierSeverity;
  code: string | null;
  message: string;
  source: DiagnosticSource;
  scope: DiagnosticScope;
  category: string | null;
  rule: string | null;
  related: DiagnosticRelatedLocation[];
}

export interface DiagnosticFingerprint {
  fingerprint: string;
  path: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  message: string;
  source: string | null;
  scope: string | null;
  category: string | null;
  rule: string | null;
}

export interface DiagnosticDeltaSummary {
  comparable: boolean;
  summary: string;
  beforeTotal: number;
  afterTotal: number;
  beforeErrorCount: number;
  afterErrorCount: number;
  beforeWarningCount: number;
  afterWarningCount: number;
  beforeInfoCount: number;
  afterInfoCount: number;
  resolvedCount: number;
  persistedCount: number;
  introducedCount: number;
  resolved: DiagnosticFingerprint[];
  persisted: DiagnosticFingerprint[];
  introduced: DiagnosticFingerprint[];
  beforeEngine: DiagnosticEngine | "none";
  afterEngine: DiagnosticEngine | "none";
  beforeFallbackUsed: boolean;
  afterFallbackUsed: boolean;
  beforeTransportAvailable: boolean | null;
  afterTransportAvailable: boolean | null;
}

export interface DiagnosticSnapshotSummary {
  comparable: boolean;
  reason: string | null;
  total: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  engine: DiagnosticEngine | "none";
  fallbackUsed: boolean;
  transportAvailable: boolean | null;
  fingerprints: DiagnosticFingerprint[];
}

export interface DiagnosticProviderAvailability {
  available: boolean;
  provider: string;
  mode: "project" | "single_file_fallback" | "mixed" | "unavailable";
  reason: string | null;
  configPaths: string[];
  supportedExtensions: string[];
  transportAvailable: boolean;
}

export interface DiagnosticRequest {
  cwd: string;
  paths: string[];
}

export interface DiagnosticSummary {
  total: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  targetCount: number;
  processedTargetCount: number;
  skippedTargetCount: number;
  providerAvailable: boolean;
  mode: DiagnosticProviderAvailability["mode"];
  engine: DiagnosticEngine | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  transportAvailable: boolean;
  fixHintCount: number;
  recommendedFixHintCount: number;
  fixHintFileCount: number;
  fixHintAvailable: boolean;
  fixHintSource: FixHintSource;
  fixHintReason: string | null;
  codeActionCandidateCount: number;
  codeActionAllowlistedCount: number;
  codeActionBlockedCount: number;
  codeActionAvailable: boolean;
  codeActionSource: CodeActionSource;
  codeActionReason: string | null;
  projectContextCount: number;
  projectContextDiagnosticCoverageCount: number;
  projectContextQuickInfoCount: number;
  projectContextDefinitionCount: number;
  projectContextImplementationCount: number;
  projectContextReferenceCount: number;
  projectContextDocumentSymbolCount: number;
  projectContextFileCount: number;
  projectContextAvailable: boolean;
  projectContextSource: ProjectContextSource;
  projectContextReason: string | null;
}

export interface DiagnosticCollectionResult {
  availability: DiagnosticProviderAvailability;
  engine: DiagnosticEngine | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  diagnostics: DiagnosticRecord[];
  fixHints: FixHintCollection;
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
  summary: DiagnosticSummary;
  processedPaths: string[];
  skippedPaths: Array<{
    path: string;
    reason: string;
  }>;
}

export interface VerifierCommandSpec {
  id: string;
  command: string;
  cwd: string;
  source: "tool_execution" | "targeted" | "configured";
  reason?: string | null;
}

export interface VerificationPlanCheck {
  id: string;
  kind: VerifierKind;
  label: string;
  filePath?: string | null;
  paths?: string[] | null;
  command?: VerifierCommandSpec | null;
  reason?: string | null;
}

export interface VerificationPlan {
  required: boolean;
  trigger: "files_changed" | "plan_verify" | "verification_bias" | "explicit_command" | "none";
  reason: string;
  checks: VerificationPlanCheck[];
}

export interface VerifierCheckResult {
  id: string;
  kind: VerifierKind;
  label: string;
  status: VerifierStatus;
  passed: boolean;
  summary: string;
  durationMs: number;
  filePath?: string | null;
  command?: VerifierCommandSpec | null;
  findings: VerifierFinding[];
  category?: VerifierFailureCategory | null;
  exitCode?: number | null;
  stdoutSummary?: string | null;
  stderrSummary?: string | null;
  skippedReason?: string | null;
  fixHints?: FixHintCollection | null;
  codeActions?: CodeActionCollection | null;
  projectContext?: ProjectContextCollection | null;
  metadata?: JsonObject | null;
}

export interface VerifierRunSummary {
  status: VerifierStatus;
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
  unavailableChecks?: number;
  findings: number;
  failureCategories: VerifierFailureCategory[];
  diagnosticErrorCount?: number;
  diagnosticWarningCount?: number;
  diagnosticInfoCount?: number;
  diagnosticProviderAvailable?: boolean;
  diagnosticEngine?: DiagnosticEngine | "none";
  diagnosticFallbackUsed?: boolean;
  diagnosticFallbackReason?: string | null;
  diagnosticTransportAvailable?: boolean;
  fixHintAvailable?: boolean;
  fixHintSource?: FixHintSource | "none";
  fixHintCount?: number;
  recommendedFixHintCount?: number;
  fixHintFileCount?: number;
  fixHintReason?: string | null;
  codeActionAvailable?: boolean;
  codeActionSource?: CodeActionSource | "none";
  codeActionCandidateCount?: number;
  codeActionAllowlistedCount?: number;
  codeActionBlockedCount?: number;
  codeActionReason?: string | null;
  projectContextAvailable?: boolean;
  projectContextSource?: ProjectContextSource | "none";
  projectContextCount?: number;
  projectContextDiagnosticCoverageCount?: number;
  projectContextQuickInfoCount?: number;
  projectContextDefinitionCount?: number;
  projectContextImplementationCount?: number;
  projectContextReferenceCount?: number;
  projectContextDocumentSymbolCount?: number;
  projectContextFileCount?: number;
  projectContextReason?: string | null;
  summary: string;
  durationMs: number;
}

export interface VerifierRunRecord {
  traceId: string | null;
  step: string | number | null;
  startedAt: string;
  finishedAt: string;
  plan: VerificationPlan;
  checks: VerifierCheckResult[];
  summary: VerifierRunSummary;
}

export interface DiagnosticProvider {
  kind: VerifierKind;
  available: boolean;
  provider: string;
  collectDiagnostics(input: DiagnosticRequest): Promise<DiagnosticCollectionResult>;
  close?(): Promise<void>;
}

export type RepairStatus =
  | "retrying"
  | "succeeded"
  | "failed"
  | "stopped"
  | "exhausted";

export type RepairProgressState =
  | "resolved"
  | "improved"
  | "unchanged"
  | "regressed"
  | "not_applicable";

export type RepairProgressTrend =
  | RepairProgressState
  | "mixed"
  | "none";

export type RepairStopReason =
  | "no_actionable_findings"
  | "attempts_exhausted"
  | "max_steps_reached"
  | "turn_interrupted";

export interface RepairDirectiveHintGroup {
  path: string | null;
  diagnosticFingerprints: string[];
  source: FixHintSource;
  available: boolean;
  reason: string | null;
  hintCount: number;
  recommendedHintCount: number;
  hints: FixHint[];
}

export interface RepairDirectiveItem {
  checkId: string;
  checkLabel: string;
  kind: VerifierKind;
  category: VerifierFailureCategory | null;
  severity: VerifierSeverity;
  path: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  source: string | null;
  scope: string | null;
  rule: string | null;
  command: string | null;
  fingerprint: string | null;
  occurrenceCount: number;
  message: string;
  excerpt: string | null;
  related: DiagnosticRelatedLocation[];
  fixHints: FixHint[];
  codeActions: CodeActionCandidate[];
  projectContext: DiagnosticProjectContext | null;
}

export interface RepairDirectiveFileGroup {
  path: string | null;
  itemCount: number;
  diagnosticCount: number;
  hintCount: number;
  recommendedHintCount: number;
  codeActionCount: number;
  allowlistedCodeActionCount: number;
  projectContextCount: number;
  categories: VerifierFailureCategory[];
  codes: string[];
  items: RepairDirectiveItem[];
  definitions: ProjectContextDefinition[];
  implementations: ProjectContextImplementation[];
  documentSymbols: ProjectContextDocumentSymbol[];
  hintGroup: RepairDirectiveHintGroup | null;
  codeActions: CodeActionCandidate[];
}

export interface RepairDirective {
  traceId: string | null;
  verifierRunStartedAt: string;
  verifierStep: string | number | null;
  attempt: number;
  maxAttempts: number;
  summary: string;
  instruction: string;
  failureCategories: VerifierFailureCategory[];
  failedChecks: Array<{
    id: string;
    kind: VerifierKind;
    label: string;
    category: VerifierFailureCategory | null;
    summary: string;
    filePath: string | null;
    command: string | null;
  }>;
  items: RepairDirectiveItem[];
  fileGroups: RepairDirectiveFileGroup[];
  fixHints: FixHintCollection;
  hintGroups: RepairDirectiveHintGroup[];
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
  filePaths: string[];
  commands: string[];
}

export interface RepairDecision {
  decision: "retry" | "stop";
  status: RepairStatus;
  stopReason: RepairStopReason | null;
  attempt: number;
  maxAttempts: number;
  actionable: boolean;
  summary: string;
  directive: RepairDirective | null;
}

export interface RepairAttemptConvergenceRecord {
  compared: boolean;
  state: RepairProgressState;
  summary: string;
  delta: DiagnosticDeltaSummary | null;
}

export interface RepairAttemptRecord {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  status: RepairStatus;
  summary: string;
  decision: RepairDecision["decision"];
  directive: RepairDirective | null;
  triggerVerifierStartedAt: string;
  triggerVerifierStep: string | number | null;
  triggerVerifierSummary: string;
  baselineDiagnostics: DiagnosticSnapshotSummary;
  convergence: RepairAttemptConvergenceRecord | null;
  codeAction: CodeActionApplyResult | null;
  resultVerifierStartedAt?: string | null;
  resultVerifierStep?: string | number | null;
  resultVerifierSummary?: string | null;
  continuationMessage?: string | null;
}

export interface CodeActionApplyResult {
  status: CodeActionApplyStatus;
  source: CodeActionSource;
  applied: boolean;
  candidateId: string | null;
  title: string | null;
  kind: CodeActionKind | null;
  allowlisted: boolean;
  summary: string;
  blockedReason: CodeActionApplyBlockedReason | null;
  failureReason: string | null;
  approvalRequired: boolean;
  approvalStatus: CodeActionApplyApprovalStatus;
  toolName: string | null;
  changeSetId: string | null;
  touchedFiles: string[];
  verifierRunStartedAt: string | null;
  verifierStep: string | number | null;
}

export interface RepairLoopSummary {
  status: RepairStatus;
  attemptsUsed: number;
  maxAttempts: number;
  attemptsRemaining: number;
  lastDecision: RepairDecision["decision"] | null;
  stopReason: RepairStopReason | null;
  triggeredByVerifierStartedAt: string | null;
  latestProgress: RepairProgressState | "none";
  progressTrend: RepairProgressTrend;
  resolvedAttemptCount: number;
  improvedAttemptCount: number;
  unchangedAttemptCount: number;
  regressedAttemptCount: number;
  notApplicableAttemptCount: number;
  resolvedDiagnosticCount: number;
  persistedDiagnosticCount: number;
  introducedDiagnosticCount: number;
  codeActionAppliedCount: number;
  codeActionBlockedCount: number;
  latestCodeActionStatus: CodeActionApplyStatus | "none";
  summary: string;
}

export interface RepairLoopRecord {
  traceId: string | null;
  startedAt: string;
  finishedAt: string | null;
  maxAttempts: number;
  initialVerifierStartedAt: string;
  initialVerifierStep: string | number | null;
  initialFailureCategories: VerifierFailureCategory[];
  attempts: RepairAttemptRecord[];
  summary: RepairLoopSummary;
}

export type VerifierInspectScope = "current" | "trace" | "replay";
export type VerifierInspectRenderProfile =
  | "json"
  | "summary"
  | "failures"
  | "repair"
  | "context";
export type VerifierInspectSnapshotRenderProfile =
  | "json"
  | "summary";
export type VerifierInspectBaselineRenderProfile =
  | "json"
  | "summary";
export type VerifierInspectCompareRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierRegressionGatePolicyProfileRenderProfile =
  | "json"
  | "summary";
export type VerifierRegressionGateRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierInspectArtifactRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierInspectArtifactListRenderProfile =
  | "json"
  | "summary";
export type VerifierReleaseHandoffRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierReleaseBundleRenderProfile =
  | "json"
  | "summary";
export type VerifierInspectArtifactPruneRenderProfile =
  | "json"
  | "summary";
export type VerifierBaselinePromotionRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierBaselinePromotionHistoryRenderProfile =
  | "json"
  | "summary";
export type VerifierReleaseTriageRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierGitHubChecksRenderProfile =
  | "json"
  | "summary";
export type VerifierGitHubMutationRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierDrilldownRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierTimelineRenderProfile =
  | "json"
  | "summary"
  | "failures";
export type VerifierInspectReferenceKind =
  | "current"
  | "trace"
  | "replay"
  | "snapshot"
  | "baseline";

export type VerifierInspectFinalOutcome =
  | "unknown"
  | "success"
  | "failed"
  | "stopped"
  | "degraded";

export interface VerifierInspectLatest {
  verifierRun: VerifierRunRecord | null;
  repairLoop: RepairLoopRecord | null;
}

export interface VerifierInspectSummary {
  hasData: boolean;
  verifierRunCount: number;
  passedVerifierRunCount: number;
  failedVerifierRunCount: number;
  skippedVerifierRunCount: number;
  diagnosticErrorCount: number;
  diagnosticWarningCount: number;
  diagnosticInfoCount: number;
  repairLoopCount: number;
  repairAttemptCount: number;
  repairSucceededCount: number;
  repairStoppedCount: number;
  repairExhaustedCount: number;
  repairFailedCount: number;
  repairResolvedCount: number;
  repairImprovedCount: number;
  repairUnchangedCount: number;
  repairRegressedCount: number;
  repairNotApplicableCount: number;
  latestRepairProgress: RepairProgressState | "none";
  repairProgressTrend: RepairProgressTrend;
  resolvedDiagnosticCount: number;
  persistedDiagnosticCount: number;
  introducedDiagnosticCount: number;
  tsserverDiagnosticRunCount: number;
  compilerApiDiagnosticRunCount: number;
  diagnosticsFallbackCount: number;
  fixHintCount: number;
  recommendedFixHintCount: number;
  fixHintFileCount: number;
  codeActionCandidateCount: number;
  codeActionAllowlistedCount: number;
  codeActionAppliedCount: number;
  codeActionBlockedCount: number;
  projectContextCount: number;
  projectContextDiagnosticCoverageCount: number;
  projectContextQuickInfoCount: number;
  projectContextDefinitionCount: number;
  projectContextImplementationCount: number;
  projectContextReferenceCount: number;
  projectContextDocumentSymbolCount: number;
  projectContextFileCount: number;
  latestVerifierStatus: VerifierStatus | "none";
  latestRepairStatus: RepairStatus | "none";
  latestDiagnosticEngine: DiagnosticEngine | "none";
  latestDiagnosticFallbackUsed: boolean;
  latestDiagnosticFallbackReason: string | null;
  latestDiagnosticTransportAvailable: boolean | null;
  latestFixHintAvailable: boolean;
  latestFixHintSource: FixHintSource | "none";
  latestFixHintReason: string | null;
  latestFixHintCount: number;
  latestRecommendedFixHintCount: number;
  latestFixHintFileCount: number;
  latestCodeActionAvailable: boolean;
  latestCodeActionSource: CodeActionSource | "none";
  latestCodeActionApplied: boolean;
  latestCodeActionStatus: CodeActionApplyStatus | "none";
  latestCodeActionBlockedReason: CodeActionApplyBlockedReason | null;
  latestProjectContextAvailable: boolean;
  latestProjectContextSource: ProjectContextSource | "none";
  latestProjectContextReason: string | null;
  latestProjectContextCount: number;
  latestProjectContextDiagnosticCoverageCount: number;
  latestProjectContextQuickInfoCount: number;
  latestProjectContextDefinitionCount: number;
  latestProjectContextImplementationCount: number;
  latestProjectContextReferenceCount: number;
  latestProjectContextDocumentSymbolCount: number;
  latestProjectContextFileCount: number;
  finalOutcome: VerifierInspectFinalOutcome;
}

export interface VerifierInspectReport {
  scope: VerifierInspectScope;
  sessionId: string | null;
  traceId: string | null;
  latest: VerifierInspectLatest;
  verifierRuns: VerifierRunRecord[];
  repairLoops: RepairLoopRecord[];
  summary: VerifierInspectSummary;
}

export interface VerifierInspectReference {
  kind: VerifierInspectReferenceKind;
  reference: string | null;
}

export interface VerifierInspectResolvedReference {
  kind: VerifierInspectReferenceKind;
  label: string;
  reference: string | null;
  scope: VerifierInspectScope;
  sessionId: string | null;
  traceId: string | null;
  replayReference: string | null;
  snapshotId: string | null;
  baselineName: string | null;
}

export interface VerifierInspectSnapshotMetadata {
  snapshotId: string;
  createdAt: string;
  source: VerifierInspectResolvedReference;
  summary: VerifierInspectSummary;
}

export interface VerifierInspectSnapshotRecord {
  metadata: VerifierInspectSnapshotMetadata;
  report: VerifierInspectReport;
}

export interface VerifierInspectSnapshotList {
  total: number;
  items: VerifierInspectSnapshotMetadata[];
}

export interface VerifierInspectBaselineMetadata {
  baselineId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  snapshotId: string;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  source: VerifierInspectResolvedReference;
  summary: VerifierInspectSummary;
  promotionCount: number;
  latestPromotionId: string | null;
}

export interface VerifierInspectBaselinePromotionRecord {
  promotionId: string;
  createdAt: string;
  baselineId: string;
  name: string;
  previousSnapshotId: string;
  nextSnapshotId: string;
  previousSource: VerifierInspectResolvedReference;
  nextSource: VerifierInspectResolvedReference;
  previousSummary: VerifierInspectSummary;
  nextSummary: VerifierInspectSummary;
  previousPolicyProfileId: VerifierRegressionGatePolicyProfileId | null;
  nextPolicyProfileId: VerifierRegressionGatePolicyProfileId | null;
  planId: string | null;
  candidate: VerifierBaselinePromotionCandidate | null;
  decision: VerifierBaselinePromotionDecision | null;
  approval: VerifierBaselinePromotionApprovalRecord | null;
}

export interface VerifierInspectBaselineRecord {
  metadata: VerifierInspectBaselineMetadata;
  history: VerifierInspectBaselinePromotionRecord[];
}

export interface VerifierInspectBaselineList {
  total: number;
  items: VerifierInspectBaselineMetadata[];
}

export interface VerifierInspectBaselineResolution {
  baseline: VerifierInspectBaselineRecord;
  snapshot: VerifierInspectSnapshotRecord;
  reference: VerifierInspectResolvedReference;
  report: VerifierInspectReport;
}

export interface VerifierInspectValueChange<T> {
  before: T;
  after: T;
  changed: boolean;
}

export interface VerifierInspectCountDelta {
  before: number;
  after: number;
  delta: number;
  changed: boolean;
}

export interface VerifierInspectBlockingDiagnosticDelta {
  comparable: boolean;
  beforeCount: number;
  afterCount: number;
  resolvedCount: number;
  persistedCount: number;
  introducedCount: number;
  resolved: DiagnosticFingerprint[];
  persisted: DiagnosticFingerprint[];
  introduced: DiagnosticFingerprint[];
  summary: string;
}

export interface VerifierInspectCompareSide {
  reference: VerifierInspectResolvedReference;
  report: VerifierInspectReport;
}

export interface VerifierInspectCompareSummary {
  hasChanges: boolean;
  finalOutcome: VerifierInspectValueChange<VerifierInspectFinalOutcome>;
  latestVerifierStatus: VerifierInspectValueChange<VerifierInspectSummary["latestVerifierStatus"]>;
  latestRepairStatus: VerifierInspectValueChange<VerifierInspectSummary["latestRepairStatus"]>;
  latestRepairProgress: VerifierInspectValueChange<VerifierInspectSummary["latestRepairProgress"]>;
  latestDiagnosticEngine: VerifierInspectValueChange<VerifierInspectSummary["latestDiagnosticEngine"]>;
  latestFixHintAvailable: VerifierInspectValueChange<boolean>;
  latestCodeActionAvailable: VerifierInspectValueChange<boolean>;
  latestProjectContextAvailable: VerifierInspectValueChange<boolean>;
  verifierRuns: VerifierInspectCountDelta;
  repairLoops: VerifierInspectCountDelta;
  repairAttempts: VerifierInspectCountDelta;
  diagnosticErrors: VerifierInspectCountDelta;
  diagnosticWarnings: VerifierInspectCountDelta;
  diagnosticInfo: VerifierInspectCountDelta;
  repairResolved: VerifierInspectCountDelta;
  repairImproved: VerifierInspectCountDelta;
  repairUnchanged: VerifierInspectCountDelta;
  repairRegressed: VerifierInspectCountDelta;
  resolvedDiagnostics: VerifierInspectCountDelta;
  persistedDiagnostics: VerifierInspectCountDelta;
  introducedDiagnostics: VerifierInspectCountDelta;
  fixHints: VerifierInspectCountDelta;
  recommendedFixHints: VerifierInspectCountDelta;
  fixHintFiles: VerifierInspectCountDelta;
  codeActionCandidates: VerifierInspectCountDelta;
  codeActionAllowlisted: VerifierInspectCountDelta;
  codeActionApplied: VerifierInspectCountDelta;
  codeActionBlocked: VerifierInspectCountDelta;
  projectContextItems: VerifierInspectCountDelta;
  projectContextCoverage: VerifierInspectCountDelta;
  projectContextDefinitions: VerifierInspectCountDelta;
  projectContextImplementations: VerifierInspectCountDelta;
  projectContextReferences: VerifierInspectCountDelta;
  projectContextDocumentSymbols: VerifierInspectCountDelta;
  projectContextFiles: VerifierInspectCountDelta;
  blockingDiagnostics: VerifierInspectBlockingDiagnosticDelta;
}

export interface VerifierInspectCompareReport {
  left: VerifierInspectCompareSide;
  right: VerifierInspectCompareSide;
  summary: VerifierInspectCompareSummary;
  artifact: VerifierInspectArtifactMetadata | null;
  handoff: VerifierReleaseHandoffMetadata | null;
  bundle: VerifierReleaseBundleMetadata | null;
}

export interface VerifierRegressionGatePolicy {
  name: string;
  failOnFinalOutcomeRegression: boolean;
  failOnLatestVerifierFailed: boolean;
  failOnLatestVerifierStatusRegression: boolean;
  failOnLatestRepairStatusRegression: boolean;
  failOnDiagnosticErrorIncrease: boolean;
  failOnBlockingDiagnosticsIntroduced: boolean;
  failOnRepairRegressedCountIncrease: boolean;
  failOnLatestRepairProgressRegression: boolean;
  noticeOnWarningDelta: boolean;
  noticeOnInfoDelta: boolean;
  noticeOnFixHintAvailabilityChange: boolean;
  noticeOnCodeActionAvailabilityChange: boolean;
  noticeOnProjectContextAvailabilityChange: boolean;
}

export type VerifierRegressionGateStatus = "pass" | "fail";
export type VerifierRegressionGateReasonSeverity = "failure" | "notice";
export type VerifierRegressionGateReasonKind =
  | "final_outcome_regressed"
  | "latest_verifier_failed"
  | "latest_verifier_status_regressed"
  | "latest_repair_status_regressed"
  | "diagnostic_errors_increased"
  | "blocking_diagnostics_introduced"
  | "repair_regressed_count_increased"
  | "latest_repair_progress_regressed"
  | "warning_delta_only"
  | "info_delta_only"
  | "fix_hint_availability_changed"
  | "code_action_availability_changed"
  | "project_context_availability_changed";

export interface VerifierRegressionGateReasonEvidence {
  finalOutcome: VerifierInspectValueChange<VerifierInspectFinalOutcome> | null;
  latestVerifierStatus: VerifierInspectValueChange<VerifierInspectSummary["latestVerifierStatus"]> | null;
  latestRepairStatus: VerifierInspectValueChange<VerifierInspectSummary["latestRepairStatus"]> | null;
  latestRepairProgress: VerifierInspectValueChange<VerifierInspectSummary["latestRepairProgress"]> | null;
  countDelta: VerifierInspectCountDelta | null;
  blockingDiagnostics: VerifierInspectBlockingDiagnosticDelta | null;
  availabilityChange: VerifierInspectValueChange<boolean> | null;
}

export interface VerifierRegressionGateReason {
  kind: VerifierRegressionGateReasonKind;
  severity: VerifierRegressionGateReasonSeverity;
  summary: string;
  evidence: VerifierRegressionGateReasonEvidence;
}

export type VerifierRegressionGatePolicyProfileId =
  | "default"
  | "strict"
  | "release"
  | (string & {});

export interface VerifierRegressionGatePolicyProfile {
  id: VerifierRegressionGatePolicyProfileId;
  name: string;
  description: string;
  builtin: boolean;
  policy: VerifierRegressionGatePolicy;
}

export interface VerifierRegressionGatePolicyProfileList {
  total: number;
  items: VerifierRegressionGatePolicyProfile[];
}

export interface VerifierRegressionGateDecision {
  profile: VerifierRegressionGatePolicyProfile;
  policy: VerifierRegressionGatePolicy;
  compare: VerifierInspectCompareReport;
  status: VerifierRegressionGateStatus;
  pass: boolean;
  failureCount: number;
  noticeCount: number;
  reasons: VerifierRegressionGateReason[];
  summary: string;
  artifact: VerifierInspectArtifactMetadata | null;
  handoff: VerifierReleaseHandoffMetadata | null;
  bundle: VerifierReleaseBundleMetadata | null;
}

export type VerifierInspectArtifactKind =
  | "compare"
  | "gate"
  | "eval";

export interface VerifierInspectArtifactBlockingDiagnosticsEvidence {
  beforeCount: number;
  afterCount: number;
  resolvedCount: number;
  persistedCount: number;
  introducedCount: number;
  summary: string;
}

export interface VerifierInspectArtifactEvidence {
  finalOutcome: VerifierInspectValueChange<VerifierInspectFinalOutcome> | null;
  latestVerifierStatus: VerifierInspectValueChange<VerifierInspectSummary["latestVerifierStatus"]> | null;
  latestRepairStatus: VerifierInspectValueChange<VerifierInspectSummary["latestRepairStatus"]> | null;
  latestRepairProgress: VerifierInspectValueChange<VerifierInspectSummary["latestRepairProgress"]> | null;
  diagnosticErrors: VerifierInspectCountDelta | null;
  diagnosticWarnings: VerifierInspectCountDelta | null;
  diagnosticInfo: VerifierInspectCountDelta | null;
  repairRegressed: VerifierInspectCountDelta | null;
  blockingDiagnostics: VerifierInspectArtifactBlockingDiagnosticsEvidence | null;
}

export interface VerifierInspectArtifactMetadata {
  artifactId: string;
  createdAt: string;
  kind: VerifierInspectArtifactKind;
  sourceReferences: VerifierInspectResolvedReference[];
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  snapshotIds: string[];
  baselineNames: string[];
  pass: boolean | null;
  hasChanges: boolean | null;
  bundleId: string | null;
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
  summary: string;
}

export interface VerifierInspectCompareArtifactRecord {
  metadata: VerifierInspectArtifactMetadata;
  compare: VerifierInspectCompareReport;
  evidence: VerifierInspectArtifactEvidence;
}

export interface VerifierRegressionGateArtifactRecord {
  metadata: VerifierInspectArtifactMetadata;
  decision: VerifierRegressionGateDecision;
  evidence: VerifierInspectArtifactEvidence;
}

export interface VerifierEvalArtifactRecord {
  metadata: VerifierInspectArtifactMetadata;
  result: EvalSuiteResult;
  evidence: VerifierInspectArtifactEvidence | null;
}

export type VerifierInspectArtifactRecord =
  | VerifierInspectCompareArtifactRecord
  | VerifierRegressionGateArtifactRecord
  | VerifierEvalArtifactRecord;

export interface VerifierInspectArtifactList {
  total: number;
  items: VerifierInspectArtifactMetadata[];
}

export type VerifierReleaseHandoffSourceKind =
  | "compare"
  | "gate"
  | "eval"
  | "baseline_promotion";

export type VerifierReleaseHandoffStatus =
  | "pass"
  | "fail"
  | "changed"
  | "steady"
  | "promoted";

export type VerifierReleaseHandoffReasonSeverity =
  | VerifierRegressionGateReasonSeverity
  | "info";

export type VerifierReleaseHandoffReasonKind =
  | VerifierRegressionGateReasonKind
  | "compare_changed"
  | "baseline_promoted";

export interface VerifierReleaseHandoffReasonSummary {
  kind: VerifierReleaseHandoffReasonKind;
  severity: VerifierReleaseHandoffReasonSeverity;
  summary: string;
}

export interface VerifierReleaseHandoffBlockingDiagnosticSummary {
  comparable: boolean;
  beforeCount: number;
  afterCount: number;
  resolvedCount: number;
  persistedCount: number;
  introducedCount: number;
  resolved: DiagnosticFingerprint[];
  persisted: DiagnosticFingerprint[];
  introduced: DiagnosticFingerprint[];
  summary: string;
}

export interface VerifierReleaseHandoffMetadata {
  handoffId: string;
  createdAt: string;
  sourceKind: VerifierReleaseHandoffSourceKind;
  status: VerifierReleaseHandoffStatus;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  primaryArtifactId: string | null;
  artifactIds: string[];
  snapshotIds: string[];
  baselineNames: string[];
  pass: boolean | null;
  bundleId: string | null;
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
  summary: string;
}

export interface VerifierReleaseHandoffRecord {
  metadata: VerifierReleaseHandoffMetadata;
  sourceReferences: VerifierInspectResolvedReference[];
  primaryArtifact: VerifierInspectArtifactMetadata | null;
  sourceArtifactIds: string[];
  baselinePromotionId: string | null;
  baselineId: string | null;
  baselineName: string | null;
  finalOutcome: VerifierInspectValueChange<VerifierInspectFinalOutcome> | null;
  latestVerifierStatus: VerifierInspectValueChange<VerifierInspectSummary["latestVerifierStatus"]> | null;
  latestRepairStatus: VerifierInspectValueChange<VerifierInspectSummary["latestRepairStatus"]> | null;
  topReasons: VerifierReleaseHandoffReasonSummary[];
  blockingDiagnostics: VerifierReleaseHandoffBlockingDiagnosticSummary | null;
  triage: VerifierReleaseTriageSummary | null;
  summary: string;
}

export interface VerifierReleaseHandoffSelection {
  available: boolean;
  reason: string | null;
  reference: string | null;
  latestArtifactId: string | null;
  latestCompareArtifactId: string | null;
  latestGateArtifactId: string | null;
  latestEvalArtifactId: string | null;
  handoff: VerifierReleaseHandoffRecord | null;
}

export interface VerifierReleaseBundleFileEntry {
  role: "bundle" | "handoff" | "artifact" | "references" | "summary";
  path: string;
  relativePath: string;
}

export interface VerifierReleaseBundleMetadata {
  bundleId: string;
  createdAt: string;
  handoffId: string;
  sourceKind: VerifierReleaseHandoffSourceKind;
  primaryArtifactId: string | null;
  artifactIds: string[];
  snapshotIds: string[];
  baselineNames: string[];
  bundlePath: string;
  summaryPath: string | null;
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
  summary: string;
}

export interface VerifierReleaseBundleRecord {
  metadata: VerifierReleaseBundleMetadata;
  handoff: VerifierReleaseHandoffRecord;
  includedArtifacts: VerifierInspectArtifactMetadata[];
  files: VerifierReleaseBundleFileEntry[];
}

export interface VerifierArtifactWorkflowProvenance {
  provider: "github_actions";
  runId: string | null;
  runAttempt: string | null;
  workflow: string | null;
  job: string | null;
  sha: string | null;
  ref: string | null;
  eventName: string | null;
  repository: string | null;
  serverUrl: string | null;
  actor: string | null;
}

export interface VerifierArtifactUploadMetadata {
  provider: "github_actions_upload_artifact";
  artifactName: string | null;
  artifactId: string | null;
  artifactUrl: string | null;
  artifactDigest: string | null;
  retentionDays: number | null;
  uploadedAt: string;
}

export interface VerifierGitHubActionsBackfillInput {
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
}

export type VerifierBaselinePromotionSourceKind =
  | "gate"
  | "eval"
  | "compare"
  | "unknown";

export type VerifierBaselinePromotionDecisionStatus =
  | "eligible"
  | "blocked";

export type VerifierBaselinePromotionApprovalStatus =
  | "pending"
  | "blocked"
  | "approved"
  | "applied";

export type VerifierBaselinePromotionApproverKind =
  | "operator"
  | "automation"
  | "workflow";

export type VerifierBaselinePromotionApprovalSource =
  | "cli"
  | "workflow_dispatch"
  | "schedule"
  | "pull_request"
  | "automation";

export type VerifierBaselinePromotionApprovalMode =
  | "explicit_apply"
  | "workflow_apply";

export type VerifierBaselinePromotionPolicyInheritanceSource =
  | "explicit"
  | "baseline"
  | "artifact"
  | "default";

export type VerifierBaselinePromotionDecisionReasonSeverity =
  | "failure"
  | "notice"
  | "info";

export type VerifierBaselinePromotionDecisionReasonKind =
  | "source_unsupported"
  | "baseline_missing"
  | "baseline_already_current"
  | "gate_failed"
  | "eval_failed"
  | "policy_inherited"
  | "policy_overridden"
  | "ready_for_promotion"
  | "approval_required"
  | "approval_blocked"
  | "promotion_applied";

export interface VerifierBaselinePromotionSourceProvenance {
  sourceKind: VerifierBaselinePromotionSourceKind;
  artifactKind: VerifierInspectArtifactKind | null;
  artifactId: string | null;
  handoffId: string | null;
  bundleId: string | null;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineName: string | null;
  summary: string | null;
}

export interface VerifierBaselinePromotionBaselineScope {
  channel: string;
  branchScope: string | null;
}

export interface VerifierBaselinePromotionCandidate {
  candidateId: string;
  createdAt: string;
  baselineName: string;
  baselineId: string | null;
  source: VerifierBaselinePromotionSourceProvenance;
  baselineScope: VerifierBaselinePromotionBaselineScope;
  currentSnapshotId: string | null;
  currentSummary: VerifierInspectSummary | null;
  targetReference: VerifierInspectResolvedReference;
  targetSnapshotId: string;
  targetSummary: VerifierInspectSummary;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  summary: string;
}

export interface VerifierBaselinePromotionDecisionReason {
  kind: VerifierBaselinePromotionDecisionReasonKind;
  severity: VerifierBaselinePromotionDecisionReasonSeverity;
  summary: string;
}

export interface VerifierBaselinePromotionBlockingEvidence {
  finalOutcome: VerifierInspectValueChange<VerifierInspectFinalOutcome> | null;
  latestVerifierStatus: VerifierInspectValueChange<VerifierInspectSummary["latestVerifierStatus"]> | null;
  latestRepairStatus: VerifierInspectValueChange<VerifierInspectSummary["latestRepairStatus"]> | null;
  diagnosticErrors: VerifierInspectCountDelta | null;
  blockingDiagnostics: VerifierInspectBlockingDiagnosticDelta | null;
  gateReasons: VerifierRegressionGateReason[];
  evalSummary: EvalSummary | null;
}

export interface VerifierBaselinePromotionEligibilityEvidence {
  sourceKind: VerifierBaselinePromotionSourceKind;
  sourceArtifactKind: VerifierInspectArtifactKind | null;
  sourceArtifactId: string | null;
  sourceHandoffId: string | null;
  sourceBundleId: string | null;
  sourcePass: boolean | null;
  sourceHasChanges: boolean;
  sourcePolicyProfileId: VerifierRegressionGatePolicyProfileId | null;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineScope: VerifierBaselinePromotionBaselineScope;
  diagnosticErrorDelta: number | null;
  blockingDiagnosticIntroducedCount: number | null;
  gateFailureReasonKinds: VerifierRegressionGateReasonKind[];
  evalFailedCount: number | null;
}

export interface VerifierBaselinePromotionDecision {
  status: VerifierBaselinePromotionDecisionStatus;
  eligible: boolean;
  reasons: VerifierBaselinePromotionDecisionReason[];
  blockingEvidence: VerifierBaselinePromotionBlockingEvidence | null;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineScope: VerifierBaselinePromotionBaselineScope;
  eligibilityEvidence: VerifierBaselinePromotionEligibilityEvidence;
  blockReason: VerifierBaselinePromotionDecisionReasonKind | null;
  summary: string;
}

export interface VerifierBaselinePromotionApprovalActor {
  kind: VerifierBaselinePromotionApproverKind;
  id: string | null;
  displayName: string | null;
}

export interface VerifierBaselinePromotionApprovalRecord {
  approvalId: string;
  createdAt: string;
  status: VerifierBaselinePromotionApprovalStatus;
  approverKind: VerifierBaselinePromotionApproverKind;
  approverId: string | null;
  actor: VerifierBaselinePromotionApprovalActor;
  source: VerifierBaselinePromotionApprovalSource;
  approvalMode: VerifierBaselinePromotionApprovalMode;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineScope: VerifierBaselinePromotionBaselineScope;
  eligibilityEvidence: VerifierBaselinePromotionEligibilityEvidence | null;
  summary: string;
}

export interface VerifierBaselinePromotionPlanRecord {
  planId: string;
  createdAt: string;
  baselineName: string;
  baselineId: string | null;
  candidate: VerifierBaselinePromotionCandidate;
  decision: VerifierBaselinePromotionDecision;
  approvalStatus: VerifierBaselinePromotionApprovalStatus;
  approval: VerifierBaselinePromotionApprovalRecord | null;
  appliedBaselineId: string | null;
  appliedSnapshotId: string | null;
  appliedPromotionId: string | null;
  handoffId: string | null;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineScope: VerifierBaselinePromotionBaselineScope;
  summary: string;
}

export interface VerifierBaselinePromotionHistory {
  baselineName: string;
  baselineId: string | null;
  total: number;
  items: VerifierInspectBaselinePromotionRecord[];
}

export type VerifierReleasePromotionStatus =
  | "eligible"
  | "blocked"
  | "applied"
  | "unavailable";

export interface VerifierReleaseAffectedFileSummary {
  path: string;
  introducedCount: number;
  persistedCount: number;
  totalCount: number;
}

export type VerifierGitHubMutationMode =
  | "check_run";

export type VerifierGitHubMutationAction =
  | "create"
  | "update";

export type VerifierGitHubMutationStatus =
  | "success"
  | "skipped"
  | "blocked"
  | "unavailable"
  | "failed";

export type VerifierGitHubMutationReasonKind =
  | "payload_unavailable"
  | "github_context_missing"
  | "token_missing"
  | "repository_missing"
  | "sha_missing"
  | "permission_denied"
  | "api_error"
  | "network_error";

export interface VerifierGitHubMutationRequestPayloadSummary {
  name: string;
  title: string;
  conclusion: VerifierGitHubChecksPayload["conclusion"];
  summary: string;
  text: string;
  annotationCount: number;
  annotationTruncated: boolean;
}

export interface VerifierGitHubMutationTarget {
  apiUrl: string;
  repository: string | null;
  owner: string | null;
  repo: string | null;
  headSha: string | null;
  checkRunId: number | null;
}

export interface VerifierGitHubMutationRequest {
  mutationId: string;
  createdAt: string;
  mode: VerifierGitHubMutationMode;
  action: VerifierGitHubMutationAction | null;
  reference: string;
  handoffId: string | null;
  artifactIds: string[];
  bundleId: string | null;
  payload: VerifierGitHubMutationRequestPayloadSummary;
  target: VerifierGitHubMutationTarget;
}

export interface VerifierGitHubMutationResponse {
  httpStatus: number | null;
  checkRunId: number | null;
  checkRunUrl: string | null;
  detailsUrl: string | null;
  summary: string;
}

export interface VerifierGitHubMutationRecord {
  mutationId: string;
  createdAt: string;
  mode: VerifierGitHubMutationMode;
  status: VerifierGitHubMutationStatus;
  reasonKind: VerifierGitHubMutationReasonKind | null;
  reason: string | null;
  attempted: boolean;
  requested: boolean;
  reference: string;
  handoffId: string | null;
  artifactIds: string[];
  bundleId: string | null;
  request: VerifierGitHubMutationRequest;
  response: VerifierGitHubMutationResponse | null;
  payload: VerifierGitHubChecksPayload;
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
  summary: string;
}

export interface VerifierGitHubMutationSelection {
  available: boolean;
  reason: string | null;
  reference: string | null;
  result: VerifierGitHubMutationRecord | null;
}

export interface VerifierReleaseTriageSummary {
  available: boolean;
  reason: string | null;
  createdAt: string;
  sourceKind: VerifierReleaseHandoffSourceKind | "unavailable";
  status: VerifierReleaseHandoffStatus | "unavailable";
  pass: boolean | null;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  baselineName: string | null;
  baselineReferenceLabel: string | null;
  targetReferenceLabel: string | null;
  handoffId: string | null;
  primaryArtifactId: string | null;
  artifactIds: string[];
  bundleId: string | null;
  snapshotIds: string[];
  sourceReferences: VerifierInspectResolvedReference[];
  finalOutcome: VerifierInspectFinalOutcome | null;
  latestVerifierStatus: VerifierInspectSummary["latestVerifierStatus"] | null;
  latestRepairStatus: VerifierInspectSummary["latestRepairStatus"] | null;
  promotionStatus: VerifierReleasePromotionStatus;
  promotionEligible: boolean | null;
  promotionSummary: string | null;
  topReasons: VerifierReleaseHandoffReasonSummary[];
  blockingDiagnostics: VerifierReleaseHandoffBlockingDiagnosticSummary | null;
  topAffectedFiles: VerifierReleaseAffectedFileSummary[];
  githubMutation: VerifierGitHubMutationRecord | null;
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
  summary: string;
}

export type VerifierGitHubChecksAnnotationLevel =
  | "failure"
  | "warning"
  | "notice";

export interface VerifierGitHubChecksAnnotation {
  fingerprint: DiagnosticFingerprint | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  startColumn: number | null;
  endColumn: number | null;
  level: VerifierGitHubChecksAnnotationLevel;
  title: string;
  message: string;
}

export interface VerifierGitHubChecksPayload {
  available: boolean;
  reason: string | null;
  createdAt: string;
  name: string;
  status: "completed";
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  text: string;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  baselineReferenceLabel: string | null;
  targetReferenceLabel: string | null;
  handoffId: string | null;
  artifactIds: string[];
  bundleId: string | null;
  topReasons: VerifierReleaseHandoffReasonSummary[];
  topAffectedFiles: VerifierReleaseAffectedFileSummary[];
  annotations: VerifierGitHubChecksAnnotation[];
  annotationTotal: number;
  annotationTruncated: boolean;
  triage: VerifierReleaseTriageSummary;
  workflow: VerifierArtifactWorkflowProvenance | null;
  upload: VerifierArtifactUploadMetadata | null;
}

export type VerifierDrilldownSourceKind =
  | "inspect"
  | "release";

export type VerifierDrilldownReasonSeverity =
  | "failure"
  | "notice"
  | "info";

export type VerifierDrilldownReasonSource =
  | "inspect"
  | "triage"
  | "github_mutation";

export interface VerifierDrilldownReasonSummary {
  kind: string;
  severity: VerifierDrilldownReasonSeverity;
  source: VerifierDrilldownReasonSource;
  path: string | null;
  summary: string;
}

export interface VerifierDrilldownBlockingDiagnosticSummary {
  available: boolean;
  comparable: boolean;
  summary: string;
  currentCount: number;
  introducedCount: number;
  persistedCount: number;
  resolvedCount: number;
  current: DiagnosticFingerprint[];
  introduced: DiagnosticFingerprint[];
  persisted: DiagnosticFingerprint[];
  resolved: DiagnosticFingerprint[];
}

export interface VerifierDrilldownCommandSuggestion {
  priority: number;
  command: string;
  reason: string;
}

export interface VerifierDrilldownReport {
  available: boolean;
  reason: string | null;
  createdAt: string;
  sourceKind: VerifierDrilldownSourceKind;
  reference: string;
  inspectReference: VerifierInspectResolvedReference | null;
  releaseReference: string | null;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  handoffSourceKind: VerifierReleaseHandoffSourceKind | "inspect" | "unavailable";
  handoffStatus: VerifierReleaseHandoffStatus | "inspect" | "unavailable";
  promotionStatus: VerifierReleasePromotionStatus;
  finalOutcome: VerifierInspectFinalOutcome | null;
  latestVerifierStatus: VerifierInspectSummary["latestVerifierStatus"] | null;
  latestRepairStatus: VerifierInspectSummary["latestRepairStatus"] | null;
  primaryArtifactId: string | null;
  handoffId: string | null;
  bundleId: string | null;
  latestArtifactId: string | null;
  latestGateArtifactId: string | null;
  latestEvalArtifactId: string | null;
  topReasons: VerifierDrilldownReasonSummary[];
  topAffectedFiles: VerifierReleaseAffectedFileSummary[];
  blockingDiagnostics: VerifierDrilldownBlockingDiagnosticSummary | null;
  githubMutation: VerifierGitHubMutationRecord | null;
  recommendedCommands: VerifierDrilldownCommandSuggestion[];
  summary: string;
}

export type VerifierTimelineEventKind =
  | "verifier_run"
  | "repair_loop"
  | "artifact_created"
  | "handoff_created"
  | "bundle_exported"
  | "promotion_planned"
  | "promotion_applied"
  | "github_mutation";

export type VerifierTimelineEventStatus =
  | "success"
  | "failure"
  | "notice"
  | "info"
  | "unavailable";

export interface VerifierTimelineLinkedIds {
  verifierRunId: string | null;
  repairLoopId: string | null;
  artifactId: string | null;
  handoffId: string | null;
  bundleId: string | null;
  baselineName: string | null;
  promotionId: string | null;
  mutationId: string | null;
  snapshotIds: string[];
}

export interface VerifierTimelineEvent {
  id: string;
  createdAt: string;
  kind: VerifierTimelineEventKind;
  status: VerifierTimelineEventStatus;
  summary: string;
  reason: string | null;
  path: string | null;
  linkedIds: VerifierTimelineLinkedIds;
  affectedFiles: string[];
  diagnostics: DiagnosticFingerprint[];
}

export interface VerifierTimelineContinuity {
  sessionId: string | null;
  traceId: string | null;
  replayReference: string | null;
  snapshotId: string | null;
  baselineId: string | null;
  baselineName: string | null;
  latestVerifierRunId: string | null;
  latestRepairLoopId: string | null;
  primaryArtifactId: string | null;
  latestArtifactId: string | null;
  latestGateArtifactId: string | null;
  latestEvalArtifactId: string | null;
  handoffId: string | null;
  bundleId: string | null;
  promotionId: string | null;
  githubMutationId: string | null;
  workflowRunId: string | null;
  uploadArtifactId: string | null;
}

export interface VerifierTimelineCommandSuggestion {
  priority: number;
  command: string;
  reason: string;
}

export interface VerifierTimelineReport {
  available: boolean;
  reason: string | null;
  createdAt: string;
  sourceKind: VerifierDrilldownSourceKind;
  reference: string;
  continuity: VerifierTimelineContinuity;
  latestStateSummary: string;
  primaryIssueEventId: string | null;
  focus: VerifierDrilldownReport;
  events: VerifierTimelineEvent[];
  recommendedCommands: VerifierTimelineCommandSuggestion[];
  summary: string;
}

export type VerifierInspectArtifactRetentionReasonKind =
  | "protected_non_artifact"
  | "within_max_count"
  | "within_max_age"
  | "delete_max_count"
  | "delete_max_age"
  | "delete_parent_artifact"
  | "orphaned";

export interface VerifierInspectArtifactRetentionPolicy {
  maxArtifactCount: number;
  maxArtifactAgeDays: number | null;
  dryRun: boolean;
}

export type VerifierInspectArtifactPruneSubjectKind =
  | "artifact"
  | "handoff"
  | "bundle";

export interface VerifierInspectArtifactPruneDecision {
  kind: VerifierInspectArtifactPruneSubjectKind;
  id: string;
  createdAt: string | null;
  path: string;
  action: "keep" | "delete";
  reasonKind: VerifierInspectArtifactRetentionReasonKind;
  reason: string;
  sourceArtifactId: string | null;
}

export interface VerifierInspectArtifactPruneResult {
  policy: VerifierInspectArtifactRetentionPolicy;
  dryRun: boolean;
  keptCount: number;
  deletedCount: number;
  kept: VerifierInspectArtifactPruneDecision[];
  deleted: VerifierInspectArtifactPruneDecision[];
  summary: string;
}

export type NetworkMode = "off" | "docs-only" | "open-web";
export type RankingMode = "balanced" | "docs-first" | "official-first";
export type SourceKind =
  | "official-api"
  | "official-doc"
  | "official-blog"
  | "release-notes"
  | "source-code"
  | "issue"
  | "community-forum"
  | "blog"
  | "unknown"
  | "web"
  | "hook"
  | (string & {});
export type SourceTrustLayer =
  | "official"
  | "release"
  | "repos"
  | "issues"
  | "community"
  | (string & {});
export type ExtractionStrategy =
  | "html-basic-readability"
  | "text-plain"
  | "markdown-plain"
  | "json-plain"
  | "xml-plain";
export type WebSearchProviderName = "fallback" | "brave";

export interface UrlMetadata {
  ok: boolean;
  input: string;
  href: string | null;
  origin: string | null;
  domain: string | null;
  pathname: string | null;
  protocol: string | null;
  error: string | null;
}

export interface UrlAccessDecision {
  allowed: boolean;
  reason: string | null;
  domain: string | null;
  official: boolean;
  networkMode: NetworkMode;
  metadata: UrlMetadata;
  matchedAllowDomain: string | null;
  matchedDenyDomain: string | null;
  docsOnlyAllowed: boolean;
}

export interface NetworkInputSummary {
  kind: "search" | "fetch";
  query: string | null;
  provider: WebSearchProviderName | null;
  networkMode: NetworkMode;
  domain: string | null;
  official: boolean;
  url: string | null;
  decision: UrlAccessDecision | null;
}

export interface SourceClassification {
  sourceKind: SourceKind;
  official: boolean;
  trustLayer: SourceTrustLayer;
}

export interface SourceScoreBreakdown {
  trustGraph: number;
  officialness: number;
  queryTitleOverlap: number;
  querySnippetOverlap: number;
  queryUrlOverlap: number;
  docsHint: number;
  freshness: number;
  allowlistBonus: number;
  mirrorPenalty: number;
  spamPenalty: number;
  modeBonus: number;
  total: number;
}

export interface WebSearchProviderResultRow {
  id: string;
  title: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  snippet: string;
  query: string;
  provider: WebSearchProviderName;
  retrievedAt: string;
  publishedAt: string | null;
  cacheHit: boolean;
  official: boolean | null;
  sourceKind: SourceKind | null;
  trustLayer: SourceTrustLayer | null;
}

export interface WebSearchProviderSearchInput {
  query: string;
  maxResults: number;
  traceId?: string | null;
  onEvent?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  search(input: WebSearchProviderSearchInput): Promise<WebSearchProviderResultRow[]>;
}

export interface RankedSourceResult extends WebSearchProviderResultRow {
  official: boolean;
  sourceKind: SourceKind;
  trustLayer: SourceTrustLayer;
  rank: number;
  score: number;
  scoreBreakdown: SourceScoreBreakdown;
}

export interface ExtractedContent {
  url: string;
  canonicalUrl: string;
  domain: string | null;
  title: string;
  publishedAt: string | null;
  author: string | null;
  headings: string[];
  excerpt: string;
  readableText: string;
  rawTextLength: number;
  truncated: boolean;
  extractionStrategy: ExtractionStrategy;
}

export interface RankedSourceResultWithSourceId extends RankedSourceResult {
  sourceId: string | null;
}

export interface SourcePackSummary {
  packId: string;
  sourceIds: string[];
  sources: SourceRecord[];
}

export interface WebSearchResult {
  query: string;
  provider: WebSearchProviderName;
  networkMode: NetworkMode;
  rankingMode: RankingMode;
  filteredOut: number;
  results: RankedSourceResultWithSourceId[];
  sourcePack: SourcePackSummary;
  citations: CitationSummary[];
}

export interface FetchUrlExtractedMeta {
  title: string;
  canonicalUrl: string;
  excerpt: string;
  headings: string[];
}

export interface FetchUrlResult {
  url: string;
  finalUrl: string;
  contentType: string | null;
  redirected: boolean;
  cacheHit: boolean;
  bodyPreview: string;
  extractedMeta: FetchUrlExtractedMeta | null;
  sourcePack: SourcePackSummary;
  citations: CitationSummary[];
}

export interface ExtractContentResult {
  url: string;
  finalUrl: string;
  contentType: string | null;
  cacheHit: boolean;
  extracted: ExtractedContent;
  sourcePack: SourcePackSummary;
  citations: CitationSummary[];
  primaryCitation: CitationSummary | null;
}

export interface WebCacheOptions {
  cacheDir?: string;
  defaultTtlMs?: number;
  negativeTtlMs?: number;
  maxEntriesPerNamespace?: number;
}

export interface WebCacheRecordBase<TValue = unknown> {
  namespace: string;
  keyHash: string;
  key: string;
  negative: boolean;
  value: TValue | null;
  createdAt: string;
  expiresAt: string;
  provider: string | null;
  query: string | null;
  url: string | null;
  hash: string | null;
  cacheHitCount: number;
  lastAccessedAt: string;
}

export interface WebCachePositiveRecord<TValue = unknown> extends WebCacheRecordBase<TValue> {
  negative: false;
  value: TValue;
  hash: string;
}

export interface WebCacheNegativeRecord extends WebCacheRecordBase<null> {
  negative: true;
  value: null;
  error: unknown;
  hash: null;
}

export type WebCacheRecord<TValue = unknown> =
  | WebCachePositiveRecord<TValue>
  | WebCacheNegativeRecord;

export type WebCacheLookupResult<TValue = unknown> =
  | {
      hit: true;
      negative: false;
      value: TValue;
      meta: WebCachePositiveRecord<TValue>;
    }
  | {
      hit: true;
      negative: true;
      value: null;
      meta: WebCacheNegativeRecord;
    }
  | null;

export type PatchUpdateHunk = string[];

export interface PatchAddOperation {
  type: "add";
  path: string;
  content: string;
}

export interface PatchDeleteOperation {
  type: "delete";
  path: string;
}

export interface PatchUpdateOperation {
  type: "update";
  path: string;
  moveTo: string | null;
  hunks: PatchUpdateHunk[];
}

export type PatchOperation =
  | PatchAddOperation
  | PatchDeleteOperation
  | PatchUpdateOperation;

export type PatchFileChangeOperation = "add" | "delete" | "update" | "rename";

export interface PatchFileChange {
  operation: PatchFileChangeOperation;
  path: string;
  previousPath: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  touchedFiles: string[];
}

export interface PatchPreview {
  fileChanges: PatchFileChange[];
  touchedFiles: string[];
  operationCount: number;
}

export interface ApplyPatchResult {
  touchedFiles: string[];
  operationCount: number;
}

export type DirectoryEntryKind = "dir" | "file" | "other";

export interface ListDirEntry {
  name: string;
  kind: DirectoryEntryKind;
  size: number | null;
}

export interface ListDirResult {
  path: string;
  entries: ListDirEntry[];
  truncated: boolean;
}

export interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
}

export interface ReplaceInFileResult {
  path: string;
  replacements: number;
}

export type FileSearchEngine = "ripgrep" | "fallback";

export interface FileSearchMatch {
  path: string;
  line: number;
  preview: string;
}

export interface SearchFilesResult {
  path: string;
  query: string;
  engine: FileSearchEngine;
  matches: FileSearchMatch[];
}

export type SkillScope = "builtin" | "project" | "local";

export interface SkillToolPreferences {
  prefer: string[];
  avoid: string[];
}

export interface SkillVariantSummary {
  id: string;
  scope: SkillScope;
  originPath: string;
  precedence: number;
}

export interface SkillInfluenceEntry {
  id: string;
  title: string;
  scope: SkillScope;
  sourceQualifiedName: string;
  summary: string;
  workflowHintCount: number;
  retrievalHintCount: number;
  preferredTools: string[];
  avoidedTools: string[];
  outputRuleCount: number;
}

export interface SkillListEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  enabled: boolean;
  active: boolean;
  scope: SkillScope;
  autoAttach: boolean;
  explicitState: "enabled" | "disabled" | null;
  precedence: number;
  originPath: string;
  sourceQualifiedName: string;
  tags: string[];
  influenceSummary: string;
  influence: SkillInfluenceEntry;
  variants: SkillVariantSummary[];
}

export interface SkillInspectRecord extends SkillListEntry {
  manifestEnabled: boolean;
  prompt: string;
  workflowHints: string[];
  retrievalHints: string[];
  toolPreferences: SkillToolPreferences;
  outputPolicy: string[];
}

export interface PluginCapabilityManifestEntry {
  type: string;
  name: string;
  description: string;
  inputSchema: JsonObject | null;
  riskCategory: string;
  tags: string[];
  permissionsHints: string[];
}

export interface PluginManifestSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  entryPath: string;
  originPath: string;
  scope: string;
  precedence: number;
  manifestEnabled: boolean;
  permissionsHints: string[];
  capabilities: PluginCapabilityManifestEntry[];
  sourceQualifiedName: string;
}

export interface PluginVariantSummary {
  scope: string;
  originPath: string;
  precedence: number;
}

export interface PluginToolSummary extends ToolMetadata {
  source: "plugin";
  type: "plugin-tool";
  pluginId: string;
  pluginName: string;
  originPath: string;
  permissionsHints: string[];
  riskCategory: string;
  tags: string[];
  sourceQualifiedName: string;
}

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  scope: string;
  enabled: boolean;
  active: boolean;
  explicitState: "enabled" | "disabled" | null;
  status: "active" | "disabled" | "error";
  permissionsHints: string[];
  originPath: string;
  entryPath: string;
  sourceQualifiedName: string;
  toolCount: number;
  toolNames: string[];
  loadError: string | null;
  variants: PluginVariantSummary[];
}

export interface PluginInspectRecord extends PluginListEntry {
  capabilities: PluginCapabilityManifestEntry[];
  tools: PluginToolSummary[];
}

export type CapabilityType =
  | "builtin-tool"
  | "web-tool"
  | "mcp-tool"
  | "plugin-tool"
  | "skill"
  | "memory"
  | "instruction/policy";

export type ToolCapabilityType =
  | "builtin-tool"
  | "web-tool"
  | "mcp-tool"
  | "plugin-tool";

export type CapabilityScope =
  | "builtin"
  | "project"
  | "local"
  | "runtime"
  | "user"
  | "external";

export type CapabilityRiskCategory =
  | "read"
  | "write"
  | "exec"
  | "network"
  | "external"
  | "policy"
  | "state"
  | "destructive"
  | (string & {});

export type CapabilityGroupKey = string;

export interface CapabilityProvenance extends JsonObject {
  layer?: JsonValue;
  instructionLayer?: JsonValue;
  importedFrom?: JsonValue;
  order?: JsonValue;
  scope?: JsonValue;
  variants?: JsonValue;
  pluginId?: JsonValue;
  pluginName?: JsonValue;
}

export interface CapabilityMetadata extends JsonObject {
  autoAttach?: JsonValue;
  influenceSummary?: JsonValue;
  influence?: JsonValue;
  summary?: JsonValue;
  ruleCount?: JsonValue;
}

export interface CapabilityInput {
  [key: string]: unknown;
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  type?: string | null;
  source?: string | null;
  enabled?: boolean | null;
  active?: boolean | null;
  riskCategory?: string | null;
  provenance?: Record<string, unknown> | CapabilityProvenance | JsonObject | null;
  description?: string | null;
  inputSchema?: JsonObject | null;
  tags?: unknown;
  scope?: string | null;
  originPath?: string | null;
  sourceQualifiedName?: string | null;
  projectAttached?: boolean | null;
  inherited?: boolean | null;
  external?: boolean | null;
  risky?: boolean | null;
  groupKey?: string | null;
  metadata?: Record<string, unknown> | CapabilityMetadata | JsonObject | null;
}

export interface CapabilitySurfaceSummary {
  total: number;
  active: number;
  disabled: number;
  external: number;
  risky: number;
  projectAttached: number;
  inherited: number;
  byType: Record<CapabilityType, number>;
}

export interface NormalizedCapability {
  id: string;
  name: string;
  displayName: string;
  type: CapabilityType;
  source: string;
  enabled: boolean;
  active: boolean;
  riskCategory: CapabilityRiskCategory;
  provenance: CapabilityProvenance;
  description: string;
  inputSchema: JsonObject | null;
  tags: string[];
  scope: CapabilityScope;
  originPath: string | null;
  sourceQualifiedName: string;
  projectAttached: boolean;
  inherited: boolean;
  external: boolean;
  risky: boolean;
  groupKey: CapabilityGroupKey | null;
  metadata: CapabilityMetadata;
}

export interface CapabilityFilters {
  type?: CapabilityType;
  enabled?: boolean;
  active?: boolean;
  source?: string;
  scope?: CapabilityScope;
  external?: boolean;
  risky?: boolean;
  projectAttached?: boolean;
  inherited?: boolean;
  groupKey?: CapabilityGroupKey;
  tag?: string;
  query?: string;
}

export type ExtensionStateKind = "skills" | "plugins";
export type ExtensionExplicitState = "enabled" | "disabled" | null;

export interface ExtensionStateSection {
  enabled: string[];
  disabled: string[];
}

export interface ExtensionStateSnapshot {
  skills: ExtensionStateSection;
  plugins: ExtensionStateSection;
}

export interface ExtensionStateResolveResult {
  enabled: boolean;
  explicitState: ExtensionExplicitState;
}

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rawArguments?: string;
}

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
}

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

export interface ProviderUsageSummary {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}

export interface ProviderCompletionMeta {
  traceId?: string | null;
  attemptCount?: number;
  fallbackUsed?: boolean;
  [key: string]: unknown;
}

export interface ProviderCompletionResult {
  text: string;
  usage: ProviderUsageSummary | null;
  toolCalls?: ProviderToolCall[];
  meta: ProviderCompletionMeta;
}

export interface ProviderListModelsOptions {
  traceId?: string | null;
  onProviderEvent?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
}

export interface ProviderCompletionRequest {
  systemPrompt: string;
  messages: ProviderMessage[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  streamOutput?: boolean;
  onTextDelta?: ((delta: string) => Promise<void> | void) | null;
  tools?: ProviderToolDefinition[];
  traceId?: string | null;
  onProviderEvent?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
  endpoint?: string | null;
}

export type PermissionCategory =
  | "read"
  | "write"
  | "exec"
  | "network"
  | "plugin"
  | "mcp"
  | "state"
  | "unknown"
  | "hook";

export interface NetworkPermissionMeta extends NetworkInputSummary {}

export interface McpPermissionMeta {
  serverId: string | null;
  serverName: string | null;
  toolName: string;
  annotations: Record<string, boolean | string | number | null | undefined>;
}

export interface PluginPermissionMeta {
  pluginId: string | null;
  pluginName: string | null;
  toolName: string;
  riskCategory: string;
  permissionsHints: string[];
}

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string | null;
  category: PermissionCategory;
  targetPaths: string[];
  targetDomains?: string[];
  network?: NetworkPermissionMeta | null;
  mcp?: McpPermissionMeta | null;
  plugin?: PluginPermissionMeta | null;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export interface ApprovalContext {
  toolName: string;
  touchedPaths: string[];
  targetDomains: string[];
  previewSummary: string[];
  rollbackAvailable: boolean;
  risk: RiskAssessment | null;
  blockedReason: string | null;
  network: NetworkPermissionMeta | null;
  mcp: McpPermissionMeta | null;
  plugin: PluginPermissionMeta | null;
}

export interface CapabilitySummary {
  id: string;
  name: string;
  displayName?: string;
  type: CapabilityType;
  source: string;
  enabled?: boolean;
  active?: boolean;
  riskCategory?: CapabilityRiskCategory;
  description?: string;
  tags?: string[];
  sourceQualifiedName?: string;
}

export interface CapabilityRouteEntry extends CapabilitySummary {
  score?: number;
  reasons?: string[];
  blockedReason?: string;
  rejectedReason?: string;
}

export interface CapabilityBudget {
  mode: string;
  maxSelected: number;
  selectThreshold: number;
  preferredCategories: string[];
  expensiveCategories: string[];
  reason: string;
  degradedPressure: number;
}

export interface RouteGovernanceSummary {
  permissionMode: string;
  approvalPolicy: string;
  networkMode: string;
  degradedFlags: string[];
}

export interface TaskClassification {
  taskClass: string;
  confidence: number;
  reasons: string[];
  freshnessRequired: boolean;
  externalCapabilityNeeded: boolean;
  likelyWrites: boolean;
  likelyShell: boolean;
  likelyWeb: boolean;
  likelyMcp: boolean;
  riskHint: string;
  [key: string]: unknown;
}

export interface RouteDecision {
  routeId?: string;
  taskClass: string;
  selectedCapabilities: CapabilityRouteEntry[];
  rejectedCapabilities: CapabilityRouteEntry[];
  requiredCapabilities: string[];
  blockedCapabilities: CapabilityRouteEntry[];
  routingMode: string;
  reasons: string[];
  degraded: boolean;
  capabilityBudget?: CapabilityBudget;
  selectedSkillIds?: string[];
  rankingMode?: string;
  governance?: RouteGovernanceSummary;
  [key: string]: unknown;
}

export interface ModelFallbackEntry {
  model: string;
  score: number;
  order: number;
  strategy: string;
}

export interface ModelCandidate {
  model: string;
  score: number;
  contextWindow?: number;
  family?: string;
}

export interface RuntimePressure {
  mode: string;
  avgHealthScore: number;
  retryPressure: number;
  degradedFlags: string[];
  taskClass?: string;
}

export interface ModelDecision {
  chosenProvider: string | null;
  chosenModel: string | null;
  fallbackModels: string[];
  fallbackChain: ModelFallbackEntry[];
  reason: string;
  estimatedContextNeed?: string;
  latencyTarget?: string;
  costSensitivity?: string;
  candidates?: ModelCandidate[];
  healthAware?: boolean;
  degradedFlags?: string[];
  runtimePressure?: RuntimePressure;
  selectedModel?: string;
  attemptedModels?: string[];
  fallbackChainUsed?: boolean;
}

export type PlanGoalStatus =
  | "pending"
  | "active"
  | "blocked"
  | "degraded"
  | "failed"
  | "completed";

export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked";

export type PlanStepKind = "primary" | "fallback" | "recovery";

export type PlanBlockedReasonKind =
  | "permission_denied"
  | "approval_denied"
  | "boundary_blocked"
  | "tool_failed"
  | "tool_preview_failed"
  | "provider_retry_exhausted"
  | "provider_circuit_open"
  | "verifier_failed"
  | "repair_exhausted"
  | "max_steps_exhausted"
  | "runtime_degraded"
  | "waiting_on_verification"
  | "unknown";

export type PlanVerificationTrigger =
  | "none"
  | "after_edit"
  | "after_execute"
  | "before_finalize"
  | "post_repair";

export type PlanRiskHintKind =
  | "writes"
  | "shell"
  | "network"
  | "approval"
  | "runtime_degraded"
  | "verification"
  | "provider"
  | "unknown";

export type PlanStopConditionKind =
  | "goal_satisfied"
  | "verifier_failed"
  | "repair_exhausted"
  | "provider_failed"
  | "max_steps_exhausted"
  | "blocked"
  | "unknown";

export type PlanEventKind =
  | "created"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "step_blocked"
  | "verification_started"
  | "verification_result"
  | "repair_started"
  | "repair_result"
  | "replanned"
  | "finalized";

export type PlanEventStatus =
  | "info"
  | "progressed"
  | "blocked"
  | "replanned"
  | "done"
  | "failed";

export interface PlanStepBlockedReason {
  kind: PlanBlockedReasonKind;
  summary: string;
  blockedAt: string;
  recoverable: boolean;
  stepId?: string | null;
  relatedStepId?: string | null;
  eventId?: string | null;
  taxonomy?: string | null;
}

export interface PlanVerificationRequirement {
  required: boolean;
  trigger: PlanVerificationTrigger;
  summary: string;
  blockingOnFailure: boolean;
}

export interface PlanRiskHint {
  kind: PlanRiskHintKind;
  level: RiskLevel;
  summary: string;
  requiresApproval?: boolean;
}

export interface PlanFallbackPath {
  summary: string;
  stepIds: string[];
  triggerKinds: PlanBlockedReasonKind[];
}

export interface PlanStopCondition {
  kind: PlanStopConditionKind;
  status: "continue" | "stop" | "done";
  summary: string;
  stepId?: string | null;
  eventId?: string | null;
  satisfiedAt?: string | null;
}

export interface PlanGoal {
  summary: string;
  taskClass: string;
  status: PlanGoalStatus;
  verificationBias: boolean;
  doneCriteria: string[];
  successSignal: string;
  fallbackSummary: string | null;
}

export interface PlanSubtask {
  id: string;
  title: string;
  summary: string;
  status: PlanGoalStatus;
  stepIds: string[];
  dependsOn: string[];
  capabilityHints: string[];
  verificationBias: boolean;
  riskHints: PlanRiskHint[];
  doneCriteria: string[];
}

export interface PlanReplanDecision {
  action: "continue" | "replan" | "fallback" | "stop";
  reasonKind: PlanBlockedReasonKind;
  summary: string;
  previousStepId: string | null;
  targetStepId: string | null;
  verificationRequired: boolean;
}

export interface PlanEvent {
  id: string;
  createdAt: string;
  kind: PlanEventKind;
  status: PlanEventStatus;
  summary: string;
  stepId?: string | null;
  linkedStepIds?: string[];
  linkedEventId?: string | null;
  reasonKind?: PlanBlockedReasonKind | null;
  replan?: PlanReplanDecision | null;
}

export interface PlanStep {
  id?: string;
  title?: string;
  type: string;
  status?: PlanStepStatus;
  kind?: PlanStepKind;
  toolName?: string;
  notes?: string;
  note?: string | null;
  capabilityHints?: string[];
  dependsOn?: string[];
  blockedReason?: PlanStepBlockedReason | null;
  verification?: PlanVerificationRequirement | null;
  riskHints?: PlanRiskHint[];
  fallbackPath?: PlanFallbackPath | null;
  approvalRequired?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  [key: string]: unknown;
}

export interface ExecutionPlan {
  planId?: string;
  taskClass?: string;
  goal?: PlanGoal;
  subtasks?: PlanSubtask[];
  steps: PlanStep[];
  edges?: Array<{
    from: string;
    to: string;
    condition: string;
  }>;
  currentStep?: string | null;
  completedSteps?: string[];
  blockedSteps?: string[];
  failedSteps?: string[];
  fallbackSteps?: string[];
  blockedReasons?: PlanStepBlockedReason[];
  doneCriteria?: string[];
  verificationBias?: boolean;
  promptSummary?: string;
  routeId?: string | null;
  model?: string | null;
  graphType?: string;
  status?: PlanGoalStatus;
  stopCondition?: PlanStopCondition | null;
  replanCount?: number;
  events?: PlanEvent[];
  createdAt?: string;
  lastUpdatedAt?: string;
  [key: string]: unknown;
}

export type PlanInspectReferenceKind = "current" | "trace" | "replay" | "latest";

export interface PlanInspectResolvedReference {
  kind: PlanInspectReferenceKind;
  reference: string | null;
  sessionId: string | null;
  traceId: string | null;
  planId: string | null;
}

export interface PlanCommandSuggestion {
  command: string;
  reason: string;
  priority: number;
}

export interface PlanCurrentReport {
  source: PlanInspectResolvedReference;
  available: boolean;
  plan: ExecutionPlan | null;
  goal: PlanGoal | null;
  currentStep: PlanStep | null;
  blockers: PlanStepBlockedReason[];
  latestReplan: PlanEvent | null;
  recentEvents: PlanEvent[];
  suggestedCommands: PlanCommandSuggestion[];
  summary: {
    status: PlanGoalStatus;
    totalSteps: number;
    completedSteps: number;
    blockerCount: number;
    replanCount: number;
    verificationRequired: boolean;
  };
}

export interface PlanTimelineReport {
  source: PlanInspectResolvedReference;
  available: boolean;
  plan: ExecutionPlan | null;
  latestState: {
    status: PlanGoalStatus;
    currentStepId: string | null;
    stopCondition: PlanStopCondition | null;
    replanCount: number;
  };
  leadingProblemEvent: PlanEvent | null;
  events: PlanEvent[];
  blockers: PlanStepBlockedReason[];
  suggestedCommands: PlanCommandSuggestion[];
}

export type PlanRenderProfile = "json" | "summary" | "failures";

export type AgentDecisionScope =
  | "overview"
  | "route"
  | "model"
  | "tool"
  | "plan"
  | "verifier";

export type AgentDecisionReferenceKind = "current" | "trace" | "replay" | "latest";

export interface AgentDecisionResolvedReference {
  kind: AgentDecisionReferenceKind;
  reference: string | null;
  sessionId: string | null;
  traceId: string | null;
  planId: string | null;
}

export type AgentDecisionLayer =
  | "route"
  | "model"
  | "tool"
  | "provider"
  | "verifier"
  | "plan"
  | "runtime"
  | "github";

export type AgentDecisionStatus = "ok" | "degraded" | "blocked" | "failed" | "unavailable";

export type AgentDecisionProblemKind =
  | PlanBlockedReasonKind
  | "route_degraded"
  | "model_degraded"
  | "verifier_stop"
  | "github_mutation_blocked"
  | "github_mutation_unavailable"
  | "state_unavailable";

export type AgentDecisionConfidence = "high" | "medium" | "low";

export interface AgentDecisionAssessment {
  bounded: boolean;
  confidence: AgentDecisionConfidence;
  unavailableReason: string | null;
}

export interface AgentDecisionLayerSummary {
  layer: AgentDecisionLayer;
  status: AgentDecisionStatus;
  summary: string;
  reasons: string[];
  degraded: boolean;
  blocking: boolean;
}

export interface AgentDecisionProblem {
  kind: AgentDecisionProblemKind;
  layer: AgentDecisionLayer;
  status: AgentDecisionStatus;
  summary: string;
  why: string;
  filePaths: string[];
  stepId: string | null;
  eventId: string | null;
  traceId: string | null;
}

export type AgentDecisionSuggestionKind =
  | "inspect"
  | "retry"
  | "approval"
  | "permission_change"
  | "wait"
  | "verify"
  | "review"
  | "github";

export interface AgentDecisionSuggestion {
  kind: AgentDecisionSuggestionKind;
  layer: AgentDecisionLayer;
  command: string;
  reason: string;
  whyNow: string;
  priority: number;
}

export type AgentRecoveryKind =
  | "permission_denied"
  | "approval_denied"
  | "boundary_blocked"
  | "provider_retry_exhausted"
  | "provider_circuit_open"
  | "verifier_failed"
  | "repair_exhausted"
  | "github_mutation_unavailable"
  | "github_mutation_blocked"
  | "insufficient_context";

export type AgentRecoveryStatus = "available" | "unavailable" | "insufficient_context";

export interface AgentRecoverySuggestion {
  kind: AgentRecoveryKind;
  layer: AgentDecisionLayer;
  status: AgentRecoveryStatus;
  blocking: boolean;
  summary: string;
  reason: string;
  whyNow: string;
  commands: AgentDecisionSuggestion[];
}

export interface AgentToolDecisionContext {
  observedTools: string[];
  latestBoundaryDecision: ExecutionBoundaryDecisionSummary | null;
  latestApproval: Record<string, unknown> | null;
  latestChangeSet: ChangeSetSummary | null;
}

export interface AgentGitHubDecisionContext {
  available: boolean;
  reason: string | null;
  reference: string | null;
  result: VerifierGitHubMutationRecord | null;
}

export interface AgentDecisionReport {
  scope: AgentDecisionScope;
  source: AgentDecisionResolvedReference;
  available: boolean;
  status: AgentDecisionStatus;
  assessment: AgentDecisionAssessment;
  taskClassification: TaskClassification | null;
  routeDecision: RouteDecision | null;
  modelDecision: ModelDecision | null;
  executionPlan: ExecutionPlan | null;
  planCurrent: PlanCurrentReport | null;
  planTimeline: PlanTimelineReport | null;
  verifier: VerifierInspectReport | null;
  runtimeScorecard: RuntimeHealthScorecard | null;
  toolContext: AgentToolDecisionContext | null;
  githubMutation: AgentGitHubDecisionContext | null;
  leadingProblem: AgentDecisionProblem | null;
  degradedLayers: AgentDecisionLayerSummary[];
  blockingReasons: AgentDecisionProblem[];
  nextSteps: AgentDecisionSuggestion[];
  recovery: AgentRecoverySuggestion[];
}

export type AgentDecisionRenderProfile = "json" | "summary" | "failures";

export interface ChangeSetFileSummary {
  operation: string;
  path: string;
  previousPath?: string | null;
  stats?: {
    added?: number;
    removed?: number;
  };
  summary: string;
  diffTruncated?: boolean;
}

export interface ChangeSetDiffStats {
  added: number;
  removed: number;
}

export interface ChangeImpactCostSummary {
  engine: string;
  scannedFiles: number;
  scanTruncated: boolean;
  cacheHit: boolean;
  deadlineHit: boolean;
}

export interface ChangeImpactSummary {
  touchedFiles: string[];
  relatedFiles: string[];
  likelyTests: string[];
  needsTestRerun: boolean;
  engine: string;
  scannedFiles: number;
  scanTruncated: boolean;
  cacheHit: boolean;
  deadlineHit: boolean;
  quality: string;
  cost: ChangeImpactCostSummary;
}

export interface ChangeSetFileEntry extends ChangeSetFileSummary {
  touchedFiles: string[];
  beforeExists: boolean;
  afterExists: boolean;
  beforeBytes: number;
  afterBytes: number;
  stats: ChangeSetDiffStats;
  diff: string;
}

export interface ChangeSetFileState {
  operation: string;
  path: string;
  previousPath: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  touchedFiles: string[];
}

export type RollbackCheckpointStatus =
  | "checkpointed"
  | "applied"
  | "apply_failed"
  | "apply_partial_failure"
  | "rolled_back"
  | "rollback_partial_failure";

export interface RollbackCheckpointFileRecord {
  operation: string;
  path: string;
  previousPath: string | null;
  beforeBlob: string | null;
  afterBlob: string | null;
  forwardPatch: string;
  reversePatch: string;
}

export interface RollbackErrorEntry {
  path: string;
  previousPath: string | null;
  operation: string;
  error: string;
}

export interface RollbackResultEntry {
  path: string;
  previousPath: string | null;
  operation: string;
  restored: boolean;
}

export interface RollbackCheckpointRecord {
  id: string;
  sessionId: string | null;
  traceId: string | null;
  toolName: string;
  origin: string;
  sourceTool: string;
  risk: RiskAssessment | null;
  createdAt: string;
  status: RollbackCheckpointStatus;
  rollbackAvailable: boolean;
  summary: ChangeSetSummary;
  files: RollbackCheckpointFileRecord[];
  appliedAt: string | null;
  applyResult: unknown;
  applyError: string | null;
  applyErrorTaxonomy?: string | null;
  rollbackAt: string | null;
  rollbackError: RollbackErrorEntry[] | null;
  restorePointId: string | null;
}

export interface RollbackCheckpointListEntry {
  id: string;
  createdAt: string;
  status: RollbackCheckpointStatus;
  origin: string;
  toolName: string;
  risk: RiskAssessment | null;
  sessionId: string | null;
  traceId: string | null;
  restorePointId: string | null;
  touchedFiles: string[];
}

export interface RollbackResult {
  changeSetId: string;
  restorePointId: string | null;
  rolledBack: boolean;
  partial: boolean;
  results: RollbackResultEntry[];
  errors: RollbackErrorEntry[];
}

export interface ChangeSetRecord {
  id: string;
  createdAt: string;
  toolName: string;
  dryRun: boolean;
  input: unknown;
  touchedFiles: string[];
  operations: Record<string, number>;
  files: ChangeSetFileEntry[];
  diff: string;
  diffTruncated: boolean;
  impact: ChangeImpactSummary;
  rollbackAvailable: boolean;
  checkpointId: string | null;
  risk: RiskAssessment | null;
  _internal: {
    cwd: string;
    fileStates: ChangeSetFileState[];
  };
}

export interface ChangeSetSummary {
  id: string;
  createdAt?: string;
  toolName: string;
  touchedFiles: string[];
  operations: Record<string, number>;
  diffTruncated?: boolean;
  rollbackAvailable?: boolean;
  checkpointId?: string | null;
  risk?: RiskAssessment | null;
  impact?: ChangeImpactSummary | JsonObject | null;
  files: ChangeSetFileSummary[];
  diff?: string;
}

export interface ChangeSetDiffSelection {
  id: string;
  toolName: string;
  risk?: RiskAssessment | null;
  impact?: ChangeImpactSummary | JsonObject | null;
  rollbackAvailable?: boolean;
  checkpointId?: string | null;
  diff?: string;
  files?: ChangeSetFileEntry[];
  file?: ChangeSetFileEntry;
}

export type ExecutionBoundaryMode = "off" | "workspace" | "strict-policy";

export interface ShellCommandMatch {
  id: string;
  reason?: string;
}

export interface ShellCommandClassification {
  summary: string;
  spawnMode: string;
  blockedMatches: ShellCommandMatch[];
  approvalMatches: ShellCommandMatch[];
  networkMatches: string[];
  destructive: boolean;
  highRisk: boolean;
  networkAccess: boolean;
}

export interface ExecutionBoundaryEnvPolicy {
  mode: "passthrough" | "allowlist";
  passThroughEnv: Record<string, string | undefined>;
  passedKeys: string[];
  droppedKeys: string[];
  redactedKeys: string[];
}

export interface ExecutionBoundaryShellPolicy {
  shell?: string | null;
  renderedCommand: string;
  classification: ShellCommandClassification;
  ptyRequested: boolean;
  networkMode: string;
  blockedReason: string | null;
  forceApproval: boolean;
}

export interface ExecutionBoundaryEvent {
  type: "execution_boundary_decision";
  traceId?: string | null;
  step?: string | number | null;
  subjectType: string;
  subjectId: string;
  toolName: string | null;
  toolSource: string;
  status: string;
  blocked: boolean;
  boundaryMode: ExecutionBoundaryMode;
  category: string | null;
  requiresApproval: boolean;
  reason: string | null;
  reasons: string[];
  degradedReasons: string[];
  targetPaths: string[];
  targetDomains: string[];
  envPolicy: Omit<ExecutionBoundaryEnvPolicy, "passThroughEnv"> | null;
  shellPolicy: {
    renderedCommand: string;
    classification: ShellCommandClassification;
    ptyRequested: boolean;
    networkMode: string;
  } | null;
  meta?: Record<string, unknown> | null;
}

export interface ExecutionBoundaryDecision {
  subjectType: string;
  subjectId: string;
  toolName: string | null;
  toolSource: string;
  status: string;
  blocked: boolean;
  degraded: boolean;
  boundaryMode: ExecutionBoundaryMode;
  permissionDecision: PermissionDecision;
  requiresApproval: boolean;
  effectiveInput: unknown;
  reasons: string[];
  degradedReasons: string[];
  shellPolicy: ExecutionBoundaryShellPolicy | null;
  envPolicy: ExecutionBoundaryEnvPolicy | null;
  meta?: Record<string, unknown> | null;
  event: ExecutionBoundaryEvent;
}

export interface ExecutionBoundaryDecisionSummary {
  subjectType: string;
  subjectId: string;
  toolName: string | null;
  toolSource: string;
  status: string;
  blocked: boolean;
  degraded: boolean;
  boundaryMode: ExecutionBoundaryMode;
  requiresApproval: boolean;
  reasons: string[];
  degradedReasons: string[];
  shellPolicy: {
    renderedCommand: string;
    classification: ShellCommandClassification;
    ptyRequested: boolean;
  } | null;
  envPolicy: Omit<ExecutionBoundaryEnvPolicy, "passThroughEnv"> | null;
  meta?: Record<string, unknown> | null;
}

export interface SourcePack {
  sourceIds: string[];
  citations?: CitationSummary[];
  rankingMode?: string;
  [key: string]: unknown;
}

export type MemoryScope = "session" | "project" | "user" | "failure";

export type MemoryKind = "episodic" | "semantic" | "policy";

export type MemoryStatus = "active" | "invalidated";

export interface MemoryRecord {
  id: string;
  key: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  source: string;
  text: string;
  summary: string;
  tags: string[];
  confidence: number;
  importance: number;
  sourceCertainty: number;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  status: MemoryStatus;
  hits: number;
}

export interface MemoryScoreBreakdown {
  importance: number;
  recency: number;
  relevance: number;
  certainty: number;
  total: number;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
  scoreBreakdown: MemoryScoreBreakdown;
}

export interface MemoryContextPack {
  items: MemorySearchResult[];
  usedTokens: number;
  text: string;
}

export interface MemorySnapshot {
  counts: Record<MemoryScope, number>;
  paths: Record<MemoryScope, string | null>;
  latest: Record<MemoryScope, Array<{
    id: string;
    kind: MemoryKind;
    summary: string;
    source: string;
    confidence: number;
    updatedAt: string;
  }>>;
}

export interface SourceRecord {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  sourceKind: SourceKind;
  trustLayer?: SourceTrustLayer | null;
  official: boolean;
  provider: string | null;
  query: string | null;
  fetchedAt: string;
  publishedAt: string | null;
  score: number | null;
  scoreBreakdown: SourceScoreBreakdown | null;
  excerpt: string | null;
  cacheHit: boolean;
  author: string | null;
  headings: string[];
  locator: string | null;
  retrievedAt: string;
  [key: string]: unknown;
}

export interface SourcePackRecord {
  id: string;
  createdAt: string;
  toolName: string | null;
  query: string | null;
  url: string | null;
  provider: string | null;
  reasonUsed: string | null;
  sourceIds: string[];
  [key: string]: unknown;
}

export interface SourceRegistryState {
  nextId: number;
  sources: SourceRecord[];
  packs: SourcePackRecord[];
}

export interface CitationSummary {
  sourceId: string;
  title: string;
  url: string;
  domain: string;
  reasonUsed?: string | null;
  locator?: string | null;
}

export interface RuntimeHealthScorecard {
  degradedFlags: string[];
  retryPressure?: number;
  provider?: {
    avgHealthScore?: number;
    [key: string]: unknown;
  };
  web?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  shell?: Record<string, unknown>;
  circuits?: {
    byLayer?: Record<string, RuntimeCircuitLayerSummary>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TraceSummary {
  traceId: string;
  success: boolean;
  stopped: boolean;
  steps: number;
  durationMs: number;
  modelCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolsUsed: string[];
  approvalsAsked: number;
  approvalsApproved: number;
  approvalsDenied: number;
  providerAttempts?: number;
  providerRetries?: number;
  providerFallbacks?: number;
  modelFallbacks?: number;
  providerMeta?: Record<string, unknown> | null;
  shellJobs?: unknown[];
  skillInfluence?: unknown;
  policySources?: unknown;
  taskClassification?: TaskClassification | null;
  routeDecision?: RouteDecision | null;
  modelDecision?: ModelDecision | null;
  executionPlan?: ExecutionPlan | null;
  mcpCalls?: unknown[];
  webRequests?: number;
  webRetries?: number;
  webCacheHits?: number;
  sourceIds?: string[];
  filesChanged?: string[];
  durations?: {
    contextPrepareMs?: number;
    modelCompleteMs?: number;
    toolExecuteMs?: number;
    [key: string]: unknown;
  };
  verifier?: VerifierRunSummary | null;
  repair?: RepairLoopSummary | null;
  runtimeScorecard?: RuntimeHealthScorecard;
  errorTaxonomy?: string | null;
  finalSummary?: string | null;
}

export interface SessionEventRecord<TPayload = unknown> {
  timestamp: string;
  sessionId: string;
  type: string;
  payload: TPayload;
}

export interface ExecutionJournalSnapshotRef {
  filePath: string;
  sessionId: string;
  traceId: string | null;
  phase: string;
  stepId: string | number;
  outputSummary: string;
  createdAt: string;
}

export interface ExecutionJournalLoadedSnapshot extends ExecutionJournalSnapshotRef {
  state: Record<string, unknown>;
}

export interface ExecutionJournalAppendInput extends Record<string, unknown> {
  type: string;
  traceId?: string | null;
  stepId?: string | number | null;
  phase?: string;
  payload?: unknown;
}

export interface ExecutionJournalRecordPhaseInput {
  traceId?: string | null;
  stepId?: string | number | null;
  phase: string;
  inputSummary?: string | null;
  outputSummary?: string | null;
  metrics?: unknown;
  error?: unknown;
  snapshot?: unknown;
  retry?: unknown;
}

export interface ExecutionJournalStartedEntry {
  timestamp: string;
  sessionId: string;
  type: "journal_started";
  phase: string;
  payload: Record<string, unknown>;
}

export interface ExecutionJournalPhaseEntry {
  timestamp: string;
  sessionId: string;
  type: "phase";
  traceId: string | null;
  stepId: string | number | null;
  phase: string;
  inputSummary: string | null;
  outputSummary: string | null;
  metrics: unknown;
  error: unknown;
  retry: unknown;
  snapshot: unknown;
}

export type ExecutionJournalEntry =
  | ExecutionJournalStartedEntry
  | ExecutionJournalPhaseEntry
  | (ExecutionJournalAppendInput & {
      timestamp: string;
      sessionId: string;
    });

export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  status: string;
  background: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  completedAt?: string | null;
  sessionId?: string | null;
  parentSessionId?: string | null;
  traceId?: string | null;
  step?: string | number | null;
  timeoutMs?: number | null;
  ptyRequested?: boolean;
  ptyEnabled?: boolean;
  ttyMode?: string | null;
  ptyDegradedReason?: string | null;
  pid?: number | null;
  pgid?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelRequested?: boolean;
  durationMs?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutDroppedBytes?: number;
  stderrDroppedBytes?: number;
  totalStdoutBytes?: number;
  totalStderrBytes?: number;
  bufferTruncated?: boolean;
  lastUpdateAt?: string | null;
  live?: boolean;
  reattached?: boolean;
  historicalOnly?: boolean;
  canReattach?: boolean;
  canCancel?: boolean;
  canTail?: boolean;
  cursorTailAvailable?: boolean;
  stdinAttachAvailable?: boolean;
  continuityState?: string | null;
  reattachPolicy?: string | null;
  outputPaths?: {
    stdoutPath?: string | null;
    stderrPath?: string | null;
    [key: string]: unknown;
  } | null;
  lifecycle?: unknown[];
  error?: unknown;
  createdBySessionId?: string | null;
  visibleFromSessionId?: string | null;
  resumedIntoSessionId?: string | null;
  resumedIntoSessionIds?: string[];
  [key: string]: unknown;
}

export interface ShellTailCursor {
  stdout: number;
  stderr: number;
}

export interface ShellAttachStrategy {
  policy: string;
  mode: string;
  platform: string;
  ttyMode: string | null;
  ptyRequested: boolean;
  ptyEnabled: boolean;
  interactive: boolean;
  liveMonitorAvailable: boolean;
  cursorTailAvailable: boolean;
  stdinAttachAvailable: boolean;
  canCancel: boolean;
  reason: string;
}

export interface JobEventRecord {
  timestamp: string;
  jobId: string;
  type: string;
  status?: string;
  background?: boolean;
  [key: string]: unknown;
}

export interface JobTailResult {
  id: string;
  status: string;
  command: string;
  cwd: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  bufferTruncated: boolean;
  cursorMode: string;
  cursor: {
    stdout: number;
    stderr: number;
  };
  nextCursor: {
    stdout: number;
    stderr: number;
  };
  readWindow: {
    stdout: {
      start: number;
      end: number;
      bytesRead: number;
      truncated: boolean;
    };
    stderr: {
      start: number;
      end: number;
      bytesRead: number;
      truncated: boolean;
    };
    totalBytesRead: number;
  };
  live: boolean;
  reattached: boolean;
  historicalOnly: boolean;
  canReattach: boolean;
  canCancel: boolean;
  cursorTailAvailable: boolean;
  stdinAttachAvailable: boolean;
  continuityState: string | null;
  reattachPolicy: string;
  ttyMode: string | null;
  ptyRequested: boolean;
  ptyEnabled: boolean;
  ptyDegradedReason: string | null;
  events: JobEventRecord[];
  attachStrategy?: ShellAttachStrategy;
  cursorRequest?: ShellTailCursor;
  [key: string]: unknown;
}

export interface ShellRunResult {
  jobId: string;
  command: string;
  cwd: string;
  status: string;
  background: boolean;
  ptyRequested: boolean;
  ptyEnabled: boolean;
  ttyMode: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  totalStdoutBytes: number;
  totalStderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  bufferTruncated: boolean;
  lastUpdateAt: string | null;
  live: boolean;
  reattached: boolean;
  historicalOnly: boolean;
  canReattach: boolean;
  canCancel: boolean;
  continuityState: string | null;
  reattachPolicy: string;
  cursorTailAvailable: boolean;
  stdinAttachAvailable: boolean;
  ptyDegradedReason: string | null;
  lifecycle: unknown[];
}

export interface ShellBackgroundStartResult {
  jobId: string;
  background: true;
  status: string;
  command: string;
  cwd: string;
  traceId: string | null | undefined;
  ptyRequested: boolean;
  ptyEnabled: boolean;
  ttyMode: string | null;
  canReattach: boolean;
  reattachPolicy: string | null;
  cursorTailAvailable: boolean;
  stdinAttachAvailable: boolean;
  ptyDegradedReason: string | null;
}

export interface ShellAttachResult {
  jobId: string;
  mode: string;
  attached: boolean;
  live: boolean;
  canCancel: boolean;
  canReattach: boolean;
  historicalOnly: boolean;
  cursorTailAvailable: boolean;
  stdinAttachAvailable: boolean;
  ttyMode: string | null;
  ptyRequested: boolean;
  ptyEnabled: boolean;
  ptyDegradedReason: string | null;
  continuityState: string | null;
  attachStrategy: ShellAttachStrategy;
  message: string;
  tail: JobTailResult;
}

export interface SessionIndexEntry {
  id: string;
  filePath: string;
  eventCount: number;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  networkMode: string | null;
  webProvider: string | null;
  finalContent: string | null;
  parentSessionId: string | null;
  branchType: string;
  resumedAt: string | null;
  resumedFromSnapshot: string | null;
  children: string[];
  branchDepth: number;
  rootSessionId: string;
}

export interface SessionLineageEntry {
  id: string;
  parentSessionId: string | null;
  branchType: string;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  finalContent: string | null;
}

export interface SessionReplay {
  session: {
    id: string;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    networkMode: string | null;
    webProvider: string | null;
    parentSessionId: string | null;
    branchType: string;
  };
  lineage: {
    rootSessionId: string;
    parentSessionId: string | null;
    branchDepth: number;
    branchType: string;
    resumedAt: string | null;
    resumedFromSnapshot: string | null;
    ancestors: SessionLineageEntry[];
    children: SessionLineageEntry[];
  };
  branchEventsSessionId: string;
  prompts: Array<{ timestamp: string; content: string | null }>;
  context: Array<{ timestamp: string; meta: Record<string, unknown> }>;
  approvals: Array<{ timestamp: string; [key: string]: unknown }>;
  toolCalls: Array<{ timestamp: string; type: string; [key: string]: unknown }>;
  webEvents: Array<{ timestamp: string; [key: string]: unknown }>;
  mcpEvents: Array<{ timestamp: string; [key: string]: unknown }>;
  hookEvents: Array<{ timestamp: string; [key: string]: unknown }>;
  boundaryDecisions: Array<{ timestamp: string; [key: string]: unknown }>;
  sourcePacks: Array<{ timestamp: string; [key: string]: unknown }>;
  changes: Array<{ timestamp: string; type: string; [key: string]: unknown }>;
  verifierRuns: Array<{ timestamp: string; run: VerifierRunRecord }>;
  repairLoops: Array<{ timestamp: string; loop: RepairLoopRecord }>;
  finals: Array<{ timestamp: string; [key: string]: unknown }>;
}

export interface JournalEventRecord<TPayload = unknown> {
  timestamp?: string;
  sessionId?: string;
  type: string;
  phase?: string;
  traceId?: string | null;
  stepId?: string | number | null;
  payload?: TPayload;
}

export interface AgentPolicyState {
  messages?: unknown[];
  lastTrace?: TraceSummary | null;
  lastChangeSet?: ChangeSetSummary | null;
  lastTaskClassification?: TaskClassification | null;
  lastRouteDecision?: RouteDecision | null;
  lastModelDecision?: ModelDecision | null;
  lastExecutionPlan?: ExecutionPlan | null;
}

export interface AgentIntelligence {
  taskClassification: TaskClassification;
  routeDecision: RouteDecision;
  modelDecision: ModelDecision;
  executionPlan: ExecutionPlan;
}

export type CommandDefinition = [usage: string, description: string];

export type CommandSection = "core" | "advanced" | "debug";

export interface CommandSurface {
  core: CommandDefinition[];
  advanced: CommandDefinition[];
  debug: CommandDefinition[];
}

export interface AgentBrandProfile {
  productName: string;
  editionName: string;
  designerName: string;
  designerEnglishName: string;
  region: string;
  almaMater: string;
  motto: string;
  blessing: string;
  attributionSummary: string;
}

export type InteractionRenderProfile = "json" | "summary";

export type InteractiveCommandPaletteCategory =
  | "query_matches"
  | "core"
  | "navigation"
  | "decision_recovery"
  | "session_history_resume"
  | "verifier_plan"
  | "advanced_debug";

export type InteractiveSelectionPreviewKind =
  | "command"
  | "resume_target"
  | "resume_action"
  | "resume_recommendation"
  | "session_action"
  | "lineage_target"
  | "lineage_action"
  | "replay_target"
  | "replay_action"
  | "session_target";

export type InteractiveSelectionPreviewDecisionState =
  | "recommended"
  | "suggested"
  | "risky"
  | "stale"
  | "neutral"
  | "unavailable";

export interface InteractiveSelectionPreview {
  previewKind: InteractiveSelectionPreviewKind;
  selectedCommand: string | null;
  resolvedCommandTemplate: string | null;
  selectedTargetSummary: string | null;
  decisionState: InteractiveSelectionPreviewDecisionState;
  relationSummary: string | null;
  availabilitySummary: string | null;
  continuitySnippet: string | null;
  whySelected: string | null;
  nextEffect: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface InteractiveCommandPaletteEntry {
  command: string;
  label: string;
  description: string;
  category: InteractiveCommandPaletteCategory;
  section: CommandSection;
  featured: boolean;
  suggested: boolean;
  keywords: string[];
  preview: InteractiveSelectionPreview;
}

export interface InteractiveCommandPaletteSection {
  category: InteractiveCommandPaletteCategory;
  title: string;
  entries: InteractiveCommandPaletteEntry[];
}

export interface InteractiveCommandPaletteReport {
  query: string | null;
  brand: AgentBrandProfile;
  sections: InteractiveCommandPaletteSection[];
  totalMatches: number;
  selectedCommand: string | null;
  selectedPreview: InteractiveSelectionPreview | null;
  fallbackMode: "tty_overlay" | "text";
  footerHints: string[];
}

export type InteractiveSessionPickerMode =
  | "continue"
  | "continue_actions"
  | "resume"
  | "resume_actions"
  | "resume_recommend"
  | "resume_recommend_actions"
  | "history_sessions"
  | "history_sessions_actions"
  | "history_lineage"
  | "history_lineage_actions"
  | "history_replay"
  | "history_replay_actions";

export type InteractiveSessionPickerStep = "target" | "action";

export type InteractiveSessionPickerEnterBehavior = "inject" | "continue";

export interface InteractiveSessionPickerEntry {
  id: string;
  label: string;
  description: string;
  command: string;
  enterBehavior: InteractiveSessionPickerEnterBehavior;
  nextResolverLine: string | null;
  targetSessionId: string | null;
  continuityStatus: SessionContinuityStatus | null;
  badges: string[];
  featured: boolean;
  suggested: boolean;
  preview: InteractiveSelectionPreview;
}

export interface InteractiveSessionPickerSection {
  title: string;
  entries: InteractiveSessionPickerEntry[];
}

export interface InteractiveSessionPickerReport {
  mode: InteractiveSessionPickerMode;
  step: InteractiveSessionPickerStep;
  title: string;
  subtitle: string | null;
  query: string | null;
  brand: AgentBrandProfile;
  anchorSessionId: string | null;
  anchorCommand: string | null;
  sections: InteractiveSessionPickerSection[];
  totalMatches: number;
  selectedCommand: string | null;
  selectedPreview: InteractiveSelectionPreview | null;
  fallbackMode: "tty_overlay" | "text";
  footerHints: string[];
}

export interface AgentInteractionStatusReport {
  brand: AgentBrandProfile;
  createdAt: string;
  session: {
    active: boolean;
    sessionId: string | null;
    parentSessionId: string | null;
    sessionFilePath: string | null;
    resumeSnapshotPath: string | null;
  };
  model: {
    provider: string | null;
    model: string | null;
    streamOutput: boolean;
    nativeToolCalling: boolean;
    permissionMode: string | null;
    approvalPolicy: string | null;
    networkMode: string | null;
  };
  usage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  context: {
    available: boolean;
    model: string | null;
    contextWindow: number | null;
    estimatedInputTokens: number | null;
    inputBudget: number | null;
    remainingInputTokens: number | null;
    outputReserve: number | null;
    compactedMessages: number | null;
    memoryItems: number | null;
    contextSlicingMode: string | null;
    memoryArbitration: string | null;
  };
  plan: {
    available: boolean;
    status: string | null;
    currentStepTitle: string | null;
    replanCount: number | null;
    blockerCount: number | null;
    verificationRequired: boolean | null;
  };
  verifier: {
    available: boolean;
    latestStatus: string | null;
    repairStatus: string | null;
    finalOutcome: string | null;
  };
  runtime: {
    providerHealthScore: number | null;
    degradedFlags: string[];
    openCircuitCount: number | null;
  };
  continuity: {
    available: boolean;
    focusSessionId: string | null;
    rootSessionId: string | null;
    branchDepth: number | null;
    continuityStatus: SessionContinuityStatus | null;
    recommendedResumeSessionId: string | null;
    replayAvailable: boolean;
  };
  drilldown: {
    primary: string | null;
    whyPlan: string | null;
    replay: string | null;
    verifier: string | null;
  };
  suggestedCommands: string[];
}

export type AgentInteractionHistoryScope = "all" | "changes" | "sessions" | "lineage" | "replay";

export interface AgentInteractionHistoryReport {
  brand: AgentBrandProfile;
  createdAt: string;
  scope: AgentInteractionHistoryScope;
  changes: RollbackCheckpointListEntry[];
  sessions: SessionIndexEntry[];
  summary: {
    changeCount: number;
    sessionCount: number;
    latestChangeId: string | null;
    latestSessionId: string | null;
  };
  suggestedCommands: string[];
}

export type SessionBrowserRenderProfile = "json" | "summary" | "failures";

export type SessionContinuityStatus =
  | "active"
  | "recent"
  | "stale"
  | "historical_only"
  | "unavailable";

export type SessionLineageRelationKind =
  | "current"
  | "self"
  | "parent"
  | "child"
  | "ancestor"
  | "descendant"
  | "sibling"
  | "related"
  | "unrelated"
  | "none";

export type SessionResumeRecommendationStatus =
  | "recommended"
  | "not_needed"
  | "discouraged"
  | "unavailable";

export type SessionResumeRecommendationReasonKind =
  | "already_current"
  | "latest_recent_session"
  | "reference_recent_session"
  | "related_recent_session"
  | "stale_session"
  | "historical_only"
  | "no_sessions"
  | "no_resumable_session";

export interface SessionCommandSuggestion {
  command: string;
  reason: string;
  priority: number;
}

export interface SessionContinuitySummary {
  sessionId: string;
  filePath: string;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  networkMode: string | null;
  webProvider: string | null;
  rootSessionId: string;
  parentSessionId: string | null;
  children: string[];
  branchDepth: number;
  branchType: string;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  resumedAt: string | null;
  resumedFromSnapshot: string | null;
  eventCount: number;
  finalContentPreview: string | null;
  relationToCurrent: SessionLineageRelationKind;
  relationToReference: SessionLineageRelationKind;
  continuityStatus: SessionContinuityStatus;
  ageDays: number | null;
  availability: {
    snapshotAvailable: boolean;
    replayAvailable: boolean;
    planAvailable: boolean;
    verifierAvailable: boolean;
    decisionAvailable: boolean;
  };
  latest: {
    activityAt: string | null;
    planStatus: string | null;
    verifierStatus: string | null;
    repairStatus: string | null;
  };
  resume: {
    status: SessionResumeRecommendationStatus;
    reasonKind: SessionResumeRecommendationReasonKind;
    summary: string;
  };
  suggestedCommands: SessionCommandSuggestion[];
}

export interface SessionBrowserResolvedReference {
  requestedReference: string | null;
  requestedKind: "current" | "latest" | "session";
  resolution: "current" | "latest" | "latest_fallback" | "session" | "unavailable";
  resolvedSessionId: string | null;
  currentSessionId: string | null;
}

export interface SessionLineageBrowserSummary {
  focus: SessionContinuitySummary | null;
  rootSessionId: string | null;
  parentSessionId: string | null;
  branchDepth: number | null;
  ancestors: SessionContinuitySummary[];
  children: SessionContinuitySummary[];
}

export interface SessionReplayBrowserSummary {
  sessionId: string | null;
  branchEventsSessionId: string | null;
  promptCount: number;
  toolCallCount: number;
  changeCount: number;
  verifierRunCount: number;
  repairLoopCount: number;
  finalCount: number;
  latestVerifierStatus: string | null;
  latestRepairStatus: string | null;
  latestFinalContentPreview: string | null;
  availability: {
    planAvailable: boolean;
    verifierAvailable: boolean;
    decisionAvailable: boolean;
  };
  suggestedCommands: SessionCommandSuggestion[];
}

export interface SessionBrowserReport {
  brand: AgentBrandProfile;
  createdAt: string;
  scope: AgentInteractionHistoryScope;
  reference: SessionBrowserResolvedReference;
  available: boolean;
  changes: RollbackCheckpointListEntry[];
  sessions: SessionContinuitySummary[];
  lineage: SessionLineageBrowserSummary | null;
  replay: SessionReplayBrowserSummary | null;
  summary: {
    sessionCount: number;
    changeCount: number;
    activeSessionId: string | null;
    recommendedResumeSessionId: string | null;
    staleSessionCount: number;
    planAvailableCount: number;
    verifierAvailableCount: number;
    decisionAvailableCount: number;
  };
  suggestedCommands: SessionCommandSuggestion[];
}

export interface SessionResumeRecommendation {
  status: SessionResumeRecommendationStatus;
  reasonKind: SessionResumeRecommendationReasonKind;
  recommendedSessionId: string | null;
  relationToCurrent: SessionLineageRelationKind;
  relationToReference: SessionLineageRelationKind;
  continuityStatus: SessionContinuityStatus | null;
  summary: string;
  blockers: string[];
  suggestedCommands: SessionCommandSuggestion[];
}

export interface SessionResumeRecommendationReport {
  brand: AgentBrandProfile;
  createdAt: string;
  reference: SessionBrowserResolvedReference;
  available: boolean;
  anchorSession: SessionContinuitySummary | null;
  relatedSessions: SessionContinuitySummary[];
  recommendation: SessionResumeRecommendation;
  suggestedCommands: SessionCommandSuggestion[];
}

export interface HookEventPayload {
  hookId?: string;
  event: string;
  status?: string;
  success?: boolean;
  blocked?: boolean;
  blockReason?: string | null;
  advisory?: string | null;
  injectedContext?: HookInjectedContext | null;
}

export type HookEventName =
  | "session_start"
  | "user_prompt_submit"
  | "before_tool"
  | "after_tool"
  | "before_apply"
  | "after_apply"
  | "pre_compact"
  | "session_end"
  | "error";

export type HookFailMode = "open" | "closed";

export interface HookFilters {
  toolName: string[] | null;
  category: string[] | null;
  success: boolean | null;
  writeOnly: boolean | null;
}

export interface HookDefinitionInput {
  id?: string;
  event?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  failMode?: string;
  filters?: Record<string, unknown> | null;
}

export interface HookDefinition {
  id: string;
  event: HookEventName;
  enabled: boolean;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  failMode: HookFailMode;
  filters: HookFilters;
  scope: string;
  sourcePath: string;
}

export interface HookInjectedContext {
  scope: "session" | "turn";
  label: string;
  content: string;
}

export interface HookParsedOutput {
  advisory: string | null;
  trace: Record<string, unknown> | null;
  block: boolean;
  reason: string | null;
  additionalContext: string | null;
  startupContext: string | null;
}

export interface HookShellResultSummary {
  jobId?: string;
  status: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  durationMs?: number | null;
  stdout?: string;
  stderr?: string;
  error?: {
    message: string;
    taxonomy: string;
  } | null;
}

export interface HookFileSnapshot {
  path: string;
  content: string | null;
}

export interface HookRunResult {
  hookId: string;
  event: HookEventName;
  status: "blocked" | "failed" | "exited";
  success: boolean;
  blocked: boolean;
  blockReason: string | null;
  failMode: HookFailMode;
  durationMs: number;
  advisory: string | null;
  traceMeta: Record<string, unknown> | null;
  boundary: ExecutionBoundaryDecisionSummary | null;
  shellResult: HookShellResultSummary | null;
  observedChangeSet: ChangeSetSummary | null;
  injectedContext: HookInjectedContext | null;
  rawObservedChangeSet?: ChangeSetRecord | null;
}

export interface HookEmitResult {
  event: string;
  matched: number;
  blocked: boolean;
  blockReason?: string | null;
  results: HookRunResult[];
  advisories?: string[];
  observedChangeSets?: ChangeSetSummary[];
  injectedContexts?: HookInjectedContext[];
}

export interface McpEventPayload {
  type: string;
  serverId?: string;
  serverName?: string;
  toolName?: string;
  error?: unknown;
}

export interface PluginEventPayload {
  pluginId?: string;
  pluginName?: string;
  toolName?: string;
  status?: string;
  error?: unknown;
}

export interface McpNormalizedToolSpec extends ToolMetadata {
  source: "mcp";
  serverId: string;
  serverName: string;
  name: string;
  normalizedName?: string;
  toolName?: string;
  title?: string | null;
}

export interface McpAttemptRecord {
  attempt: number;
  ok: boolean;
  durationMs: number;
  taxonomy?: string;
  code?: string;
  status?: number | null;
  retryable?: boolean;
  delayMs?: number;
}

export interface SerializedMcpError {
  name: string;
  message: string;
  taxonomy: string;
  code: string;
  serverId: string | null;
  serverName: string | null;
  method: string | null;
  toolName: string | null;
  requestId: string | number | null;
  traceId: string | null;
  attempt: number;
  retryable: boolean;
  retryExhausted: boolean;
  details: Record<string, unknown> | null;
  attempts: McpAttemptRecord[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  scope: string;
  sourcePath: string;
  transport: string;
  command: string | null;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envKeys: string[];
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  protocolVersion: string;
  [key: string]: unknown;
}

export interface McpRegistryServerView {
  id: string;
  name: string;
  scope: string;
  sourcePath: string;
  transport: string;
  command: string | null;
  args: string[];
  cwd: string;
  envKeys: string[];
  enabled: boolean;
  status: string;
  healthScore: number;
  lastConnectedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  latencyMs: number | null;
  errorRate: number;
  [key: string]: unknown;
}

export interface McpClientStats {
  calls: number;
  successes: number;
  failures: number;
  errorRate: number;
  healthScore: number;
  latencyMs: number | null;
  lastConnectedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: SerializedMcpError | null;
  status: string;
}

export interface McpToolCallResult {
  serverId: string;
  serverName: string;
  toolName: string;
  content: unknown[];
  structuredContent: unknown;
  isError: boolean;
  summary: string;
  raw: unknown;
}

export interface ContextRoutingBrief {
  taskBrief: string | null;
  routeBrief: string | null;
  planBrief: string | null;
  runtimeBrief: string | null;
}

export interface ContextSkillSummary {
  text: string | null;
  skillIds: string[];
}

export interface ContextSourceSummary {
  text: string | null;
  sourceIds: string[];
  mode: string;
}

export interface ContextPlanMeta {
  model: string;
  contextWindow: number;
  outputReserve: number;
  budgets: {
    totalInputBudget: number;
    system: number;
    summary: number;
    memory: number;
    recentMessages: number;
    currentMessageTokens: number;
  };
  estimatedInputTokens: number;
  compactedMessages: number;
  rollingSummaryTokens: number;
  memoryItems: number;
  memoryTokens: number;
  selectedContextKinds: string[];
  skippedContextKinds: string[];
  selectedSourceIds: string[];
  selectedSkillIds: string[];
  selectedMemoryIds: string[];
  policySources: string[];
  instructionEntryIds: string[];
  instructionLayers: InstructionLayer[];
  instructionFiles: string[];
  instructionRuleIds: string[];
  instructionSummary: InstructionHierarchySummary;
  contextSlicingMode: string;
  memoryArbitration: string;
  routingMode: string | null;
  [key: string]: unknown;
}

export type RuntimeLayerName = "provider" | "web" | "mcp" | "shell" | "all";

export type RuntimeCircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  halfOpenMaxRequests?: number;
  successThreshold?: number;
}

export interface CircuitTransition {
  type: RuntimeCircuitState;
  at: string;
  reason: string;
}

export interface RuntimeCircuitSnapshot {
  key: string;
  state: RuntimeCircuitState;
  failureStreak: number;
  openCount: number;
  blockedRequests: number;
  cooldownMs: number;
  cooldownUntilMs: number;
  lastStateChangedAt: string | null;
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastBlockedAt: string | null;
  lastFailure: unknown;
  lastLatencyMs: number | null;
  lastOpenReason: string | null;
  halfOpenInFlight: number;
  halfOpenSuccesses: number;
  [key: string]: unknown;
}

export interface RuntimeCircuitGate {
  allowed: boolean;
  state: RuntimeCircuitState;
  blocked: boolean;
  retryAt?: number;
  transitions: CircuitTransition[];
  snapshot: RuntimeCircuitSnapshot;
}

export interface RuntimeCircuitOutcome {
  transitions: CircuitTransition[];
  snapshot: RuntimeCircuitSnapshot;
}

export interface RuntimeRequestMetrics {
  key: string;
  layer: string;
  provider: string | null;
  requestClass: string;
  endpoint: string | null;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  totalRetries: number;
  retryExhaustedCount: number;
  fallbackCount: number;
  timeoutCount: number;
  http5xxCount: number;
  http429Count: number;
  cacheHitCount: number;
  blockedByCircuitCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  approxP95Ms: number;
  approxP99Ms: number;
  retryPressure: number;
  healthScore: number;
  retryDelayMs: number;
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastBlockedAt: string | null;
  lastError: unknown;
  retryExhaustionFingerprints: Array<{
    fingerprint: string;
    count: number;
    lastSeenAt: string;
  }>;
  latencyBuckets: Record<string, number>;
  [key: string]: unknown;
}

export interface RuntimeMcpServerSummary {
  id: string | null;
  name: string | null;
  status: string | null;
  healthScore: number | null;
  latencyMs: number | null;
  errorRate: number | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  [key: string]: unknown;
}

export interface RuntimeShellSummary {
  totalJobs: number;
  liveJobs: number;
  runningJobs: number;
  backgroundJobs: number;
  orphanedJobs: number;
  reattachedJobs: number;
  historicalJobs: number;
  timedOutJobs: number;
  failedJobs: number;
  lastSessionId: string | null;
  updatedAt: string | null;
  healthScore: number;
  [key: string]: unknown;
}

export interface RuntimeLayerScoreSummary {
  requestClasses: number;
  totalRequests: number;
  totalRetries: number;
  avgHealthScore: number;
  avgLatencyMs: number;
  [key: string]: unknown;
}

export interface RuntimeCircuitLayerSummary {
  total: number;
  open: number;
  halfOpen: number;
  closed: number;
  [key: string]: number;
}

export interface RuntimeHealthOverview {
  updatedAt: string;
  lastSessionContext: {
    sessionId: string | null;
    parentSessionId: string | null;
    rootSessionId: string | null;
    resumedFromSessionId: string | null;
    boundAt: string;
  } | null;
  scorecard: RuntimeHealthScorecard;
  provider: {
    requestClasses: Record<string, RuntimeRequestMetrics>;
    circuits: Record<string, RuntimeCircuitSnapshot>;
  };
  web: {
    requestClasses: Record<string, RuntimeRequestMetrics>;
    circuits: Record<string, RuntimeCircuitSnapshot>;
  };
  mcp: {
    requestClasses: Record<string, RuntimeRequestMetrics>;
    circuits: Record<string, RuntimeCircuitSnapshot>;
    servers: RuntimeMcpServerSummary[];
  };
  shell: {
    summary: RuntimeShellSummary;
  };
}

export interface EvalCaseResult {
  suite: string;
  name: string;
  pass: boolean;
  score: number;
  durationMs: number;
  failureReason: string | null;
  capabilityTags: string[];
  metrics: JsonObject | Record<string, unknown> | null;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  averageScore: number;
}

export interface EvalCapabilityScoreEntry {
  tag: string;
  total: number;
  passed: number;
  averageScore: number;
}

export interface EvalScorecard {
  capabilities: EvalCapabilityScoreEntry[];
}

export interface EvalRunRequest {
  suite?: string;
  baselineGate?: VerifierRegressionGateDecision | null;
}

export interface EvalSuiteResult {
  suite: string;
  startedAt: string;
  durationMs: number;
  cases: EvalCaseResult[];
  summary: EvalSummary;
  scorecard: EvalScorecard;
  baselineGate: VerifierRegressionGateDecision | null;
  baselinePolicyProfile: VerifierRegressionGatePolicyProfile | null;
  artifact: VerifierInspectArtifactMetadata | null;
  handoff: VerifierReleaseHandoffMetadata | null;
  bundle: VerifierReleaseBundleMetadata | null;
}
