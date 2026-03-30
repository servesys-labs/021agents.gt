/**
 * Training adapters — convert existing telemetry into algorithm-specific formats.
 *
 * Maps Agent Lightning's adapter concept onto our session/turn data model.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface Triplet {
  prompt: string;
  response: string;
  reward: number;
}

export interface SessionRecord {
  session_id: string;
  agent_name: string;
  input_text: string | null;
  output_text: string | null;
  status: string;
  cost_total_usd: number | null;
}

export interface TurnRecord {
  turn_number: number;
  content: string | null;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface EvalTrialRecord {
  task_name: string;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  score: number | null;
}

// ── Adapters ───────────────────────────────────────────────────────────

/**
 * Convert session records into (prompt, response, reward) triplets.
 * Used by RL-style algorithms.
 */
export function sessionsToTriplets(
  sessions: SessionRecord[],
  rewards: Map<string, number>,
): Triplet[] {
  return sessions
    .filter((s) => s.input_text && s.output_text)
    .map((s) => ({
      prompt: s.input_text!,
      response: s.output_text!,
      reward: rewards.get(s.session_id) ?? (s.status === "completed" ? 0.5 : 0.0),
    }));
}

/**
 * Convert eval trials into a reward map keyed by task name.
 */
export function evalTrialsToRewardMap(trials: EvalTrialRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const trial of trials) {
    const score = trial.passed ? 1.0 : (trial.score ?? 0.0);
    map.set(trial.task_name, score);
  }
  return map;
}

/**
 * Extract the failing eval trials as text summaries for APO gradient computation.
 */
export function extractFailureSummaries(trials: EvalTrialRecord[]): string[] {
  return trials
    .filter((t) => !t.passed)
    .map((t) => {
      let summary = `Task "${t.task_name}": Input="${t.input}"`;
      if (t.expected) summary += `, Expected="${t.expected}"`;
      if (t.actual) summary += `, Got="${t.actual}"`;
      return summary;
    });
}

/**
 * Flatten multi-turn sessions into prompt-response pairs for SFT.
 */
export function sessionsToConversationPairs(
  sessions: SessionRecord[],
  turns: Map<string, TurnRecord[]>,
): Array<{ messages: Array<{ role: string; content: string }> }> {
  const conversations: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  for (const session of sessions) {
    const sessionTurns = turns.get(session.session_id) ?? [];
    if (sessionTurns.length === 0) continue;

    const messages: Array<{ role: string; content: string }> = [];

    if (session.input_text) {
      messages.push({ role: "user", content: session.input_text });
    }

    for (const turn of sessionTurns) {
      if (turn.content) {
        // Alternate user/assistant based on turn number
        const role = turn.turn_number % 2 === 1 ? "assistant" : "user";
        messages.push({ role, content: turn.content });
      }
    }

    if (messages.length > 0) {
      conversations.push({ messages });
    }
  }

  return conversations;
}
