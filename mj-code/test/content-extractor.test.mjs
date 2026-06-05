import test from "node:test";
import assert from "node:assert/strict";

import { extractContentFromDocument } from "../src/lib/content-extractor.mjs";

test("content extractor handles html metadata headings and canonical urls", () => {
  const extracted = extractContentFromDocument({
    url: "https://docs.example.com/reference/page",
    contentType: "text/html",
    body: `
      <html>
        <head>
          <title>Responses API Docs</title>
          <link rel="canonical" href="https://docs.example.com/reference/page" />
          <meta name="description" content="Official docs page" />
          <meta name="author" content="MJ Code" />
          <meta property="article:published_time" content="2026-04-01T00:00:00.000Z" />
        </head>
        <body>
          <h1>Responses API</h1>
          <h2>Streaming</h2>
          <p>The responses API supports streaming output.</p>
        </body>
      </html>
    `,
    maxChars: 4000,
  });

  assert.equal(extracted.title, "Responses API Docs");
  assert.equal(extracted.canonicalUrl, "https://docs.example.com/reference/page");
  assert.equal(extracted.author, "MJ Code");
  assert.equal(extracted.publishedAt, "2026-04-01T00:00:00.000Z");
  assert.deepEqual(extracted.headings, ["Responses API", "Streaming"]);
  assert.equal(extracted.excerpt, "Official docs page");
  assert.equal(extracted.extractionStrategy, "html-basic-readability");
});

test("content extractor handles plain markdown json and xml branches", () => {
  const plain = extractContentFromDocument({
    url: "https://docs.example.com/plain",
    contentType: "text/plain",
    body: "Intro:\nThis is plain text.",
    maxChars: 4000,
  });
  assert.equal(plain.extractionStrategy, "text-plain");
  assert.ok(plain.headings.includes("Intro:"));

  const markdown = extractContentFromDocument({
    url: "https://docs.example.com/markdown",
    contentType: "text/markdown",
    body: "# Intro\n## Setup\nMore details.",
    maxChars: 4000,
  });
  assert.equal(markdown.extractionStrategy, "markdown-plain");
  assert.match(markdown.readableText, /Setup/);

  const json = extractContentFromDocument({
    url: "https://docs.example.com/data.json",
    contentType: "application/json",
    body: "{\"name\":\"mj-code\"}",
    maxChars: 4000,
  });
  assert.equal(json.extractionStrategy, "json-plain");
  assert.equal(json.canonicalUrl, "https://docs.example.com/data.json");

  const xml = extractContentFromDocument({
    url: "https://docs.example.com/feed.xml",
    contentType: "application/xml",
    body: "<root><title>Feed</title></root>",
    maxChars: 4000,
  });
  assert.equal(xml.extractionStrategy, "xml-plain");
});

test("content extractor preserves truncation semantics", () => {
  const extracted = extractContentFromDocument({
    url: "https://docs.example.com/long",
    contentType: "text/plain",
    body: `${"x".repeat(120)}\n${"y".repeat(120)}`,
    maxChars: 60,
  });

  assert.equal(extracted.truncated, true);
  assert.ok(extracted.rawTextLength > 60);
  assert.match(extracted.readableText, /content truncated/);
  assert.match(extracted.excerpt, /^x+/);
});

test("content extractor rejects empty bodies", () => {
  assert.throws(
    () => extractContentFromDocument({
      url: "https://docs.example.com/empty",
      contentType: "text/plain",
      body: "",
    }),
    /Document body is empty/,
  );
});

test("content extractor rejects unsupported content types", () => {
  assert.throws(
    () => extractContentFromDocument({
      url: "https://docs.example.com/file.pdf",
      contentType: "application/pdf",
      body: "%PDF-1.4",
    }),
    /No extraction strategy/,
  );
});
