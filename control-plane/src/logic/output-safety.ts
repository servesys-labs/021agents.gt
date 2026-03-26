/**
 * Output Safety Scanner — scans agent outputs for prompt leakage,
 * secret leakage, harmful content, and toxicity.
 */

// ── Types ───────────────────────────────────────────────────────

export interface OutputIssue {
  type: "prompt_leak" | "secret" | "harmful" | "toxic";
  severity: "low" | "medium" | "high" | "critical";
  evidence: string;
  location: { start: number; end: number };
}

export interface OutputScanResult {
  safe: boolean;
  issues: OutputIssue[];
  redacted: string;
}

// ── System prompt leak detection ────────────────────────────────

const SYSTEM_PROMPT_MARKERS = [
  /\b(?:You\s+are\s+a(?:n)?)\s+(?:helpful|AI|assistant|agent|bot)\b/i,
  /\b(?:Your\s+role\s+is|Your\s+purpose\s+is|Your\s+job\s+is)\b/i,
  /\b(?:Your\s+instructions\s+are|You\s+(?:have\s+been|were)\s+(?:instructed|told|programmed)\s+to)\b/i,
  /\b(?:System\s+prompt|System\s+message|System\s+instructions?)\s*:/i,
  /\b(?:As\s+(?:a|an)\s+(?:AI|language\s+model|assistant|agent),?\s+(?:you|I)\s+(?:should|must|will|am))\b/i,
  /\b(?:Do\s+not\s+reveal\s+(?:these|your|this)\s+(?:instructions?|prompt|guidelines?))\b/i,
];

function detectPromptLeak(text: string, systemPrompt?: string): OutputIssue[] {
  const issues: OutputIssue[] = [];

  // Check for generic system prompt pattern leakage
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    marker.lastIndex = 0;
    const m = marker.exec(text);
    if (m) {
      issues.push({
        type: "prompt_leak",
        severity: "high",
        evidence: m[0],
        location: { start: m.index, end: m.index + m[0].length },
      });
    }
  }

  // If a system prompt is provided, check for verbatim substrings (>30 chars)
  if (systemPrompt && systemPrompt.length > 30) {
    // Check overlapping windows of the system prompt
    const windowSize = 40;
    const step = 20;
    for (let i = 0; i <= systemPrompt.length - windowSize; i += step) {
      const chunk = systemPrompt.slice(i, i + windowSize);
      // Skip very generic chunks
      if (/^\s+$/.test(chunk)) continue;
      const idx = text.indexOf(chunk);
      if (idx !== -1) {
        issues.push({
          type: "prompt_leak",
          severity: "critical",
          evidence: `Verbatim system prompt substring: "${chunk.slice(0, 50)}..."`,
          location: { start: idx, end: idx + chunk.length },
        });
        break; // One verbatim match is enough
      }
    }
  }

  return issues;
}

// ── Secret leakage detection ────────────────────────────────────

