/**
 * Batch workload — 10% of total RPS.
 *
 * Submits batch jobs via the public batch API. Each batch contains
 * BATCH_TASK_COUNT tasks (default 10). The batch API returns 202
 * immediately; tasks are processed asynchronously via the job queue.
 *
 * Each task exercises: queue → reserve → RUNTIME.fetch → settle →
 * terminal state write (all in separate withOrgDb transactions per
 * the Bug 2 fix in Commit 4).
 */
import http from "k6/http";
import { BASE_URL, AGENT_NAME, BATCH_TASK_COUNT } from "../config.js";
import { authHeaders } from "../helpers/auth.js";
import { checkBatchResponse } from "../helpers/checks.js";

const BATCH_INPUTS = [
  "Analyze user engagement for segment A.",
  "Generate weekly report for team alpha.",
  "Summarize support tickets from today.",
  "Check compliance status for all agents.",
  "Run sentiment analysis on recent feedback.",
];

function buildBatchTasks(count) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    tasks.push({
      input: BATCH_INPUTS[i % BATCH_INPUTS.length] + ` (task ${i + 1}/${count})`,
    });
  }
  return tasks;
}

export default function () {
  const res = http.post(
    `${BASE_URL}/v1/agents/${AGENT_NAME}/run/batch`,
    JSON.stringify({
      tasks: buildBatchTasks(BATCH_TASK_COUNT),
      metadata: { source: "load-test", timestamp: Date.now() },
    }),
    { headers: authHeaders(), tags: { endpoint: "batch" } },
  );
  checkBatchResponse(res, "batch");
}
