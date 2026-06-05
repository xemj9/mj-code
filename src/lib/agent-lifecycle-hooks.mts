import type {
  HookEmitResult,
  HookEventName,
  HookInjectedContext,
} from "../types/contracts.js";

interface HookRunnerLike {
  emit(
    eventName: HookEventName,
    payload?: Record<string, unknown>,
    context?: {
      traceId?: string | null;
      step?: string | number | null;
      sessionId?: string | null;
      parentSessionId?: string | null;
      rootSessionId?: string | null;
      observePaths?: string[];
    },
  ): Promise<HookEmitResult>;
}

export interface LifecycleContextEntry extends HookInjectedContext {
  hookId: string;
  event: HookEventName;
}

export interface LifecycleHookOutcome {
  event: HookEventName;
  emission: HookEmitResult | null;
  blocked: boolean;
  blockReason: string | null;
  contextEntries: LifecycleContextEntry[];
}

export async function emitLifecycleHook(
  hookRunner: HookRunnerLike | null | undefined,
  eventName: HookEventName,
  payload: Record<string, unknown>,
  context: {
    traceId?: string | null;
    step?: string | number | null;
    sessionId?: string | null;
    parentSessionId?: string | null;
    rootSessionId?: string | null;
    observePaths?: string[];
  } = {},
  options: {
    allowBlock?: boolean;
  } = {},
): Promise<LifecycleHookOutcome> {
  if (!hookRunner) {
    return {
      event: eventName,
      emission: null,
      blocked: false,
      blockReason: null,
      contextEntries: [],
    };
  }

  const emission = await hookRunner.emit(eventName, payload, context);
  return {
    event: eventName,
    emission,
    blocked: options.allowBlock === true ? emission.blocked === true : false,
    blockReason: options.allowBlock === true ? emission.blockReason ?? null : null,
    contextEntries: collectLifecycleContextEntries(eventName, emission),
  };
}

export function formatLifecycleContext(entries: LifecycleContextEntry[]): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  const lines = ["Hook-injected lifecycle context:"];
  for (const entry of entries) {
    lines.push(`- [${entry.event}/${entry.label}] ${entry.hookId}: ${entry.content}`);
  }
  return lines.join("\n");
}

export function mergeLifecycleContexts(
  existing: LifecycleContextEntry[],
  incoming: LifecycleContextEntry[],
): LifecycleContextEntry[] {
  const merged = new Map<string, LifecycleContextEntry>();
  for (const entry of [...existing, ...incoming]) {
    const key = `${entry.event}:${entry.hookId}:${entry.scope}:${entry.label}:${entry.content}`;
    merged.set(key, entry);
  }
  return [...merged.values()];
}

function collectLifecycleContextEntries(
  eventName: HookEventName,
  emission: HookEmitResult,
): LifecycleContextEntry[] {
  return emission.results.flatMap((result) => {
    if (!result.injectedContext) {
      return [];
    }
    return [{
      hookId: result.hookId,
      event: eventName,
      scope: result.injectedContext.scope,
      label: result.injectedContext.label,
      content: result.injectedContext.content,
    }];
  });
}
