import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { evaluateVerification } from "../src/runtime/verification";

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");
const TOOLS_PATH = path.resolve(__dirname, "../src/runtime/tools.ts");

function loadSource(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

// ── Executable unit tests: evaluateVerification ───────────────

describe("evaluateVerification — pass_condition regex matching", () => {
  it("passes when stdout matches regex and exit code is 0", () => {
    const result = evaluateVerification(
      { stdout: "PASS 42 tests", exitCode: 0 },
      "^PASS \\d+ tests$",
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when stdout does not match regex", () => {
    const result = evaluateVerification(
      { stdout: "FAIL 3 tests", exitCode: 0 },
      "^PASS",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_failed");
  });

  it("fails when exit code is non-zero even if stdout matches regex", () => {
    const result = evaluateVerification(
      { stdout: "PASS 42 tests", exitCode: 1 },
      "PASS",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_failed");
  });

  it("supports substring-style regex", () => {
    const result = evaluateVerification(
      { stdout: "All 15 tests passed successfully", exitCode: 0 },
      "tests passed",
    );
    expect(result.ok).toBe(true);
  });

  it("supports anchored patterns", () => {
    const result = evaluateVerification(
      { stdout: '{"success":true,"count":5}', exitCode: 0 },
      '^\\{"success":true',
    );
    expect(result.ok).toBe(true);
  });
});

describe("evaluateVerification — invalid regex", () => {
  it("returns verify_condition_invalid_regex for malformed pattern", () => {
    const result = evaluateVerification(
      { stdout: "anything", exitCode: 0 },
      "[invalid(regex",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_condition_invalid_regex");
  });

  it("returns verify_condition_invalid_regex for unclosed group", () => {
    const result = evaluateVerification(
      { stdout: "ok", exitCode: 0 },
      "(unclosed",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_condition_invalid_regex");
  });
});

describe("evaluateVerification — no pass_condition (exit code only)", () => {
  it("passes when exit code is 0", () => {
    const result = evaluateVerification(
      { stdout: "anything", exitCode: 0 },
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("treats empty string pass_condition as unset (exit-code-only mode)", () => {
    // Empty string should NOT enter regex mode — it's equivalent to undefined
    const result = evaluateVerification(
      { stdout: "anything", exitCode: 0 },
      "",
    );
    expect(result.ok).toBe(true);

    // And empty string with non-zero exit should fail on exit code, not regex
    const result2 = evaluateVerification(
      { stdout: "anything", exitCode: 1 },
      "",
    );
    expect(result2.ok).toBe(false);
    expect(result2.reason).toBe("verify_command_failed");
  });

  it("fails when exit code is non-zero", () => {
    const result = evaluateVerification(
      { stdout: "", exitCode: 1 },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_failed");
  });

  it("fails when exit code is undefined (defaults to non-zero)", () => {
    const result = evaluateVerification(
      { stdout: "output" },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_failed");
  });
});

describe("evaluateVerification — timeout", () => {
  it("returns verify_command_timeout for Promise.race sentinel (exitCode -1)", () => {
    const result = evaluateVerification(
      { stdout: "", stderr: "", exitCode: -1 },
      "PASS",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_timeout");
  });

  it("returns verify_command_timeout when sandbox error contains 'timeout'", () => {
    const result = evaluateVerification(null, "PASS", "sandbox exec timeout after 30s");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_timeout");
  });

  it("returns verify_command_timeout when sandbox error contains 'timed out'", () => {
    const result = evaluateVerification(null, undefined, "Operation timed out");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_timeout");
  });
});

describe("evaluateVerification — infrastructure failure (fail-closed)", () => {
  it("returns verify_command_infra_failure when execResult is null", () => {
    const result = evaluateVerification(null, "PASS");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_infra_failure");
  });

  it("returns verify_command_infra_failure when sandbox throws non-timeout error", () => {
    const result = evaluateVerification(null, undefined, "Container allocation failed");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_infra_failure");
  });

  it("returns verify_command_infra_failure when sandbox throws empty error", () => {
    const result = evaluateVerification(null, undefined, "");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_infra_failure");
  });
});

describe("evaluateVerification — stdout only, not stderr", () => {
  it("regex matches against stdout, ignoring stderr", () => {
    const result = evaluateVerification(
      { stdout: "PASS", stderr: "WARNING: deprecated", exitCode: 0 },
      "PASS",
    );
    expect(result.ok).toBe(true);
  });

  it("regex does NOT match stderr content", () => {
    const result = evaluateVerification(
      { stdout: "", stderr: "PASS 42 tests", exitCode: 0 },
      "PASS",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify_command_failed");
  });
});

// ── Workflow wiring (structural, minimal) ─────────────────────

describe("workflow wiring — verification call site", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("calls evaluateVerification with execResult, pass_condition, and sandboxError", () => {
    expect(source).toContain("evaluateVerification(execResult, p.pass_condition, sandboxError)");
  });

  it("captures sandbox errors instead of silently swallowing them", () => {
    const verifyBlock = source.slice(
      source.indexOf("Structured verification contract"),
      source.indexOf("if (!completionContract.ok", source.indexOf("Structured verification contract")),
    );
    // The catch must capture the error, not discard it
    expect(verifyBlock).toContain("catch (err");
    expect(verifyBlock).toContain("sandboxError = err");
    // Must NOT have an empty catch that skips verification
    expect(verifyBlock).not.toMatch(/catch\s*\{\s*\/\/.*skip/i);
  });

  it("fail-closed: sandbox failure feeds into contract result", () => {
    const verifyBlock = source.slice(
      source.indexOf("Structured verification contract"),
      source.indexOf("if (!completionContract.ok", source.indexOf("Structured verification contract")),
    );
    // After evaluateVerification, result feeds into completionContract
    expect(verifyBlock).toContain("completionContract.reasons.push(verification.reason)");
    expect(verifyBlock).toContain("completionContract.ok = false");
  });
});

// ── Schema fields ─────────────────────────────────────────────

describe("AgentRunParams — verification fields", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("includes verify_command and pass_condition", () => {
    expect(source).toContain("verify_command?: string");
    expect(source).toContain("pass_condition?: string");
  });
});

// ── Heuristic unchanged ───────────────────────────────────────

describe("heuristic completion contract — unchanged", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("evaluateCompletionContract is still synchronous and pure", () => {
    const funcDef = source.slice(
      source.indexOf("function evaluateCompletionContract"),
      source.indexOf("function evaluateCompletionContract") + 200,
    );
    expect(funcDef).not.toContain("async");
  });

  it("still checks output_too_short, execution_intent_without_tools, all_tool_calls_failed", () => {
    expect(source).toContain('"output_too_short"');
    expect(source).toContain('"execution_intent_without_tools"');
    expect(source).toContain('"all_tool_calls_failed"');
  });
});

// ── Sandbox helpers exported ──────────────────────────────────

describe("sandbox helpers — exported for verification", () => {
  const source = loadSource(TOOLS_PATH);

  it("getSafeSandbox and stableSandboxId are exported", () => {
    expect(source).toContain("export function getSafeSandbox(");
    expect(source).toContain("export function stableSandboxId(");
  });
});
