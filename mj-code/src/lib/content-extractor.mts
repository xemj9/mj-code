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

  if (
    normalizedType.includes("markdown") ||
    normalizedType.includes("text/plain") ||
    normalizedType.includes("application/json") ||
    normalizedType.includes("application/xml") ||
    normalizedType.includes("text/xml")
  ) {
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
    extractTag(html, "title") || extractMeta(html, "og:title") || metadata.domain || url,
  );
  const canonicalUrl = extractCanonical(html) || canonicalizeUrl(url);
  const author = decodeHtmlEntities(
    extractMeta(html, "author") || extractMeta(html, "article:author") || "",
  );
  const publishedAt =
    extractMeta(html, "article:published_time") ||
    extractMeta(html, "og:published_time") ||
    extractMeta(html, "date") ||
    null;
  const headings = extractHeadings(html);
  const excerpt = decodeHtmlEntities(
    extractMeta(html, "description") ||
    extractMeta(html, "og:description") ||
    "",
  );

  const bodyOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const readableText = truncateText(
    decodeHtmlEntities(
      bodyOnly
        .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
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
  if (contentType.includes("json")) {
    return "json-plain";
  }
  if (contentType.includes("xml")) {
    return "xml-plain";
  }
  return "text-plain";
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
