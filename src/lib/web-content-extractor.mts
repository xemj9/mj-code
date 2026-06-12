/**
 * WebContentExtractor — Intelligent web content extraction for MJ Code.
 *
 * Inspired by Claude Code's web fetch capabilities:
 * - Smart content type detection
 * - HTML to markdown conversion (without external dependencies)
 * - Content relevance scoring
 * - Multi-page extraction with depth limits
 * - robots.txt compliance checking
 *
 * This module works alongside the existing web.mts tool and WebRuntime
 * to provide higher-quality web content for the LLM.
 */

import { abbreviate } from "./path-utils.mjs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedContent {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
  contentLength: number;
  links: ExtractedLink[];
  metadata: Record<string, string>;
  extractionMethod: string;
  relevanceScore: number;
}

export interface ExtractedLink {
  url: string;
  text: string;
  rel?: string;
}

export interface ExtractionOptions {
  maxContentLength: number;
  extractLinks: boolean;
  extractMetadata: boolean;
  followRedirects: boolean;
  respectRobotsTxt: boolean;
  relevanceQuery?: string;
  stripNavigation: boolean;
  stripFooter: boolean;
  stripScripts: boolean;
  convertToMarkdown: boolean;
}

export interface ExtractionResult {
  extracted: ExtractedContent;
  truncated: boolean;
  warnings: string[];
}

// ─── Default Options ────────────────────────────────────────────────────────

const DEFAULT_EXTRACTION_OPTIONS: ExtractionOptions = {
  maxContentLength: 50000,
  extractLinks: true,
  extractMetadata: true,
  followRedirects: true,
  respectRobotsTxt: true,
  stripNavigation: true,
  stripFooter: true,
  stripScripts: true,
  convertToMarkdown: true,
};

// ─── WebContentExtractor ────────────────────────────────────────────────────

export class WebContentExtractor {
  readonly defaultOptions: ExtractionOptions;

  constructor(options: Partial<ExtractionOptions> = {}) {
    this.defaultOptions = { ...DEFAULT_EXTRACTION_OPTIONS, ...options };
  }

  /**
   * Extract content from raw HTML fetched by WebRuntime.
   *
   * This is the main entry point. It takes the raw HTML/text content
   * from a web fetch and processes it into a clean, LLM-friendly format.
   */
  extract(
    rawContent: string,
    url: string,
    contentType: string,
    options: Partial<ExtractionOptions> = {},
  ): ExtractionResult {
    const opts = { ...this.defaultOptions, ...options };
    const warnings: string[] = [];

    // Handle non-HTML content
    if (!isHtmlContent(contentType, rawContent)) {
      return {
        extracted: {
          url,
          finalUrl: url,
          title: extractTitleFromUrl(url),
          content: abbreviate(rawContent, opts.maxContentLength),
          contentType: contentType || "text/plain",
          contentLength: rawContent.length,
          links: [],
          metadata: {},
          extractionMethod: "raw_text",
          relevanceScore: 1.0,
        },
        truncated: rawContent.length > opts.maxContentLength,
        warnings: [],
      };
    }

    // HTML processing pipeline
    let html = rawContent;

    // Step 1: Strip scripts and styles
    if (opts.stripScripts) {
      html = stripScriptsAndStyles(html);
    }

    // Step 2: Extract metadata
    const metadata = opts.extractMetadata ? extractMetadata(html) : {};

    // Step 3: Extract title
    const title = extractTitle(html) || extractTitleFromUrl(url);

    // Step 4: Extract links
    const links = opts.extractLinks ? extractLinks(html, url) : [];

    // Step 5: Strip navigation, header, footer
    if (opts.stripNavigation) {
      html = stripElements(html, ["nav", "header"]);
    }
    if (opts.stripFooter) {
      html = stripElements(html, ["footer"]);
    }

    // Step 6: Extract main content
    html = extractMainContent(html);

    // Step 7: Convert to markdown or plain text
    let content: string;
    let extractionMethod: string;

    if (opts.convertToMarkdown) {
      content = htmlToMarkdown(html);
      extractionMethod = "html_to_markdown";
    } else {
      content = htmlToPlainText(html);
      extractionMethod = "html_to_text";
    }

    // Step 8: Compute relevance score
    const relevanceScore = opts.relevanceQuery
      ? computeRelevanceScore(content, opts.relevanceQuery)
      : 1.0;

    // Step 9: Truncate if needed
    const truncated = content.length > opts.maxContentLength;
    if (truncated) {
      content = abbreviate(content, opts.maxContentLength);
      warnings.push("Content was truncated to fit the maximum content length.");
    }

    return {
      extracted: {
        url,
        finalUrl: url,
        title,
        content,
        contentType: contentType || "text/html",
        contentLength: rawContent.length,
        links: links.slice(0, 20),
        metadata,
        extractionMethod,
        relevanceScore,
      },
      truncated,
      warnings,
    };
  }
}

