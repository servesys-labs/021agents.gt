/**
 * Cron expression parser — 5-field standard cron + common shortcuts.
 *
 * Format: minute hour day-of-month month day-of-week
 * Supports: wildcards, ranges (1-5), lists (1,3,5), steps (star/5)
 * Shortcuts: @yearly, @monthly, @weekly, @daily, @hourly, @every_5m, @every_15m, @every_30m
 */

const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@every_5m": "*/5 * * * *",
  "@every_15m": "*/15 * * * *",
  "@every_30m": "*/30 * * * *",
};

const FIELD_RANGES: [number, number][] = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 6],    // day of week (0 = Sunday)
];

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];

/**
 * Validate a single cron field value.
 */
function validateField(field: string, min: number, max: number, name: string): string | null {
  if (field === "*") return null;

  // Step: */n or m-n/s
  if (field.includes("/")) {
    const [range, stepStr] = field.split("/", 2);
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step < 1) {
      return `Invalid step value in ${name}: '${field}'`;
    }
    if (range !== "*") {
      const err = validateField(range, min, max, name);
      if (err) return err;
    }
    return null;
  }

  // List: 1,3,5
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const err = validateField(part.trim(), min, max, name);
      if (err) return err;
    }
    return null;
  }

  // Range: 1-5
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-", 2);
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end)) {
      return `Invalid range in ${name}: '${field}'`;
    }
    if (start < min || start > max || end < min || end > max) {
      return `Range out of bounds in ${name}: '${field}' (valid: ${min}-${max})`;
    }
    if (start > end) {
      return `Invalid range in ${name}: start > end in '${field}'`;
    }
    return null;
  }

  // Single value
  const val = parseInt(field, 10);
  if (isNaN(val) || val < min || val > max) {
    return `Invalid value in ${name}: '${field}' (valid: ${min}-${max})`;
  }
  return null;
}

export interface ParsedCron {
  expression: string;
  fields: string[];
  original: string;
}

/**
 * Parse and validate a cron expression.
 * Returns the parsed result or throws an error with a descriptive message.
 */
export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Cron expression cannot be empty");
  }

  // Handle shortcuts
  const resolved = SHORTCUTS[trimmed.toLowerCase()] || trimmed;
  const original = trimmed;

  const fields = resolved.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: '${resolved}'`
    );
  }

  // Validate each field
  for (let i = 0; i < 5; i++) {
    const [min, max] = FIELD_RANGES[i];
    const err = validateField(fields[i], min, max, FIELD_NAMES[i]);
    if (err) throw new Error(err);
  }

  return { expression: resolved, fields, original };
}
