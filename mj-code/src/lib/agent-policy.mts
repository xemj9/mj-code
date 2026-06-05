import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import { scopeRuntimeHealthOverviewToProvider } from "./runtime-health.mjs";

import type {
  AgentIntelligence,
  EvalRunRequest,
  AgentPolicyState,
  EffectivePolicy,
  ExecutionPlan,
  ModelDecision,
  ResolvedConfig,
  RouteDecision,
  RuntimeHealthOverview,
  RuntimeHealthScorecard,
  TaskClassification,
} from "../types/contracts.js";

interface RuntimeHealthLike {
  getOverview(): RuntimeHealthOverview;
  inspectLayer(layer: string): unknown;
}

interface ActiveSkillLike {
  id?: string;
  toolPreferences?: {
    prefer?: string[];
    avoid?: string[];
  };
}

interface TaskClassifierLike {
  classify(prompt: string, context: {
    capabilityRegistry: Pick<CapabilityRegistryLike, "list"> | null | undefined;
    runtimeHealth: RuntimeHealthOverview;
    runtimeScorecard?: RuntimeHealthScorecard;
    activeSkills: unknown[];
    networkMode: string;
    permissionMode: string;
    lastTrace: AgentPolicyState["lastTrace"];
    messages: unknown[];
  }): TaskClassification;
}

interface CapabilityRouterLike {
  route(context: {
    prompt: string;
    taskClassification: TaskClassification;
    capabilityRegistry: Pick<CapabilityRegistryLike, "list"> | null | undefined;
    runtimeHealth: RuntimeHealthOverview;
    policy: EffectivePolicy;
    networkMode: ResolvedConfig["networkMode"];
    permissionMode: ResolvedConfig["permissionMode"];
    approvalPolicy: ResolvedConfig["approvalPolicy"];
    activeSkills: ActiveSkillLike[];
    mcpEnabled?: boolean;
  }): RouteDecision;
}

interface ModelRouterLike {
  route(context: {
    taskClassification: TaskClassification;
    routeDecision: RouteDecision;
    runtimeHealth: RuntimeHealthOverview;
    availableModels: string[];
    currentModel: string | null;
    provider: string | null;
  }): ModelDecision;
}

interface PlannerLike {
  createPlan(context: {
    prompt: string;
    taskClassification: TaskClassification;
    routeDecision: RouteDecision;
    modelDecision: ModelDecision;
  }): ExecutionPlan;
}

interface EvalRunnerLike {
  runSuite(name: string, context: Record<string, unknown>): unknown;
}

interface SkillLoaderLike {
  getActiveSkills(): ActiveSkillLike[];
}

interface PolicyStackLike {
  getEffectivePolicy(): EffectivePolicy;
}

export class AgentPolicy {
  private readonly config: ResolvedConfig;
  private readonly runtimeHealth: RuntimeHealthLike;
  private readonly capabilityRegistry: Pick<CapabilityRegistryLike, "list">;
  private readonly taskClassifier: TaskClassifierLike;
  private readonly capabilityRouter: CapabilityRouterLike;
  private readonly modelRouter: ModelRouterLike;
  private readonly planner: PlannerLike;
  private readonly evalRunner: EvalRunnerLike;
  private readonly skillLoader: SkillLoaderLike;
  private readonly policyStack: PolicyStackLike;
  private readonly sourceRegistry: unknown;
  private readonly mcpRegistry: unknown;

  constructor({
    config,
    runtimeHealth,
    capabilityRegistry,
    taskClassifier,
    capabilityRouter,
    modelRouter,
    planner,
    evalRunner,
    skillLoader,
    policyStack,
    sourceRegistry,
    mcpRegistry,
  }: {
    config: ResolvedConfig;
    runtimeHealth: RuntimeHealthLike;
    capabilityRegistry: Pick<CapabilityRegistryLike, "list">;
    taskClassifier: TaskClassifierLike;
    capabilityRouter: CapabilityRouterLike;
    modelRouter: ModelRouterLike;
    planner: PlannerLike;
    evalRunner: EvalRunnerLike;
    skillLoader: SkillLoaderLike;
    policyStack: PolicyStackLike;
    sourceRegistry: unknown;
    mcpRegistry: unknown;
  }) {
    this.config = config;
    this.runtimeHealth = runtimeHealth;
    this.capabilityRegistry = capabilityRegistry;
    this.taskClassifier = taskClassifier;
    this.capabilityRouter = capabilityRouter;
    this.modelRouter = modelRouter;
    this.planner = planner;
    this.evalRunner = evalRunner;
    this.skillLoader = skillLoader;
    this.policyStack = policyStack;
    this.sourceRegistry = sourceRegistry;
    this.mcpRegistry = mcpRegistry;
  }

  previewRoute(
    prompt: string,
    state: AgentPolicyState = {},
    refresh: (() => void) | null = null,
  ): AgentIntelligence | {
    taskClassification: AgentPolicyState["lastTaskClassification"];
    routeDecision: AgentPolicyState["lastRouteDecision"];
    modelDecision: AgentPolicyState["lastModelDecision"];
    executionPlan: AgentPolicyState["lastExecutionPlan"];
  } {
    const normalized = `${prompt ?? ""}`.trim();
    if (!normalized) {
      return {
        taskClassification: state.lastTaskClassification ?? null,
        routeDecision: state.lastRouteDecision ?? null,
        modelDecision: state.lastModelDecision ?? null,
        executionPlan: state.lastExecutionPlan ?? null,
      };
    }
    if (typeof refresh === "function") {
      refresh();
    }
    return this.computeIntelligence(normalized, state);
  }

