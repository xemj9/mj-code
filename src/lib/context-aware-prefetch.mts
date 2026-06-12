/**
 * ContextAwarePrefetch — Intelligent context prefetching inspired by Claude Code.
 *
 * Claude Code prefetches context based on:
 * - File path references in the prompt
 * - Import/dependency chains
 * - Recent file modifications
 * - Task type heuristics
 *
 * MJ Code's implementation extends the existing local-context-prefetch with:
 * - AST-aware import chain resolution (for TS/JS files)
 * - Git-aware recent changes prefetch
 * - Task-type-driven prefetch strategies
 * - Repository structure inference
 * - Symbol definition prefetch (for referenced identifiers)
 *
 * This module is designed to work alongside the existing prefetchLocalContextForPrompt
 * and adds higher-order intelligence on top of it.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { TaskClassification } from "../types/contracts.js";
import { abbreviate } from "./path-utils.mjs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PrefetchStrategy {
  name: string;
  priority: number;
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  filePatterns: string[];
}

export interface PrefetchCandidate {
  filePath: string;
  relativePath: string;
  reason: string;
  priority: number;
  source: string;
}

export interface ContextAwarePrefetchResult {
  candidates: PrefetchCandidate[];
  attachments: Array<{
    path: string;
    relativePath: string;
    bytes: number;
    lineCount: number;
    content: string;
    truncated: boolean;
    reason: string;
  }>;
  skipped: Array<{ path: string; reason: string }>;
  strategies: string[];
  totalBytes: number;
}

export interface ContextAwarePrefetchConfig {
  cwd: string;
  maxTotalChars: number;
  maxCharsPerFile: number;
  maxFiles: number;
  enableImportChain: boolean;
  enableGitAware: boolean;
  enableStructureInference: boolean;
  enableSymbolPrefetch: boolean;
}

// ─── Strategy Definitions ───────────────────────────────────────────────────

const TASK_STRATEGIES: Record<string, PrefetchStrategy> = {
  code_edit: {
    name: "edit-focused",
    priority: 90,
    maxFiles: 6,
    maxCharsPerFile: 8000,
    maxTotalChars: 24000,
    filePatterns: ["*.ts", "*.mts", "*.tsx", "*.js", "*.jsx", "*.py"],
  },
  bug_fix: {
    name: "debug-focused",
    priority: 95,
    maxFiles: 8,
    maxCharsPerFile: 6000,
    maxTotalChars: 28000,
    filePatterns: ["*.ts", "*.mts", "*.tsx", "*.test.*", "*.spec.*"],
  },
  refactor: {
    name: "refactor-focused",
    priority: 85,
    maxFiles: 10,
    maxCharsPerFile: 6000,
    maxTotalChars: 30000,
    filePatterns: ["*.ts", "*.mts", "*.tsx", "*.js"],
  },
  repo_understanding: {
    name: "understanding-focused",
    priority: 70,
    maxFiles: 5,
    maxCharsPerFile: 4000,
    maxTotalChars: 16000,
    filePatterns: ["*.md", "*.json", "*.ts", "*.mts"],
  },
  web_retrieval: {
    name: "web-focused",
    priority: 30,
    maxFiles: 2,
    maxCharsPerFile: 3000,
    maxTotalChars: 6000,
    filePatterns: ["*.md", "*.json"],
  },
  shell_execution: {
    name: "shell-focused",
    priority: 20,
    maxFiles: 2,
    maxCharsPerFile: 2000,
    maxTotalChars: 4000,
    filePatterns: ["*.sh", "*.json", "Makefile", "Dockerfile"],
  },
  test_repair: {
    name: "test-focused",
    priority: 95,
    maxFiles: 8,
    maxCharsPerFile: 6000,
    maxTotalChars: 28000,
    filePatterns: ["*.test.*", "*.spec.*", "*.ts", "*.mts"],
  },
};

const DEFAULT_STRATEGY: PrefetchStrategy = {
  name: "default",
  priority: 50,
  maxFiles: 4,
  maxCharsPerFile: 6000,
  maxTotalChars: 16000,
  filePatterns: [],
};

// ─── Import Resolution Patterns ─────────────────────────────────────────────

// Common import patterns in TS/JS
const IMPORT_PATTERNS = [
  // ES module imports: import ... from './path'
  /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](\.[^'"]+)['"]/g,
  // Re-exports: export ... from './path'
  /export\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](\.[^'"]+)['"]/g,
  // Dynamic imports: import('./path')
  /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  // require calls: require('./path')
  /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];

// ─── ContextAwarePrefetch Engine ────────────────────────────────────────────

export class ContextAwarePrefetch {
  readonly config: ContextAwarePrefetchConfig;

  constructor(config: Partial<ContextAwarePrefetchConfig> & { cwd: string }) {
    this.config = {
      maxTotalChars: 20000,
      maxCharsPerFile: 6000,
      maxFiles: 6,
      enableImportChain: true,
      enableGitAware: true,
      enableStructureInference: true,
      enableSymbolPrefetch: false,
      ...config,
    };
  }

  /**
   * Perform context-aware prefetch for a given prompt.
   *
   * This is the main entry point. It:
   * 1. Selects a strategy based on task type
   * 2. Extracts file references from the prompt
   * 3. Resolves import chains (if enabled)
   * 4. Adds recently modified files (if git-aware)
   * 5. Adds repository structure context (if enabled)
   * 6. Reads and attaches the files
   */
  async prefetch(
    prompt: string,
    taskClassification?: TaskClassification | null,
  ): Promise<ContextAwarePrefetchResult> {
    const strategy = this.selectStrategy(taskClassification);
    const candidates = await this.collectCandidates(prompt, strategy);
    const deduplicated = this.deduplicateAndRank(candidates, strategy);
    const attachments = await this.readCandidates(deduplicated, strategy);

    return {
      candidates: deduplicated,
      attachments,
      skipped: [],
      strategies: [strategy.name],
      totalBytes: attachments.reduce((sum, a) => sum + a.bytes, 0),
    };
  }

  /**
   * Select the best prefetch strategy based on task classification.
   */
  selectStrategy(taskClassification?: TaskClassification | null): PrefetchStrategy {
    if (!taskClassification?.taskClass) {
      return DEFAULT_STRATEGY;
    }
    return TASK_STRATEGIES[taskClassification.taskClass] ?? DEFAULT_STRATEGY;
  }

  /**
   * Collect all prefetch candidates from various sources.
   */
  private async collectCandidates(
    prompt: string,
    strategy: PrefetchStrategy,
  ): Promise<PrefetchCandidate[]> {
    const candidates: PrefetchCandidate[] = [];

    // Source 1: Direct file references in prompt
    const directRefs = this.extractFileReferences(prompt);
    for (const ref of directRefs) {
      candidates.push({
        filePath: ref,
        relativePath: path.relative(this.config.cwd, ref),
        reason: "direct_reference",
        priority: 100,
        source: "prompt",
      });
    }

    // Source 2: Import chain resolution
    if (this.config.enableImportChain && directRefs.length > 0) {
      const importChain = await this.resolveImportChain(directRefs, 2);
      for (const imported of importChain) {
        candidates.push({
          filePath: imported.path,
          relativePath: path.relative(this.config.cwd, imported.path),
          reason: `import_chain:${imported.importer}`,
          priority: 60,
          source: "import_chain",
        });
      }
    }

    // Source 3: Git-aware recent changes
    if (this.config.enableGitAware) {
      const recentChanges = await this.getRecentGitChanges(3);
      for (const change of recentChanges) {
        candidates.push({
          filePath: change,
          relativePath: path.relative(this.config.cwd, change),
          reason: "recent_git_change",
          priority: 40,
          source: "git",
        });
      }
    }

    // Source 4: Repository structure inference
    if (this.config.enableStructureInference) {
      const structureFiles = await this.inferRepositoryStructure();
      for (const structFile of structureFiles) {
        candidates.push({
          filePath: structFile.path,
          relativePath: path.relative(this.config.cwd, structFile.path),
          reason: structFile.reason,
          priority: structFile.priority,
          source: "structure",
        });
      }
    }

    return candidates;
  }

  /**
   * Extract file references from prompt text.
   *
   * This extends the existing PATH_PATTERN matching with:
   * - Backtick-enclosed paths
   * - "in the file X" patterns
   * - Line number references (file.ts:42)
   */
  private extractFileReferences(prompt: string): string[] {
    const refs: string[] = [];
    const seen = new Set<string>();

    const addRef = (rawPath: string) => {
      const cleaned = rawPath.replace(/[`"'），。；]+$/g, "").replace(/^[`"'（]+/g, "");
      if (!cleaned || seen.has(cleaned) || cleaned.startsWith("http")) {
        return;
      }
      // Strip line numbers
      const withoutLineNums = cleaned.replace(/[:#]\d+(-\d+)?$/, "");
      const resolved = path.isAbsolute(withoutLineNums)
        ? withoutLineNums
        : path.resolve(this.config.cwd, withoutLineNums);

      // Verify it's within workspace
      const relative = path.relative(this.config.cwd, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return;
      }
      // Skip node_modules and .git
      if (relative.includes("/node_modules/") || relative.includes("/.git/")) {
        return;
      }

      if (!seen.has(resolved)) {
        seen.add(resolved);
        refs.push(resolved);
      }
    };

    // Pattern 1: Standard file paths with extensions
    const PATH_RE = /(?<![\w:/.-])((?:\.{1,2}\/|\/)?[\w@+./-]+?\.(?:md|mdx|txt|json|jsonl|js|jsx|ts|tsx|mts|mjs|py|rs|go|java|c|cc|cpp|h|hpp|css|scss|html|yaml|yml|toml|sql|sh|zsh|fish|vue|svelte))(?:[:#]\d+(-\d+)?)?/gi;
    for (const match of prompt.matchAll(PATH_RE)) {
      addRef(match[1] ?? "");
    }

    // Pattern 2: Backtick-enclosed paths
    const BACKTICK_RE = /`([^`]+\.[a-z]{1,4})`/gi;
    for (const match of prompt.matchAll(BACKTICK_RE)) {
      addRef(match[1] ?? "");
    }

    // Pattern 3: "in the file X" / "in file X" patterns
    const IN_FILE_RE = /(?:in|of|from|inside|at|open|edit|fix|check|read|write)\s+(?:the\s+)?(?:file\s+)?[`"']?([^`"'\s]+\.[a-z]{1,4})[`"']?/gi;
    for (const match of prompt.matchAll(IN_FILE_RE)) {
      addRef(match[1] ?? "");
    }

    return refs;
  }

  /**
   * Resolve import chains from a set of files.
   *
   * This traces import statements in the given files and resolves them
   * to actual file paths. Depth controls how many levels deep to trace.
   */
  private async resolveImportChain(
    filePaths: string[],
    depth: number,
  ): Promise<Array<{ path: string; importer: string }>> {
    const resolved: Array<{ path: string; importer: string }> = [];
    const visited = new Set<string>(filePaths);
    const queue = [...filePaths.map((p) => ({ path: p, depth: 0 }))];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= depth) {
        continue;
      }

      const imports = await this.extractImports(item.path);
      for (const importPath of imports) {
        if (!visited.has(importPath)) {
          visited.add(importPath);
          resolved.push({ path: importPath, importer: path.basename(item.path) });
          queue.push({ path: importPath, depth: item.depth + 1 });
        }
      }
    }

    return resolved;
  }

  /**
   * Extract import paths from a file.
   */
  private async extractImports(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const imports: string[] = [];
      const seen = new Set<string>();

      for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of content.matchAll(pattern)) {
          const importSpecifier = match[1] ?? "";
          if (!importSpecifier || seen.has(importSpecifier)) {
            continue;
          }
          seen.add(importSpecifier);

          const resolved = this.resolveImportSpecifier(importSpecifier, filePath);
          if (resolved) {
            imports.push(resolved);
          }
        }
      }

      return imports;
    } catch {
      return [];
    }
  }

  /**
   * Resolve a bare import specifier to an actual file path.
   */
  private resolveImportSpecifier(specifier: string, fromFile: string): string | null {
    if (!specifier.startsWith(".")) {
      return null; // Only resolve relative imports
    }

    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, specifier);

    // Try exact path first
    try {
      const stat = require("fs").statSync(resolved);
      if (stat.isFile()) return resolved;
    } catch {}

    // Try with extensions
    for (const ext of [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"]) {
      try {
        const stat = require("fs").statSync(`${resolved}${ext}`);
        if (stat.isFile()) return `${resolved}${ext}`;
      } catch {}
    }

    // Try index files
    for (const indexFile of ["index.ts", "index.mts", "index.tsx", "index.js", "index.mjs"]) {
      try {
        const indexPath = path.join(resolved, indexFile);
        const stat = require("fs").statSync(indexPath);
        if (stat.isFile()) return indexPath;
      } catch {}
    }

    return null;
  }

  /**
   * Get recently modified files from git.
   */
  private async getRecentGitChanges(count: number): Promise<string[]> {
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      const output = execSync(
        `git diff --name-only HEAD~${count} HEAD -- . 2>/dev/null || git diff --name-only --cached -- . 2>/dev/null || git ls-files --modified -- .`,
        { cwd: this.config.cwd, encoding: "utf8", timeout: 3000 },
      );
      return output
        .split("\n")
        .map((line: string) => line.trim())
        .filter(Boolean)
        .filter((line: string) => !line.includes("node_modules"))
        .map((line: string) => path.resolve(this.config.cwd, line))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  /**
   * Infer repository structure and suggest important files.
   */
  private async inferRepositoryStructure(): Promise<Array<{ path: string; reason: string; priority: number }>> {
    const files: Array<{ path: string; reason: string; priority: number }> = [];
    const importantFiles = [
      { name: "MJ.md", reason: "project_instructions", priority: 80 },
      { name: "README.md", reason: "project_readme", priority: 70 },
      { name: "package.json", reason: "project_config", priority: 65 },
      { name: "tsconfig.json", reason: "typescript_config", priority: 55 },
      { name: "AGENTS.md", reason: "agent_instructions", priority: 75 },
    ];

    for (const { name, reason, priority } of importantFiles) {
      const filePath = path.resolve(this.config.cwd, name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          files.push({ path: filePath, reason, priority });
        }
      } catch {
        // File doesn't exist, skip
      }
    }

    return files;
  }

  /**
   * Deduplicate candidates and rank by priority.
   */
  private deduplicateAndRank(
    candidates: PrefetchCandidate[],
    strategy: PrefetchStrategy,
  ): PrefetchCandidate[] {
    const seen = new Set<string>();
    const unique: PrefetchCandidate[] = [];

    for (const candidate of candidates.sort((a, b) => b.priority - a.priority)) {
      if (!seen.has(candidate.filePath)) {
        seen.add(candidate.filePath);
        unique.push(candidate);
      }
    }

    return unique.slice(0, strategy.maxFiles);
  }

  /**
   * Read candidate files and create attachments.
   */
  private async readCandidates(
    candidates: PrefetchCandidate[],
    strategy: PrefetchStrategy,
  ): Promise<ContextAwarePrefetchResult["attachments"]> {
    const attachments: ContextAwarePrefetchResult["attachments"] = [];
    let remainingChars = strategy.maxTotalChars;

    for (const candidate of candidates) {
      if (attachments.length >= strategy.maxFiles || remainingChars <= 0) {
        break;
      }

      try {
        const stat = await fs.stat(candidate.filePath);
        if (!stat.isFile() || stat.size > 512 * 1024) {
          continue;
        }

        const raw = await fs.readFile(candidate.filePath, "utf8");
        if (raw.includes(" ")) {
          continue; // Binary file
        }

        const budget = Math.min(strategy.maxCharsPerFile, remainingChars);
        const content = abbreviate(raw, budget);
        const lineCount = raw.split(/\r?\n/).length;

        attachments.push({
          path: candidate.filePath,
          relativePath: path.relative(this.config.cwd, candidate.filePath) || path.basename(candidate.filePath),
          bytes: stat.size,
          lineCount,
          content,
          truncated: content.length < raw.length,
          reason: candidate.reason,
        });

        remainingChars -= content.length;
      } catch {
        // Can't read file, skip
      }
    }

    return attachments;
  }
}
