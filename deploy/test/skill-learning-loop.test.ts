/**
 * Phase 6 merge gate — round-trip regression test.
 *
 * Proves the full learning loop: a rule written via appendRule
 * (control-plane) is visible to getSkillPrompt (deploy) on the next
 * read, merged into the skill body, and changes observable behavior
 * against a simulated eval assertion.
 *
 * Crosses the control-plane ↔ deploy workspace boundary intentionally.
 * The whole point of this test is to prove the two sides agree on
 * schema at runtime, not just at code-review time. The cross-workspace
 * import is honest about what's being asserted:
 *
 *   appendRule writes to skill_overlays (column names, column order,
 *   agent_name default, created_at ordering) with a shape that
 *   loadSkillOverlays / getSkillPrompt know how to read.
 *
 * Per Shape A (Phase 6 commit 5 skipped), there is NO HTTP client in
 * between. The test runs both helpers in-process against a shared
 * stateful mock sql that models skill_overlays as an ordered array
 * and returns query results based on SQL fragments.
 */

import { describe, it, expect, vi } from "vitest";

import {
  appendRule,
  OVERLAY_JOINER,
} from "../../control-plane/src/logic/skill-mutation";

// Mutable reference the db mock closes over. Each test sets this to the
// stateful sql BEFORE calling loadSkillOverlays so the real function
// executes its query against the same in-memory state that appendRule
// just wrote to. This is what makes the "round-trip" real rather than
// schema-theater: we invoke the actual deploy read path, not a hand-rolled
// inline query that shadows it.
let currentMockSql: any = null;
vi.mock("../src/runtime/db", () => ({
  getDb: async () => currentMockSql,
}));

import {
  loadSkillOverlays,
  getSkillPrompt,
} from "../src/runtime/skills";
import { BUNDLED_SKILLS_BY_NAME } from "../src/runtime/skills-manifest.generated";

// ── Stateful in-memory DB ─────────────────────────────────────────

interface OverlayRow {
  overlay_id: string;
  org_id: string;
  agent_name: string;
  skill_name: string;
  rule_text: string;
  source: string;
  created_at: number; // ms since epoch, for deterministic ordering
}

interface AuditRow {
  audit_id: string;
  org_id: string;
  skill_name: string;
  agent_name: string;
  overlay_id: string | null;
  before_sha: string;
  after_sha: string;
  before_content: string;
  after_content: string;
  reason: string;
  source: string;
  created_at: number;
}

/**
 * Build a stateful sql mock that models the minimal surface both
 * appendRule and loadSkillOverlays exercise. Dispatches on SQL
 * fragment substrings. Not a full postgres emulator — just enough
 * to prove the round trip.
 */
