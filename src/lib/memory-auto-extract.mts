/**
 * MemoryAutoExtract — Automatic memory extraction from conversations.
 *
 * Inspired by Claude Code's memory extraction system, which automatically
 * identifies and stores:
 * - User preferences ("I prefer X", "Always do Y")
 * - Technical decisions ("We chose to use X because Y")
 * - Failure patterns ("This approach doesn't work because Z")
 * - Project conventions ("This project uses X style")
 *
 * MJ Code's implementation uses rule-based pattern matching instead of
 * LLM-based extraction (to avoid extra API calls and maintain zero-dependency).
 * It operates on the conversation history and extracts structured memories
 * that can be persisted to the MemoryStore.
 */

import type { MemoryKind, MemoryScope } from "../types/contracts.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  toolCalls?: Array<{ name: string }>;
  [key: string]: unknown;
}

export interface ExtractedMemory {
  scope: MemoryScope;
  kind: MemoryKind;
  text: string;
  summary: string;
  source: string;
  importance: number;
  confidence: number;
  tags: string[];
  key: string;
}

export interface MemoryExtractionResult {
  extracted: ExtractedMemory[];
  patterns: Array<{ pattern: string; matches: number }>;
  totalScanned: number;
}

export interface MemoryExtractionConfig {
  maxExtractionsPerTurn: number;
  minImportance: number;
  enablePreferenceExtraction: boolean;
  enableDecisionExtraction: boolean;
  enableFailureExtraction: boolean;
  enableConventionExtraction: boolean;
}

// ─── Extraction Patterns ────────────────────────────────────────────────────

interface ExtractionPattern {
  name: string;
  patterns: RegExp[];
  scope: MemoryScope;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  keyPrefix: string;
  tagFactory?: (match: RegExpMatchArray) => string[];
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  // User preferences
  {
    name: "user_preference",
    patterns: [
      /(?:I\s+prefer|I\s+like|I\s+want|I\s+always|I\s+never|always\s+use|never\s+use|please\s+always|please\s+never)\s+(.{10,100})/gi,
      /(?:my\s+preference\s+is|my\s+style\s+is|I\s+typically|I\s+usually)\s+(.{10,100})/gi,
      /(?:偏好|习惯|通常|总是|从不|不要|最好用|不要用)\s*(.{5,80})/gu,
    ],
    scope: "user",
    kind: "policy",
    importance: 0.92,
    confidence: 0.88,
    keyPrefix: "user-pref",
  },
  // Technical decisions
  {
    name: "technical_decision",
    patterns: [
      /(?:we\s+(?:should|will|decided\s+to|chose\s+to|need\s+to))\s+(.{10,120})/gi,
      /(?:the\s+(?:best|right|correct)\s+(?:approach|way|method)\s+(?:is|would\s+be))\s+(.{10,120})/gi,
      /(?:I\s+recommend|I\s+suggest|let's\s+(?:use|go\s+with|adopt))\s+(.{10,120})/gi,
    ],
    scope: "project",
    kind: "semantic",
    importance: 0.80,
    confidence: 0.82,
    keyPrefix: "decision",
  },
  // Failure patterns
  {
    name: "failure_pattern",
    patterns: [
      /(?:this\s+(?:doesn't|does\s+not|won't|will\s+not)\s+work\s+(?:because|since|as))\s+(.{10,120})/gi,
      /(?:the\s+(?:problem|issue|error)\s+(?:is|was)\s+(?:that\s+)?)\s*(.{10,120})/gi,
      /(?:failed\s+(?:because|due\s+to|since))\s+(.{10,120})/gi,
      /(?:不能|无法|失败|报错|出错)(.{5,80})/gu,
    ],
    scope: "failure",
    kind: "episodic",
    importance: 0.85,
    confidence: 0.90,
    keyPrefix: "failure",
  },
  // Project conventions
  {
    name: "project_convention",
    patterns: [
      /(?:this\s+project\s+(?:uses|follows|adopts|requires))\s+(.{10,120})/gi,
      /(?:in\s+this\s+(?:codebase|project|repo),?\s+we\s+(?:use|follow|adopt))\s+(.{10,120})/gi,
      /(?:convention|style|pattern|practice)\s*(?:is|:)\s*(.{10,120})/gi,
    ],
    scope: "project",
    kind: "semantic",
    importance: 0.82,
    confidence: 0.78,
    keyPrefix: "convention",
  },
];

// ─── MemoryAutoExtract ──────────────────────────────────────────────────────

export class MemoryAutoExtract {
  readonly config: MemoryExtractionConfig;

