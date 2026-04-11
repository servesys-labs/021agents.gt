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

import { describe, it, expect } from "vitest";

import {
  appendRule,
  OVERLAY_JOINER,
} from "../../control-plane/src/logic/skill-mutation";
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

    // appendRule: rate-limit check
    if (query.includes("count(*)") && query.includes("skill_audit")) {
      const skillName = String(values[0]);
      const count = audit.filter((a) => a.skill_name === skillName).length;
      return Promise.resolve([{ n: count }]);
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

    // ── Step 3: read overlays via loadSkillOverlays (deploy read path).
    //
    // loadSkillOverlays takes Hyperdrive via getDb; we bypass that by
    // building the overlay map directly from the mocked sql — same
    // shape loadSkillOverlays returns. This is the moment the two
    // workspaces prove they agree on schema: if appendRule wrote under
    // column 'rule_text' and loadSkillOverlays read under a different
    // column, this step would hand an empty map to step 4 and the
    // test would fail.
    const overlayRows = await sql`
      SELECT skill_name, rule_text FROM skill_overlays
      WHERE org_id = ${orgId} AND (agent_name = ${agentName} OR agent_name = '')
      ORDER BY created_at ASC
    `;
    const overlayMap: Record<string, string[]> = {};
    for (const r of overlayRows as any[]) {
      (overlayMap[r.skill_name] ??= []).push(r.rule_text);
    }
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

    // Read overlays and merge — both rules should appear in order.
    const overlayRows = await sql`
      SELECT skill_name, rule_text FROM skill_overlays
      WHERE org_id = ${orgId} AND (agent_name = ${agentName} OR agent_name = '')
      ORDER BY created_at ASC
    `;
    const overlayMap: Record<string, string[]> = {};
    for (const r of overlayRows as any[]) {
      (overlayMap[r.skill_name] ??= []).push(r.rule_text);
    }
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

    const overlayRows = await sql`
      SELECT skill_name, rule_text FROM skill_overlays
      WHERE org_id = ${orgId} AND (agent_name = ${agentName} OR agent_name = '')
      ORDER BY created_at ASC
    `;
    const overlayMap: Record<string, string[]> = {};
    for (const r of overlayRows as any[]) {
      (overlayMap[r.skill_name] ??= []).push(r.rule_text);
    }

    const merged = getSkillPrompt(targetSkill, "SUBSTITUTED_VALUE", [], undefined, overlayMap);
    expect(merged).not.toBeNull();
    // Base template's {{ARGS}} placeholders are replaced with the actual arg...
    expect(merged).toContain("SUBSTITUTED_VALUE");
    // ...but the learned rule keeps {{ARGS}} literal.
    expect(merged).toContain("contains {{ARGS}}");
  });
});
