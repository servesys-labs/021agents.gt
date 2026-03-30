/**
 * Edge Runtime — Plan-Based Model Router.
 *
 * Classifies task complexity and category, then selects the optimal
 * model from the agent's plan routing table.
 *
 * Classification uses a fast LLM call (Workers AI glm-4.7-flash, free, ~200ms)
 * to classify all 3 dimensions in one call. Falls back to regex if LLM fails.
 *
 * Routing hierarchy:
 *   1. Category-specific route (coding.planner, research.synthesize, etc.)
 *   2. General route for complexity tier (general.simple, general.complex)
 *   3. Flat routing table fallback
 *   4. Default model
 *
 * Plans are loaded from agent config_json.plan or config/default.json.
 */

import type { RuntimeEnv } from "./types";

// ── Types ─────────────────────────────────────────────────────

export type ComplexityTier = "simple" | "moderate" | "complex" | "tool_call" | "image_gen" | "vision" | "tts" | "stt";

export type TaskCategory = "coding" | "research" | "creative" | "multimodal" | "general";

export type TaskRole =
  | "planner" | "implementer" | "reviewer" | "debugger"  // coding
  | "search" | "analyze" | "synthesize"                    // research
  | "write" | "image" | "voice"                            // creative
  | "simple" | "moderate" | "complex" | "tool_call"        // general
  | "image_gen" | "vision" | "tts" | "stt";               // multimodal

export interface RouteClassification {
  complexity: "simple" | "moderate" | "complex";
  category: "general" | "coding" | "research" | "creative" | "multimodal";
  role: string;
}

export interface RouteDecision {
  model: string;
  provider: string;
  max_tokens: number;
  complexity: ComplexityTier;
  category: TaskCategory;
  role: TaskRole;
  /** Cost of the classification LLM call (included in routing overhead). */
  routing_cost_usd: number;
}

export interface PlanRouting {
  [category: string]: {
    [role: string]: {
      model: string;
      provider: string;
      max_tokens?: number;
    };
  };
}

// ── LLM Classifier ────────────────────────────────────────────

const VALID_COMPLEXITIES = new Set(["simple", "moderate", "complex"]);
const VALID_CATEGORIES = new Set(["general", "coding", "research", "creative", "multimodal"]);
const VALID_ROLES = new Set([
  "planner", "implementer", "reviewer", "debugger",
  "search", "analyze", "synthesize",
  "write", "image", "voice",
  "simple", "moderate", "complex",
]);

/**
 * Classify a user message across all 3 dimensions in a single fast LLM call.
 * Uses Workers AI glm-4.7-flash (free, ~200ms). Falls back to regex classifiers
 * if the LLM call fails or env.AI is unavailable.
 *
 * Results are cached per session via an optional sessionCache Map.
 */
export async function classifyTurn(
  input: string,
  env: RuntimeEnv,
  sessionCache?: Map<string, RouteClassification>,
): Promise<RouteClassification> {
  // Check session cache first
  if (sessionCache) {
    const cached = sessionCache.get(input);
    if (cached) return cached;
  }

  // Fall back to regex if no AI binding
  if (!env.AI) {
    return classifyTurnRegex(input);
  }

  try {
    const classifierPrompt = `Classify this user message into exactly 3 dimensions. Return ONLY valid JSON.

Message: "${input.slice(0, 500)}"

Respond with:
{"complexity":"simple|moderate|complex","category":"general|coding|research|creative|multimodal","role":"<role>"}

Rules:
- complexity: "simple" = greeting/yes/no/short factual, "moderate" = normal question/task, "complex" = multi-step analysis/comparison/design
- category: "coding" = writing/debugging/reviewing code, "research" = searching/analyzing data, "creative" = writing prose/stories/marketing, "multimodal" = images/audio/video, "general" = everything else
- role: for coding = planner|implementer|reviewer|debugger, for research = search|analyze|synthesize, for creative = write, for general = use complexity value`;

    const response = await env.AI.run("@cf/zai-org/glm-4.7-flash" as any, {
      messages: [{ role: "user", content: classifierPrompt }],
      max_tokens: 50,
    });

    const text = typeof response === "string"
      ? response
      : (response as any)?.response || (response as any)?.result || "";

    // Extract JSON from response (handle markdown fences, leading text, etc.)
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const complexity = VALID_COMPLEXITIES.has(parsed.complexity) ? parsed.complexity : "moderate";
      const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : "general";
      const role = VALID_ROLES.has(parsed.role) ? parsed.role : complexity;

      const result: RouteClassification = { complexity, category, role };

      // Cache the result
      if (sessionCache) {
        sessionCache.set(input, result);
      }

      return result;
    }
  } catch {
    // LLM call failed — fall through to regex
  }

  // Regex fallback
  const result = classifyTurnRegex(input);
  if (sessionCache) {
    sessionCache.set(input, result);
  }
  return result;
}

