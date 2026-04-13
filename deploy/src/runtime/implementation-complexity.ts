import type { ImplementationComplexityMetrics, ToolResult } from "./types";

export const TRACKED_IMPLEMENTATION_TOOLS = ["write-file", "edit-file"] as const;

const UNTRACKED_MUTATION_TOOLS = new Set([
  "bash",
  "python-exec",
  "sandbox-exec",
  "dynamic-exec",
]);

function splitContentLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized === "") return [];
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed === "" ? [""] : trimmed.split("\n");
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Uint32Array(b.length + 1);
  const curr = new Uint32Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
    curr.fill(0);
  }

  return prev[b.length];
}

export function diffLineCounts(before: string, after: string): { lines_added: number; lines_removed: number } {
  const beforeLines = splitContentLines(before);
  const afterLines = splitContentLines(after);

  let prefix = 0;
  const minLength = Math.min(beforeLines.length, afterLines.length);
  while (prefix < minLength && beforeLines[prefix] === afterLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);
  const shared = longestCommonSubsequenceLength(beforeMiddle, afterMiddle);

  return {
    lines_added: afterMiddle.length - shared,
    lines_removed: beforeMiddle.length - shared,
  };
}

export function summarizeImplementationComplexity(
  toolResults: Array<Pick<ToolResult, "tool" | "error" | "file_mutation">>,
): ImplementationComplexityMetrics {
  const touchedPaths = new Set<string>();
  const createdPaths = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let possibleUntrackedMutations = false;

  for (const result of toolResults) {
    if (UNTRACKED_MUTATION_TOOLS.has(result.tool)) {
      possibleUntrackedMutations = true;
    }

    if (result.error || !result.file_mutation) continue;

    const mutation = result.file_mutation;
    if (!mutation.path.startsWith("/workspace/")) continue;

    touchedPaths.add(mutation.path);
    if (!mutation.existed_before) {
      createdPaths.add(mutation.path);
    }

    const diff = diffLineCounts(mutation.before_content, mutation.after_content);
    linesAdded += diff.lines_added;
    linesRemoved += diff.lines_removed;
  }

  return {
    files_touched: touchedPaths.size,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    new_files_created: createdPaths.size,
    measurement_scope: "tracked_file_tools_only",
    tracked_tools: [...TRACKED_IMPLEMENTATION_TOOLS],
    possible_untracked_mutations: possibleUntrackedMutations,
  };
}
