import { api } from "./api";

// --- Types ---

export interface TrainingIteration {
  iteration: number;
  pass_rate: number;
  reward_score: number;
  cost_usd: number;
  duration_ms: number;
  improvements: string[];
}

export interface TrainingJob {
  id: string;
  agent_name: string;
  status: "created" | "running" | "completed" | "failed";
  algorithm: string;
  max_iterations: number;
  current_iteration: number;
  best_score: number;
  auto_activate: boolean;
  iterations: TrainingIteration[];
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface TrainingConfig {
  algorithm?: "hill_climb" | "beam_search" | "genetic";
  max_iterations?: number;
  auto_activate?: boolean;
}

export type TrainingEventType =
  | "iteration_start"
  | "iteration_end"
  | "eval_result"
  | "optimization"
  | "complete"
  | "error";

export interface TrainingEvent {
  type: TrainingEventType;
  data: Record<string, unknown>;
}

// --- API calls ---

export async function createTrainingJob(
  agentName: string,
  config: TrainingConfig = {}
): Promise<TrainingJob> {
  const res = await api.post<{ job: TrainingJob }>("/training/jobs", {
    agent_name: agentName,
    ...config,
  });
  return res.job;
}

export async function listTrainingJobs(agentName: string): Promise<TrainingJob[]> {
  const res = await api.get<{ jobs: TrainingJob[] }>(
    `/training/jobs?agent_name=${encodeURIComponent(agentName)}`
  );
  return res.jobs ?? [];
}

export async function getTrainingJob(jobId: string): Promise<TrainingJob> {
  const res = await api.get<{ job: TrainingJob }>(`/training/jobs/${encodeURIComponent(jobId)}`);
  return res.job;
}

/**
 * Stream training progress via SSE (GET request).
 */
export function streamTrainingProgress(
  jobId: string,
  onEvent: (event: TrainingEvent) => void
): { abort: () => void } {
  const controller = new AbortController();

  const run = async () => {
    let res: Response;
    try {
      res = await fetch(
        `${api.baseUrl}/training/jobs/${encodeURIComponent(jobId)}/progress`,
        {
          headers: {
            ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
          },
          signal: controller.signal,
        }
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      onEvent({
        type: "error",
        data: { message: `Connection failed: ${(err as Error).message}` },
      });
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      onEvent({ type: "error", data: { message: `HTTP ${res.status}: ${text}` } });
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      onEvent({ type: "error", data: { message: "No readable stream" } });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("data:")) {
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
              const parsed = JSON.parse(raw);
              const eventType: TrainingEventType = parsed.type ?? "iteration_end";
              onEvent({ type: eventType, data: parsed });
            } catch {
              // ignore malformed lines
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onEvent({
          type: "error",
          data: { message: `Stream error: ${(err as Error).message}` },
        });
      }
    }
  };

  run().catch((err) => {
    if (err.name !== "AbortError") {
      onEvent({ type: "error", data: { message: err.message } });
    }
  });

  return { abort: () => controller.abort() };
}
