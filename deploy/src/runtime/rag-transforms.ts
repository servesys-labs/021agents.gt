/**
 * RAG Pipeline Transforms — codemode-powered quality enhancements.
 *
 * These run as pure functions in the Worker (no V8 isolate overhead for the
 * critical path). The codemode integration allows agents to customize these
 * transforms per-org via registered snippets, but the defaults are fast
 * pure-JS implementations that handle 95% of cases.
 *
 * 1. smartChunk()     — structure-aware chunking (headers, tables, code, lists)
 * 2. validateChunks() — reject garbage before embedding (binary, boilerplate, dupes)
 * 3. rewriteQuery()   — expand and improve search queries
 * 4. dedupResults()   — remove near-duplicate search results
 */

// ── 1. Smart Chunker ─────────────────────────────────────────────

export interface ChunkOptions {
  maxChunkChars?: number;   // Default 2000 (~400 words)
  overlapChars?: number;    // Default 200 (~40 words) for context continuity
  respectBoundaries?: boolean; // Default true — split on headers/paragraphs first
}

export interface Chunk {
  text: string;
  index: number;
  /** Where in the original text this chunk starts */
  startOffset: number;
  /** Structural type detected for this chunk */
  type: "prose" | "table" | "code" | "list" | "header_section";
}

/**
 * Structure-aware chunking that keeps semantic units intact.
 *
 * Priority order for split points:
 *   1. Page breaks (--- or \f)
 *   2. Markdown headers (# ## ###)
 *   3. Double newlines (paragraph breaks)
 *   4. List boundaries (numbered/bullet transitions)
 *   5. Sentence boundaries (. ? ! followed by space+uppercase)
 *   6. Word boundaries (last resort)
 */
export function smartChunk(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChunkChars ?? 2000;
  const overlapChars = opts.overlapChars ?? 200;
  const respectBoundaries = opts.respectBoundaries ?? true;

  if (!text.trim()) return [];

  if (!respectBoundaries) {
    if (text.length <= maxChars) {
      return [{ text: text.trim(), index: 0, startOffset: 0, type: detectChunkType(text) }];
    }
    return naiveChunk(text, maxChars, overlapChars);
  }

  // Step 1: Split into structural sections (always split on headers/page breaks)
  const sections = splitIntoSections(text);

  // If no structural boundaries found and text is small, return single chunk
  if (sections.length <= 1 && text.length <= maxChars) {
    return [{ text: text.trim(), index: 0, startOffset: 0, type: detectChunkType(text) }];
  }

  // Step 2: For each section, either keep whole or sub-chunk
  const chunks: Chunk[] = [];
  let globalOffset = 0;

  for (const section of sections) {
    if (section.length <= maxChars) {
      chunks.push({
        text: section.trim(),
        index: chunks.length,
        startOffset: globalOffset,
        type: detectChunkType(section),
      });
    } else {
      // Section too large — sub-chunk by paragraphs, then sentences
      const subChunks = chunkLargeSection(section, maxChars, overlapChars);
      for (const sc of subChunks) {
        chunks.push({
          text: sc.trim(),
          index: chunks.length,
          startOffset: globalOffset + section.indexOf(sc),
          type: detectChunkType(sc),
        });
      }
    }
    globalOffset += section.length;
  }

  // Consolidate structurally-repetitive table chunks.
  // If multiple chunks share the same table header, merge rows into fewer chunks.
  const consolidated = consolidateTableChunks(chunks, maxChars);

  return consolidated.filter(c => c.text.length > 20); // Drop tiny fragments
}

