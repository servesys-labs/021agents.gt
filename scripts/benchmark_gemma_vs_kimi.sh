#!/usr/bin/env bash
set -euo pipefail

# Benchmark GPU Gemma path vs Workers AI Kimi.
#
# Required:
#   SERVICE_TOKEN
#
# Optional:
#   BENCH_RUNTIME_URL         (default: https://runtime.oneshots.co)
#   BENCH_REPEATS             (default: 2)
#   BENCH_GEMMA_MODEL         (default: gemma-4-26b-moe)
#   BENCH_GEMMA_PROVIDER      (default: custom-gemma4-fast)
#   BENCH_KIMI_MODEL          (default: @cf/moonshotai/kimi-k2.5)
#   BENCH_KIMI_PROVIDER       (default: workers-ai)
#   BENCH_PROMPTS_FILE        (newline-delimited prompts; fallback built-ins if unset)
#
# Usage:
#   set -a && source .env && set +a
#   bash scripts/benchmark_gemma_vs_kimi.sh

RUNTIME_URL="${BENCH_RUNTIME_URL:-https://runtime.oneshots.co}"
REPEATS="${BENCH_REPEATS:-2}"
GEMMA_MODEL="${BENCH_GEMMA_MODEL:-gemma-4-26b-moe}"
GEMMA_PROVIDER="${BENCH_GEMMA_PROVIDER:-custom-gemma4-fast}"
KIMI_MODEL="${BENCH_KIMI_MODEL:-@cf/moonshotai/kimi-k2.5}"
KIMI_PROVIDER="${BENCH_KIMI_PROVIDER:-workers-ai}"
PROMPTS_FILE="${BENCH_PROMPTS_FILE:-}"

if [[ -z "${SERVICE_TOKEN:-}" ]]; then
  echo "Missing SERVICE_TOKEN" >&2
  exit 1
fi

export RUNTIME_URL REPEATS SERVICE_TOKEN GEMMA_MODEL GEMMA_PROVIDER KIMI_MODEL KIMI_PROVIDER PROMPTS_FILE

python3 - <<'PY'
import json
import os
import subprocess
import statistics
import time

runtime_url = os.environ["RUNTIME_URL"]
repeats = int(os.environ["REPEATS"])
service_token = os.environ["SERVICE_TOKEN"]
gemma_model = os.environ["GEMMA_MODEL"]
gemma_provider = os.environ["GEMMA_PROVIDER"]
kimi_model = os.environ["KIMI_MODEL"]
kimi_provider = os.environ["KIMI_PROVIDER"]
prompts_file = os.environ.get("PROMPTS_FILE", "").strip()

if prompts_file:
    with open(prompts_file, "r", encoding="utf-8") as f:
        prompts = [line.strip() for line in f if line.strip()]
else:
    prompts = [
        "Summarize the key idea of retrieval-augmented generation in 4 bullets.",
        "Write a concise TypeScript function to debounce a callback and explain edge cases.",
        "Compare Redis vs Postgres for session storage in a web app.",
        "Given this list [3,1,4,1,5], return sorted unique values and explain complexity.",
        "Draft a short customer-facing incident update for a 15-minute API outage.",
    ]

models = [
    {"label": "gemma_gpu", "model": gemma_model, "provider": gemma_provider},
    {"label": "kimi_workers", "model": kimi_model, "provider": kimi_provider},
]

endpoint = runtime_url.rstrip("/") + "/cf/llm/infer"

def run_once(model_cfg, prompt):
    payload = {
        "model": model_cfg["model"],
        "provider": model_cfg["provider"],
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 600,
        "temperature": 0,
    }
    started = time.perf_counter()
    try:
        cmd = [
            "curl", "-sS", "-w", "\\n%{http_code}",
            "-X", "POST", endpoint,
            "-H", f"Authorization: Bearer {service_token}",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "curl failed").strip())
        txt = proc.stdout
        body, _, code_text = txt.rpartition("\n")
        status = int(code_text.strip() or "0")
        if status < 200 or status >= 300:
            return {
                "ok": False,
                "status": status,
                "elapsed_ms": elapsed_ms,
                "model_latency_ms": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": 0.0,
                "output": "",
                "error": f"HTTP {status}: {body[:300]}",
            }
        data = json.loads(body or "{}")
        return {
            "ok": True,
            "status": status,
            "elapsed_ms": elapsed_ms,
            "model_latency_ms": float(data.get("latency_ms", 0) or 0),
            "input_tokens": int(data.get("input_tokens", 0) or 0),
            "output_tokens": int(data.get("output_tokens", 0) or 0),
            "cost_usd": float(data.get("cost_usd", 0) or 0),
            "output": str(data.get("content", "")),
            "error": "",
        }
    except Exception as e:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return {
            "ok": False,
            "status": 0,
            "elapsed_ms": elapsed_ms,
            "model_latency_ms": 0.0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
            "output": "",
            "error": str(e),
        }

