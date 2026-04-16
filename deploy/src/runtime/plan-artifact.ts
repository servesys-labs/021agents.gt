import type { QueryRouteLike } from "./query-profile";

export interface PlanningArtifactStep {
  id: string;
  title: string;
  acceptance: string;
}

export interface PlanningArtifactAlternative {
  option: string;
  rationale: string;
}

export interface PlanningArtifact {
  schema_version: "plan.v1";
  goal: string;
  steps: PlanningArtifactStep[];
  assumptions: string[];
  alternatives: PlanningArtifactAlternative[];
  tradeoffs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((item) => readNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  return out.length > 0 ? out : null;
}

function parseCandidate(candidate: string): Record<string, unknown> | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractPlanningArtifact(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const candidates: string[] = [raw];
  for (const match of raw.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  for (const match of raw.matchAll(/```\s*([\s\S]*?)```/g)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export function validatePlanningArtifact(
  artifact: Record<string, unknown> | null,
): { ok: true; artifact: PlanningArtifact } | { ok: false; reason: "planning_artifact_missing" | "planning_artifact_invalid" } {
  if (!artifact) return { ok: false, reason: "planning_artifact_missing" };

  if (artifact.schema_version !== "plan.v1") {
    return { ok: false, reason: "planning_artifact_invalid" };
  }

  const goal = readNonEmptyString(artifact.goal);
  if (!goal) return { ok: false, reason: "planning_artifact_invalid" };

  if (!Array.isArray(artifact.steps) || artifact.steps.length === 0) {
    return { ok: false, reason: "planning_artifact_invalid" };
  }
  const steps: PlanningArtifactStep[] = [];
  for (const step of artifact.steps) {
    if (!isRecord(step)) return { ok: false, reason: "planning_artifact_invalid" };
    const id = readNonEmptyString(step.id);
    const title = readNonEmptyString(step.title);
    const acceptance = readNonEmptyString(step.acceptance);
    if (!id || !title || !acceptance) {
      return { ok: false, reason: "planning_artifact_invalid" };
    }
    steps.push({ id, title, acceptance });
  }

  const assumptions = readStringArray(artifact.assumptions);
  const tradeoffs = readStringArray(artifact.tradeoffs);
  if (!assumptions || !tradeoffs) {
    return { ok: false, reason: "planning_artifact_invalid" };
  }

  if (!Array.isArray(artifact.alternatives) || artifact.alternatives.length === 0) {
    return { ok: false, reason: "planning_artifact_invalid" };
  }
  const alternatives: PlanningArtifactAlternative[] = [];
  for (const alt of artifact.alternatives) {
    if (!isRecord(alt)) return { ok: false, reason: "planning_artifact_invalid" };
    const option = readNonEmptyString(alt.option);
    const rationale = readNonEmptyString(alt.rationale);
    if (!option || !rationale) {
      return { ok: false, reason: "planning_artifact_invalid" };
    }
    alternatives.push({ option, rationale });
  }

  return {
    ok: true,
    artifact: {
      schema_version: "plan.v1",
      goal,
      steps,
      assumptions,
      alternatives,
      tradeoffs,
    },
  };
}

export function requiresPlanningArtifact(route: QueryRouteLike, input: string): boolean {
  const complexity = String(route?.complexity || "moderate").toLowerCase();
  const category = String(route?.category || "general").toLowerCase();
  const role = String(route?.role || complexity).toLowerCase();
  const q = String(input || "").toLowerCase();

  if (complexity === "complex") return true;
  if (category === "coding" && role === "planner") return true;
  if (/\b(build|deploy)\b/.test(q)) return true;

  const asksForPlan = /\b(plan|roadmap|outline|steps)\b/.test(q);
  const largeTaskShape = /\b(build|deploy|refactor|migrate|migration|architect|architecture|implementation|system|codebase|multi-file)\b/.test(q);
  if (asksForPlan && largeTaskShape) return true;

  return false;
}
