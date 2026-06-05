import { canonicalizeUrl, getUrlMetadata } from "./web-policy.mjs";
import { createExtractionError } from "./web-errors.mjs";

import type {
  ExtractedContent,
  ExtractionStrategy,
} from "../types/contracts.js";

const MAX_HEADINGS = 24;

export interface ExtractContentFromDocumentInput {
  url: string;
  contentType: string | null | undefined;
  body: ArrayBuffer | ArrayBufferView | Buffer | string | null | undefined;
  maxChars?: number;
}

export function extractContentFromDocument({
  url,
  contentType,
  body,
  maxChars = 24000,
}: ExtractContentFromDocumentInput): ExtractedContent {
  const normalizedBody = normalizeBody(body);
  const normalizedType = `${contentType ?? ""}`.toLowerCase();
  if (!normalizedBody) {
    throw createExtractionError({
      url,
      message: "Document body is empty.",
    });
  }

  if (normalizedType.includes("html")) {
    return extractHtmlContent(url, normalizedBody, maxChars);
  }

  if (normalizedType.includes("pdf")) {
    // PDF content — attempt text extraction from binary data
    return extractPdfContent(url, normalizedBody, maxChars);
  }

  if (
    normalizedType.includes("markdown") ||
    normalizedType.includes("text/plain") ||
    normalizedType.includes("text/csv") ||
    normalizedType.includes("text/richtext") ||
    normalizedType.includes("application/rtf") ||
    normalizedType.includes("application/json") ||
    normalizedType.includes("application/ld+json") ||
    normalizedType.includes("application/xml") ||
    normalizedType.includes("text/xml") ||
    normalizedType.includes("application/rss+xml") ||
    normalizedType.includes("application/atom+xml")
  ) {
    return extractPlainContent(url, normalizedBody, normalizedType, maxChars);
  }

  // For unknown content types, try plain text extraction as a best-effort fallback
  // This helps with content types like application/octet-stream that might actually be text
  if (normalizedBody.length > 0 && isLikelyReadableText(normalizedBody)) {
    return extractPlainContent(url, normalizedBody, normalizedType, maxChars);
  }

  throw createExtractionError({
    url,
    message: `No extraction strategy for content type "${contentType}".`,
    details: {
      contentType,
    },
  });
}

function extractHtmlContent(url: string, html: string, maxChars: number): ExtractedContent {
  const metadata = getUrlMetadata(url);
  const title = decodeHtmlEntities(
    extractTag(html, "title") || extractMeta(html, "og:title") || extractMeta(html, "twitter:title") || metadata.domain || url,
  );
  const canonicalUrl = extractCanonical(html) || canonicalizeUrl(url);
  const author = decodeHtmlEntities(
    extractMeta(html, "author") || extractMeta(html, "article:author") || extractMeta(html, "citation_author") || "",
  );
  const publishedAt =
    extractMeta(html, "article:published_time") ||
    extractMeta(html, "og:published_time") ||
    extractMeta(html, "date") ||
    extractMeta(html, "citation_date") ||
    extractMeta(html, "citation_publication_date") ||
    null;
  const headings = extractHeadings(html);
  const excerpt = decodeHtmlEntities(
    extractMeta(html, "description") ||
    extractMeta(html, "og:description") ||
    extractMeta(html, "twitter:description") ||
    "",
  );

  // Strip non-content elements before converting to text
  const bodyOnly = html
    // Remove script, style, noscript blocks
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    // Remove nav, header, footer, aside (non-content regions)
    .replace(/<nav[\s>][\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s>][\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s>][\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s>][\s\S]*?<\/aside>/gi, " ")
    // Remove form elements
    .replace(/<form[\s>][\s\S]*?<\/form>/gi, " ")
    // Remove SVG
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    // Remove iframe, video, audio, canvas (embedded media)
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<video[\s\S]*?<\/video>/gi, " ")
    .replace(/<audio[\s\S]*?<\/audio>/gi, " ")
    .replace(/<canvas[\s>][\s\S]*?<\/canvas>/gi, " ")
    // Remove button, input, select, textarea (interactive elements)
    .replace(/<button[\s>][\s\S]*?<\/button>/gi, " ")
    .replace(/<input[^>]*>/gi, " ")
    .replace(/<select[\s>][\s\S]*?<\/select>/gi, " ")
    .replace(/<textarea[\s>][\s\S]*?<\/textarea>/gi, " ")
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, " ");

  const readableText = truncateText(
    decodeHtmlEntities(
      bodyOnly
        .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr|dd|dt|blockquote|pre|figcaption)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    ),
    maxChars,
  );

  return {
    url,
    canonicalUrl,
    domain: metadata.domain,
    title,
    publishedAt,
    author: author || null,
    headings,
    excerpt: excerpt || readableText.text.slice(0, 240),
    readableText: readableText.text,
    rawTextLength: readableText.originalLength,
    truncated: readableText.truncated,
    extractionStrategy: "html-basic-readability",
  };
}