/**
 * Regex-based fallback classifier. Returns all 3 dimensions using
 * the original pattern-matching heuristics.
 */
function classifyTurnRegex(input: string): RouteClassification {
  const complexity = classifyComplexity(input);
  const category = classifyCategory(input);
  const role = classifyRole(input, category);

  // Normalize multimodal complexity tiers to simple/moderate/complex for RouteClassification
  const normalizedComplexity: "simple" | "moderate" | "complex" =
    complexity === "simple" ? "simple"
    : complexity === "complex" ? "complex"
    : "moderate";

  return {
    complexity: normalizedComplexity,
    category,
    role: role as string,
  };
}

// ── Complexity Classification (regex fallback) ────────────────

const COMPLEX_SIGNALS = [
  /\b(analyze|explain|compare|evaluate|design|architect|plan|review|debug|refactor)\b/i,
  /\b(step.by.step|in.detail|comprehensive|thorough|deep.dive)\b/i,
  /\b(trade.?offs?|pros?.and.cons|implications|consequences)\b/i,
  /\bwhy\b.*\?/i,
  /\bhow\b.*\bwork/i,
];

const SIMPLE_SIGNALS = [
  /^(hi|hello|hey|thanks|ok|yes|no|sure)\b/i,
  /\b(what is|define|translate|convert|list)\b/i,
  /\b(one word|brief|short|quick)\b/i,
];