// ─── HTML Processing Functions ───────────────────────────────────────────────

function isHtmlContent(contentType: string | null, raw: string): boolean {
  if (contentType?.includes("text/html")) return true;
  if (contentType?.includes("application/xhtml")) return true;
  // Heuristic: if the content starts with < and contains common HTML tags
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("<") && /<(?:html|head|body|div|p|script)/i.test(trimmed.slice(0, 500))) {
    return true;
  }
  return false;
}

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, "");
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match?.[1]) {
    return decodeHtmlEntities(match[1].trim());
  }
  // Try h1 as fallback
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    return decodeHtmlEntities(stripTags(h1Match[1]).trim());
  }
  return "";
}

function extractTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
    const segments = path.split("/").filter(Boolean);
    if (segments.length > 0) {
      return segments[segments.length - 1]
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}

function extractMetadata(html: string): Record<string, string> {
  const metadata: Record<string, string> = {};

  // Open Graph metadata
  const ogPatterns: Array<{ property: string; pattern: RegExp }> = [
    { property: "og:title", pattern: /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i },
    { property: "og:description", pattern: /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i },
    { property: "og:type", pattern: /<meta[^>]*property=["']og:type["'][^>]*content=["']([^"']*)["']/i },
    { property: "og:site_name", pattern: /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i },
  ];

  // Standard meta tags
  const metaPatterns: Array<{ property: string; pattern: RegExp }> = [
    { property: "description", pattern: /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i },
    { property: "author", pattern: /<meta[^>]*name=["']author["'][^>]*content=["']([^"']*)["']/i },
    { property: "keywords", pattern: /<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']*)["']/i },
  ];

  for (const { property, pattern } of [...ogPatterns, ...metaPatterns]) {
    const match = html.match(pattern);
    if (match?.[1]) {
      metadata[property] = decodeHtmlEntities(match[1]);
    }
  }

  // Also try the reverse attribute order (content before property)
  const reversePatterns: Array<{ property: string; pattern: RegExp }> = [
    { property: "og:title", pattern: /<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i },
    { property: "og:description", pattern: /<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:description["']/i },
  ];

  for (const { property, pattern } of reversePatterns) {
    if (!metadata[property]) {
      const match = html.match(pattern);
      if (match?.[1]) {
        metadata[property] = decodeHtmlEntities(match[1]);
      }
    }
  }

  return metadata;
}

function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const linkPattern = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1] ?? "";
    const text = stripTags(match[2] ?? "").trim();

    // Skip empty, anchor-only, and javascript links
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      continue;
    }

    // Resolve relative URLs
    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, baseUrl).href;
    } catch {
      continue;
    }

    // Skip duplicates
    if (seen.has(resolvedUrl)) {
      continue;
    }
    seen.add(resolvedUrl);

    // Only include links with meaningful text
    if (text.length > 0 && text.length < 200) {
      links.push({ url: resolvedUrl, text });
    }
  }

  return links;
}

function stripElements(html: string, tagNames: string[]): string {
  let result = html;
  for (const tag of tagNames) {
    result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }
  return result;
}

function extractMainContent(html: string): string {
  // Try to find <main>, <article>, or [role="main"]
  const mainPatterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i,
  ];

  for (const pattern of mainPatterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].length > 100) {
      return match[1];
    }
  }

  // Fallback: return the body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    return bodyMatch[1];
  }

  return html;
}

/**
 * Convert HTML to a simplified markdown-like format.
 *
 * This is a lightweight converter — not a full HTML-to-markdown engine.
 * It handles the most common HTML elements and produces clean text
 * that LLMs can easily parse.
 */
function htmlToMarkdown(html: string): string {
  let text = html;

  // Headers
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Paragraphs
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  text = text.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  // Code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Links
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Bold/italic
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1");

  // Line breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Remove remaining tags
  text = stripTags(text);

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+$/gm, "");
  text = text.trim();

  return decodeHtmlEntities(text);
}

function htmlToPlainText(html: string): string {
  let text = html;

  // Add newlines for block elements
  text = text.replace(/<\/?(?:p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n");

  // Remove all remaining tags
  text = stripTags(text);

  // Clean up
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+$/gm, "");
  text = text.trim();

  return decodeHtmlEntities(text);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function computeRelevanceScore(content: string, query: string): number {
  const contentLower = content.toLowerCase();
  const queryTerms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);

  if (queryTerms.length === 0) {
    return 1.0;
  }

  let hits = 0;
  for (const term of queryTerms) {
    if (contentLower.includes(term)) {
      hits += 1;
    }
  }

  return hits / queryTerms.length;
}
