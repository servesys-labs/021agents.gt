#!/usr/bin/env node
/**
 * Migrate legacy eval artifacts from local filesystem into control-plane APIs.
 *
 * Usage:
 *   node scripts/migrate-eval-from-filesystem.mjs \
 *     --base-url http://127.0.0.1:8787 \
 *     --token <JWT_OR_API_KEY> \
 *     --root ../data/eval
 */
import { promises as fs } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = value;
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir) {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function postJson(baseUrl, token, route, body) {
  const resp = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${route} -> ${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(args["base-url"] || "").trim().replace(/\/+$/, "");
  const token = String(args.token || "").trim();
  const root = path.resolve(process.cwd(), String(args.root || "../data/eval"));

  if (!baseUrl || !token) {
    throw new Error("Missing required --base-url or --token");
  }

  const tasksDir = path.join(root, "tasks");
  const datasetsDir = path.join(root, "datasets");
  const evaluatorsFile = path.join(root, "evaluators.json");
  const experimentsFile = path.join(root, "experiments.json");

  const summary = {
    tasks: 0,
    datasets: 0,
    evaluators: 0,
    experiments: 0,
    warnings: [],
  };

  // Tasks
  for (const file of await listFiles(tasksDir)) {
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file, ext);
    const raw = await fs.readFile(file, "utf8");
    let tasks = [];
    if (ext === ".jsonl") {
      tasks = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    } else if (ext === ".json") {
      const parsed = JSON.parse(raw);
      tasks = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      summary.warnings.push(`Skipping unsupported task file: ${file}`);
      continue;
    }
    await postJson(baseUrl, token, "/api/v1/eval/tasks", { name, tasks });
    summary.tasks += 1;
  }

  // Datasets
  for (const file of await listFiles(datasetsDir)) {
    if (path.extname(file).toLowerCase() !== ".json") continue;
    const name = path.basename(file, ".json");
    const parsed = await readJson(file);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    await postJson(baseUrl, token, "/api/v1/eval/datasets", { name, items });
    summary.datasets += 1;
  }

  // Evaluators
  if (await exists(evaluatorsFile)) {
    const evaluators = await readJson(evaluatorsFile);
    if (Array.isArray(evaluators)) {
      for (const ev of evaluators) {
        await postJson(baseUrl, token, "/api/v1/eval/evaluators", {
          name: String(ev?.name || "").trim(),
          kind: String(ev?.kind || "rule"),
          config: ev?.config || {},
        });
        summary.evaluators += 1;
      }
    } else {
      summary.warnings.push("evaluators.json exists but is not an array");
    }
  }

  // Experiments
  if (await exists(experimentsFile)) {
    const experiments = await readJson(experimentsFile);
    if (Array.isArray(experiments)) {
      for (const exp of experiments) {
        await postJson(baseUrl, token, "/api/v1/eval/experiments", {
          name: String(exp?.name || "").trim(),
          agent_name: String(exp?.agent_name || "").trim(),
          dataset: String(exp?.dataset || "").trim(),
          evaluator: String(exp?.evaluator || "").trim(),
          metadata: exp?.metadata || {},
        });
        summary.experiments += 1;
      }
    } else {
      summary.warnings.push("experiments.json exists but is not an array");
    }
  }

  console.log(JSON.stringify({ ok: true, root, summary }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