  constructor(config: Partial<MemoryExtractionConfig> = {}) {
    this.config = {
      maxExtractionsPerTurn: 5,
      minImportance: 0.7,
      enablePreferenceExtraction: true,
      enableDecisionExtraction: true,
      enableFailureExtraction: true,
      enableConventionExtraction: true,
      ...config,
    };
  }

  /**
   * Extract memories from a conversation turn.
   *
   * This is the main entry point. It scans the user message and assistant
   * response for patterns that indicate extractable knowledge.
   */
  extractFromTurn(
    userMessage: string,
    assistantResponse: string,
    toolEvents: Array<{ tool: string; success: boolean }> = [],
  ): MemoryExtractionResult {
    const extracted: ExtractedMemory[] = [];
    const patternCounts: Array<{ pattern: string; matches: number }> = [];
    let totalScanned = 0;

    // Only extract from user and assistant messages
    const texts = [
      { text: userMessage, role: "user" as const },
      { text: assistantResponse, role: "assistant" as const },
    ];

    for (const { text } of texts) {
      totalScanned += text.length;

      for (const patternDef of EXTRACTION_PATTERNS) {
        // Skip disabled pattern types
        if (patternDef.name === "user_preference" && !this.config.enablePreferenceExtraction) continue;
        if (patternDef.name === "technical_decision" && !this.config.enableDecisionExtraction) continue;
        if (patternDef.name === "failure_pattern" && !this.config.enableFailureExtraction) continue;
        if (patternDef.name === "project_convention" && !this.config.enableConventionExtraction) continue;

        let matchCount = 0;

        for (const regex of patternDef.patterns) {
          regex.lastIndex = 0;
          const matches = text.matchAll(regex);

          for (const match of matches) {
            if (extracted.length >= this.config.maxExtractionsPerTurn) {
              break;
            }

            const capturedText = match[1]?.trim();
            if (!capturedText || capturedText.length < 10) {
              continue;
            }

            // Dedup check: skip if we already extracted something very similar
            if (this.isDuplicateExtraction(capturedText, extracted)) {
              continue;
            }

            const memory: ExtractedMemory = {
              scope: patternDef.scope,
              kind: patternDef.kind,
              text: capturedText,
              summary: summarizeExtractedText(capturedText),
              source: `auto-extract:${patternDef.name}`,
              importance: patternDef.importance,
              confidence: patternDef.confidence,
              tags: patternDef.tagFactory?.(match) ?? [patternDef.name],
              key: `${patternDef.keyPrefix}-${hashString(capturedText).slice(0, 8)}`,
            };

            if (memory.importance >= this.config.minImportance) {
              extracted.push(memory);
              matchCount += 1;
            }
          }

          if (extracted.length >= this.config.maxExtractionsPerTurn) {
            break;
          }
        }

        patternCounts.push({ pattern: patternDef.name, matches: matchCount });
      }

      if (extracted.length >= this.config.maxExtractionsPerTurn) {
        break;
      }
    }

    // Also extract from tool events (failure patterns)
    if (this.config.enableFailureExtraction) {
      for (const event of toolEvents) {
        if (!event.success) {
          extracted.push({
            scope: "failure",
            kind: "episodic",
            text: `Tool ${event.tool} failed during execution`,
            summary: `Tool failure: ${event.tool}`,
            source: "auto-extract:tool_failure",
            importance: 0.82,
            confidence: 0.95,
            tags: ["failure", event.tool],
            key: `tool-failure-${event.tool}-${Date.now()}`,
          });
        }
      }
    }

    return {
      extracted,
      patterns: patternCounts,
      totalScanned,
    };
  }

  /**
   * Check if a candidate extraction is a duplicate of an already-extracted memory.
   */
  private isDuplicateExtraction(text: string, existing: ExtractedMemory[]): boolean {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

    for (const memory of existing) {
      const existingNormalized = memory.text.toLowerCase().replace(/\s+/g, " ").trim();
      // Simple overlap check: if >80% of tokens overlap, it's a duplicate
      const overlap = computeTokenOverlap(normalized, existingNormalized);
      if (overlap > 0.8) {
        return true;
      }
    }

    return false;
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function summarizeExtractedText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) {
    return compact;
  }
  return `${compact.slice(0, 117)}...`;
}

function hashString(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

function computeTokenOverlap(a: string, b: string): number {
  const tokensA = a.split(/\s+/);
  const tokensB = new Set(b.split(/\s+/));
  if (tokensA.length === 0 || tokensB.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      hits += 1;
    }
  }
  return hits / tokensA.length;
}
