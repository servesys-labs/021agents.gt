/**
 * Design-time lint rules for no-code declarative agent graphs.
 * Ported from agentos/graph/design_lint.py + agentos/graph/contracts.py.
 *
 * Checks:
 * - Background nodes off critical path
 * - Idempotency keys on async side-effect nodes
 * - Async fan-in warnings
 * - Skill manifest and state contract validation
 */

import {
  type GraphValidationIssue,
  type GraphValidationResult,
  validateGraphDefinition,
} from "./graph-validate";

// ── Kind sets ────────────────────────────────────────────────────────

const BACKGROUND_KINDS = new Set([
  "telemetry",
  "telemetry_emit",
  "eval_enqueue",
  "experiment_enqueue",
  "autoresearch_enqueue",
  "index",
  "index_write",
  "analytics",
]);

const SIDE_EFFECT_KINDS = new Set([
  "telemetry",
  "telemetry_emit",
  "eval_enqueue",
  "experiment_enqueue",
  "autoresearch_enqueue",
  "index",
  "index_write",
  "db_write",
  "memory_write",
]);

const FINAL_KINDS = new Set(["final", "final_answer", "respond"]);

const ALLOWED_SKILL_SIDE_EFFECTS = new Set(["none", "read", "write", "external"]);
const ALLOWED_REDUCERS = new Set(["append", "last_write_wins", "set_union", "scored_merge"]);

// ── Node helpers ─────────────────────────────────────────────────────

function nodeKind(node: Record<string, unknown>): string {
  const kind = node.kind;
  if (typeof kind === "string" && kind.trim()) return kind.trim();
  const typ = node.type;
  if (typeof typ === "string" && typ.trim()) return typ.trim();
  return "";
}

function nodeAsync(node: Record<string, unknown>): boolean {
  if (typeof node.async === "boolean") return node.async;
  const execution = node.execution;
  if (typeof execution === "object" && execution !== null) {
    const ex = execution as Record<string, unknown>;
    if (typeof ex.async === "boolean") return ex.async;
    if (typeof ex.blocking === "boolean") return !ex.blocking;
  }
  if (typeof node.blocking === "boolean") return !node.blocking;
  return false;
}

function idempotencyKey(node: Record<string, unknown>): string | null {
  const raw = node.idempotency_key;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const config = node.config;
  if (typeof config === "object" && config !== null) {
    const c = (config as Record<string, unknown>).idempotency_key;
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const execution = node.execution;
  if (typeof execution === "object" && execution !== null) {
    const e = (execution as Record<string, unknown>).idempotency_key;
    if (typeof e === "string" && e.trim()) return e.trim();
  }
  return null;
}

function asNonEmptyStrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((s) => s.trim());
}

function issue(
  code: string,
  message: string,
  path: string | null = null,
  details: Record<string, unknown> = {},
): GraphValidationIssue {
  return { code, message, path, details };
}

// ── Skill manifest validation ────────────────────────────────────────

function validateSkillManifest(
  manifest: unknown,
  pathPrefix: string,
): { errors: GraphValidationIssue[]; warnings: GraphValidationIssue[] } {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];
  if (manifest == null) return { errors, warnings };
  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push(issue("INVALID_SKILL_MANIFEST", "skill_manifest must be an object", pathPrefix));
    return { errors, warnings };
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id.trim()) {
    errors.push(issue("MISSING_SKILL_ID", "skill_manifest.id is required", `${pathPrefix}.id`));
  }
  const se = m.side_effects ?? "none";
  if (typeof se !== "string" || !ALLOWED_SKILL_SIDE_EFFECTS.has(se.trim())) {
    errors.push(
      issue(
        "INVALID_SKILL_SIDE_EFFECTS",
        "skill_manifest.side_effects must be one of: none, read, write, external",
        `${pathPrefix}.side_effects`,
      ),
    );
  }
  const at = m.allowed_tools;
  if (at != null && !Array.isArray(at)) {
    errors.push(
      issue(
        "INVALID_SKILL_ALLOWED_TOOLS",
        "skill_manifest.allowed_tools must be a list of strings",
        `${pathPrefix}.allowed_tools`,
      ),
    );
  }
  if (Array.isArray(at)) {
    for (let i = 0; i < at.length; i++) {
      if (typeof at[i] !== "string" || !(at[i] as string).trim()) {
        errors.push(
          issue(
            "INVALID_SKILL_ALLOWED_TOOLS",
            "skill_manifest.allowed_tools must contain non-empty strings",
            `${pathPrefix}.allowed_tools[${i}]`,
          ),
        );
      }
    }
  }
  const writes = asNonEmptyStrList(m.state_writes);
  if ((m.side_effects === "write" || m.side_effects === "external") && writes.length === 0) {
    warnings.push(
      issue(
        "SKILL_WRITE_WITHOUT_STATE_WRITES",
        "Skill declares write/external side effects but no state_writes keys.",
        pathPrefix,
      ),
    );
  }
  return { errors, warnings };
}