results = []
for prompt_idx, prompt in enumerate(prompts, start=1):
    for model_cfg in models:
        for run_idx in range(1, repeats + 1):
            res = run_once(model_cfg, prompt)
            res.update({
                "prompt_idx": prompt_idx,
                "prompt": prompt,
                "run_idx": run_idx,
                "label": model_cfg["label"],
                "model": model_cfg["model"],
                "provider": model_cfg["provider"],
            })
            results.append(res)

def agg(label):
    rows = [r for r in results if r["label"] == label]
    ok_rows = [r for r in rows if r["ok"]]
    fail_rows = [r for r in rows if not r["ok"]]
    def avg(key):
        vals = [float(r[key]) for r in ok_rows]
        return statistics.mean(vals) if vals else 0.0
    return {
        "runs": len(rows),
        "success": len(ok_rows),
        "fail": len(fail_rows),
        "success_rate": (len(ok_rows) / len(rows) * 100.0) if rows else 0.0,
        "avg_elapsed_ms": avg("elapsed_ms"),
        "avg_model_latency_ms": avg("model_latency_ms"),
        "avg_input_tokens": avg("input_tokens"),
        "avg_output_tokens": avg("output_tokens"),
        "avg_cost_usd": avg("cost_usd"),
    }

gemma_summary = agg("gemma_gpu")
kimi_summary = agg("kimi_workers")

print("")
print("## Gemma vs Kimi Benchmark")
print("")
print(f"- Endpoint: `{endpoint}`")
print(f"- Prompts: `{len(prompts)}`")
print(f"- Repeats per prompt/model: `{repeats}`")
print("")
print("| Model | Runs | Success | Success Rate | Avg E2E ms | Avg Model ms | Avg In Tok | Avg Out Tok | Avg Cost USD |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
print(
    f"| gemma_gpu (`{gemma_model}`) | {gemma_summary['runs']} | {gemma_summary['success']} | "
    f"{gemma_summary['success_rate']:.1f}% | {gemma_summary['avg_elapsed_ms']:.1f} | "
    f"{gemma_summary['avg_model_latency_ms']:.1f} | {gemma_summary['avg_input_tokens']:.1f} | "
    f"{gemma_summary['avg_output_tokens']:.1f} | {gemma_summary['avg_cost_usd']:.6f} |"
)
print(
    f"| kimi_workers (`{kimi_model}`) | {kimi_summary['runs']} | {kimi_summary['success']} | "
    f"{kimi_summary['success_rate']:.1f}% | {kimi_summary['avg_elapsed_ms']:.1f} | "
    f"{kimi_summary['avg_model_latency_ms']:.1f} | {kimi_summary['avg_input_tokens']:.1f} | "
    f"{kimi_summary['avg_output_tokens']:.1f} | {kimi_summary['avg_cost_usd']:.6f} |"
)

print("")
print("## Sample Outputs")
print("")
for prompt_idx in range(1, min(4, len(prompts) + 1)):
    print(f"### Prompt {prompt_idx}")
    print(prompts[prompt_idx - 1])
    for label in ("gemma_gpu", "kimi_workers"):
        rows = [r for r in results if r["label"] == label and r["prompt_idx"] == prompt_idx and r["ok"]]
        sample = rows[0]["output"][:220].replace("\n", " ") if rows else "<no successful output>"
        print(f"- {label}: {sample}")
    print("")

# Save machine-readable output for further analysis.
out_path = f"/tmp/benchmark_gemma_vs_kimi_{int(time.time())}.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"results": results, "gemma_summary": gemma_summary, "kimi_summary": kimi_summary}, f, indent=2)
print(f"Saved raw results: {out_path}")
PY
