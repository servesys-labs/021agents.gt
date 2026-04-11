/**
 * Gold images, drift detection, and compliance checking.
 */

// ── Drift detection ──────────────────────────────────────────────

const CRITICAL_FIELDS = new Set([
  "governance",
  "governance.budget_limit_usd",
  "governance.blocked_tools",
  "governance.require_confirmation_for_destructive",
]);

const WARNING_FIELDS = new Set([
  "model",
  "max_turns",
  "timeout_seconds",
  "plan",
  "tools",
]);

const SKIP_FIELDS = new Set(["agent_id", "created_at", "updated_at", "version"]);

export interface DriftField {
  field: string;
  gold_value: unknown;
  agent_value: unknown;
  severity: string;
}

export interface DriftReport {
  agent_name: string;
  image_id: string;
  image_name: string;
  total_drifts: number;
  status: string;
  drifted_fields: DriftField[];
}

function classifyFieldSeverity(fieldPath: string): string {
  if (CRITICAL_FIELDS.has(fieldPath)) return "critical";
  for (const critical of CRITICAL_FIELDS) {
    if (fieldPath.startsWith(critical + ".")) return "critical";
  }
  if (WARNING_FIELDS.has(fieldPath)) return "warning";
  return "info";
}

function compareDicts(
  gold: Record<string, unknown>,
  agent: Record<string, unknown>,
  prefix: string,
  drifts: DriftField[],
): void {
  const allKeys = new Set([...Object.keys(gold), ...Object.keys(agent)]);
  for (const key of [...allKeys].sort()) {
    if (SKIP_FIELDS.has(key)) continue;

    const fullKey = prefix ? `${prefix}.${key}` : key;
    const goldVal = gold[key];
    const agentVal = agent[key];

    if (goldVal === agentVal) continue;
    if (JSON.stringify(goldVal) === JSON.stringify(agentVal)) continue;

    // Recurse into nested dicts
    if (
      goldVal && agentVal &&
      typeof goldVal === "object" && !Array.isArray(goldVal) &&
      typeof agentVal === "object" && !Array.isArray(agentVal)
    ) {
      compareDicts(
        goldVal as Record<string, unknown>,
        agentVal as Record<string, unknown>,
        fullKey,
        drifts,
      );
      continue;
    }

    // Normalize lists for comparison
    if (Array.isArray(goldVal) && Array.isArray(agentVal)) {
      const goldSorted = [...goldVal].map(String).sort();
      const agentSorted = [...agentVal].map(String).sort();
      if (JSON.stringify(goldSorted) === JSON.stringify(agentSorted)) continue;
    }

    drifts.push({
      field: fullKey,
      gold_value: goldVal,
      agent_value: agentVal,
      severity: classifyFieldSeverity(fullKey),
    });
  }
}

export function detectDrift(
  agentConfig: Record<string, unknown>,
  goldConfig: Record<string, unknown>,
  agentName: string,
  imageId: string,
  imageName: string,
): DriftReport {
  const drifts: DriftField[] = [];
  compareDicts(goldConfig, agentConfig, "", drifts);

  const hasCritical = drifts.some((d) => d.severity === "critical");
  const hasWarning = drifts.some((d) => d.severity === "warning");

  let status: string;
  if (hasCritical) status = "critical";
  else if (hasWarning || drifts.length > 0) status = "drifted";
  else status = "compliant";

  return {
    agent_name: agentName,
    image_id: imageId,
    image_name: imageName,
    total_drifts: drifts.length,
    status,
    drifted_fields: drifts,
  };
}

// ── Gold image helpers ───────────────────────────────────────────

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalConfigString(config: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(config));
}

// Small synchronous SHA-256 implementation so both sync/async hash helpers
// use SHA-256 semantics (matching Python parity expectations).
function sha256Hex(input: string): string {
  const rightRotate = (v: number, amt: number) => (v >>> amt) | (v << (32 - amt));
  const words: number[] = [];
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  }
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[(((bytes.length + 8) >> 6) << 4) + 15] = bytes.length * 8;

  const K = [
    1116352408, 1899447441, -1245643825, -373957723, 961987163, 1508970993, -1841331548,
    -1424204075, -670586216, 310598401, 607225278, 1426881987, 1925078388, -2132889090,
    -1680079193, -1046744716, -459576895, -272742522, 264347078, 604807628, 770255983,
    1249150122, 1555081692, 1996064986, -1740746414, -1473132947, -1341970488, -1084653625,
    -958395405, -710438585, 113926993, 338241895, 666307205, 773529912, 1294757372,
    1396182291, 1695183700, 1986661051, -2117940946, -1838011259, -1564481375, -1474664885,
    -1035236496, -949202525, -778901479, -694614492, -200395387, 275423344, 430227734,
    506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779,
    1955562222, 2024104815, -2067236844, -1933114872, -1866530822, -1538233109, -1090935817,
    -965641998,
  ];
  const H = [1779033703, -1150833019, 1013904242, -1521486534, 1359893119, -1694144372, 528734635, 1541459225];
  const W = new Array<number>(64);

  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) W[t] = words[i + t] | 0;
    for (let t = 16; t < 64; t++) {
      const s0 = rightRotate(W[t - 15], 7) ^ rightRotate(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rightRotate(W[t - 2], 17) ^ rightRotate(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (((W[t - 16] + s0) | 0) + ((W[t - 7] + s1) | 0)) | 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((((h + S1) | 0) + ch) | 0) + ((K[t] + W[t]) | 0)) | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  return H.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

export function configHash(config: Record<string, unknown>): string {
  return sha256Hex(canonicalConfigString(config)).slice(0, 16);
}

/** Compute a deterministic config hash using crypto.subtle (async). */
export async function configHashAsync(config: Record<string, unknown>): Promise<string> {
  const canonical = canonicalConfigString(config);
  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Compliance summary from DB rows ──────────────────────────────

export function complianceSummaryFromChecks(
  checks: Record<string, unknown>[],
): Record<string, unknown> {
  if (!checks.length) {
    return {
      total_checks: 0,
      compliant: 0,
      drifted: 0,
      critical: 0,
      compliance_rate: 0.0,
    };
  }

  // Dedupe by agent (latest check per agent)
  const latest: Record<string, Record<string, unknown>> = {};
  for (const c of checks) {
    const name = String(c.agent_name ?? "");
    if (!(name in latest)) {
      latest[name] = c;
    }
  }

  const statuses = Object.values(latest).map((c) => String(c.status ?? "unchecked"));
  const compliant = statuses.filter((s) => s === "compliant").length;
  const drifted = statuses.filter((s) => s === "drifted").length;
  const critical = statuses.filter((s) => s === "critical").length;
  const total = statuses.length;

  return {
    total_checks: total,
    compliant,
    drifted,
    critical,
    compliance_rate: total ? Math.round((compliant / total) * 1000) / 1000 : 0.0,
    agents_checked: Object.keys(latest),
  };
}
