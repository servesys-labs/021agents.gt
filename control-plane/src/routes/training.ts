/**
 * Training routes — Agent Lightning-style training loop for AgentOS.
 *
 * Orchestrates iterative eval → optimize → re-eval cycles to improve agents.
 * Delegates eval execution to RUNTIME, runs lightweight optimization (APO, baseline)
 * within the Worker, and stores versioned resources in Supabase.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { requireScope } from "../middleware/auth";
import { getDbForOrg } from "../db/client";
import { getAlgorithm } from "../logic/training-algorithms";
import { computeRewardForEvalRun } from "../logic/reward-aggregator";
import {
  runPreflightChecks,
  runPromptSafetyGate,
  validateTrainedConfig,
  checkCircuitBreaker,
  revertToPreviousResource,
} from "../logic/training-safety";
import type {
  TrainingJob,
  TrainingResource,
  EvalIterationResult,
  IterationHistory,
  OptimizationContext,
} from "../logic/training-algorithms";

export const trainingRoutes = createOpenAPIRouter();

/** Fire-and-forget audit log for training events. */
async function auditTraining(
  sql: any, orgId: string, userId: string,
  action: string, resourceId: string, details: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${orgId}, ${userId}, ${action}, 'training', ${resourceId}, ${JSON.stringify(details)}, now())
    `;
  } catch { /* non-critical */ }
}

// ── Schemas ─────────────────────────────────────────────────────────

const TrainingJobCreate = z.object({
  agent_name: z.string().min(1),
  algorithm: z.enum(["baseline", "apo", "multi"]).default("apo"),
  max_iterations: z.number().int().min(1).max(100).default(10),
  auto_activate: z.boolean().default(false),
  dataset_name: z.string().optional(),
  eval_tasks: z.array(z.object({
    name: z.string().optional(),
    input: z.string(),
    expected: z.string().optional(),
    grader: z.string().default("contains"),
  })).optional(),
  config: z.record(z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
});

const TrainingJobSummary = z.object({
  job_id: z.string(),
  agent_name: z.string(),
  algorithm: z.string(),
  status: z.string(),
  current_iteration: z.number(),
  max_iterations: z.number(),
  best_score: z.number().nullable(),
  best_iteration: z.number().nullable(),
  auto_activate: z.boolean(),
  created_at: z.string(),
});

const IterationSummary = z.object({
  iteration_id: z.string(),
  iteration_number: z.number(),
  status: z.string(),
  pass_rate: z.number().nullable(),
  reward_score: z.number().nullable(),
  resource_version: z.number().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

// ── POST /jobs — create training job ──────────────────────────────

const createJobRoute = createRoute({
  method: "post",
  path: "/jobs",
  tags: ["Training"],
  summary: "Create a training job",
  description: "Create a new training job for an agent. Use /jobs/{job_id}/step to advance iterations.",
  middleware: [requireScope("training:write")],
  request: {
    body: { content: { "application/json": { schema: TrainingJobCreate } } },
  },
  responses: {
    201: { description: "Job created", content: { "application/json": { schema: TrainingJobSummary } } },
    ...errorResponses(400, 401, 404),
  },
});

trainingRoutes.openapi(createJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent exists
  const agents = await sql`
    SELECT name FROM agents WHERE name = ${body.agent_name} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (agents.length === 0) {
    return c.json({ error: `Agent '${body.agent_name}' not found` }, 404);
  }

  // Must have either dataset_name or eval_tasks
  if (!body.dataset_name && (!body.eval_tasks || body.eval_tasks.length === 0)) {
    return c.json({ error: "Either dataset_name or eval_tasks is required" }, 400);
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await sql`
    INSERT INTO training_jobs (
      job_id, org_id, agent_name, algorithm, status, config_json,
      dataset_name, eval_tasks_json, max_iterations, auto_activate,
      created_by, tags
    ) VALUES (
      ${jobId}, ${user.org_id}, ${body.agent_name}, ${body.algorithm}, 'created',
      ${JSON.stringify(body.config)}, ${body.dataset_name ?? null},
      ${body.eval_tasks ? JSON.stringify(body.eval_tasks) : null},
      ${body.max_iterations}, ${body.auto_activate},
      ${user.user_id}, ${body.tags}
    )
  `;

  // Snapshot current system prompt as initial resource (version 0)
  const agentRows = await sql`
    SELECT config_json FROM agents WHERE name = ${body.agent_name} AND org_id = ${user.org_id}
  `;
  if (agentRows.length > 0) {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(String(agentRows[0].config_json || "{}")); } catch {}
    const systemPrompt = String(config.system_prompt ?? "");

    if (systemPrompt) {
      await sql`
        INSERT INTO training_resources (
          resource_id, org_id, agent_name, job_id,
          resource_type, resource_key, version,
          content_text, source, is_active
        ) VALUES (
          ${crypto.randomUUID().replace(/-/g, "").slice(0, 16)},
          ${user.org_id}, ${body.agent_name}, ${jobId},
          'system_prompt', 'main', 0,
          ${systemPrompt}, 'initial', true
        )
        ON CONFLICT (org_id, agent_name, resource_type, resource_key, version) DO NOTHING
      `;
    }
  }

  auditTraining(sql, user.org_id, user.user_id, "training.created", jobId, {
    agent_name: body.agent_name, algorithm: body.algorithm, max_iterations: body.max_iterations,
  });

  return c.json({
    job_id: jobId,
    agent_name: body.agent_name,
    algorithm: body.algorithm,
    status: "created",
    current_iteration: 0,
    max_iterations: body.max_iterations,
    best_score: null,
    best_iteration: null,
    auto_activate: body.auto_activate,
    created_at: new Date().toISOString(),
  }, 201);
});