// ── State contract validation ────────────────────────────────────────

function validateStateContract(
  stateContract: unknown,
  pathPrefix = "state_contract",
): { errors: GraphValidationIssue[]; warnings: GraphValidationIssue[] } {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];
  if (stateContract == null) return { errors, warnings };
  if (typeof stateContract !== "object" || Array.isArray(stateContract)) {
    errors.push(issue("INVALID_STATE_CONTRACT", "state_contract must be an object", pathPrefix));
    return { errors, warnings };
  }
  const sc = stateContract as Record<string, unknown>;
  const reducers = sc.reducers ?? {};
  if (reducers != null && (typeof reducers !== "object" || Array.isArray(reducers))) {
    errors.push(
      issue(
        "INVALID_STATE_REDUCERS",
        "state_contract.reducers must be an object map of key -> reducer",
        `${pathPrefix}.reducers`,
      ),
    );
  }
  if (typeof reducers === "object" && reducers !== null && !Array.isArray(reducers)) {
    const r = reducers as Record<string, unknown>;
    for (const [key, reducer] of Object.entries(r)) {
      if (!key.trim()) {
        errors.push(
          issue(
            "INVALID_STATE_REDUCER_KEY",
            "Reducer keys must be non-empty strings",
            `${pathPrefix}.reducers`,
          ),
        );
        continue;
      }
      if (typeof reducer !== "string" || !ALLOWED_REDUCERS.has(reducer.trim())) {
        errors.push(
          issue(
            "INVALID_STATE_REDUCER",
            `Reducer for '${key}' must be one of: ${[...ALLOWED_REDUCERS].sort().join(", ")}`,
            `${pathPrefix}.reducers[${key}]`,
          ),
        );
      }
    }
  }
  const rk = sc.required_keys;
  if (rk != null && !Array.isArray(rk)) {
    errors.push(
      issue(
        "INVALID_STATE_REQUIRED_KEYS",
        "state_contract.required_keys must be a list",
        `${pathPrefix}.required_keys`,
      ),
    );
  }
  return { errors, warnings };
}

// ── Graph contract lint ──────────────────────────────────────────────

