/**
 * Per-tool summary extraction for inline tool call display.
 * Pure functions — no Svelte dependencies.
 */

export interface ToolSummary {
  /** Shown while the tool is still executing */
  pending: string;
  /** Shown after tool completes (success or error) */
  completed: string;
}

type SummaryExtractor = (
  args: Record<string, unknown>,
  result: string | undefined,
  error: string | undefined,
) => ToolSummary;

// ── Helpers ──────────────────────────────────────────────────

function tryParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function truncate(s: string, max = 40): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorFirstLine(error: string): string {
  const first = error.split("\n")[0] || error;
  return truncate(first, 60);
}

function countJsonArray(result: string | undefined): number | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

// ── Per-tool extractors ──────────────────────────────────────

const extractors: Record<string, SummaryExtractor> = {
  "web-search": (args, result, error) => {
    const q = truncate(String(args.query || args.q || ""), 50);
    if (error) return { pending: `searching "${q}"`, completed: `error: ${errorFirstLine(error)}` };
    if (!result) return { pending: `searching "${q}"`, completed: `searching "${q}"` };
    const matches = result.match(/\[\d+\]/g);
    const count = matches ? matches.length : 0;
    return { pending: `searching "${q}"`, completed: count > 0 ? `${count} results for "${q}"` : `results for "${q}"` };
  },

  "parallel-web-search": (args, result, error) => {
    const queries = Array.isArray(args.queries) ? args.queries.length : 0;
    const label = queries > 0 ? `${queries} queries` : "queries";
    if (error) return { pending: `searching ${label}...`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `searching ${label}...`, completed: result ? `${label} completed` : `searching ${label}...` };
  },

  browse: (args, _result, error) => {
    const url = truncate(String(args.url || ""), 50);
    if (error) return { pending: `loading ${url}`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `loading ${url}`, completed: `loaded ${url}` };
  },

  "browser-render": (args, _result, error) => {
    const url = truncate(String(args.url || ""), 50);
    if (error) return { pending: `rendering ${url}`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `rendering ${url}`, completed: `rendered ${url}` };
  },

  "http-request": (args, result, error) => {
    const method = String(args.method || "GET").toUpperCase();
    const url = truncate(String(args.url || ""), 40);
    if (error) return { pending: `${method} ${url}`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `${method} ${url}`, completed: `${method} ${url} done` };
  },

  "python-exec": (_args, result, error) => {
    if (error) return { pending: "running python\u2026", completed: `exit 1: ${errorFirstLine(error)}` };
    return { pending: "running python\u2026", completed: result ? "exit 0" : "running\u2026" };
  },

  bash: (args, result, error) => {
    const cmd = truncate(String(args.command || args.cmd || ""), 50);
    const pending = cmd ? `$ ${cmd}` : "running command\u2026";
    if (error) return { pending, completed: `exit 1: ${errorFirstLine(error)}` };
    return { pending, completed: result ? "exit 0" : "running\u2026" };
  },

  "memory-save": (args, _result, error) => {
    const key = truncate(String(args.key || args.name || ""), 40);
    const scope = String(args.scope || args.memory_type || "");
    if (error) return { pending: `saving "${key}"`, completed: `error: ${errorFirstLine(error)}` };
    const suffix = scope ? ` (${scope})` : "";
    return { pending: `saving "${key}"`, completed: `saved "${key}"${suffix}` };
  },

  "memory-recall": (args, result, error) => {
    const q = truncate(String(args.query || args.key || ""), 40);
    if (error) return { pending: `recalling "${q}"`, completed: `error: ${errorFirstLine(error)}` };
    if (!result) return { pending: `recalling "${q}"`, completed: `recalling "${q}"` };
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        const n = parsed.length;
        return { pending: `recalling "${q}"`, completed: n === 0 ? "no facts found" : `${n} fact${n > 1 ? "s" : ""} found` };
      }
    } catch { /* not JSON array */ }
    return { pending: `recalling "${q}"`, completed: "facts found" };
  },

  "memory-delete": (args, _result, error) => {
    const key = truncate(String(args.key || args.id || ""), 40);
    if (error) return { pending: `deleting "${key}"`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `deleting "${key}"`, completed: `deleted "${key}"` };
  },

  "read-file": (args, result, error) => {
    const path = String(args.path || args.file || "");
    const name = basename(path);
    if (error) return { pending: `reading ${name}`, completed: `error: ${errorFirstLine(error)}` };
    const lines = result ? countLines(result) : 0;
    return { pending: `reading ${name}`, completed: lines > 0 ? `read ${lines} lines` : `read ${name}` };
  },

  "write-file": (args, _result, error) => {
    const path = String(args.path || args.file || "");
    const name = basename(path);
    const content = String(args.content || "");
    const size = formatBytes(new TextEncoder().encode(content).length);
    if (error) return { pending: `writing ${name}`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `writing ${name}`, completed: `wrote ${size} to ${name}` };
  },

  "edit-file": (args, result, error) => {
    const path = String(args.path || args.file || "");
    const name = basename(path);
    if (error) return { pending: `editing ${name}`, completed: `error: ${errorFirstLine(error)}` };
    const patch = String(args.patch || result || "");
    // Match lines starting with +/- but exclude unified diff headers (+++ / ---)
    const added = (patch.match(/^\+(?!\+\+)/gm) || []).length;
    const deleted = (patch.match(/^-(?!--)/gm) || []).length;
    if (added || deleted) {
      return { pending: `editing ${name}`, completed: `+${added} -${deleted} in ${name}` };
    }
    return { pending: `editing ${name}`, completed: `edited ${name}` };
  },

  "execute-code": (args, result, error) => {
    const lang = String(args.language || args.lang || "code");
    if (error) return { pending: `executing ${lang}\u2026`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `executing ${lang}\u2026`, completed: result ? "completed" : "executing\u2026" };
  },

  grep: (args, result, error) => {
    const pattern = truncate(String(args.pattern || args.query || ""), 40);
    if (error) return { pending: `grep "${pattern}"`, completed: `error: ${errorFirstLine(error)}` };
    const n = result ? countLines(result) : 0;
    return { pending: `grep "${pattern}"`, completed: n > 0 ? `${n} matches` : "no matches" };
  },

  glob: (args, result, error) => {
    const pattern = truncate(String(args.pattern || args.glob || ""), 40);
    if (error) return { pending: `glob ${pattern}`, completed: `error: ${errorFirstLine(error)}` };
    const n = result ? countLines(result.trim()) : 0;
    return { pending: `glob ${pattern}`, completed: n > 0 ? `${n} files` : "no files" };
  },

  sql: (args, result, error) => {
    const query = truncate(String(args.query || args.sql || ""), 50);
    if (error) return { pending: `querying\u2026`, completed: `error: ${errorFirstLine(error)}` };
    const rows = countJsonArray(result);
    return { pending: `querying\u2026`, completed: rows !== null ? `${rows} row${rows !== 1 ? "s" : ""}` : "query completed" };
  },

  codemode: (args, _result, error) => {
    const scope = truncate(String(args.scope || args.mode || ""), 30);
    if (error) return { pending: `codemode ${scope}\u2026`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `codemode ${scope}\u2026`, completed: `codemode ${scope} done` };
  },

  "run-codemode": (args, _result, error) => {
    const scope = truncate(String(args.scope || args.mode || ""), 30);
    if (error) return { pending: `codemode ${scope}\u2026`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `codemode ${scope}\u2026`, completed: `codemode ${scope} done` };
  },

  "vision-analyze": (args, _result, error) => {
    if (error) return { pending: "analyzing image\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "analyzing image\u2026", completed: "analysis complete" };
  },

  "mcp-call": (args, _result, error) => {
    const tool = truncate(String(args.tool || args.name || "mcp"), 30);
    if (error) return { pending: `mcp: ${tool}\u2026`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `mcp: ${tool}\u2026`, completed: `mcp: ${tool} done` };
  },

  "text-to-speech": (args, _result, error) => {
    if (error) return { pending: "generating speech\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "generating speech\u2026", completed: "audio generated" };
  },

  "speech-to-text": (args, _result, error) => {
    if (error) return { pending: "transcribing\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "transcribing\u2026", completed: "transcription complete" };
  },

  autoresearch: (args, result, error) => {
    const q = truncate(String(args.query || args.topic || ""), 40);
    if (error) return { pending: `researching "${q}"\u2026`, completed: `error: ${errorFirstLine(error)}` };
    return { pending: `researching "${q}"\u2026`, completed: result ? "research complete" : `researching "${q}"\u2026` };
  },

  swarm: (args, result, error) => {
    const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
    const taskLabel = tasks > 0 ? `${tasks} tasks` : "tasks";
    if (error) return { pending: `running ${taskLabel}\u2026`, completed: `error: ${errorFirstLine(error)}` };
    if (!result) return { pending: `running ${taskLabel}\u2026`, completed: `running ${taskLabel}\u2026` };
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        const passed = parsed.filter((r: any) => r.status === "success" || r.success).length;
        const failed = parsed.length - passed;
        if (failed > 0) return { pending: `running ${taskLabel}\u2026`, completed: `${passed}/${parsed.length} passed, ${failed} failed` };
        return { pending: `running ${taskLabel}\u2026`, completed: `${passed}/${parsed.length} passed` };
      }
    } catch { /* not JSON */ }
    return { pending: `running ${taskLabel}\u2026`, completed: `${taskLabel} completed` };
  },

  "knowledge-search": (_args, result, error) => {
    if (error) return { pending: "searching knowledge base\u2026", completed: `error: ${errorFirstLine(error)}` };
    if (!result) return { pending: "searching knowledge base\u2026", completed: "searching\u2026" };
    const n = countJsonArray(result);
    return { pending: "searching knowledge base\u2026", completed: n !== null ? `${n} chunks found` : "results found" };
  },

  "run-agent": (args, _result, error) => {
    const name = String(args.agent_name || args.name || "agent");
    if (error) return { pending: `delegating to ${name}\u2026`, completed: `${name} failed: ${errorFirstLine(error)}` };
    return { pending: `delegating to ${name}\u2026`, completed: `${name} completed` };
  },

  "create-schedule": (args, _result, error) => {
    const cron = String(args.cron || args.schedule || "");
    if (error) return { pending: "creating schedule\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "creating schedule\u2026", completed: cron ? `scheduled: ${cron}` : "scheduled" };
  },

  "web-crawl": (args, result, error) => {
    const url = truncate(String(args.url || ""), 50);
    if (error) return { pending: `crawling ${url}\u2026`, completed: `error: ${errorFirstLine(error)}` };
    if (!result) return { pending: `crawling ${url}\u2026`, completed: "crawling\u2026" };
    try {
      const parsed = JSON.parse(result);
      const pages = Array.isArray(parsed) ? parsed.length : (parsed.pages || 0);
      return { pending: `crawling ${url}\u2026`, completed: `crawled ${pages} pages` };
    } catch {
      return { pending: `crawling ${url}\u2026`, completed: `crawled ${url}` };
    }
  },

  "image-generate": (_args, _result, error) => {
    if (error) return { pending: "generating image\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "generating image\u2026", completed: "image generated" };
  },

  "git-commit": (args, _result, error) => {
    const msg = truncate(String(args.message || ""), 40);
    if (error) return { pending: "committing\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "committing\u2026", completed: msg ? `committed: ${msg}` : "committed" };
  },

  "git-status": (_args, _result, error) => {
    if (error) return { pending: "git status\u2026", completed: `error: ${errorFirstLine(error)}` };
    return { pending: "git status\u2026", completed: "status checked" };
  },

  "git-diff": (_args, result, error) => {
    if (error) return { pending: "git diff\u2026", completed: `error: ${errorFirstLine(error)}` };
    const lines = result ? countLines(result) : 0;
    return { pending: "git diff\u2026", completed: lines > 0 ? `${lines} lines changed` : "no changes" };
  },
};

// ── Public API ───────────────────────────────────────────────

export function getToolSummary(
  name: string,
  rawArgs: string,
  result: string | undefined,
  error: string | undefined,
): ToolSummary {
  const args = tryParseArgs(rawArgs);
  const extractor = extractors[name];

  if (extractor) {
    return extractor(args, result, error);
  }

  // Default fallback
  if (error) {
    return { pending: `${name} executing\u2026`, completed: `error: ${errorFirstLine(error)}` };
  }
  return {
    pending: `${name} executing\u2026`,
    completed: result ? `${name} completed` : `${name} executing\u2026`,
  };
}