function extractPlainContent(
  url: string,
  body: string,
  contentType: string,
  maxChars: number,
): ExtractedContent {
  const metadata = getUrlMetadata(url);
  const readableText = truncateText(body.trim(), maxChars);
  const headings = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(#|\w[^.]{0,80}:)$/.test(line))
    .slice(0, MAX_HEADINGS);

  return {
    url,
    canonicalUrl: canonicalizeUrl(url),
    domain: metadata.domain,
    title: metadata.domain || url,
    publishedAt: null,
    author: null,
    headings,
    excerpt: readableText.text.slice(0, 240),
    readableText: readableText.text,
    rawTextLength: readableText.originalLength,
    truncated: readableText.truncated,
    extractionStrategy: resolvePlainExtractionStrategy(contentType),
  };
}

function extractTag(html: string, tagName: string): string {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractMeta(html: string, name: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escapeForRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+property=["']${escapeForRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeForRegExp(name)}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeForRegExp(name)}["'][^>]*>`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function extractCanonical(html: string): string {
  const match =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  return match?.[1]?.trim() ?? "";
}

function extractHeadings(html: string): string[] {
  const matches = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  return matches
    .map((match) => decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .slice(0, MAX_HEADINGS);
}

function decodeHtmlEntities(value: string): string {
  return `${value ?? ""}`
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function truncateText(
  text: string,
  maxChars: number,
): { text: string; originalLength: number; truncated: boolean } {
  const normalized = `${text ?? ""}`.trim();
  if (normalized.length <= maxChars) {
    return {
      text: normalized,
      originalLength: normalized.length,
      truncated: false,
    };
  }

  return {
    text: `${normalized.slice(0, maxChars - 19)}\n...<content truncated>`,
    originalLength: normalized.length,
    truncated: true,
  };
}

function resolvePlainExtractionStrategy(contentType: string): ExtractionStrategy {
  if (contentType.includes("markdown")) {
    return "markdown-plain";
  }
  if (contentType.includes("json") || contentType.includes("ld+json")) {
    return "json-plain";
  }
  if (contentType.includes("xml") || contentType.includes("rss") || contentType.includes("atom")) {
    return "xml-plain";
  }
  if (contentType.includes("csv")) {
    return "text-plain";
  }
  return "text-plain";
}

/**
 * Extract text content from PDF data.
 * Uses a simple approach: extract text between stream markers and decode printable text.
 * For production use, a proper PDF parser like pdf-parse would be better,
 * but this avoids adding a dependency.
 */
function extractPdfContent(url: string, body: string, maxChars: number): ExtractedContent {
  const metadata = getUrlMetadata(url);

  // Try to extract readable text from PDF stream objects
  // PDF text is typically in BT...ET blocks within stream objects
  const textChunks: string[] = [];

  // Method 1: Extract text from parentheses within BT/ET blocks
  const btEtPattern = /BT[\s\S]*?ET/g;
  const btEtMatches = body.match(btEtPattern) ?? [];
  for (const block of btEtMatches) {
    // Extract text from Tj and TJ operators
    const tjPattern = /\(([^)]*)\)\s*Tj/g;
    const tjMatches = [...block.matchAll(tjPattern)];
    for (const match of tjMatches) {
      if (match[1]) {
        textChunks.push(decodePdfString(match[1]));
      }
    }
    // TJ array format: [(text) num (text) ...]
    const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;
    const tjArrayMatches = [...block.matchAll(tjArrayPattern)];
    for (const arrMatch of tjArrayMatches) {
      const innerTexts = [...arrMatch[1].matchAll(/\(([^)]*)\)/g)];
      for (const t of innerTexts) {
        if (t[1]) {
          textChunks.push(decodePdfString(t[1]));
        }
      }
    }
  }

  // Method 2: If no text found, try extracting any visible text sequences
  if (textChunks.length === 0) {
    // Look for text in stream objects
    const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    const streamMatches = body.match(streamPattern) ?? [];
    for (const stream of streamMatches) {
      const printableChars = stream.replace(/[^\x20-\x7E\n\r]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (printableChars.length > 20) {
        textChunks.push(printableChars);
      }
    }
  }

  const readableText = truncateText(textChunks.join(" ").replace(/\s+/g, " ").trim(), maxChars);

  return {
    url,
    canonicalUrl: canonicalizeUrl(url),
    domain: metadata.domain,
    title: metadata.domain || url,
    publishedAt: null,
    author: null,
    headings: [],
    excerpt: readableText.text.slice(0, 240),
    readableText: readableText.text || `[PDF document from ${metadata.domain ?? url}]`,
    rawTextLength: readableText.originalLength,
    truncated: readableText.truncated,
    extractionStrategy: "pdf-basic",
  };
}

/**
 * Decode PDF string literals, handling common escape sequences.
 */
function decodePdfString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct: string) => {
      const code = parseInt(oct, 8);
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : "";
    });
}

/**
 * Heuristic check: does this body look like it contains human-readable text?
 * Used as a fallback when the content type is unknown.
 */
function isLikelyReadableText(body: string): boolean {
  if (body.length === 0) return false;

  // Check the first 2000 characters for printable ratio
  const sample = body.slice(0, 2000);
  let printable = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 32 && code <= 126) || // printable ASCII
      code === 9 || code === 10 || code === 13 || // tab, newline, CR
      code > 127 // Unicode characters
    ) {
      printable++;
    }
  }

  // If more than 70% of characters are printable, it's likely readable text
  return printable / sample.length > 0.7;
}

function escapeForRegExp(value: string): string {
  return `${value ?? ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBody(body: ExtractContentFromDocumentInput["body"]): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body)).toString("utf8");
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  return "";
}
