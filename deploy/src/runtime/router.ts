/**
 * Edge Runtime — Plan-Based Model Router.
 *
 * Classifies task complexity and category, then selects the optimal
 * model from the agent's plan routing table.
 *
 * Routing hierarchy:
 *   1. Category-specific route (coding.planner, research.synthesize, etc.)
 *   2. General route for complexity tier (general.simple, general.complex)
 *   3. Flat routing table fallback
 *   4. Default model
 *
 * Plans are loaded from agent config_json.plan or config/default.json.
 */

// ── Types ─────────────────────────────────────────────────────

export type ComplexityTier = "simple" | "moderate" | "complex" | "tool_call" | "image_gen" | "vision" | "tts" | "stt";

export type TaskCategory = "coding" | "research" | "creative" | "multimodal" | "general";

export type TaskRole =
  | "planner" | "implementer" | "reviewer" | "debugger"  // coding
  | "search" | "analyze" | "synthesize"                    // research
  | "write" | "image" | "voice"                            // creative
  | "simple" | "moderate" | "complex" | "tool_call"        // general
  | "image_gen" | "vision" | "tts" | "stt";               // multimodal

export interface RouteDecision {
  model: string;
  provider: string;
  max_tokens: number;
  complexity: ComplexityTier;
  category: TaskCategory;
  role: TaskRole;
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

// ── Complexity Classification ─────────────────────────────────

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
 *
 * @param input — user's task text
 * @param planRouting — plan routing table from agent config
 * @param defaultModel — fallback model
 * @param defaultProvider — fallback provider
 */
export function selectModel(
  input: string,
  planRouting: PlanRouting | undefined,
  defaultModel: string,
  defaultProvider: string,
): RouteDecision {
  const complexity = classifyComplexity(input);
  const category = classifyCategory(input);
  const role = classifyRole(input, category);

  if (!planRouting || Object.keys(planRouting).length === 0) {
    return {
      model: defaultModel,
      provider: defaultProvider,
      max_tokens: complexity === "complex" ? 8192 : complexity === "moderate" ? 4096 : 2048,
      complexity,
      category,
      role,
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
        max_tokens: route.max_tokens || 4096,
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
        max_tokens: route.max_tokens || 4096,
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
    max_tokens: complexity === "complex" ? 8192 : 4096,
    complexity,
    category,
    role,
  };
}