  getRoute(which: "last" | "all" = "last", state: AgentPolicyState = {}) {
    if (which === "last") {
      return state.lastRouteDecision ?? null;
    }
    return {
      taskClassification: state.lastTaskClassification ?? null,
      routeDecision: state.lastRouteDecision ?? null,
      modelDecision: state.lastModelDecision ?? null,
      executionPlan: state.lastExecutionPlan ?? null,
    };
  }

  getExecutionPlan(which: "last" | "all" = "last", state: AgentPolicyState = {}) {
    if (which === "last") {
      return state.lastExecutionPlan ?? null;
    }
    return {
      taskClassification: state.lastTaskClassification ?? null,
      routeDecision: state.lastRouteDecision ?? null,
      modelDecision: state.lastModelDecision ?? null,
      executionPlan: state.lastExecutionPlan ?? null,
    };
  }

  getModelDecision(state: AgentPolicyState = {}): ModelDecision {
    return state.lastModelDecision ?? {
      chosenProvider: this.config.provider,
      chosenModel: this.config.model,
      fallbackModels: [],
      fallbackChain: [],
      reason: "No turn-level model routing decision has been recorded yet.",
    };
  }

  getProviderDecision(state: AgentPolicyState = {}) {
    return {
      provider: this.config.provider,
      configuredModel: this.config.model,
      modelDecision: this.getModelDecision(state),
      runtime: this.runtimeHealth.inspectLayer("provider"),
    };
  }

  explainWhy(scope: "overview" | "route" | "model" | "tool" | "plan" = "overview", state: AgentPolicyState = {}) {
    const runtimeHealth = getPolicyRuntimeHealth(this.runtimeHealth, this.config.provider);
    const base = {
      scope,
      taskClassification: state.lastTaskClassification ?? null,
      routeDecision: state.lastRouteDecision ?? null,
      modelDecision: state.lastModelDecision ?? null,
      executionPlan: state.lastExecutionPlan ?? null,
      policySources: this.policyStack.getEffectivePolicy().sources,
      runtimeHealth,
      lastTrace: state.lastTrace ?? null,
    };

    if (scope === "route") {
      return {
        scope,
        taskClassification: base.taskClassification,
        routeDecision: base.routeDecision,
        policySources: base.policySources,
        runtimeHealth: base.runtimeHealth,
      };
    }

    if (scope === "model") {
      return {
        scope,
        taskClassification: base.taskClassification,
        modelDecision: base.modelDecision,
        runtimeHealth: base.runtimeHealth,
      };
    }

    if (scope === "tool") {
      return {
        scope,
        routeDecision: base.routeDecision,
        executionPlan: base.executionPlan,
        observedTools: state.lastTrace?.toolsUsed ?? [],
        lastChangeSet: state.lastChangeSet ?? null,
      };
    }

    if (scope === "plan") {
      return {
        scope,
        executionPlan: base.executionPlan,
      };
    }

    return base;
  }

  runEval(input: string | EvalRunRequest = "all") {
    const suite = typeof input === "string"
      ? input
      : input.suite ?? "all";
    return this.evalRunner.runSuite(suite, {
      capabilityRegistry: this.capabilityRegistry,
      runtimeHealth: getPolicyRuntimeHealth(this.runtimeHealth, this.config.provider),
      activeSkills: this.skillLoader.getActiveSkills(),
      policy: this.policyStack.getEffectivePolicy(),
      availableModels: this.config.availableModels ?? [this.config.model].filter(Boolean),
      baselineGate: typeof input === "string"
        ? null
        : input.baselineGate ?? null,
    });
  }

  computeIntelligence(prompt: string, state: AgentPolicyState = {}): AgentIntelligence {
    const runtimeHealth = getPolicyRuntimeHealth(this.runtimeHealth, this.config.provider);
    const activeSkills = this.skillLoader.getActiveSkills();
    const policy = this.policyStack.getEffectivePolicy();
    const taskClassification = this.taskClassifier.classify(prompt, {
      capabilityRegistry: this.capabilityRegistry,
      runtimeHealth,
      runtimeScorecard: runtimeHealth.scorecard,
      activeSkills,
      networkMode: this.config.networkMode,
      permissionMode: this.config.permissionMode,
      lastTrace: state.lastTrace ?? null,
      messages: state.messages ?? [],
    });
    const routeDecision = this.capabilityRouter.route({
      prompt,
      taskClassification,
      capabilityRegistry: this.capabilityRegistry,
      runtimeHealth,
      policy,
      networkMode: this.config.networkMode,
      permissionMode: this.config.permissionMode,
      approvalPolicy: this.config.approvalPolicy,
      activeSkills,
      mcpEnabled: this.config.mcpEnabled,
    });
    const modelDecision = this.modelRouter.route({
      taskClassification,
      routeDecision,
      runtimeHealth,
      availableModels: this.config.availableModels ?? [],
      currentModel: this.config.model,
      provider: this.config.provider,
    });
    const executionPlan = this.planner.createPlan({
      prompt,
      taskClassification,
      routeDecision,
      modelDecision,
    });

    return {
      taskClassification,
      routeDecision,
      modelDecision,
      executionPlan,
    };
  }
}

function getPolicyRuntimeHealth(
  runtimeHealth: RuntimeHealthLike,
  provider: string | null | undefined,
): RuntimeHealthOverview {
  return scopeRuntimeHealthOverviewToProvider(runtimeHealth.getOverview(), provider);
}