const CODING_SIGNALS = [
  /\b(code|function|class|module|api|endpoint|bug|error|test|deploy|git|npm|pip)\b/i,
  /\b(javascript|typescript|python|rust|go|java|sql|html|css|react|vue|svelte)\b/i,
  /\b(refactor|implement|fix|debug|review|write.*code)\b/i,
  /```/,
];

const RESEARCH_SIGNALS = [
  /\b(research|investigate|find|search|look.up|what.*latest|recent|current)\b/i,
  /\b(compare|analyze|summarize|synthesis|report|paper|article)\b/i,
  /\b(data|statistics|trends|market|industry)\b/i,
];

const CREATIVE_SIGNALS = [
  /\b(write|draft|compose|create|generate|design)\b/i,
  /\b(story|poem|essay|blog|email|letter|article|copy|script)\b/i,
  /\b(image|picture|illustration|logo|graphic|video|audio)\b/i,
];

/**
 * Classify task complexity tier.
 */
// Multimodal detection patterns
const IMAGE_GEN_SIGNALS = [/\b(generate|create|draw|make)\b.*\b(image|picture|photo|illustration|art)\b/i, /\bimage.?gen/i, /\bdall-?e\b/i];
const VISION_SIGNALS = [/\b(look at|describe|analyze)\b.*\b(image|picture|photo|screenshot)\b/i, /\bvision\b/i, /\bOCR\b/i];
const TTS_SIGNALS = [/\b(read aloud|speak|say|text.?to.?speech|TTS)\b/i, /\bvoice\b.*\b(generate|output)\b/i];
const STT_SIGNALS = [/\b(transcribe|speech.?to.?text|STT|listen to)\b/i, /\baudio\b.*\b(text|convert)\b/i];

export function classifyComplexity(input: string): ComplexityTier {
  // Check multimodal first — these are specialized tiers
  if (IMAGE_GEN_SIGNALS.some((r) => r.test(input))) return "image_gen";
  if (VISION_SIGNALS.some((r) => r.test(input))) return "vision";
  if (TTS_SIGNALS.some((r) => r.test(input))) return "tts";
  if (STT_SIGNALS.some((r) => r.test(input))) return "stt";

  const words = input.split(/\s+/).length;
  const complexScore = COMPLEX_SIGNALS.filter((r) => r.test(input)).length;
  const simpleScore = SIMPLE_SIGNALS.filter((r) => r.test(input)).length;

  if (simpleScore > 0 && complexScore === 0 && words < 20) return "simple";
  if (complexScore >= 2 || words > 100) return "complex";
  return "moderate";
}

/**
 * Classify task category.
 */
export function classifyCategory(input: string): TaskCategory {
  // Check multimodal first
  const multimodalScore = [...IMAGE_GEN_SIGNALS, ...VISION_SIGNALS, ...TTS_SIGNALS, ...STT_SIGNALS]
    .filter((r) => r.test(input)).length;

  const scores = {
    coding: CODING_SIGNALS.filter((r) => r.test(input)).length,
    research: RESEARCH_SIGNALS.filter((r) => r.test(input)).length,
    creative: CREATIVE_SIGNALS.filter((r) => r.test(input)).length,
    multimodal: multimodalScore,
  };

  const max = Math.max(scores.coding, scores.research, scores.creative, scores.multimodal);
  if (max === 0) return "general";
  if (scores.multimodal === max && scores.multimodal > 0) return "multimodal";
  if (scores.coding === max) return "coding";
  if (scores.research === max) return "research";
  return "creative";
}

/**
 * Detect the task role within a category.
 */
export function classifyRole(input: string, category: TaskCategory): TaskRole {
  if (category === "coding") {
    if (/\b(plan|design|architect|structure)\b/i.test(input)) return "planner";
    if (/\b(review|audit|check|verify)\b/i.test(input)) return "reviewer";
    if (/\b(debug|fix|error|bug|trace|diagnose)\b/i.test(input)) return "debugger";
    return "implementer";
  }
  if (category === "research") {
    if (/\b(search|find|look.up|discover)\b/i.test(input)) return "search";
    if (/\b(synthe|summar|conclude|recommend)\b/i.test(input)) return "synthesize";
    return "analyze";
  }
  if (category === "creative") {
    if (/\b(image|picture|illustration|logo|graphic)\b/i.test(input)) return "image";
    if (/\b(voice|speak|audio|tts|speech)\b/i.test(input)) return "voice";
    return "write";
  }
  // general — map to complexity tier
  return classifyComplexity(input);
}

// ── Route Selection ───────────────────────────────────────────

/**
 * Select the optimal model for a task based on plan routing.
 * Uses the LLM classifier (classifyTurn) for accurate classification,
 * with regex fallback.
 *
 * @param input — user's task text
 * @param planRouting — plan routing table from agent config
 * @param defaultModel — fallback model
 * @param defaultProvider — fallback provider
 * @param env — runtime environment (for AI binding)
 * @param sessionCache — optional per-session cache to avoid re-classifying
 */
export async function selectModel(
  input: string,
  planRouting: PlanRouting | undefined,
  defaultModel: string,
  defaultProvider: string,
  env?: RuntimeEnv,
  sessionCache?: Map<string, RouteClassification>,
): Promise<RouteDecision> {
  // Skip LLM classification — simplified plans use one model per plan.
  // Use fast regex classification only (no extra LLM call = lower latency + cost).
  let complexity: ComplexityTier;
  let category: TaskCategory;
  let role: TaskRole;
  let routingCostUsd = 0;

  {
    const classification = classifyTurnRegex(input);
    complexity = classification.complexity as ComplexityTier;
    category = classification.category as TaskCategory;
    role = classification.role as TaskRole;
  }

  if (!planRouting || Object.keys(planRouting).length === 0) {
    return {
      model: defaultModel,
      provider: defaultProvider,
      max_tokens: 0, // Let model decide output length
      complexity,
      category,
      role,
      routing_cost_usd: routingCostUsd,
    };
  }

  // 1. Try category-specific route
  const categoryRoutes = planRouting[category];
  if (categoryRoutes) {
    const route = categoryRoutes[role] || categoryRoutes[complexity];
    if (route) {
      return {
        model: route.model || defaultModel,
        provider: route.provider || defaultProvider,
        max_tokens: 0, // Let model decide
        complexity,
        category,
        role,
      };
    }
  }

  // 2. Try general routes
  const generalRoutes = planRouting["general"];
  if (generalRoutes) {
    const route = generalRoutes[complexity] || generalRoutes["moderate"];
    if (route) {
      return {
        model: route.model || defaultModel,
        provider: route.provider || defaultProvider,
        max_tokens: 0, // Let model decide
        complexity,
        category,
        role,
      };
    }
  }

  // 3. Fallback
  return {
    model: defaultModel,
    provider: defaultProvider,
    max_tokens: 0, // Let model decide
    complexity,
    category,
    role,
  };
}