function lintGraphContracts(
  raw: Record<string, unknown>,
  nodeIds: Set<string>,
  nodeMap: Map<string, Record<string, unknown>>,
  asyncNodeIds: Set<string>,
): { errors: GraphValidationIssue[]; warnings: GraphValidationIssue[] } {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];

  const { errors: se, warnings: sw } = validateStateContract(raw.state_contract);
  errors.push(...se);
  warnings.push(...sw);

  // Parse reducers
  const reducers = new Map<string, string>();
  const stateContract = raw.state_contract;
  if (typeof stateContract === "object" && stateContract !== null && !Array.isArray(stateContract)) {
    const sc = stateContract as Record<string, unknown>;
    const r = sc.reducers;
    if (typeof r === "object" && r !== null && !Array.isArray(r)) {
      for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
        if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim()) {
          reducers.set(k.trim(), v.trim());
        }
      }
    }
  }

  for (const nid of [...nodeIds].sort()) {
    const node = nodeMap.get(nid) ?? {};
    const manifests = node.skills;
    if (Array.isArray(manifests)) {
      for (let i = 0; i < manifests.length; i++) {
        const { errors: me, warnings: mw } = validateSkillManifest(
          manifests[i],
          `nodes[${nid}].skills[${i}]`,
        );
        errors.push(...me);
        warnings.push(...mw);
      }
    } else if (manifests != null) {
      errors.push(
        issue(
          "INVALID_NODE_SKILLS",
          "Node skills must be a list of skill_manifest objects",
          `nodes[${nid}].skills`,
        ),
      );
    }

    const stateWrites = asNonEmptyStrList(node.state_writes);
    const stateReads = asNonEmptyStrList(node.state_reads);

    if (stateWrites.length > 0) {
      for (const key of stateWrites) {
        if (!reducers.has(key)) {
          warnings.push(
            issue(
              "STATE_WRITE_WITHOUT_REDUCER",
              `Node '${nid}' writes state key '${key}' without an explicit reducer.`,
              `nodes[${nid}].state_writes`,
              { node_id: nid, state_key: key },
            ),
          );
        }
      }
      if (asyncNodeIds.has(nid)) {
        const ik = node.idempotency_key;
        if (typeof ik !== "string" || !ik.trim()) {
          errors.push(
            issue(
              "ASYNC_STATE_WRITE_MISSING_IDEMPOTENCY",
              `Async node '${nid}' writes state and requires idempotency_key.`,
              `nodes[${nid}]`,
              { node_id: nid },
            ),
          );
        }
      }
    }

    if (stateReads.length > 0 && stateWrites.length === 0 && asyncNodeIds.has(nid)) {
      warnings.push(
        issue(
          "ASYNC_STATE_READ_ONLY_NODE",
          `Async node '${nid}' reads state but does not write state; verify ordering assumptions.`,
          `nodes[${nid}]`,
          { node_id: nid },
        ),
      );
    }
  }

  return { errors, warnings };
}

// ── Contract summary ─────────────────────────────────────────────────

export function summarizeGraphContracts(raw: Record<string, unknown>): Record<string, unknown> {
  const nodesRaw = raw.nodes;
  const nodes = Array.isArray(nodesRaw) ? nodesRaw : [];
  let skillManifestCount = 0;
  let stateReadRefs = 0;
  let stateWriteRefs = 0;

  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as Record<string, unknown>;
    const skills = n.skills;
    if (Array.isArray(skills)) {
      skillManifestCount += skills.filter((s) => typeof s === "object" && s !== null).length;
    }
    const reads = n.state_reads;
    if (Array.isArray(reads)) {
      stateReadRefs += reads.filter((r) => typeof r === "string" && r.trim()).length;
    }
    const writes = n.state_writes;
    if (Array.isArray(writes)) {
      stateWriteRefs += writes.filter((w) => typeof w === "string" && w.trim()).length;
    }
  }

  return {
    state_contract_present: typeof raw.state_contract === "object" && raw.state_contract !== null,
    skill_manifest_count: skillManifestCount,
    state_read_refs: stateReadRefs,
    state_write_refs: stateWriteRefs,
  };
}

// ── Main lint function ───────────────────────────────────────────────

/**
 * Run design lint checks on a validated DAG graph.
 * When strict=true, warnings are promoted to errors (for publish gates).
 */