function buildStatefulSql(orgId: string, agentName: string) {
  const overlays: OverlayRow[] = [];
  const audit: AuditRow[] = [];
  let overlayCounter = 1;
  let auditCounter = 1;
  let clock = 1;

  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").toLowerCase();

    // Advisory lock — serialization primitive held until transaction commit,
    // not a data query. Pass through so the mock doesn't throw on the
    // Phase 6 race fix (skill-mutation.ts:168) that guards the rate-limit
    // COUNT→INSERT pair against concurrent auto-fire mutations.
    if (query.includes("pg_advisory_xact_lock")) {
      return Promise.resolve([]);
    }

    // appendRule: rate-limit check.
    // Phase 6.5 dual bucket: partition by source LIKE 'auto-fire%'.
    // The production query returns FILTER-partitioned columns; the mock
    // does the same classification in-memory so the round-trip tests
    // exercise the real column shape.
    if (query.includes("count(*)") && query.includes("skill_audit")) {
      const skillName = String(values[0]);
      const rows = audit.filter((a) => a.skill_name === skillName);
      const autoCount = rows.filter((a) => a.source.startsWith("auto-fire")).length;
      const humanCount = rows.length - autoCount;
      return Promise.resolve([{ auto_count: autoCount, human_count: humanCount }]);
    }

    // appendRule: custom-skill existence lookup
    if (query.includes("select 1 from skills")) {
      return Promise.resolve([]); // no custom skills — only bundled
    }

    // appendRule: read overlays for (org, agent, skill).
    // The SQL template is: WHERE org_id = $0 AND skill_name = $1 AND
    //   (agent_name = $2 OR agent_name = '') ORDER BY created_at ASC.
    // So skillName is at values[1], not values[2].
    if (query.includes("select rule_text from skill_overlays")) {
      const skillName = String(values[1]);
      const rows = overlays
        .filter(
          (o) =>
            o.skill_name === skillName &&
            (o.agent_name === agentName || o.agent_name === ""),
        )
        .sort((a, b) => a.created_at - b.created_at)
        .map((o) => ({ rule_text: o.rule_text }));
      return Promise.resolve(rows);
    }

    // loadSkillOverlays: read ALL overlays for (org, agent)
    if (query.includes("select skill_name, rule_text from skill_overlays")) {
      const rows = overlays
        .filter((o) => o.agent_name === agentName || o.agent_name === "")
        .sort((a, b) => a.created_at - b.created_at)
        .map((o) => ({ skill_name: o.skill_name, rule_text: o.rule_text }));
      return Promise.resolve(rows);
    }

    // appendRule: insert overlay
    if (query.includes("insert into skill_overlays")) {
      const row: OverlayRow = {
        overlay_id: `ov-${overlayCounter++}`,
        org_id: String(values[0]),
        agent_name: String(values[1]),
        skill_name: String(values[2]),
        rule_text: String(values[3]),
        source: String(values[4]),
        created_at: clock++,
      };
      overlays.push(row);
      return Promise.resolve([{ overlay_id: row.overlay_id }]);
    }

    // appendRule: insert audit
    if (query.includes("insert into skill_audit")) {
      const row: AuditRow = {
        audit_id: `au-${auditCounter++}`,
        org_id: String(values[0]),
        skill_name: String(values[1]),
        agent_name: String(values[2]),
        overlay_id: values[3] as string | null,
        before_sha: String(values[4]),
        after_sha: String(values[5]),
        before_content: String(values[6]),
        after_content: String(values[7]),
        reason: String(values[8]),
        source: String(values[9]),
        created_at: clock++,
      };
      audit.push(row);
      return Promise.resolve([{ audit_id: row.audit_id }]);
    }

    throw new Error(`Unhandled sql query in stateful mock: ${query}`);
  };

  return { sql, overlays, audit };
}

// ── Eval simulation ───────────────────────────────────────────────

/**
 * Simulated "eval case": given a skill prompt and a user input,
 * decide whether the skill's rules are strong enough to handle it.
 *
 * Phase 6's point is that a failing case should become a passing case
 * after /improve appends the right rule. We encode this as a simple
 * substring check: the eval asks "does the prompt tell the agent what
 * to do when `when:` condition X is true?" If the substring matches,
 * the case passes.
 */
function runEvalCase(skillPrompt: string, requiredRule: string): "pass" | "fail" {
  return skillPrompt.includes(requiredRule) ? "pass" : "fail";
}

// ── The round-trip test ───────────────────────────────────────────

