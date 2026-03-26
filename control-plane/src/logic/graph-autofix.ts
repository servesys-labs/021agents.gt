/**
 * Deterministic graph lint auto-fix helpers for no-code workflows.
 * Ported from agentos/graph/autofix.py.
 */

import type { GraphValidationIssue } from "./graph-validate";
import { lintGraphDesign, lintPayloadFromResult } from "./graph-lint";

function nodeIdFromIssue(iss: GraphValidationIssue): string {
  if (typeof iss.details === "object" && iss.details !== null) {
    const nid = (iss.details as Record<string, unknown>).node_id;
    if (typeof nid === "string" && nid.trim()) return nid.trim();
  }
  const path = iss.path;
  if (typeof path === "string" && path.startsWith("nodes[") && path.endsWith("]")) {
    return path.slice("nodes[".length, -1);
  }
  return "";
}

interface AppliedFix {
  code: string;
  [key: string]: unknown;
}

/**
 * Apply deterministic fixes for known lint issue codes.
 * Returns [fixedGraph, appliedFixes].
 */
export function autofixGraphCommonIssues(
  graph: Record<string, unknown>,
  issues: GraphValidationIssue[],
): [Record<string, unknown>, AppliedFix[]] {
  // Deep clone
  const fixed = JSON.parse(JSON.stringify(graph)) as Record<string, unknown>;
  const nodesRaw = fixed.nodes;
  let edgesRaw = fixed.edges;
  if (!Array.isArray(nodesRaw) || !Array.isArray(edgesRaw)) {
    return [fixed, []];
  }

  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of nodesRaw) {
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      const n = node as Record<string, unknown>;
      const nid = n.id;
      if (typeof nid === "string" && nid.trim()) {
        nodesById.set(nid.trim(), n);
      }
    }
  }

  const applied: AppliedFix[] = [];

  for (const iss of issues) {
    const code = (iss.code ?? "").trim();

    if (code === "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY") {
      const nid = nodeIdFromIssue(iss);
      const node = nodesById.get(nid);
      if (node) {
        node.idempotency_key =
          node.idempotency_key ||
          `session:\${session_id}:turn:\${turn}:${nid || "side_effect"}`;
        applied.push({ code, node_id: nid, action: "set_idempotency_key" });
      }
    } else if (code === "BACKGROUND_ON_CRITICAL_PATH") {
      const nid = nodeIdFromIssue(iss);
      const before = (edgesRaw as unknown[]).length;
      const filtered = (edgesRaw as unknown[]).filter((e: unknown) => {
        if (typeof e !== "object" || e === null) return true;
        const ed = e as Record<string, unknown>;
        const src = ((ed.source ?? ed.from) as string) ?? "";
        return typeof src !== "string" || src.trim() !== nid;
      });
      if (filtered.length !== before) {
        fixed.edges = filtered;
        edgesRaw = filtered;
        applied.push({ code, node_id: nid, action: "remove_outgoing_edges" });
      }
    } else if (code === "FANIN_FROM_ASYNC_BRANCH") {
      const details = iss.details as Record<string, unknown> | undefined;
      let asyncPreds: string[] = [];
      if (details) {
        const raw = details.async_predecessors;
        if (Array.isArray(raw)) {
          asyncPreds = raw
            .filter((p): p is string => typeof p === "string" && p.trim() !== "")
            .map((p) => p.trim());
        }
      }
      const changed: string[] = [];
      for (const pred of asyncPreds) {
        const node = nodesById.get(pred);
        if (node) {
          node.async = false;
          changed.push(pred);
        }
      }
      if (changed.length > 0) {
        applied.push({ code, node_ids: changed, action: "set_async_false" });
      }
    }
  }

  return [fixed, applied];
}

/**
 * Run lint and return optional post-fix candidate with before/after status.
 */
export function lintAndAutofixGraph(
  graph: Record<string, unknown>,
  opts: { strict: boolean; apply?: boolean },
): Record<string, unknown> {
  const apply = opts.apply ?? true;

  const before = lintGraphDesign(graph, { strict: opts.strict });
  const beforePayload = lintPayloadFromResult(before);

  if (!apply || before.valid) {
    return {
      autofix_applied: false,
      applied_fixes: [],
      graph,
      lint_before: beforePayload,
      lint_after: beforePayload,
    };
  }

  const [fixedGraph, applied] = autofixGraphCommonIssues(graph, before.errors);
  const after = lintGraphDesign(fixedGraph, { strict: opts.strict });

  return {
    autofix_applied: applied.length > 0,
    applied_fixes: applied,
    graph: fixedGraph,
    lint_before: beforePayload,
    lint_after: lintPayloadFromResult(after),
  };
}