// ── GET /jobs — list training jobs ──────────────────────────────────

const listJobsRoute = createRoute({
  method: "get",
  path: "/jobs",
  tags: ["Training"],
  summary: "List training jobs",
  middleware: [requireScope("training:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
  },
  responses: {
    200: { description: "Job list", content: { "application/json": { schema: z.array(TrainingJobSummary) } } },
  },
});

trainingRoutes.openapi(listJobsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, status, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agent_name && status) {
    rows = await sql`
      SELECT * FROM training_jobs
      WHERE org_id = ${user.org_id} AND agent_name = ${agent_name} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agent_name) {
    rows = await sql`
      SELECT * FROM training_jobs
      WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (status) {
    rows = await sql`
      SELECT * FROM training_jobs
      WHERE org_id = ${user.org_id} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM training_jobs
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json(rows.map((r: any) => ({
    job_id: r.job_id,
    agent_name: r.agent_name,
    algorithm: r.algorithm,
    status: r.status,
    current_iteration: r.current_iteration,
    max_iterations: r.max_iterations,
    best_score: r.best_score,
    best_iteration: r.best_iteration,
    auto_activate: r.auto_activate,
    created_at: r.created_at,
  })));
});

// ── GET /jobs/{job_id} — get job detail ─────────────────────────────

const getJobRoute = createRoute({
  method: "get",
  path: "/jobs/{job_id}",
  tags: ["Training"],
  summary: "Get training job detail",
  middleware: [requireScope("training:read")],
  request: { params: z.object({ job_id: z.string() }) },
  responses: {
    200: { description: "Job detail with iterations", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});

trainingRoutes.openapi(getJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const jobs = await sql`
    SELECT * FROM training_jobs WHERE job_id = ${job_id} AND org_id = ${user.org_id}
  `;
  if (jobs.length === 0) return c.json({ error: "Training job not found" }, 404);

  const iterations = await sql`
    SELECT * FROM training_iterations
    WHERE job_id = ${job_id} AND org_id = ${user.org_id} ORDER BY iteration_number
  `;

  const resources = await sql`
    SELECT * FROM training_resources
    WHERE job_id = ${job_id} AND org_id = ${user.org_id} ORDER BY version
  `;

  const job = jobs[0] as any;
  return c.json({
    ...job,
    config: JSON.parse(job.config_json || "{}"),
    iterations: iterations.map((i: any) => ({
      iteration_id: i.iteration_id,
      iteration_number: i.iteration_number,
      status: i.status,
      pass_rate: i.pass_rate,
      avg_score: i.avg_score,
      reward_score: i.reward_score,
      reward_breakdown: JSON.parse(i.reward_breakdown_json || "{}"),
      resource_version: i.resource_version,
      algorithm_output: JSON.parse(i.algorithm_output_json || "{}"),
      started_at: i.started_at,
      completed_at: i.completed_at,
    })),
    resources: resources.map((r: any) => ({
      resource_id: r.resource_id,
      resource_type: r.resource_type,
      resource_key: r.resource_key,
      version: r.version,
      source: r.source,
      eval_score: r.eval_score,
      is_active: r.is_active,
      created_at: r.created_at,
    })),
  });
});

// ── POST /jobs/{job_id}/step — advance one iteration ────────────────

const stepJobRoute = createRoute({
  method: "post",
  path: "/jobs/{job_id}/step",
  tags: ["Training"],
  summary: "Advance one training iteration",
  description: "Executes one eval→reward→optimize cycle. Call repeatedly to run the full training loop.",
  middleware: [requireScope("training:write")],
  request: { params: z.object({ job_id: z.string() }) },
  responses: {
    200: { description: "Iteration result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 404, 409),
  },
});

trainingRoutes.openapi(stepJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load job
  const jobs = await sql`
    SELECT * FROM training_jobs WHERE job_id = ${job_id} AND org_id = ${user.org_id}
  `;
  if (jobs.length === 0) return c.json({ error: "Training job not found" }, 404);

  const jobRow = jobs[0] as any;
  if (jobRow.status === "completed" || jobRow.status === "cancelled") {
    return c.json({ error: `Job is ${jobRow.status}` }, 409);
  }

  // Fix #1: Atomic check-and-set to prevent race condition on concurrent /step calls.
  // If another request already incremented the iteration, this returns 0 rows → 409.
  const casResult = await sql`
    UPDATE training_jobs SET current_iteration = current_iteration + 1
    WHERE job_id = ${job_id} AND org_id = ${user.org_id} AND current_iteration = ${jobRow.current_iteration}
    RETURNING current_iteration
  `;
  if (casResult.length === 0) {
    return c.json({ error: "Iteration already in progress" }, 409);
  }

  const iterationNumber = (casResult[0] as any).current_iteration;
  const iterationId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  const job: TrainingJob = {
    job_id: jobRow.job_id,
    org_id: jobRow.org_id,
    agent_name: jobRow.agent_name,
    algorithm: jobRow.algorithm,
    config_json: JSON.parse(jobRow.config_json || "{}"),
    current_iteration: iterationNumber,
    max_iterations: jobRow.max_iterations,
    best_score: jobRow.best_score,
    best_iteration: jobRow.best_iteration,
  };

  // Mark job as running
  if (jobRow.status === "created") {
    await sql`UPDATE training_jobs SET status = 'running', started_at = now() WHERE job_id = ${job_id}`;
  }

  // ── Pre-flight: verify agent tools and config before eval ─────
  // Only on first iteration — subsequent iterations reuse the result
  if (iterationNumber === 1) {
    try {
      const preflight = await runPreflightChecks(sql, c.env, user.org_id, job.agent_name);
      if (!preflight.passed) {
        await sql`
          UPDATE training_jobs SET status = 'failed', completed_at = now()
          WHERE job_id = ${job_id}
        `;
        return c.json({
          error: "Pre-flight checks failed",
          preflight,
          detail: preflight.failed_tools.length > 0
            ? `Tools not in catalog: ${preflight.failed_tools.join(", ")}`
            : preflight.checks.filter((c: any) => !c.passed).map((c: any) => c.detail).join("; "),
        }, 400);
      }
    } catch (e) {
      // Non-blocking: log warning but continue
      console.warn(`[training] Preflight check error for ${job.agent_name}:`, e);
    }
  }

  // Create iteration record
  await sql`
    INSERT INTO training_iterations (iteration_id, job_id, org_id, iteration_number, status, started_at)
    VALUES (${iterationId}, ${job_id}, ${user.org_id}, ${iterationNumber}, 'evaluating', now())
  `;

  // ── Step 1: Get current resources ──────────────────────────────
  const resourceRows = await sql`
    SELECT * FROM training_resources
    WHERE org_id = ${user.org_id} AND agent_name = ${job.agent_name}
      AND job_id = ${job_id} AND is_active = true
    ORDER BY version DESC
  `;
  const currentResources: TrainingResource[] = resourceRows.map((r: any) => ({
    resource_id: r.resource_id,
    resource_type: r.resource_type,
    resource_key: r.resource_key,
    version: r.version,
    content_text: r.content_text,
    content_json: r.content_json ? JSON.parse(r.content_json) : null,
    is_active: r.is_active,
    eval_score: r.eval_score,
  }));

  // ── Step 2: Build system prompt override for eval ──────────────
  // Fix #7: Instead of mutating agent config before eval, pass the override
  // in the eval payload. We still track the original prompt for reference but
  // never temporarily mutate the live agent config.
  const promptResource = currentResources.find(
    (r) => r.resource_type === "system_prompt" && r.resource_key === "main",
  );
  let originalPrompt: string | null = null;
  const systemPromptOverride = promptResource?.content_text ?? null;

  if (systemPromptOverride) {
    const agentRows = await sql`
      SELECT config_json FROM agents WHERE name = ${job.agent_name} AND org_id = ${user.org_id}
    `;
    if (agentRows.length > 0) {
      const config = JSON.parse(String(agentRows[0].config_json || "{}"));
      originalPrompt = config.system_prompt ?? null;
    }
  }

  // ── Step 3: Run eval tasks via Workflow (crash-safe, checkpointed) ──
  let evalResult: EvalIterationResult = {
    eval_run_id: null,
    pass_rate: null,
    avg_score: null,
    avg_latency_ms: null,
    total_cost_usd: null,
  };

  const progressEvents: Record<string, unknown>[] = [];

  try {
    const evalTasks = jobRow.eval_tasks_json
      ? JSON.parse(jobRow.eval_tasks_json)
      : [];

    if (evalTasks.length > 0) {
      // Run each eval task through the Workflow-backed agent.run() path.
      // This gives us per-task progress via KV, crash safety, and proper
      // tool execution — unlike the batch eval endpoint which is simpler
      // but doesn't go through the full Workflow.
      const taskResults: Array<{ passed: boolean; output: string; cost_usd: number; latency_ms: number }> = [];
      let totalCost = 0;
      let totalLatency = 0;

      for (const task of evalTasks) {
        const taskInput = String(task.input || "");
        const taskExpected = String(task.expected || "");
        const grader = String(task.grader || "contains");
        const taskStart = Date.now();

        try {
          // Call RUNTIME /run which routes to DO → Workflow
          const runResp = await c.env.RUNTIME.fetch("https://runtime/run", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              input: taskInput,
              agent_name: job.agent_name,
              org_id: user.org_id,
              ...(systemPromptOverride ? { system_prompt_override: systemPromptOverride } : {}),
            }),
          });

          const runResult = await runResp.json() as Record<string, unknown>;
          const output = String(runResult.output || "");
          const costUsd = Number(runResult.cost_usd || 0);
          const latencyMs = Date.now() - taskStart;

          // Grade the result
          let passed = false;
          if (grader === "contains" && taskExpected) {
            passed = output.toLowerCase().includes(taskExpected.toLowerCase());
          } else if (grader === "exact" && taskExpected) {
            passed = output.trim() === taskExpected.trim();
          } else if (!taskExpected) {
            // No expected value — pass if we got a non-empty response
            passed = output.length > 0;
          }

          taskResults.push({ passed, output, cost_usd: costUsd, latency_ms: latencyMs });
          totalCost += costUsd;
          totalLatency += latencyMs;
        } catch (taskErr) {
          taskResults.push({ passed: false, output: String(taskErr), cost_usd: 0, latency_ms: Date.now() - taskStart });
        }
      }

      // Aggregate results
      const passCount = taskResults.filter((r) => r.passed).length;
      const passRate = evalTasks.length > 0 ? passCount / evalTasks.length : 0;
      const avgLatency = taskResults.length > 0 ? totalLatency / taskResults.length : 0;

      evalResult = {
        eval_run_id: null, // Individual runs don't create eval_runs rows
        pass_rate: passRate,
        avg_score: passRate,
        avg_latency_ms: avgLatency,
        total_cost_usd: totalCost,
      };

      // Collect KV progress events if available
      if (c.env.AGENT_PROGRESS_KV) {
        try {
          const listResult = await c.env.AGENT_PROGRESS_KV.list({
            prefix: `rpc:${job.agent_name}`,
            limit: 10,
          });
          for (const key of listResult.keys) {
            const raw = await c.env.AGENT_PROGRESS_KV.get(key.name);
            if (raw) {
              const events = JSON.parse(raw) as Record<string, unknown>[];
              progressEvents.push(...events.slice(-5)); // Last 5 per key
            }
          }
        } catch {
          // KV not available — non-critical
        }
      }

      // Write eval results to DB for reward aggregator
      try {
        const evalRunId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        await sql`
          INSERT INTO eval_runs (org_id, agent_name, pass_rate, avg_score, avg_latency_ms, total_cost_usd, total_tasks, total_trials, created_at)
          VALUES (${user.org_id}, ${job.agent_name}, ${passRate}, ${passRate}, ${avgLatency}, ${totalCost}, ${evalTasks.length}, ${1}, now())
          RETURNING id
        `.then((rows: any) => {
          if (rows.length > 0) evalResult.eval_run_id = rows[0].id;
        });
      } catch {
        // eval_runs table may not exist in test env
      }
    }
  } catch (e) {
    console.warn(`[training] Eval failed for job ${job_id} iteration ${iterationNumber}:`, e);
  }

  // ── Step 3.5: Guardrail scan on eval outputs ──────────────────
  // Scan the agent's responses through guardrail engine to populate
  // guardrail_events for the reward aggregator. Without this, the
  // guardrail signal in the reward is always "assume compliant."
  if (evalResult.eval_run_id) {
    try {
      const { evaluateOutput, DEFAULT_GUARDRAIL_POLICY } = await import("../logic/guardrail-engine");
      const trialRows = await sql`
        SELECT actual, task_name FROM eval_trials
        WHERE run_id = ${evalResult.eval_run_id}
        LIMIT 20
      `;
      for (const trial of trialRows) {
        const output = String(trial.actual || "");
        if (!output) continue;
        const scanResult = evaluateOutput(output, DEFAULT_GUARDRAIL_POLICY);
        // Write to guardrail_events so reward aggregator can read it
        await sql`
          INSERT INTO guardrail_events (org_id, agent_name, event_type, action, text_preview, matches, created_at)
          VALUES (${user.org_id}, ${job.agent_name}, 'output', ${scanResult.action},
                  ${output.slice(0, 200)}, ${JSON.stringify(scanResult.reasons)}, now())
        `.catch(() => {}); // Non-critical — don't fail training if table doesn't exist
      }
    } catch {
      // Guardrail engine not available or eval_trials table missing — skip
    }
  }

  // ── Step 4: Compute reward ────────────────────────────────────
  let rewardScore = evalResult.pass_rate ?? 0;
  let rewardBreakdown: Record<string, number> = { eval: rewardScore };

  if (evalResult.eval_run_id) {
    try {
      const reward = await computeRewardForEvalRun(
        sql, user.org_id, job.agent_name, evalResult.eval_run_id,
      );
      rewardScore = reward.score;
      rewardBreakdown = reward.breakdown;
    } catch {
      // Fall back to pass_rate
    }
  }

  // Fix #10: Write to training_rewards so GET /rewards/{agent_name} returns data
  try {
    await sql`
      INSERT INTO training_rewards (org_id, agent_name, source, score, raw_value, metadata_json)
      VALUES (
        ${user.org_id}, ${job.agent_name}, ${'training-iter-' + iterationNumber},
        ${rewardScore}, ${String(rewardScore)},
        ${JSON.stringify({ job_id, iteration: iterationNumber, breakdown: rewardBreakdown })}
      )
    `;
  } catch { /* Non-critical — training_rewards table may not exist */ }

  // Update iteration with eval results
  await sql`
    UPDATE training_iterations SET
      status = 'optimizing',
      eval_run_id = ${evalResult.eval_run_id},
      pass_rate = ${evalResult.pass_rate},
      avg_score = ${evalResult.avg_score},
      avg_latency_ms = ${evalResult.avg_latency_ms},
      total_cost_usd = ${evalResult.total_cost_usd},
      reward_score = ${rewardScore},
      reward_breakdown_json = ${JSON.stringify(rewardBreakdown)},
      resource_version = ${promptResource?.version ?? 0}
    WHERE iteration_id = ${iterationId}
  `;

  // ── Step 5: Run optimization algorithm ────────────────────────
  const historyRows = await sql`
    SELECT iteration_number, reward_score, pass_rate, resource_version, algorithm_output_json
    FROM training_iterations
    WHERE job_id = ${job_id} AND org_id = ${user.org_id} AND status = 'completed'
    ORDER BY iteration_number
  `;
  const history: IterationHistory[] = historyRows.map((h: any) => ({
    iteration_number: h.iteration_number,
    reward_score: h.reward_score,
    pass_rate: h.pass_rate,
    resource_version: h.resource_version,
    algorithm_output_json: JSON.parse(h.algorithm_output_json || "{}"),
  }));

  const algorithm = getAlgorithm(job.algorithm, job.config_json);
  const ctx: OptimizationContext = {
    job: { ...job, current_iteration: iterationNumber },
    currentIteration: iterationNumber,
    currentResources,
    evalResults: evalResult,
    rewardScore,
    history,
  };

  let optimizationResult = await algorithm.optimize(ctx);

  // If APO needs LLM calls, execute them here (where we have env.AI)
  if (optimizationResult.metadata.requires_llm_calls && c.env.AI) {
    try {
      const gradientPrompt = optimizationResult.metadata.gradient_prompt as string;
      const editTemplate = optimizationResult.metadata.edit_prompt_template as string;

      // Step 5a: Generate gradient (critique)
      const gradientResp = await c.env.AI.run(
        "@cf/meta/llama-3.1-70b-instruct" as keyof AiModels,
        { messages: [{ role: "user", content: gradientPrompt }], max_tokens: 500 } as any,
      ) as { response?: string };
      const gradient = gradientResp.response ?? "";

      // Step 5b: Apply gradient to produce new prompt
      const editPrompt = editTemplate.replace("{{GRADIENT}}", gradient);
      const editResp = await c.env.AI.run(
        "@cf/meta/llama-3.1-70b-instruct" as keyof AiModels,
        { messages: [{ role: "user", content: editPrompt }], max_tokens: 2000 } as any,
      ) as { response?: string };
      const newPrompt = editResp.response ?? "";

      if (newPrompt.trim()) {
        optimizationResult = {
          updatedResources: [{
            resourceType: "system_prompt",
            resourceKey: "main",
            contentText: newPrompt.trim(),
            source: "apo",
          }],
          metadata: {
            ...optimizationResult.metadata,
            gradient,
            new_prompt_length: newPrompt.length,
            requires_llm_calls: false,
          },
        };
      }
    } catch (e) {
      console.warn(`[training] APO LLM calls failed for job ${job_id}:`, e);
      optimizationResult.metadata.llm_error = String(e);
    }
  }

  // ── Step 5.5: Safety gate — veto unsafe prompts ────────────────
  const safetyResults: Record<string, unknown>[] = [];
  for (const update of optimizationResult.updatedResources) {
    if (update.resourceType === "system_prompt" && update.contentText) {
      const originalContent = promptResource?.content_text ?? "";
      const safetyCheck = runPromptSafetyGate(update.contentText, originalContent);
      safetyResults.push({ resource: update.resourceKey, ...safetyCheck });

      if (!safetyCheck.safe) {
        // Veto this candidate — revert to original
        update.contentText = originalContent;
        optimizationResult.metadata.safety_vetoed = true;
        optimizationResult.metadata.safety_reasons = safetyCheck.reasons;
      }
    }
  }
  if (safetyResults.length > 0) {
    optimizationResult.metadata.safety_checks = safetyResults;
  }

  // ── Step 5.6: Config validation gate ──────────────────────────
  for (const update of optimizationResult.updatedResources) {
    if (update.contentJson) {
      const validation = validateTrainedConfig(update.contentJson);
      if (!validation.valid) {
        // Reject this config update
        update.contentJson = undefined;
        optimizationResult.metadata.config_validation_errors = validation.errors;
      }
    }
  }

  // Fix #9: Filter out resource updates with empty/undefined contentText (e.g. APO placeholder on LLM failure)
  optimizationResult.updatedResources = optimizationResult.updatedResources.filter(
    (u) => (u.contentText && u.contentText.trim() !== "") || u.contentJson,
  );

  // ── Step 6: Store new resources ───────────────────────────────
  const newVersion = (promptResource?.version ?? 0) + 1;

  for (const update of optimizationResult.updatedResources) {

    // Deactivate current version
    await sql`
      UPDATE training_resources SET is_active = false
      WHERE org_id = ${user.org_id} AND agent_name = ${job.agent_name}
        AND resource_type = ${update.resourceType} AND resource_key = ${update.resourceKey}
        AND is_active = true
    `;

    // Insert new version
    await sql`
      INSERT INTO training_resources (
        resource_id, org_id, agent_name, job_id,
        resource_type, resource_key, version,
        content_text, content_json, source,
        parent_version, iteration_id, eval_score, is_active
      ) VALUES (
        ${crypto.randomUUID().replace(/-/g, "").slice(0, 16)},
        ${user.org_id}, ${job.agent_name}, ${job_id},
        ${update.resourceType}, ${update.resourceKey}, ${newVersion},
        ${update.contentText ?? null}, ${update.contentJson ? JSON.stringify(update.contentJson) : null},
        ${update.source}, ${promptResource?.version ?? 0}, ${iterationId},
        ${rewardScore}, true
      )
    `;
  }

  // Apply optimized prompt to agent config (if algorithm produced one)
  const newPromptResource = optimizationResult.updatedResources.find(
    (r) => r.resourceType === "system_prompt",
  );
  if (newPromptResource?.contentText) {
    const agentRows = await sql`
      SELECT config_json FROM agents WHERE name = ${job.agent_name} AND org_id = ${user.org_id}
    `;
    if (agentRows.length > 0) {
      const config = JSON.parse(String(agentRows[0].config_json || "{}"));
      config.system_prompt = newPromptResource.contentText;
      await sql`
        UPDATE agents SET config_json = ${JSON.stringify(config)}, updated_at = now()
        WHERE name = ${job.agent_name} AND org_id = ${user.org_id}
      `;
    }
  }

  // ── Step 7: Update job state ──────────────────────────────────
  const isBest = job.best_score === null || rewardScore > job.best_score;

  await sql`
    UPDATE training_iterations SET
      status = 'completed',
      algorithm_output_json = ${JSON.stringify(optimizationResult.metadata)},
      resource_snapshot_json = ${JSON.stringify({ version: newVersion })},
      completed_at = now()
    WHERE iteration_id = ${iterationId}
  `;

  // Fix #8: Re-fetch history INCLUDING the just-completed iteration before calling shouldContinue
  const freshHistoryRows = await sql`
    SELECT iteration_number, reward_score, pass_rate, resource_version, algorithm_output_json
    FROM training_iterations
    WHERE job_id = ${job_id} AND org_id = ${user.org_id} AND status = 'completed'
    ORDER BY iteration_number
  `;
  const freshHistory: IterationHistory[] = freshHistoryRows.map((h: any) => ({
    iteration_number: h.iteration_number,
    reward_score: h.reward_score,
    pass_rate: h.pass_rate,
    resource_version: h.resource_version,
    algorithm_output_json: JSON.parse(h.algorithm_output_json || "{}"),
  }));

  const freshCtx: OptimizationContext = {
    job: { ...job, current_iteration: iterationNumber },
    currentIteration: iterationNumber,
    currentResources,
    evalResults: evalResult,
    rewardScore,
    history: freshHistory,
  };

  const shouldContinue = algorithm.shouldContinue(freshCtx);
  const newStatus = shouldContinue ? "running" : "completed";

  // Fix #1: current_iteration already incremented atomically at the start;
  // only update score/status fields here.
  await sql`
    UPDATE training_jobs SET
      best_score = ${isBest ? rewardScore : job.best_score},
      best_iteration = ${isBest ? iterationNumber : job.best_iteration},
      best_resource_version = ${isBest ? newVersion : jobRow.best_resource_version},
      status = ${newStatus},
      completed_at = ${newStatus === "completed" ? sql`now()` : null}
    WHERE job_id = ${job_id}
  `;

  // Fix #2: Auto-activate the BEST resource version when training completes,
  // regardless of whether the final iteration was the best one.
  if (newStatus === "completed" && jobRow.auto_activate) {
    const bestVersion = isBest ? newVersion : jobRow.best_resource_version;
    try {
      // Look up the best resource version's content and apply it to the agent
      if (bestVersion != null) {
        const bestResourceRows = await sql`
          SELECT content_text FROM training_resources
          WHERE org_id = ${user.org_id} AND agent_name = ${job.agent_name}
            AND resource_type = 'system_prompt' AND resource_key = 'main'
            AND version = ${bestVersion}
        `;
        if (bestResourceRows.length > 0 && bestResourceRows[0].content_text) {
          const agentRows = await sql`
            SELECT config_json FROM agents WHERE name = ${job.agent_name} AND org_id = ${user.org_id}
          `;
          if (agentRows.length > 0) {
            const config = JSON.parse(String(agentRows[0].config_json || "{}"));
            config.system_prompt = bestResourceRows[0].content_text;
            await sql`
              UPDATE agents SET config_json = ${JSON.stringify(config)}, updated_at = now()
              WHERE name = ${job.agent_name} AND org_id = ${user.org_id}
            `;
          }
        }
      }
      // Fix #4: Use direct VALUES insert with ON CONFLICT, matching agents.ts pattern
      const agentRows = await sql`
        SELECT config_json FROM agents WHERE name = ${job.agent_name} AND org_id = ${user.org_id}
      `;
      if (agentRows.length > 0) {
        const versionTag = 'training-' + job_id;
        await sql`
          INSERT INTO agent_versions (agent_name, version_number, config_json, created_by, created_at)
          VALUES (${job.agent_name}, ${versionTag}, ${String(agentRows[0].config_json)}, ${user.user_id}, now())
          ON CONFLICT (agent_name, version_number) DO UPDATE
          SET config_json = ${String(agentRows[0].config_json)}, created_by = ${user.user_id}
        `;
      }
    } catch { /* Non-critical */ }
  }

  // ── Post-training: evolve analysis + release channel ──────────
  if (newStatus === "completed") {
    // Trigger evolve analysis (fire-and-forget via queue)
    try {
      await c.env.JOB_QUEUE.send({
        type: "evolution_analysis",
        payload: { agent_name: job.agent_name, org_id: user.org_id, days: 1 },
      });
    } catch { /* Non-critical */ }

    // Create draft release channel entry if score improved
    if (isBest && rewardScore > 0.5) {
      try {
        await sql`
          INSERT INTO release_channels (org_id, agent_name, channel, version, config_json, promoted_by, promoted_at)
          VALUES (
            ${user.org_id}, ${job.agent_name}, 'training-candidate',
            ${'training-' + job_id},
            ${JSON.stringify({ source: "training", job_id, best_score: rewardScore, iterations: iterationNumber })},
            ${user.user_id}, now()
          )
          ON CONFLICT DO NOTHING
        `;
      } catch { /* Non-critical — release_channels may not exist */ }
    }
  }

  auditTraining(sql, user.org_id, user.user_id,
    newStatus === "completed" ? "training.completed" : "training.step",
    job_id, { iteration: iterationNumber, reward: rewardScore, status: newStatus },
  );

  return c.json({
    job_id,
    iteration_number: iterationNumber,
    status: newStatus,
    eval: evalResult,
    reward: { score: rewardScore, breakdown: rewardBreakdown },
    optimization: {
      algorithm: job.algorithm,
      resources_updated: optimizationResult.updatedResources.length,
      new_version: newVersion,
      metadata: optimizationResult.metadata,
    },
    is_best: isBest,
    should_continue: shouldContinue,
  });
});

// ── POST /jobs/{job_id}/cancel — cancel job ─────────────────────────

const cancelJobRoute = createRoute({
  method: "post",
  path: "/jobs/{job_id}/cancel",
  tags: ["Training"],
  summary: "Cancel a training job",
  middleware: [requireScope("training:write")],
  request: { params: z.object({ job_id: z.string() }) },
  responses: {
    200: { description: "Job cancelled", content: { "application/json": { schema: z.object({ cancelled: z.boolean() }) } } },
    ...errorResponses(404),
  },
});

trainingRoutes.openapi(cancelJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    UPDATE training_jobs SET status = 'cancelled', completed_at = now()
    WHERE job_id = ${job_id} AND org_id = ${user.org_id} AND status IN ('created', 'running', 'paused')
  `;
  if (result.count === 0) return c.json({ error: "Job not found or already finished" }, 404);

  auditTraining(sql, user.org_id, user.user_id, "training.cancelled", job_id, {});

  return c.json({ cancelled: true });
});

// ── DELETE /jobs/{job_id} — delete job ──────────────────────────────

const deleteJobRoute = createRoute({
  method: "delete",
  path: "/jobs/{job_id}",
  tags: ["Training"],
  summary: "Delete a training job",
  middleware: [requireScope("training:write")],
  request: { params: z.object({ job_id: z.string() }) },
  responses: {
    200: { description: "Job deleted", content: { "application/json": { schema: z.object({ deleted: z.string() }) } } },
    ...errorResponses(404, 409),
  },
});

trainingRoutes.openapi(deleteJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Fix #6: Prevent deleting running jobs
  const jobCheck = await sql`
    SELECT status FROM training_jobs WHERE job_id = ${job_id} AND org_id = ${user.org_id}
  `;
  if (jobCheck.length === 0) return c.json({ error: "Training job not found" }, 404);
  if (jobCheck[0].status === "running") {
    return c.json({ error: "Cannot delete a running job. Cancel it first." }, 409);
  }

  await sql`DELETE FROM training_jobs WHERE job_id = ${job_id} AND org_id = ${user.org_id}`;
  return c.json({ deleted: job_id });
});

