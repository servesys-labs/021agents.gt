/**
 * Console-compatible shim for runtime modules.
 *
 * Previously this routed through a module-level JsonlLogger singleton, but
 * that leaked org_id / session_id across concurrent workflows on the same
 * Worker isolate and dropped any event logged before `logger.init()` ran.
 *
 * The shim now mirrors directly to `console.*`, so logs always reach
 * wrangler tail. Structured KV logging lives on per-workflow JsonlLogger
 * instances created via `createJsonlLogger()` and owned by the caller
 * (e.g. workflow.run()), not this shim.
 *
 * Use `log.info / log.warn / log.error / log.debug` anywhere in
 * deploy/src/runtime/ instead of raw `console.*`.
 */

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") {
    return String(arg);
  }
  try { return JSON.stringify(arg); } catch { return "[unserializable]"; }
}

function format(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

export const log = {
  info(...args: unknown[]): void { console.log(format(args)); },
  warn(...args: unknown[]): void { console.warn(format(args)); },
  error(...args: unknown[]): void { console.error(format(args)); },
  debug(...args: unknown[]): void { console.debug(format(args)); },
};
