import fs from "node:fs/promises";
import path from "node:path";

import type {
  ExtensionStateKind,
  ExtensionStateResolveResult,
  ExtensionStateSection,
  ExtensionStateSnapshot,
} from "../types/contracts.js";

export const EXTENSION_STATE_FILE_BASENAME = "capability-state.json";

export interface ExtensionStateStoreLike {
  initialize(): Promise<void>;
  resolve(
    kind: ExtensionStateKind,
    id: string,
    manifestEnabled?: boolean,
  ): ExtensionStateResolveResult;
  setEnabled(
    kind: ExtensionStateKind,
    id: string,
    enabled: boolean,
  ): Promise<ExtensionStateResolveResult>;
  exportState(): ExtensionStateSnapshot;
  persist(): Promise<void>;
}

export class ExtensionStateStore implements ExtensionStateStoreLike {
  readonly projectStateDir: string;
  readonly filePath: string;
  private state: ExtensionStateSnapshot;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.filePath = path.join(projectStateDir, EXTENSION_STATE_FILE_BASENAME);
    this.state = createEmptyState();
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.projectStateDir, { recursive: true });
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      this.state = normalizeState(payload);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
      this.state = createEmptyState();
    }
  }

  resolve(
    kind: ExtensionStateKind,
    id: string,
    manifestEnabled = true,
  ): ExtensionStateResolveResult {
    const section = getSection(this.state, kind) ?? createEmptySection();
    if (section.enabled.includes(id)) {
      return {
        enabled: true,
        explicitState: "enabled",
      };
    }
    if (section.disabled.includes(id)) {
      return {
        enabled: false,
        explicitState: "disabled",
      };
    }
    return {
      enabled: manifestEnabled !== false,
      explicitState: null,
    };
  }

  async setEnabled(
    kind: ExtensionStateKind,
    id: string,
    enabled: boolean,
  ): Promise<ExtensionStateResolveResult> {
    const normalizedKind = assertKind(kind);
    const section = getSection(this.state, normalizedKind) ?? createEmptySection();
    section.enabled = section.enabled.filter((entry) => entry !== id);
    section.disabled = section.disabled.filter((entry) => entry !== id);

    if (enabled) {
      section.enabled.push(id);
    } else {
      section.disabled.push(id);
    }

    section.enabled = sortUnique(section.enabled);
    section.disabled = sortUnique(section.disabled);
    this.state[normalizedKind] = section;
    await this.persist();
    return this.resolve(normalizedKind, id);
  }

  exportState(): ExtensionStateSnapshot {
    return structuredClone(this.state);
  }

  async persist(): Promise<void> {
    await fs.mkdir(this.projectStateDir, { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

function createEmptyState(): ExtensionStateSnapshot {
  return {
    skills: createEmptySection(),
    plugins: createEmptySection(),
  };
}

function createEmptySection(): ExtensionStateSection {
  return {
    enabled: [],
    disabled: [],
  };
}

function normalizeState(value: unknown): ExtensionStateSnapshot {
  const record = isRecord(value) ? value : {};
  return {
    skills: normalizeSection(record.skills),
    plugins: normalizeSection(record.plugins),
  };
}

function normalizeSection(value: unknown): ExtensionStateSection {
  const record = isRecord(value) ? value : {};
  return {
    enabled: sortUnique(Array.isArray(record.enabled) ? record.enabled : []),
    disabled: sortUnique(Array.isArray(record.disabled) ? record.disabled : []),
  };
}

function getSection(
  state: ExtensionStateSnapshot,
  kind: ExtensionStateKind,
): ExtensionStateSection | null {
  return kind === "skills" || kind === "plugins"
    ? state[kind]
    : null;
}

function assertKind(kind: string): ExtensionStateKind {
  if (kind === "skills" || kind === "plugins") {
    return kind;
  }
  throw new Error(`Unsupported extension state kind "${kind}".`);
}

function sortUnique(values: unknown[]): string[] {
  return [...new Set(values.map((entry) => `${entry}`.trim()).filter(Boolean))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === code;
}