export function lintGraphDesign(
  raw: unknown,
  opts: { strict?: boolean } = {},
): GraphValidationResult {
  const strict = opts.strict ?? false;

  const base = validateGraphDefinition(raw);
  if (!base.valid || base.summary === null) return base;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;

  const g = raw as Record<string, unknown>;
  const nodesRaw = g.nodes;
  if (!Array.isArray(nodesRaw)) return base;

  // Build node map
  const nodeMap = new Map<string, Record<string, unknown>>();
  for (const n of nodesRaw) {
    if (typeof n === "object" && n !== null && !Array.isArray(n)) {
      const nd = n as Record<string, unknown>;
      const nid = nd.id;
      if (typeof nid === "string" && nid.trim()) {
        nodeMap.set(nid.trim(), nd);
      }
    }
  }

  const nodeIds = new Set<string>((base.summary.node_ids as string[]) ?? []);

  // Build adjacency + reverse adjacency
  const adj = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();
  for (const nid of nodeIds) {
    adj.set(nid, []);
    rev.set(nid, []);
    incomingCount.set(nid, 0);
  }

  const edges = g.edges;
  if (Array.isArray(edges)) {
    for (const e of edges) {
      if (typeof e !== "object" || e === null) continue;
      const ed = e as Record<string, unknown>;
      let s = (ed.source ?? ed.from) as unknown;
      let t = (ed.target ?? ed.to) as unknown;
      if (typeof s === "string" && typeof t === "string") {
        s = (s as string).trim();
        t = (t as string).trim();
        if (nodeIds.has(s as string) && nodeIds.has(t as string)) {
          adj.get(s as string)!.push(t as string);
          rev.get(t as string)!.push(s as string);
          incomingCount.set(t as string, (incomingCount.get(t as string) ?? 0) + 1);
        }
      }
    }
  }
  for (const [k, v] of adj) adj.set(k, [...new Set(v)].sort());
  for (const [k, v] of rev) rev.set(k, [...new Set(v)].sort());

  // Find final nodes
  let finalNodes = [...nodeIds].filter((nid) => FINAL_KINDS.has(nodeKind(nodeMap.get(nid) ?? {})));
  if (finalNodes.length === 0) {
    finalNodes = (base.summary.exit_nodes as string[]) ?? [];
  }

  // Compute critical path ancestors (BFS backwards from final)
  const criticalAncestors = new Set<string>();
  const stack = [...finalNodes];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (criticalAncestors.has(cur)) continue;
    criticalAncestors.add(cur);
    stack.push(...(rev.get(cur) ?? []));
  }

  const errors = [...base.errors];
  let warnings = [...base.warnings];

  // Check background nodes on critical path
  for (const nid of [...nodeIds].sort()) {
    const node = nodeMap.get(nid) ?? {};
    const kind = nodeKind(node);
    const isAsync = nodeAsync(node);
    const isBackground = BACKGROUND_KINDS.has(kind);
    const isSideEffect = SIDE_EFFECT_KINDS.has(kind);

    if (isBackground && criticalAncestors.has(nid)) {
      errors.push(
        issue(
          "BACKGROUND_ON_CRITICAL_PATH",
          `Background node '${nid}' (${kind}) is on the path to final response. Move it to a non-blocking branch.`,
          `nodes[${nid}]`,
          { node_id: nid, kind },
        ),
      );
    }

    if (isAsync && isSideEffect && idempotencyKey(node) === null) {
      errors.push(
        issue(
          "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY",
          `Async side-effect node '${nid}' (${kind}) requires idempotency_key to support retries/replays safely.`,
          `nodes[${nid}]`,
          { node_id: nid, kind },
        ),
      );
    }
  }

  // Contract checks
  const asyncNodeIds = new Set(
    [...nodeIds].filter((nid) => nodeAsync(nodeMap.get(nid) ?? {})),
  );
  const { errors: cErrors, warnings: cWarnings } = lintGraphContracts(
    g,
    nodeIds,
    nodeMap,
    asyncNodeIds,
  );
  errors.push(...cErrors);
  warnings.push(...cWarnings);

  // Fan-in from async branches
  for (const nid of [...nodeIds].sort()) {
    if ((incomingCount.get(nid) ?? 0) <= 1) continue;
    const preds = rev.get(nid) ?? [];
    const asyncPreds = preds.filter((p) => nodeAsync(nodeMap.get(p) ?? {}));
    if (asyncPreds.length > 0) {
      warnings.push(
        issue(
          "FANIN_FROM_ASYNC_BRANCH",
          `Node '${nid}' has fan-in from async predecessor(s): ${asyncPreds.sort().join(", ")}. Avoid joining async branches into blocking response path.`,
          `nodes[${nid}]`,
          { node_id: nid, async_predecessors: asyncPreds.sort() },
        ),
      );
    }
  }

  // Strict mode: promote warnings to errors
  if (strict && warnings.length > 0) {
    errors.push(...warnings);
    warnings = [];
  }

  const summary: Record<string, unknown> = {
    ...(base.summary ?? {}),
    lint: {
      strict,
      final_nodes: finalNodes.sort(),
      critical_path_node_count: criticalAncestors.size,
      background_node_count: [...nodeIds].filter((nid) =>
        BACKGROUND_KINDS.has(nodeKind(nodeMap.get(nid) ?? {})),
      ).length,
      async_node_count: asyncNodeIds.size,
    },
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

/** Serialize a lint result into an API-safe payload. */
export function lintPayloadFromResult(result: GraphValidationResult): Record<string, unknown> {
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    summary: result.summary,
  };
}
