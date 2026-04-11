/**
 * Consistent error-response helpers.
 *
 * Second-pass UX audit surfaced ~20 endpoints that returned raw `err.message`
 * or `String(err)` directly to callers. That leaks:
 *   - Postgres constraint names, table names, error codes
 *   - Internal file paths and module names from stack traces
 *   - Env var names from "X not configured" errors
 *   - Upstream API error bodies verbatim
 *
 * This helper takes the raw error, logs the full detail server-side with a
 * short correlation id, and returns a tuple the route handler can put in a
 * Hono JSON response. Users only ever see the generic `userMessage` plus
 * the `ref` so they can quote it to support, never the raw internals.
 *
 * Use this anywhere you'd otherwise be tempted to do:
 *     return c.json({ error: err.message }, 500);
 *
 * Instead:
 *     return c.json(failSafe(err, "sessions/list"), 500);
 */

export interface FailSafePayload {
  error: string;
  ref: string;
  code?: string;
}

/**
 * Log the raw error with a correlation id and return a caller-safe payload.
 *
 * @param err        The caught error value (anything — Error, string, unknown).
 * @param scope      A short label like `"auth/signup"` used in the log line.
 * @param opts       Optional overrides:
 *                     - userMessage: replace the default generic message
 *                     - code: machine-readable error code for the client
 */
export function failSafe(
  err: unknown,
  scope: string,
  opts?: { userMessage?: string; code?: string },
): FailSafePayload {
  const ref = crypto.randomUUID().slice(0, 8);
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`
      : typeof err === "string"
        ? err
        : (() => { try { return JSON.stringify(err); } catch { return "[unserializable]"; } })();
  console.error(`[${scope}] (ref=${ref}) ${raw}`);
  const userMessage =
    opts?.userMessage ||
    `Something went wrong on our side. Please try again in a moment. (ref: ${ref})`;
  const payload: FailSafePayload = { error: userMessage, ref };
  if (opts?.code) payload.code = opts.code;
  return payload;
}

/**
 * Shorthand for upstream-service errors (Stripe, Twilio, GitHub, etc).
 * The caller should already have logged the raw response; this just returns
 * a user-facing payload that includes a correlation id.
 */
export function upstreamFail(
  scope: string,
  provider: string,
  status: number,
): FailSafePayload {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[${scope}] upstream ${provider} returned ${status} (ref=${ref})`);
  return {
    error: `${provider} returned an unexpected error. Please try again in a moment. (ref: ${ref})`,
    ref,
  };
}