// ── POST /jobs/{job_id}/auto-step — start unattended training ───────

const autoStepRoute = createRoute({
  method: "post",
  path: "/jobs/{job_id}/auto-step",
  tags: ["Training"],
  summary: "Start unattended training via queue",
  description: "Enqueues the first training step on the job queue. Subsequent steps are auto-enqueued until the job completes or is cancelled.",
  middleware: [requireScope("training:write")],
  request: { params: z.object({ job_id: z.string() }) },
  responses: {
    200: { description: "Auto-step started", content: { "application/json": { schema: z.object({ queued: z.boolean(), job_id: z.string() }) } } },
    ...errorResponses(404, 409),
  },
});

trainingRoutes.openapi(autoStepRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const jobs = await sql`
    SELECT status FROM training_jobs WHERE job_id = ${job_id} AND org_id = ${user.org_id}
  `;
  if (jobs.length === 0) return c.json({ error: "Training job not found" }, 404);
  if (jobs[0].status === "completed" || jobs[0].status === "cancelled") {
    return c.json({ error: `Job is already ${jobs[0].status}` }, 409);
  }

  // Mark as running if still created
  if (jobs[0].status === "created") {
    await sql`UPDATE training_jobs SET status = 'running', started_at = now() WHERE job_id = ${job_id}`;
  }

  // Enqueue first step — queue consumer will chain subsequent steps
  await c.env.JOB_QUEUE.send({
    type: "training_step",
    payload: { job_id, org_id: user.org_id },
  });

  return c.json({ queued: true, job_id });
});

