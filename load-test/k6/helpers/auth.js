/**
 * Auth helper — rotates API keys across VUs for multi-tenant load.
 *
 * Each VU gets assigned to one of the 10 orgs via `exec.vu.idInTest % N`.
 * This ensures RLS plan-cache diversity: Postgres can't cache a single
 * org_id filter plan and must re-plan for each distinct org.
 */
import { API_KEYS } from "../config.js";
import exec from "k6/execution";

export function getApiKey() {
  if (API_KEYS.length === 0) {
    throw new Error("No API keys configured. Set API_KEY or API_KEY_0..API_KEY_9 env vars.");
  }
  const idx = exec.vu.idInTest % API_KEYS.length;
  return API_KEYS[idx];
}

export function authHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
}
