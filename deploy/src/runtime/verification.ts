/**
 * Structured verification contract — pure evaluation logic.
 *
 * Extracted from workflow.ts so it can be unit-tested without
 * pulling in WorkflowEntrypoint / Cloudflare runtime dependencies.
 */

/**
 * Evaluate the result of a verify_command execution against pass_condition.
 * Pure function — all sandbox interaction happens before this is called.
 *
 * @param execResult - sandbox exec result, or null if sandbox was unavailable
 * @param passCondition - regex pattern (optional)
 * @param sandboxError - error message if sandbox threw (optional)
 * @returns { ok, reason } — ok=true means verification passed
 */
export function evaluateVerification(
  execResult: { stdout?: string; stderr?: string; exitCode?: number } | null,
  passCondition: string | undefined,
  sandboxError?: string,
): { ok: boolean; reason?: string } {
  // Infrastructure failure — sandbox threw or was unavailable.
  // Fail closed: verification was requested but could not execute.
  if (sandboxError !== undefined || execResult === null) {
    const msg = (sandboxError || "").toLowerCase();
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return { ok: false, reason: "verify_command_timeout" };
    }
    return { ok: false, reason: "verify_command_infra_failure" };
  }

  // Timeout from Promise.race sentinel
  if (execResult.exitCode === -1) {
    return { ok: false, reason: "verify_command_timeout" };
  }

  const exitOk = (execResult.exitCode ?? 1) === 0;

  if (passCondition !== undefined && passCondition !== null && passCondition !== "") {
    // Regex mode: both exit-success AND stdout match are required.
    let regex: RegExp;
    try {
      regex = new RegExp(passCondition);
    } catch {
      return { ok: false, reason: "verify_condition_invalid_regex" };
    }
    const stdout = String(execResult.stdout || "");
    if (!exitOk) return { ok: false, reason: "verify_command_failed" };
    if (!regex.test(stdout)) return { ok: false, reason: "verify_command_failed" };
    return { ok: true };
  }

  // No pass_condition: exit-success is enough
  if (!exitOk) return { ok: false, reason: "verify_command_failed" };
  return { ok: true };
}