// ── GET /jobs/{job_id}/iterations — list iterations ─────────────────

const listIterationsRoute = createRoute({
  method: "get",
  path: "/jobs/{job_id}/iterations",
  tags: ["Training"],
  summary: "List training iterations",
  middleware: [requireScope("training:read")],
  request: { params: z.object({ job_id: z.string() }) },
  responses: {
    200: { description: "Iteration list", content: { "application/json": { schema: z.array(IterationSummary) } } },
  },
});

trainingRoutes.openapi(listIterationsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM training_iterations
    WHERE job_id = ${job_id} AND org_id = ${user.org_id}
    ORDER BY iteration_number
  `;

  return c.json(rows.map((r: any) => ({
    iteration_id: r.iteration_id,
    iteration_number: r.iteration_number,
    status: r.status,
    pass_rate: r.pass_rate,
    reward_score: r.reward_score,
    resource_version: r.resource_version,
    started_at: r.started_at,
    completed_at: r.completed_at,
  })));
});

// ── GET /resources/{agent_name} — list resource versions ────────────

const listResourcesRoute = createRoute({
  method: "get",
  path: "/resources/{agent_name}",
  tags: ["Training"],
  summary: "List resource versions for an agent",
  middleware: [requireScope("training:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      resource_type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: {
    200: { description: "Resource versions", content: { "application/json": { schema: z.array(z.record(z.unknown())) } } },
  },
});

trainingRoutes.openapi(listResourcesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name } = c.req.valid("param");
  const { resource_type, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = resource_type
    ? await sql`
        SELECT * FROM training_resources
        WHERE org_id = ${user.org_id} AND agent_name = ${agent_name} AND resource_type = ${resource_type}
        ORDER BY version DESC LIMIT ${limit}
      `
    : await sql`
        SELECT * FROM training_resources
        WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
        ORDER BY version DESC LIMIT ${limit}
      `;

  return c.json(rows.map((r: any) => ({
    resource_id: r.resource_id,
    resource_type: r.resource_type,
    resource_key: r.resource_key,
    version: r.version,
    source: r.source,
    eval_score: r.eval_score,
    is_active: r.is_active,
    parent_version: r.parent_version,
    content_length: r.content_text?.length ?? 0,
    created_at: r.created_at,
  })));
});

// ── POST /resources/{agent_name}/{resource_type}/{resource_key}/activate

const activateResourceRoute = createRoute({
  method: "post",
  path: "/resources/{agent_name}/{resource_type}/{resource_key}/activate",
  tags: ["Training"],
  summary: "Activate a specific resource version",
  middleware: [requireScope("training:write")],
  request: {
    params: z.object({
      agent_name: z.string(),
      resource_type: z.string(),
      resource_key: z.string(),
    }),
    body: { content: { "application/json": { schema: z.object({ version: z.number().int() }) } } },
  },
  responses: {
    200: { description: "Resource activated", content: { "application/json": { schema: z.object({ activated: z.boolean(), version: z.number() }) } } },
    ...errorResponses(404),
  },
});

trainingRoutes.openapi(activateResourceRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, resource_type, resource_key } = c.req.valid("param");
  const { version } = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Deactivate all versions of this resource
  await sql`
    UPDATE training_resources SET is_active = false
    WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
      AND resource_type = ${resource_type} AND resource_key = ${resource_key}
  `;

  // Activate the requested version
  const result = await sql`
    UPDATE training_resources SET is_active = true
    WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
      AND resource_type = ${resource_type} AND resource_key = ${resource_key}
      AND version = ${version}
  `;

  if (result.count === 0) {
    return c.json({ error: "Resource version not found" }, 404);
  }

  // Apply to agent config if it's a system_prompt
  if (resource_type === "system_prompt") {
    const resourceRows = await sql`
      SELECT content_text FROM training_resources
      WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
        AND resource_type = ${resource_type} AND resource_key = ${resource_key}
        AND version = ${version}
    `;
    if (resourceRows.length > 0 && resourceRows[0].content_text) {
      const agentRows = await sql`
        SELECT config_json FROM agents WHERE name = ${agent_name} AND org_id = ${user.org_id}
      `;
      if (agentRows.length > 0) {
        const config = JSON.parse(String(agentRows[0].config_json || "{}"));
        config.system_prompt = resourceRows[0].content_text;
        await sql`
          UPDATE agents SET config_json = ${JSON.stringify(config)}, updated_at = now()
          WHERE name = ${agent_name} AND org_id = ${user.org_id}
        `;
      }
    }
  }

  auditTraining(sql, user.org_id, user.user_id, "resource.activated", agent_name, {
    resource_type, resource_key, version,
  });

  return c.json({ activated: true, version });
});

// ── GET /rewards/{agent_name} — reward history ──────────────────────

const listRewardsRoute = createRoute({
  method: "get",
  path: "/rewards/{agent_name}",
  tags: ["Training"],
  summary: "Get reward history for an agent",
  middleware: [requireScope("training:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: { description: "Reward history", content: { "application/json": { schema: z.array(z.record(z.unknown())) } } },
  },
});

trainingRoutes.openapi(listRewardsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM training_rewards
    WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
    ORDER BY created_at DESC LIMIT ${limit}
  `;

  return c.json(rows);
});