/** Split text into major sections at structural boundaries. */
function splitIntoSections(text: string): string[] {
  // First split on horizontal rules and page breaks
  let parts = text.split(/\n---\n|\n\f\n/);

  // Then split each part on markdown headers (H1-H3)
  const sections: string[] = [];
  for (const part of parts) {
    // Use lookahead to keep the header with its content
    const headerParts = part.split(/\n(?=#{1,3}\s)/);
    sections.push(...headerParts);
  }

  return sections.filter(s => s.trim().length > 0);
}

/** Sub-chunk a large section by paragraphs, then sentences. */
function chunkLargeSection(text: string, maxChars: number, overlapChars: number): string[] {
  // Try paragraph-level splits first
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current += (current ? "\n\n" : "") + para;
    } else {
      if (current) chunks.push(current);
      if (para.length <= maxChars) {
        // Start new chunk with overlap from previous
        const overlap = current.length > overlapChars
          ? current.slice(-overlapChars)
          : "";
        current = overlap ? overlap + "\n\n" + para : para;
      } else {
        // Paragraph itself is too large — split by sentences
        const sentenceChunks = chunkBySentences(para, maxChars, overlapChars);
        chunks.push(...sentenceChunks.slice(0, -1));
        current = sentenceChunks[sentenceChunks.length - 1] || "";
      }
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** Split by sentence boundaries. */
function chunkBySentences(text: string, maxChars: number, overlapChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks: string[] = [];
  let current = "";

  for (const sent of sentences) {
    if (current.length + sent.length <= maxChars) {
      current += sent;
    } else {
      if (current) chunks.push(current.trim());
      current = sent;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Fallback: naive character-based chunking with overlap. */
function naiveChunk(text: string, maxChars: number, overlapChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  const stride = maxChars - overlapChars;
  for (let i = 0; i < text.length; i += stride) {
    const slice = text.slice(i, i + maxChars).trim();
    if (slice.length > 20) {
      chunks.push({ text: slice, index: chunks.length, startOffset: i, type: "prose" });
    }
  }
  return chunks;
}

/**
 * Consolidate table chunks that share the same header structure.
 * Instead of 35 chunks each repeating "<thead>Unit|Type|Rent...</thead>",
 * produce ~5-8 larger chunks with the header once + more data rows each.
 */
function consolidateTableChunks(chunks: Chunk[], maxChars: number): Chunk[] {
  // Group table chunks by their header signature
  const tableGroups = new Map<string, Chunk[]>();
  const nonTableChunks: Chunk[] = [];

  for (const chunk of chunks) {
    if (chunk.type !== "table") {
      nonTableChunks.push(chunk);
      continue;
    }
    const sig = extractTableHeader(chunk.text);
    if (!sig) {
      nonTableChunks.push(chunk);
      continue;
    }
    const group = tableGroups.get(sig) || [];
    group.push(chunk);
    tableGroups.set(sig, group);
  }

  // For each group of same-header tables, merge rows into fewer chunks
  const mergedTables: Chunk[] = [];
  for (const [sig, group] of tableGroups) {
    if (group.length <= 2) {
      // Few enough — keep as-is
      mergedTables.push(...group);
      continue;
    }

    // Extract all data rows from all chunks, combine with header once
    const header = extractTableHeaderHtml(group[0].text);
    const allRows: string[] = [];
    for (const chunk of group) {
      const rows = extractTableBodyRows(chunk.text);
      allRows.push(...rows);
    }

    // Re-chunk the combined rows into groups that fit maxChars
    let currentRows: string[] = [];
    let currentSize = header.length + 50; // overhead for <table>...</table>
    let chunkIdx = 0;

    for (const row of allRows) {
      if (currentSize + row.length > maxChars && currentRows.length > 0) {
        // Emit chunk
        const merged = `<table>${header}<tbody>${currentRows.join("")}</tbody></table>`;
        mergedTables.push({
          text: merged,
          index: 0, // re-indexed later
          startOffset: group[0].startOffset,
          type: "table",
        });
        chunkIdx++;
        currentRows = [];
        currentSize = header.length + 50;
      }
      currentRows.push(row);
      currentSize += row.length;
    }
    if (currentRows.length > 0) {
      const merged = `<table>${header}<tbody>${currentRows.join("")}</tbody></table>`;
      mergedTables.push({
        text: merged,
        index: 0,
        startOffset: group[0].startOffset,
        type: "table",
      });
    }
  }

  // Combine and re-index
  const result = [...nonTableChunks, ...mergedTables];
  result.forEach((c, i) => { c.index = i; });
  return result;
}

/** Extract the <thead>...</thead> content as a key for grouping. */
function extractTableHeader(html: string): string | null {
  const match = html.match(/<thead>(.*?)<\/thead>/s);
  return match ? match[1].replace(/\s+/g, " ").toLowerCase().trim() : null;
}

/** Extract the full <thead>...</thead> tag for re-use. */
function extractTableHeaderHtml(html: string): string {
  const match = html.match(/<thead>.*?<\/thead>/s);
  return match ? match[0] : "";
}

/** Extract all <tr> rows from the <tbody>. */
function extractTableBodyRows(html: string): string[] {
  const bodyMatch = html.match(/<tbody>(.*?)<\/tbody>/s);
  if (!bodyMatch) {
    // No explicit tbody — extract all <tr> that aren't in <thead>
    const withoutHead = html.replace(/<thead>.*?<\/thead>/s, "");
    const rows = withoutHead.match(/<tr>.*?<\/tr>/gs);
    return rows || [];
  }
  const rows = bodyMatch[1].match(/<tr>.*?<\/tr>/gs);
  return rows || [];
}

/** Detect the structural type of a text chunk. */
function detectChunkType(text: string): Chunk["type"] {
  const trimmed = text.trim();
  if (/^#{1,6}\s/.test(trimmed)) return "header_section";
  if (/<table|<tr|<th|<td|\|.*\|.*\|/i.test(trimmed)) return "table";
  if (/^```|^\s{4}\S/m.test(trimmed)) return "code";
  if (/^[\s]*[-*•]\s|^[\s]*\d+[.)]\s/m.test(trimmed)) return "list";
  return "prose";
}

// ── 2. Ingestion Validator ────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /** Quality score 0-1 (1 = high quality text, 0 = garbage) */
  quality: number;
}

/**
 * Validate a chunk before embedding. Rejects:
 * - Binary/non-printable content (raw PDF bytes)
 * - Boilerplate (headers/footers repeated across pages)
 * - Content below minimum information density
 * - Exact duplicates of already-seen content
 */
export function validateChunk(
  text: string,
  seenHashes?: Set<string>,
): ValidationResult {
  if (!text || text.trim().length < 10) {
    return { valid: false, reason: "too_short", quality: 0 };
  }

  // Check printable ratio — catches binary PDF garbage
  const sample = text.slice(0, 500);
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code >= 32 && code < 127) || code === 9 || code === 10 || code === 13 || code > 160) {
      printable++;
    }
  }
  const printableRatio = printable / sample.length;
  if (printableRatio < 0.75) {
    return { valid: false, reason: "binary_content", quality: printableRatio };
  }

  // Check for PDF markers
  if (/endstream|endobj|\/Type\s*\/Font|\/BaseFont|%PDF-|\/MediaBox/i.test(text.slice(0, 200))) {
    return { valid: false, reason: "pdf_raw_bytes", quality: 0.1 };
  }

  // Check information density — reject boilerplate
  const words = text.trim().split(/\s+/);
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const uniqueRatio = uniqueWords.size / Math.max(words.length, 1);
  if (uniqueRatio < 0.15 && words.length > 20) {
    return { valid: false, reason: "low_information_density", quality: uniqueRatio };
  }

  // Check for exact duplicates via hash
  if (seenHashes) {
    const hash = simpleHash(text.trim().toLowerCase());
    if (seenHashes.has(hash)) {
      return { valid: false, reason: "duplicate", quality: 0.5 };
    }
    seenHashes.add(hash);
  }

  // Quality score: weighted combination
  const lengthScore = Math.min(words.length / 50, 1); // Prefer chunks with 50+ words
  const quality = printableRatio * 0.3 + uniqueRatio * 0.4 + lengthScore * 0.3;
  return { valid: true, quality };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ── 3. Query Rewriter ─────────────────────────────────────────────

/**
 * Improve a search query for better retrieval.
 * - Expands common abbreviations
 * - Adds implicit context terms
 * - Handles short/vague queries by expanding
 */
export function rewriteQuery(
  query: string,
  context?: { agentName?: string; recentTopics?: string[] },
): string {
  let expanded = query.trim();
  if (!expanded) return expanded;

  // Expand common abbreviations
  const abbreviations: Record<string, string> = {
    "ARR": "annual recurring revenue ARR",
    "MRR": "monthly recurring revenue MRR",
    "LTV": "lifetime value LTV",
    "CAC": "customer acquisition cost CAC",
    "API": "API application programming interface",
    "SDK": "SDK software development kit",
    "CI/CD": "CI/CD continuous integration deployment",
    "KPI": "KPI key performance indicator",
    "OKR": "OKR objectives key results",
    "ROI": "return on investment ROI",
    "SLA": "service level agreement SLA",
    "P&L": "profit and loss P&L",
    "COGS": "cost of goods sold COGS",
  };

  for (const [abbr, expansion] of Object.entries(abbreviations)) {
    if (expanded.includes(abbr) && !expanded.includes(expansion)) {
      expanded = expanded.replace(new RegExp(`\\b${abbr}\\b`, "g"), expansion);
    }
  }

  // For very short queries (1-2 words), expand with context
  const wordCount = expanded.split(/\s+/).length;
  if (wordCount <= 2 && context?.recentTopics?.length) {
    const topicHint = context.recentTopics.slice(0, 2).join(" ");
    expanded = `${expanded} ${topicHint}`;
  }

  return expanded;
}

// ── 4. Post-Retrieval Deduplication + Source Diversity ─────────────

export interface SearchResult {
  id: string;
  score: number;
  text: string;
  source: string;
  [key: string]: unknown;
}

/**
 * Remove near-duplicate results and enforce source diversity.
 *
 * Three-layer dedup:
 *   1. Structural dedup — chunks with identical table/code headers are near-dupes
 *   2. Word-level Jaccard — catches prose near-dupes (threshold 0.60)
 *   3. Source diversity — cap results per source so one document can't flood
 */
export function dedupResults(
  results: SearchResult[],
  opts: { similarityThreshold?: number; maxPerSource?: number } = {},
): SearchResult[] {
  if (results.length <= 1) return results;

  const threshold = opts.similarityThreshold ?? 0.60;
  const maxPerSource = opts.maxPerSource ?? 3;

  // Layer 1: Structural dedup — detect repeated table/code headers
  const structSigs = results.map(r => extractStructuralSignature(r.text));
  const keep: boolean[] = new Array(results.length).fill(true);
  const seenSigs = new Map<string, number>(); // sig → index of first occurrence

  for (let i = 0; i < results.length; i++) {
    if (!keep[i]) continue;
    const sig = structSigs[i];
    if (sig) {
      const existing = seenSigs.get(sig);
      if (existing !== undefined && existing !== i) {
        // Same structural pattern — keep higher-scored one
        if (results[existing].score >= results[i].score) {
          keep[i] = false;
          continue;
        } else {
          keep[existing] = false;
          seenSigs.set(sig, i);
        }
      } else {
        seenSigs.set(sig, i);
      }
    }
  }

  // Layer 2: Word-level Jaccard dedup on remaining results
  const wordSets = results.map(r =>
    new Set(r.text.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  );

  for (let i = 0; i < results.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < results.length; j++) {
      if (!keep[j]) continue;

      const setA = wordSets[i];
      const setB = wordSets[j];
      let intersection = 0;
      for (const word of setA) {
        if (setB.has(word)) intersection++;
      }
      const union = setA.size + setB.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard >= threshold) {
        if (results[i].score >= results[j].score) {
          keep[j] = false;
        } else {
          keep[i] = false;
          break;
        }
      }
    }
  }

  // Layer 3: Source diversity — cap results per source
  const filtered = results.filter((_, i) => keep[i]);
  const sourceCounts = new Map<string, number>();
  return filtered.filter(r => {
    const count = sourceCounts.get(r.source) || 0;
    if (count >= maxPerSource) return false;
    sourceCounts.set(r.source, count + 1);
    return true;
  });
}

/**
 * Extract a structural signature from a chunk.
 * For tables: the header row (column names).
 * For code blocks: the first line (language marker + function sig).
 * Returns null for prose (no structural pattern to match).
 */
function extractStructuralSignature(text: string): string | null {
  // HTML tables: extract <thead> content as signature
  const theadMatch = text.match(/<thead>(.*?)<\/thead>/s);
  if (theadMatch) {
    // Normalize: strip whitespace, lowercase
    return "table:" + theadMatch[1].replace(/\s+/g, " ").toLowerCase().trim();
  }

  // Markdown tables: extract header row (first row with |)
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|")) {
      // Check if next line is a separator (|---|---|)
      const idx = lines.indexOf(line);
      if (idx + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[idx + 1].trim())) {
        return "mdtable:" + trimmed.toLowerCase();
      }
    }
  }

  // Code blocks: first line
  if (text.trim().startsWith("```")) {
    const firstLine = text.trim().split("\n")[0];
    return "code:" + firstLine.toLowerCase();
  }

  return null;
}
