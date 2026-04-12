/**
 * Interactive workload — 70% of total RPS.
 *
 * Simulates users running agents via the public API:
 *   60% sync /run
 *   30% stream /run/stream
 *   10% conversation create (with input)
 *
 * Each request exercises the full billing hot path:
 *   auth → rate limiter → reserveCreditHold → RUNTIME.fetch →
 *   settleCreditHold → response
 */
import http from "k6/http";
import { sleep } from "k6";
import { BASE_URL, AGENT_NAME } from "../config.js";
import { authHeaders } from "../helpers/auth.js";
import { checkRunResponse, checkStreamResponse, checkConversationResponse } from "../helpers/checks.js";
import exec from "k6/execution";

const INPUTS = [
  "What's the status of my agent?",
  "How many sessions ran today?",
  "Show me the error rate for the last hour.",
  "List the top 5 most expensive sessions.",
  "What tools are available?",
  "Summarize recent activity.",
  "Check if there are any alerts.",
  "What's the average latency?",
  "How many credits have I used this week?",
  "Run a quick health check.",
];

function pickInput() {
  return INPUTS[Math.floor(Math.random() * INPUTS.length)];
}

/** Sync agent run — 60% of interactive traffic. */
export function syncRun() {
  const res = http.post(
    `${BASE_URL}/v1/agents/${AGENT_NAME}/run`,
    JSON.stringify({
      input: pickInput(),
      user_id: `load-test-user-${exec.vu.idInTest}`,
    }),
    { headers: authHeaders(), tags: { endpoint: "sync_run" } },
  );
  checkRunResponse(res, "sync_run");
}

/** Streaming agent run — 30% of interactive traffic. */
export function streamRun() {
  const res = http.post(
    `${BASE_URL}/v1/agents/${AGENT_NAME}/run/stream`,
    JSON.stringify({
      input: pickInput(),
      user_id: `load-test-user-${exec.vu.idInTest}`,
    }),
    {
      headers: authHeaders(),
      tags: { endpoint: "stream_run" },
      // k6 consumes the full SSE body before returning
      responseType: "text",
    },
  );
  checkStreamResponse(res, "stream_run");
}

/** Conversation create with initial input — 10% of interactive traffic. */
export function conversationRun() {
  const res = http.post(
    `${BASE_URL}/v1/agents/${AGENT_NAME}/conversations`,
    JSON.stringify({
      input: pickInput(),
      title: `load-test-${Date.now()}`,
      user_id: `load-test-user-${exec.vu.idInTest}`,
    }),
    { headers: authHeaders(), tags: { endpoint: "conversation" } },
  );
  checkConversationResponse(res, "conversation");
}

/**
 * Default interactive function — probabilistic routing.
 * Called by the k6 executor; each invocation picks one of the three
 * request types based on the 60/30/10 weight distribution.
 */
export default function () {
  const roll = Math.random() * 100;
  if (roll < 60) {
    syncRun();
  } else if (roll < 90) {
    streamRun();
  } else {
    conversationRun();
  }
}