// ── POST /resources/{agent_name}/rollback — revert to previous resource ─

const rollbackRoute = createRoute({
  method: "post",
  path: "/resources/{agent_name}/rollback",
  tags: ["Training"],
  summary: "Rollback to previous resource version",
  description: "Reverts the active resource to the previous version and updates the agent config.",
  middleware: [requireScope("training:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            resource_type: z.string().default("system_prompt"),
            resource_key: z.string().default("main"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Rollback result", content: { "application/json": { schema: z.object({ reverted: z.boolean(), from_version: z.number().nullable(), to_version: z.number().nullable() }) } } },
    ...errorResponses(400, 404),
  },
});

trainingRoutes.openapi(rollbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name } = c.req.valid("param");
  const { resource_type, resource_key } = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await revertToPreviousResource(sql, user.org_id, agent_name, resource_type, resource_key);

  if (!result.reverted) {
    return c.json({ error: "No previous version to rollback to", ...result }, 404);
  }

  auditTraining(sql, user.org_id, user.user_id, "resource.rolled_back", agent_name, {
    resource_type, resource_key, from_version: result.from_version, to_version: result.to_version,
  });

  return c.json(result);
});

// ── GET /resources/{agent_name}/circuit-breaker — check circuit breaker ──

const circuitBreakerRoute = createRoute({
  method: "get",
  path: "/resources/{agent_name}/circuit-breaker",
  tags: ["Training"],
  summary: "Check circuit breaker status",
  description: "Returns whether the circuit breaker is tripped (error rate spike after resource activation). Read-only — use POST /resources/{agent_name}/rollback to revert if tripped.",
  middleware: [requireScope("training:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      window_minutes: z.coerce.number().int().min(1).max(120).default(15),
      error_threshold: z.coerce.number().min(0).max(1).default(0.3),
    }),
  },
  responses: {
    200: { description: "Circuit breaker state", content: { "application/json": { schema: z.object({
      tripped: z.boolean(),
      error_rate: z.number(),
      total_sessions: z.number(),
      error_sessions: z.number(),
      window_minutes: z.number(),
      activated_at: z.string().nullable(),
    }) } } },
  },
});

// Fix #3: GET endpoint returns status only — no destructive side effects.
// Callers should use POST /resources/{agent_name}/rollback to revert if tripped.
trainingRoutes.openapi(circuitBreakerRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name } = c.req.valid("param");
  const { window_minutes, error_threshold } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const state = await checkCircuitBreaker(sql, user.org_id, agent_name, window_minutes, error_threshold);

  return c.json(state);
});