const SECRET_PATTERNS: Array<{
  name: string;
  regex: RegExp;
  severity: "high" | "critical";
}> = [
  {
    name: "API key (generic)",
    regex: /\b(?:sk|pk|ak)[-_][A-Za-z0-9]{16,}\b/g,
    severity: "critical",
  },
  {
    name: "AWS access key",
    regex: /\bAKIA[A-Z0-9]{16}\b/g,
    severity: "critical",
  },
  {
    name: "Postgres connection string",
    regex: /postgres(?:ql)?:\/\/[^\s"']+/gi,
    severity: "critical",
  },
  {
    name: "MySQL connection string",
    regex: /mysql:\/\/[^\s"']+/gi,
    severity: "critical",
  },
  {
    name: "MongoDB connection string",
    regex: /mongodb(?:\+srv)?:\/\/[^\s"']+/gi,
    severity: "critical",
  },
  {
    name: "Redis connection string",
    regex: /redis(?:s)?:\/\/[^\s"']+/gi,
    severity: "high",
  },
  {
    name: "Internal IP (10.x)",
    regex: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    severity: "high",
  },
  {
    name: "Internal IP (172.16-31.x)",
    regex: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
    severity: "high",
  },
  {
    name: "Internal IP (192.168.x)",
    regex: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
    severity: "high",
  },
  {
    name: "Bearer token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
    severity: "critical",
  },
  {
    name: "JWT token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    severity: "critical",
  },
  {
    name: "Private key block",
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    severity: "critical",
  },
  {
    name: "Generic secret/password value",
    regex: /\b(?:password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*]{8,}["']?\b/gi,
    severity: "high",
  },
];

function detectSecretLeakage(text: string): OutputIssue[] {
  const issues: OutputIssue[] = [];
  for (const sp of SECRET_PATTERNS) {
    sp.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sp.regex.exec(text)) !== null) {
      issues.push({
        type: "secret",
        severity: sp.severity,
        evidence: `${sp.name}: ${m[0].slice(0, 60)}${m[0].length > 60 ? "..." : ""}`,
        location: { start: m.index, end: m.index + m[0].length },
      });
    }
  }
  return issues;
}

// ── Harmful content detection ───────────────────────────────────

const HARMFUL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "violence_instructions",
    regex: /\b(?:how\s+to\s+(?:make|build|create|assemble)\s+(?:a\s+)?(?:bomb|explosive|weapon|gun|poison|drug))\b/i,
  },
  {
    name: "self_harm",
    regex: /\b(?:how\s+to\s+(?:kill\s+yourself|commit\s+suicide|end\s+(?:your|my)\s+life)|methods?\s+(?:of|for)\s+(?:suicide|self[- ]harm))\b/i,
  },
  {
    name: "illegal_activity",
    regex: /\b(?:how\s+to\s+(?:hack\s+into|break\s+into|steal\s+from|forge|counterfeit|launder\s+money)|step[- ]by[- ]step\s+(?:guide|instructions?)\s+(?:to|for)\s+(?:hacking|fraud|theft))\b/i,
  },
  {
    name: "exploitation",
    regex: /\b(?:how\s+to\s+(?:exploit|manipulate|groom|traffic)\s+(?:children|minors|people|victims))\b/i,
  },
];

function detectHarmfulContent(text: string): OutputIssue[] {
  const issues: OutputIssue[] = [];
  for (const hp of HARMFUL_PATTERNS) {
    hp.regex.lastIndex = 0;
    const m = hp.regex.exec(text);
    if (m) {
      issues.push({
        type: "harmful",
        severity: "critical",
        evidence: `${hp.name}: "${m[0]}"`,
        location: { start: m.index, end: m.index + m[0].length },
      });
    }
  }
  return issues;
}

// ── Toxicity heuristics ─────────────────────────────────────────

const PROFANITY_TERMS = [
  "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick",
  "damn", "piss", "crap", "slut", "whore",
];

const HATE_INDICATORS = [
  /\b(?:kill\s+all|exterminate|genocide\s+(?:of|against))\b/i,
  /\b(?:(?:all|those|the)\s+(?:\w+\s+)?(?:should\s+)?die|deserve\s+to\s+die)\b/i,
  /\b(?:racial\s+(?:superiority|inferiority)|master\s+race|ethnic\s+cleansing)\b/i,
  /\b(?:(?:go\s+back\s+to|get\s+out\s+of)\s+(?:your|their|my)\s+country)\b/i,
];

function detectToxicity(text: string): OutputIssue[] {
  const issues: OutputIssue[] = [];
  const lower = text.toLowerCase();

  // Profanity scan
  for (const term of PROFANITY_TERMS) {
    const idx = lower.indexOf(term);
    if (idx !== -1) {
      issues.push({
        type: "toxic",
        severity: "medium",
        evidence: `Profanity: "${term}"`,
        location: { start: idx, end: idx + term.length },
      });
    }
  }

  // Hate speech
  for (const pattern of HATE_INDICATORS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    if (m) {
      issues.push({
        type: "toxic",
        severity: "high",
        evidence: `Hate speech indicator: "${m[0]}"`,
        location: { start: m.index, end: m.index + m[0].length },
      });
    }
  }

  return issues;
}

// ── Redaction helper ────────────────────────────────────────────

function redactIssues(text: string, issues: OutputIssue[]): string {
  // Only redact secrets and prompt leaks — harmful/toxic are flagged but not redacted
  const redactable = issues.filter((i) => i.type === "secret" || i.type === "prompt_leak");
  if (!redactable.length) return text;

  const sorted = [...redactable].sort((a, b) => b.location.start - a.location.start);
  let result = text;
  for (const issue of sorted) {
    const placeholder = `[REDACTED:${issue.type}]`;
    result =
      result.slice(0, issue.location.start) +
      placeholder +
      result.slice(issue.location.end);
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Scan agent output for safety issues.
 */
export function scanOutput(
  text: string,
  systemPrompt?: string,
): OutputScanResult {
  const issues: OutputIssue[] = [
    ...detectPromptLeak(text, systemPrompt),
    ...detectSecretLeakage(text),
    ...detectHarmfulContent(text),
    ...detectToxicity(text),
  ];

  // De-duplicate overlapping issues by location
  const deduped: OutputIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = `${issue.type}:${issue.location.start}:${issue.location.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(issue);
    }
  }

  const safe = deduped.length === 0;
  const redacted = redactIssues(text, deduped);

  return { safe, issues: deduped, redacted };
}
