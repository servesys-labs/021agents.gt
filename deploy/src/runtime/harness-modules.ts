/**
 * Harness Helpers — custom ES modules injected into codemode sandboxes.
 *
 * These modules are available to LLM-generated code running in V8 isolates
 * via the DynamicWorkerExecutor `modules` option (v0.2.1+).
 *
 * Usage inside sandbox:
 *   import { gitCommit, lintFile, refineSearch } from "harness";
 *
 * The helpers call back to the host worker's tools via the codemode.* RPC
 * bridge, so they have the same permissions as the executing scope.
 */

// ── Module source code (string) injected into every sandbox ──────

/**
 * The harness module provides high-level abstractions over the raw tools,
 * implementing the SWE-agent ACI patterns as composable functions.
 */
export const HARNESS_MODULE_SOURCE = `
// ── Git Helpers ─────────────────────────────────────────────────

/**
 * Initialize a git repo, make an initial commit, and return status.
 * Handles the common "start a project from scratch" pattern.
 */
export async function gitInit(codemode) {
  await codemode.git_init({});
  return await codemode.git_status({});
}

/**
 * Stage all changes, commit with message, and return the log.
 * The standard "checkpoint my work" operation.
 */
export async function gitCheckpoint(codemode, message) {
  const status = await codemode.git_status({});
  if (status.includes("nothing to commit")) return "Nothing to commit";
  await codemode.git_commit({ message });
  return await codemode.git_log({ count: 3 });
}

/**
 * Safe edit: commit before editing, edit, lint, rollback if lint fails.
 * Implements the "edit with safety net" pattern from harness engineering.
 */
export async function safeEdit(codemode, path, oldText, newText) {
  // Checkpoint current state
  await codemode.git_commit({ message: "pre-edit checkpoint" }).catch(() => {});

  // Attempt the edit (lint-on-edit will reject bad syntax)
  const result = await codemode.edit_file({ path, old_text: oldText, new_text: newText });

  if (result.includes("REJECTED")) {
    // Lint failed — the edit was NOT applied, so no rollback needed
    return { success: false, error: result };
  }

  return { success: true, diff: result };
}

// ── Search Helpers ──────────────────────────────────────────────

/**
 * Progressive search: try specific first, broaden if no results.
 * Implements the "refine before flooding" pattern.
 */
export async function findDefinition(codemode, name) {
  // Try exact definition patterns first
  const patterns = [
    "function " + name,
    "class " + name,
    "const " + name,
    "export .* " + name,
    "def " + name,
  ];

  for (const pattern of patterns) {
    const result = await codemode.grep({ pattern, max_results: 5 });
    if (result && !result.includes("No matches")) {
      return result;
    }
  }

  // Fallback to name search
  return await codemode.grep({ pattern: name, max_results: 10 });
}

/**
 * Navigate to a symbol in a file: find it, then view with context.
 * Combines search + stateful viewing.
 */
export async function navigateTo(codemode, path, symbol) {
  const search = await codemode.search_file({ path, term: symbol });
  if (!search || search.includes("No matches")) {
    return { found: false, content: "Symbol not found in " + path };
  }

  // Extract first matching line number
  const lineMatch = search.match(/^(\\d+):/m);
  const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

  const view = await codemode.view_file({ path, line, window: 50 });
  return { found: true, line, content: view };
}

// ── File Workflow Helpers ───────────────────────────────────────

/**
 * Read a file with automatic pagination for large files.
 * Returns the full content for small files, first page + metadata for large ones.
 */
export async function smartRead(codemode, path) {
  const firstPage = await codemode.read_file({ path, offset: 1, limit: 100 });
  const totalMatch = firstPage.match(/of (\\d+) total/);
  const totalLines = totalMatch ? parseInt(totalMatch[1], 10) : 0;

  if (totalLines <= 100) {
    return { content: firstPage, totalLines, complete: true };
  }

  return {
    content: firstPage,
    totalLines,
    complete: false,
    hint: "File has " + totalLines + " lines. Use view_file with line number to navigate.",
  };
}

/**
 * Create or overwrite a file with git tracking.
 * Writes the file, syncs to R2, and optionally commits.
 */
export async function writeAndTrack(codemode, path, content, commitMessage) {
  await codemode.write_file({ path, content });
  if (commitMessage) {
    await codemode.git_commit({ message: commitMessage }).catch(() => {});
  }
  return "Written " + content.length + " bytes to " + path;
}

// ── Multi-Step Workflow Helpers ─────────────────────────────────

/**
 * Implement a feature: find relevant code, edit it, lint, commit.
 * High-level workflow that chains multiple tools.
 */
export async function editWorkflow(codemode, steps) {
  const results = [];

  for (const step of steps) {
    if (step.type === "find") {
      const found = await findDefinition(codemode, step.name);
      results.push({ step: "find", result: found });
    } else if (step.type === "edit") {
      const edited = await safeEdit(codemode, step.path, step.old_text, step.new_text);
      results.push({ step: "edit", result: edited });
      if (!edited.success) break; // Stop on first failed edit
    } else if (step.type === "commit") {
      const committed = await gitCheckpoint(codemode, step.message);
      results.push({ step: "commit", result: committed });
    } else if (step.type === "verify") {
      const output = await codemode.bash({ command: step.command, timeout_seconds: 30 });
      results.push({ step: "verify", result: output });
    }
  }

  return results;
}
`;

/**
 * Build the modules record for DynamicWorkerExecutor.
 * Includes the harness module and any additional custom modules.
 */
export function buildSandboxModules(
  customModules?: Record<string, string>,
): Record<string, string> {
  return {
    "harness.js": HARNESS_MODULE_SOURCE,
    ...customModules,
  };
}

/**
 * Type definitions for the harness module (injected into codemode description).
 * The LLM sees these types so it knows what helpers are available.
 */
export const HARNESS_TYPE_DEFS = `
// Available via: import { ... } from "harness.js"
declare module "harness.js" {
  /** Initialize git repo and return status. */
  export function gitInit(codemode: any): Promise<string>;
  /** Stage all + commit + return recent log. */
  export function gitCheckpoint(codemode: any, message: string): Promise<string>;
  /** Edit with lint safety net. Rolls back if syntax breaks. */
  export function safeEdit(codemode: any, path: string, oldText: string, newText: string): Promise<{success: boolean; diff?: string; error?: string}>;
  /** Find a function/class/const definition by name. */
  export function findDefinition(codemode: any, name: string): Promise<string>;
  /** Find a symbol in a file and view surrounding context. */
  export function navigateTo(codemode: any, path: string, symbol: string): Promise<{found: boolean; line?: number; content: string}>;
  /** Read file with auto-pagination info. */
  export function smartRead(codemode: any, path: string): Promise<{content: string; totalLines: number; complete: boolean; hint?: string}>;
  /** Write file and optionally commit. */
  export function writeAndTrack(codemode: any, path: string, content: string, commitMessage?: string): Promise<string>;
  /** Run a multi-step edit workflow (find → edit → commit → verify). */
  export function editWorkflow(codemode: any, steps: Array<{type: string; [key: string]: any}>): Promise<Array<{step: string; result: any}>>;
}
`;
