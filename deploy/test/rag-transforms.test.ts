/**
 * Tests for RAG pipeline transforms: smart chunking, validation,
 * query rewriting, and deduplication.
 */
import { describe, it, expect } from "vitest";

import {
  smartChunk,
  validateChunk,
  rewriteQuery,
  dedupResults,
} from "../src/runtime/rag-transforms";

// ── Smart Chunker ─────────────────────────────────────────────────

describe("smartChunk", () => {
  it("returns single chunk for short text", () => {
    const chunks = smartChunk("Hello world, this is a short document.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Hello world");
    expect(chunks[0].type).toBe("prose");
  });

  it("splits on markdown headers", () => {
    const text = [
      "# Introduction",
      "This is the intro paragraph with enough detail to be a real meaningful chunk on its own.",
      "",
      "# Architecture",
      "This describes the system architecture in detail with enough words to stand alone as a chunk.",
      "",
      "# Pricing",
      "Here are the pricing tiers for the product with enough content to be a standalone chunk.",
    ].join("\n");
    const chunks = smartChunk(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].text).toContain("Introduction");
  });

  it("keeps tables intact as single chunks", () => {
    const text = [
      "Some intro text.",
      "",
      "<table><tr><th>Name</th><th>Price</th></tr>",
      "<tr><td>Widget</td><td>$10</td></tr>",
      "<tr><td>Gadget</td><td>$20</td></tr></table>",
      "",
      "Some conclusion text.",
    ].join("\n");
    const chunks = smartChunk(text);
    const tableChunk = chunks.find(c => c.type === "table");
    expect(tableChunk).toBeDefined();
    expect(tableChunk!.text).toContain("<table>");
    expect(tableChunk!.text).toContain("</table>");
  });

  it("detects code blocks", () => {
    const text = "```python\ndef hello():\n    print('hi')\n```";
    const chunks = smartChunk(text);
    expect(chunks[0].type).toBe("code");
  });

  it("detects lists", () => {
    const text = "- Item one\n- Item two\n- Item three";
    const chunks = smartChunk(text);
    expect(chunks[0].type).toBe("list");
  });

  it("handles empty input", () => {
    expect(smartChunk("")).toHaveLength(0);
    expect(smartChunk("   ")).toHaveLength(0);
  });

  it("sub-chunks large sections by paragraphs", () => {
    // Create text with 5000+ characters in a single section
    const para = "This is a moderately long paragraph that contains enough words to contribute meaningful content. ";
    const text = para.repeat(50); // ~5000 chars
    const chunks = smartChunk(text, { maxChunkChars: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1200); // Some tolerance for overlap
    }
  });

  it("respects maxChunkChars option", () => {
    const text = "This is a meaningful sentence with several words. ".repeat(100); // ~5000 chars
    const chunks = smartChunk(text, { maxChunkChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("filters out tiny fragments", () => {
    const text = "# Title\n\nA.\n\n# Content\nReal content with enough text to be meaningful.";
    const chunks = smartChunk(text);
    // "A." is too short (< 20 chars) and should be filtered
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("preserves page breaks as section boundaries", () => {
    const text = "Page 1 has enough content to be a real chunk with details.\n---\nPage 2 also has enough content to stand on its own as a chunk.";
    const chunks = smartChunk(text);
    expect(chunks.length).toBe(2);
  });
});

// ── Ingestion Validator ───────────────────────────────────────────

describe("validateChunk", () => {
  it("accepts normal readable text", () => {
    const result = validateChunk("AgentOS is an AI agent platform for building and deploying agents at scale.");
    expect(result.valid).toBe(true);
    expect(result.quality).toBeGreaterThan(0.5);
  });

  it("rejects binary content", () => {
    // Create content with enough non-printable bytes to trigger binary detection
    const binary = String.fromCharCode(0, 1, 2, 3, 4, 5, 137, 80, 78, 71, 13, 10, 26, 10) +
      String.fromCharCode(...Array.from({ length: 200 }, () => Math.floor(Math.random() * 30)));
    const result = validateChunk(binary);
    expect(result.valid).toBe(false);
    // Either binary_content or low_information_density — both correctly reject
    expect(["binary_content", "low_information_density"]).toContain(result.reason);
  });

  it("rejects raw PDF markers", () => {
    const pdfBytes = "endstream\nendobj\n1 0 obj\n<</Type /Pages\n/Kids [3 0 R 5 0 R]";
    const result = validateChunk(pdfBytes);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("pdf_raw_bytes");
  });

  it("rejects text that is too short", () => {
    const result = validateChunk("hi");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("too_short");
  });

  it("rejects low information density (repeated words)", () => {
    const repetitive = "the the the the the the the the the the the the the the the the the the the the the";
    const result = validateChunk(repetitive);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("low_information_density");
  });

  it("detects duplicate chunks via hash set", () => {
    const seenHashes = new Set<string>();
    const text = "This is a unique piece of content about AI agents.";
    const r1 = validateChunk(text, seenHashes);
    expect(r1.valid).toBe(true);

    const r2 = validateChunk(text, seenHashes);
    expect(r2.valid).toBe(false);
    expect(r2.reason).toBe("duplicate");
  });

  it("allows similar but not identical chunks", () => {
    const seenHashes = new Set<string>();
    validateChunk("AgentOS uses Cloudflare Workers for edge execution.", seenHashes);
    const r2 = validateChunk("AgentOS uses Cloudflare Workers for edge execution and Durable Objects for state.", seenHashes);
    expect(r2.valid).toBe(true); // Different enough
  });
});

// ── Query Rewriter ────────────────────────────────────────────────

describe("rewriteQuery", () => {
  it("expands ARR abbreviation", () => {
    const result = rewriteQuery("Q2 ARR target");
    expect(result).toContain("annual recurring revenue");
    expect(result).toContain("ARR");
  });

  it("expands multiple abbreviations", () => {
    const result = rewriteQuery("LTV to CAC ratio");
    expect(result).toContain("lifetime value");
    expect(result).toContain("customer acquisition cost");
  });

  it("leaves non-abbreviated queries unchanged", () => {
    const query = "What is the pricing for the standard plan?";
    expect(rewriteQuery(query)).toBe(query);
  });

  it("expands short queries with context", () => {
    const result = rewriteQuery("pricing", { recentTopics: ["agent platform", "Q2 planning"] });
    expect(result).toContain("agent platform");
  });

  it("handles empty query", () => {
    expect(rewriteQuery("")).toBe("");
  });
});

// ── Post-Retrieval Deduplication ──────────────────────────────────

describe("dedupResults", () => {
  it("removes near-identical results", () => {
    const results = [
      { id: "a", score: 0.9, text: "AgentOS platform runs on Cloudflare Workers with Durable Objects for state management", source: "doc1" },
      { id: "b", score: 0.85, text: "AgentOS platform runs on Cloudflare Workers with Durable Objects for state", source: "doc2" },
      { id: "c", score: 0.7, text: "The pricing tiers include free basic standard and premium plans", source: "doc3" },
    ];
    const deduped = dedupResults(results);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].id).toBe("a"); // Higher score kept
    expect(deduped[1].id).toBe("c"); // Different content kept
  });

  it("keeps all results when they are distinct", () => {
    const results = [
      { id: "a", score: 0.9, text: "Machine learning algorithms for natural language processing", source: "s1" },
      { id: "b", score: 0.8, text: "Cloudflare Workers run on the edge with V8 isolates", source: "s2" },
      { id: "c", score: 0.7, text: "Database connection pooling via Hyperdrive", source: "s3" },
    ];
    const deduped = dedupResults(results);
    expect(deduped).toHaveLength(3);
  });

  it("handles single result", () => {
    const results = [{ id: "a", score: 0.9, text: "Only one result", source: "s1" }];
    expect(dedupResults(results)).toHaveLength(1);
  });

  it("handles empty results", () => {
    expect(dedupResults([])).toHaveLength(0);
  });

  it("respects custom similarity threshold", () => {
    const results = [
      { id: "a", score: 0.9, text: "word1 word2 word3 word4 word5", source: "s1" },
      { id: "b", score: 0.8, text: "word1 word2 word3 word4 word6", source: "s2" },
    ];
    // With high threshold (0.9), these are not similar enough to dedup
    const strict = dedupResults(results, { similarityThreshold: 0.9 });
    expect(strict).toHaveLength(2);

    // With low threshold (0.5), they are similar enough
    const loose = dedupResults(results, { similarityThreshold: 0.5 });
    expect(loose).toHaveLength(1);
  });

  it("enforces source diversity (maxPerSource)", () => {
    const results = [
      { id: "a1", score: 0.95, text: "Document A first chunk about topic alpha", source: "doc-a" },
      { id: "a2", score: 0.90, text: "Document A second chunk about topic beta", source: "doc-a" },
      { id: "a3", score: 0.85, text: "Document A third chunk about topic gamma", source: "doc-a" },
      { id: "a4", score: 0.80, text: "Document A fourth chunk about topic delta", source: "doc-a" },
      { id: "b1", score: 0.75, text: "Document B completely different content about epsilon", source: "doc-b" },
    ];
    const deduped = dedupResults(results, { maxPerSource: 2 });
    const sourceA = deduped.filter(r => r.source === "doc-a");
    const sourceB = deduped.filter(r => r.source === "doc-b");
    expect(sourceA).toHaveLength(2); // Capped at 2
    expect(sourceB).toHaveLength(1); // Different source, kept
  });

  it("deduplicates table chunks with same HTML headers (structural dedup)", () => {
    const header = "<thead><tr><th>Unit</th><th>Rent</th><th>Tenant</th></tr></thead>";
    const results = [
      { id: "t1", score: 0.9, text: `<table>${header}<tbody><tr><td>101</td><td>750</td><td>Alice</td></tr></tbody></table>`, source: "rentroll" },
      { id: "t2", score: 0.85, text: `<table>${header}<tbody><tr><td>102</td><td>800</td><td>Bob</td></tr></tbody></table>`, source: "rentroll" },
      { id: "t3", score: 0.80, text: `<table>${header}<tbody><tr><td>103</td><td>900</td><td>Carol</td></tr></tbody></table>`, source: "rentroll" },
      { id: "o1", score: 0.70, text: "This property offers a value-add opportunity with projected NOI increase of 19%.", source: "offering-memo" },
    ];
    const deduped = dedupResults(results, { maxPerSource: 3 });
    // Structural dedup should catch the identical table headers
    const rentroll = deduped.filter(r => r.source === "rentroll");
    expect(rentroll.length).toBeLessThanOrEqual(1); // Same header = structural dupe
    // The offering memo should survive
    const memo = deduped.filter(r => r.source === "offering-memo");
    expect(memo).toHaveLength(1);
  });
});

// ── Table Consolidation at Ingest ─────────────────────────────────

describe("smartChunk — table consolidation", () => {
  it("consolidates repeated table chunks with same headers into fewer chunks", () => {
    // Simulate a 5-page rent roll where each page has the same table header
    const header = "<thead><tr><th>Unit</th><th>Type</th><th>Rent</th><th>Tenant</th></tr></thead>";
    const pages: string[] = [];
    for (let p = 0; p < 5; p++) {
      let rows = "";
      for (let r = 0; r < 10; r++) {
        rows += `<tr><td>${100 + p * 10 + r}</td><td>1BR</td><td>${700 + r * 10}</td><td>Tenant${p * 10 + r}</td></tr>`;
      }
      pages.push(`<table>${header}<tbody>${rows}</tbody></table>`);
    }
    const text = pages.join("\n\n");

    // Without consolidation, naive chunking would produce 5 table chunks
    // With consolidation, same-header tables should be merged
    const chunks = smartChunk(text, { maxChunkChars: 5000 });
    const tableChunks = chunks.filter(c => c.type === "table");
    // Should be fewer than 5 — ideally 1-2 merged chunks
    expect(tableChunks.length).toBeLessThan(5);
    // But all data should still be present
    const allText = tableChunks.map(c => c.text).join(" ");
    expect(allText).toContain("100"); // First unit
    expect(allText).toContain("149"); // Last unit
  });
});

// ── Integration: Full Pipeline Simulation ─────────────────────────

describe("full RAG pipeline simulation", () => {
  it("chunk → validate → deduplicate end-to-end", () => {
    const document = [
      "# AgentOS Overview",
      "AgentOS is an AI agent control plane for building, testing, governing, deploying, and observing AI agents at scale.",
      "",
      "# Architecture",
      "The platform runs on Cloudflare Workers with Durable Objects for stateful session management and workflow orchestration.",
      "LLM inference is self-hosted on dual RTX PRO 6000 Blackwell GPUs providing zero-cost inference at 155 tokens per second.",
      "",
      "# Pricing",
      "| Plan | Price | Features |",
      "| Free | $0/mo | Gemma 4 MoE, 50 sessions per day, 5 tools |",
      "| Standard | $99/mo | Claude Sonnet and GPT-5.4, unlimited sessions, priority support |",
    ].join("\n");

    // Chunk
    const chunks = smartChunk(document);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Validate
    const seenHashes = new Set<string>();
    const valid = chunks.filter(c => validateChunk(c.text, seenHashes).valid);
    expect(valid.length).toBe(chunks.length); // All should be valid

    // Simulate search results from these chunks
    const searchResults = valid.map((c, i) => ({
      id: `chunk-${i}`,
      score: 0.9 - i * 0.05,
      text: c.text,
      source: "agentos-overview",
    }));

    // Dedup
    const deduped = dedupResults(searchResults);
    expect(deduped.length).toBeGreaterThanOrEqual(1);
    expect(deduped.length).toBeLessThanOrEqual(searchResults.length);
  });

  it("rejects binary PDF then accepts clean OCR output", () => {
    const binaryPdf = "%PDF-1.4\n1 0 obj\n<</Type /Catalog>>\nendobj\nstream\n\x00\x01\x02\x03";
    const cleanOcr = "Invoice #12345\nOneShots Inc.\nAI Agent Platform - Standard Plan: $2,400.00\nTotal: $5,274.38";

    const binaryResult = validateChunk(binaryPdf);
    expect(binaryResult.valid).toBe(false);

    const cleanResult = validateChunk(cleanOcr);
    expect(cleanResult.valid).toBe(true);
    expect(cleanResult.quality).toBeGreaterThan(0.5);
  });
});