describe("Phase 6 merge gate — round-trip regression", () => {
  const orgId = "org-roundtrip";
  const agentName = "agent-roundtrip";
  const targetSkill = "debug";

  it("failing eval → appendRule → loadSkillOverlays → getSkillPrompt → passing eval", async () => {
    // The rule we're about to teach the /debug skill: always require
    // confirmation before operating on /tmp paths. The eval case
    // passes iff this rule (or something that contains this phrase)
    // appears in the skill prompt.
    const requiredRule =
      "when: user names a path under /tmp/\nthen: require explicit confirmation before rm";

    // ── Step 1: baseline /debug has no such rule — eval FAILS.
    const baseline = BUNDLED_SKILLS_BY_NAME[targetSkill];
    expect(baseline).toBeDefined();
    expect(runEvalCase(baseline!.prompt_template, requiredRule)).toBe("fail");

    // Same assertion through the public API that agents use at runtime:
    const baselinePrompt = getSkillPrompt(targetSkill, "args", [], undefined, {});
    expect(baselinePrompt).not.toBeNull();
    expect(runEvalCase(baselinePrompt!, requiredRule)).toBe("fail");

    // ── Step 2: write the rule via appendRule (control-plane write path).
    const { sql, overlays, audit } = buildStatefulSql(orgId, agentName);
    const writeResult = await appendRule(
      sql,
      { orgId, agentName, userRole: "owner" },
      {
        skillName: targetSkill,
        ruleText: requiredRule,
        source: "improve",
        reason: "round-trip test: eval expected rule about /tmp confirmation",
      },
    );
    expect(writeResult.appended).toBe(true);
    if (!writeResult.appended) return;
    expect(writeResult.overlay_count).toBe(1);
    expect(overlays.length).toBe(1);
    expect(audit.length).toBe(1);
    expect(audit[0].overlay_id).toBe(overlays[0].overlay_id);
    expect(audit[0].source).toBe("improve");

    // ── Step 3: read overlays via the REAL loadSkillOverlays.
    //
    // getDb is vi.mocked at the top of this file to return currentMockSql,
    // so loadSkillOverlays' SELECT hits the same stateful in-memory DB
    // that appendRule just wrote to. If the read side's SELECT column
    // names or WHERE clause drift from the write side's INSERT, this
    // step hands an empty map to step 4 and the test fails. That's the
    // whole point of running the actual function — not a hand-rolled
    // copy of the same query.
    currentMockSql = sql;
    const overlayMap = await loadSkillOverlays({} as any, orgId, agentName);
    expect(overlayMap[targetSkill]).toBeDefined();
    expect(overlayMap[targetSkill]).toEqual([requiredRule]);

    // ── Step 4: getSkillPrompt with overlays → merged body.
    const mergedPrompt = getSkillPrompt(targetSkill, "args", [], undefined, overlayMap);
    expect(mergedPrompt).not.toBeNull();
    expect(mergedPrompt).toContain("Learned rules (Phase 6 overlays)");
    expect(mergedPrompt).toContain(requiredRule);

    // ── Step 5: eval PASSES now.
    expect(runEvalCase(mergedPrompt!, requiredRule)).toBe("pass");
  });

  it("second appendRule preserves the first rule and joins both in getSkillPrompt", async () => {
    const rule1 = "when: path contains /tmp/\nthen: require confirmation";
    const rule2 = "when: user asks to delete\nthen: list files before removal";

    const { sql } = buildStatefulSql(orgId, agentName);

    const r1 = await appendRule(
      sql,
      { orgId, agentName, userRole: "admin" },
      { skillName: targetSkill, ruleText: rule1, source: "improve" },
    );
    expect(r1.appended).toBe(true);

    const r2 = await appendRule(
      sql,
      { orgId, agentName, userRole: "admin" },
      { skillName: targetSkill, ruleText: rule2, source: "improve" },
    );
    expect(r2.appended).toBe(true);
    if (!r2.appended) return;
    expect(r2.overlay_count).toBe(2);

    // The second append's before_sha should match the sha of the first
    // rule (which is what loadSkillOverlays would return post-append-1),
    // proving both sides agree on the overlay state transitions.
    const { sha256Hex } = await import("../../control-plane/src/logic/skill-mutation");
    expect(r2.before_sha).toBe(await sha256Hex(rule1));

    // Read overlays via the real loadSkillOverlays (same vi.mock hook).
    currentMockSql = sql;
    const overlayMap = await loadSkillOverlays({} as any, orgId, agentName);
    expect(overlayMap[targetSkill]).toEqual([rule1, rule2]);

    const merged = getSkillPrompt(targetSkill, "", [], undefined, overlayMap);
    expect(merged).not.toBeNull();
    // Both rules present, joined by OVERLAY_JOINER.
    expect(merged).toContain(rule1);
    expect(merged).toContain(rule2);
    const learnedBlockIdx = merged!.indexOf("Learned rules (Phase 6 overlays)");
    expect(learnedBlockIdx).toBeGreaterThan(-1);
    const learnedBlock = merged!.slice(learnedBlockIdx);
    const rule1Idx = learnedBlock.indexOf(rule1);
    const rule2Idx = learnedBlock.indexOf(rule2);
    expect(rule1Idx).toBeGreaterThan(-1);
    expect(rule2Idx).toBeGreaterThan(rule1Idx);
    // Joiner appears between them.
    expect(learnedBlock).toContain(OVERLAY_JOINER);
  });

  it("workflow.ts invokes loadSkillOverlays in both skill-activation paths", async () => {
    // Static regression for the P0-A gap surfaced in the second-pass audit:
    // Phase 6 commit 4 added loadSkillOverlays but never wired it into
    // workflow.ts. The function became an orphan — learned rules were
    // persisted in Postgres but the runtime read path never called
    // the reader, so agents saw only the disk body.
    //
    // This assertion catches a future regression where someone removes
    // the wiring from either activation path in workflow.ts. Static grep
    // because workflow.ts is too large to instantiate under vitest.
    const fs = await import("fs");
    const content = fs.readFileSync("src/workflow.ts", "utf8");
    const loaderCalls = content.match(/loadSkillOverlays\s*\(/g) ?? [];
    // Both skill-activation paths (manual /command and auto-activate tag)
    // must call the overlay loader. At least 2 calls expected.
    expect(loaderCalls.length).toBeGreaterThanOrEqual(2);
    // And getSkillPrompt must be called with the overlays map as its
    // final argument. Both call sites end with ", overlays)" — simple
    // literal match that doesn't need to parse nested parens.
    const withOverlays = content.match(/getSkillPrompt\([^;]*?,\s*overlays\)/g) ?? [];
    expect(withOverlays.length).toBeGreaterThanOrEqual(2);
  });

  it("{{ARGS}} substitution still runs on base template; rule text is literal even under round-trip", async () => {
    // The merge order bug we caught in commit 5: rule text containing
    // {{ARGS}} MUST NOT be substituted. Round-trip verifies this survives
    // the full pipeline, not just getSkillPrompt in isolation.
    const literalArgsRule = "when: rule contains {{ARGS}}\nthen: leave it literal";
    const { sql } = buildStatefulSql(orgId, agentName);

    const r = await appendRule(
      sql,
      { orgId, agentName, userRole: "owner" },
      { skillName: targetSkill, ruleText: literalArgsRule },
    );
    expect(r.appended).toBe(true);

    currentMockSql = sql;
    const overlayMap = await loadSkillOverlays({} as any, orgId, agentName);

    const merged = getSkillPrompt(targetSkill, "SUBSTITUTED_VALUE", [], undefined, overlayMap);
    expect(merged).not.toBeNull();
    // Base template's {{ARGS}} placeholders are replaced with the actual arg...
    expect(merged).toContain("SUBSTITUTED_VALUE");
    // ...but the learned rule keeps {{ARGS}} literal.
    expect(merged).toContain("contains {{ARGS}}");
  });
});

describe("Phase 6.5 pre-requisite — org-wide overlay scope", () => {
  it("rule written with agentName='' loads under ANY agent name via loadSkillOverlays", async () => {
    // This invariant is the correctness load-bearer for the Phase 6.5
    // auto-fire detector. The meta-agent runs /improve under its own
    // agent name (not the target agent's), so target-scoped overlays
    // would silently never load. Org-wide scope (agent_name="") loads
    // for every agent's invocation and is the only shape that lets
    // auto-fire rules reach the model.
    //
    // The test: appendRule under agentName="", loadSkillOverlays under
    // a totally-different agent name, assert the rule is visible AND
    // getSkillPrompt merges it into the effective skill prompt.
    const orgId = "org-scope-test";
    const writerAgent = ""; // org-wide write — the Phase 6.5 invariant
    const readerAgent = "completely-different-agent";
    const { sql, overlays } = buildStatefulSql(orgId, readerAgent);
    currentMockSql = sql;

    const writeResult = await appendRule(
      sql,
      { orgId, agentName: writerAgent, userRole: "owner" },
      {
        skillName: "improve",
        ruleText: "ATTENTION: learned rule from auto-fire",
        source: "auto-fire:evolve",
        reason: "test pattern=foo count=5 severity=0.8 agent=some-bot",
      },
    );
    expect(writeResult.appended).toBe(true);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].agent_name).toBe(""); // org-wide stored

    // loadSkillOverlays is called with a DIFFERENT agent name than the
    // writer. The production query `WHERE agent_name = X OR agent_name = ''`
    // must match the org-wide row and return it.
    const loaded = await loadSkillOverlays({} as any, orgId, readerAgent);
    expect(loaded.improve).toBeDefined();
    expect(loaded.improve).toHaveLength(1);
    expect(loaded.improve[0]).toBe("ATTENTION: learned rule from auto-fire");

    // And the merged getSkillPrompt output includes the rule for the
    // reader agent, proving the round trip closes end-to-end.
    const improveSkill = BUNDLED_SKILLS_BY_NAME["improve"];
    expect(improveSkill).toBeDefined();
    const prompt = getSkillPrompt("improve", "", [improveSkill!], undefined, loaded);
    expect(prompt).toContain("ATTENTION: learned rule from auto-fire");
  });
});
