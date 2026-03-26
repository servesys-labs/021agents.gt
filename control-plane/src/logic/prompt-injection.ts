/**
 * Prompt Injection Detector — pattern-based detection for common injection vectors.
 *
 * Detects instruction overrides, role play attacks, prompt extraction,
 * encoding attacks, delimiter injection, and indirect injection.
 */

// ── Types ───────────────────────────────────────────────────────

export interface InjectionPattern {
  name: string;
  pattern: RegExp;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
}

export interface InjectionResult {
  detected: boolean;
  score: number;
  patterns: string[];
  recommendation: "allow" | "warn" | "block";
}

// ── Pattern definitions ─────────────────────────────────────────

export const INJECTION_PATTERNS: InjectionPattern[] = [
  // Instruction override
  {
    name: "instruction_override",
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:previous|prior|above|all|your|the)\s+(?:instructions?|prompts?|rules?|guidelines?|constraints?|directions?)\b/i,
    severity: "critical",
    description: "Attempts to override or ignore system instructions",
  },
  {
    name: "new_instructions",
    pattern: /\b(?:new\s+instructions?|from\s+now\s+on|instead\s+(?:you\s+)?(?:should|must|will)|your\s+(?:new|real|actual)\s+(?:instructions?|role|purpose))\b/i,
    severity: "critical",
    description: "Attempts to inject new instructions",
  },
  {
    name: "do_not_follow",
    pattern: /\b(?:do\s+not\s+follow|stop\s+following|cease\s+following)\s+(?:your|the|those|these|any)\s+(?:instructions?|rules?|guidelines?)\b/i,
    severity: "high",
    description: "Instructs the model to stop following its guidelines",
  },

  // Role play
  {
    name: "role_play",
    pattern: /\b(?:you\s+are\s+now|pretend\s+(?:you\s+are|to\s+be)|act\s+as\s+(?:if\s+)?|roleplay\s+as|imagine\s+you\s+are|behave\s+as|assume\s+the\s+role|switch\s+to|become\s+a)\b/i,
    severity: "high",
    description: "Attempts to reassign the model's identity or role",
  },
  {
    name: "jailbreak_dan",
    pattern: /\b(?:DAN|Do\s+Anything\s+Now|STAN|DUDE|AIM|KEVIN|OPPO)\b/,
    severity: "critical",
    description: "Known jailbreak persona references",
  },

  // Prompt extraction
  {
    name: "prompt_extraction",
    pattern: /\b(?:what\s+(?:is|are)\s+your\s+(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)|show\s+me\s+your\s+(?:system\s+)?(?:prompt|instructions?)|reveal\s+your\s+(?:prompt|instructions?)|print\s+your\s+(?:system\s+)?(?:prompt|instructions?|message)|display\s+your\s+(?:prompt|instructions?)|output\s+your\s+(?:system\s+)?(?:prompt|instructions?)|repeat\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)(?:\s+back)?)\b/i,
    severity: "high",
    description: "Attempts to extract the system prompt",
  },
  {
    name: "prompt_leak_indirect",
    pattern: /\b(?:beginning\s+of\s+(?:your\s+)?(?:conversation|prompt)|first\s+message\s+(?:you\s+)?received|initial\s+(?:prompt|instructions?|context)|text\s+(?:above|before)\s+(?:this|my)\s+message)\b/i,
    severity: "medium",
    description: "Indirect attempts to reference the system prompt",
  },

  // Encoding attacks
  {
    name: "base64_instruction",
    pattern: /\b(?:decode|base64|b64)\s*[:(]\s*[A-Za-z0-9+/=]{20,}/i,
    severity: "high",
    description: "Base64-encoded instruction payloads",
  },
  {
    name: "unicode_homoglyph",
    pattern: /[\u0400-\u04FF\u0500-\u052F].*(?:ignore|forget|override|instructions)/i,
    severity: "medium",
    description: "Unicode homoglyph-based obfuscation of injection keywords",
  },
  {
    name: "hex_encoded",
    pattern: /(?:\\x[0-9a-fA-F]{2}){4,}/,
    severity: "medium",
    description: "Hex-encoded character sequences",
  },

  // Delimiter injection
  {
    name: "delimiter_flood",
    pattern: /(?:[`]{3,}|[-]{5,}|[=]{5,}|[#]{5,}|[*]{5,}|[~]{5,}){2,}/,
    severity: "medium",
    description: "Excessive delimiter usage to break context boundaries",
  },
  {
    name: "markdown_system_block",
    pattern: /```(?:system|prompt|instructions?|rules?)\b/i,
    severity: "high",
    description: "Fake system/prompt code blocks to inject instructions",
  },

  // Indirect injection
  {
    name: "trust_escalation",
    pattern: /\b(?:the\s+following\s+(?:text|content|message)\s+is\s+trusted|admin\s+override|sudo\s+mode|developer\s+mode|maintenance\s+mode|debug\s+mode|god\s+mode|root\s+access)\b/i,
    severity: "critical",
    description: "Claims elevated trust or privilege",
  },
  {
    name: "context_manipulation",
    pattern: /\b(?:end\s+of\s+(?:system\s+)?prompt|<\/?(?:system|user|assistant|context)>|SYSTEM:|USER:|ASSISTANT:)\b/i,
    severity: "high",
    description: "Attempts to manipulate conversation context or role markers",
  },
  {
    name: "output_format_hijack",
    pattern: /\b(?:respond\s+only\s+with|output\s+(?:only|exactly)|say\s+(?:only|exactly|nothing\s+(?:but|except)))\b/i,
    severity: "medium",
    description: "Attempts to constrain output format to exfiltrate data or bypass safety",
  },
];

// ── Severity weights ────────────────────────────────────────────

const SEVERITY_WEIGHTS: Record<string, number> = {
  low: 0.15,
  medium: 0.3,
  high: 0.6,
  critical: 0.9,
};

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect prompt injection patterns in the given text.
 * Returns a result with detection status, score (0-1), matched patterns, and recommendation.
 */
export function detectInjection(text: string): InjectionResult {
  const matched: string[] = [];
  let maxWeight = 0;
  let totalWeight = 0;

  for (const p of INJECTION_PATTERNS) {
    p.pattern.lastIndex = 0;
    if (p.pattern.test(text)) {
      matched.push(p.name);
      const w = SEVERITY_WEIGHTS[p.severity] ?? 0.1;
      totalWeight += w;
      if (w > maxWeight) maxWeight = w;
    }
  }

  // Score: combine max severity with breadth of matches
  // Single critical = 0.9, multiple patterns compound up to 1.0
  const breadthBonus = Math.min(0.1, matched.length * 0.02);
  const score = matched.length === 0 ? 0 : Math.min(1, maxWeight + breadthBonus);

  let recommendation: "allow" | "warn" | "block";
  if (score >= 0.6) {
    recommendation = "block";
  } else if (score >= 0.25) {
    recommendation = "warn";
  } else {
    recommendation = "allow";
  }

  return {
    detected: matched.length > 0,
    score,
    patterns: matched,
    recommendation,
  };
}
