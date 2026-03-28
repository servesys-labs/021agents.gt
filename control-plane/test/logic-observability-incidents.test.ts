import { describe, it, expect } from "vitest";
import {
  applyDedupeWindow,
  buildIntegrityIncident,
  buildLoopIncident,
  severityFromIntegrityPayload,
} from "../src/logic/observability-incidents";

describe("observability-incidents severity mapping", () => {
  it("strict integrity breach is critical", () => {
    expect(
      severityFromIntegrityPayload({
        strict: true,
        missing_turns: 0,
        missing_runtime_events: 0,
        missing_billing_records: 0,
        lifecycle_mismatch: 0,
      }),
    ).toBe("critical");
  });

  it("lifecycle mismatch without strict is high", () => {
    expect(
      severityFromIntegrityPayload({
        strict: false,
        lifecycle_mismatch: 1,
      }),
    ).toBe("high");
  });

  it("missing turns maps to high", () => {
    expect(
      severityFromIntegrityPayload({
        strict: false,
        missing_turns: 2,
        lifecycle_mismatch: 0,
      }),
    ).toBe("high");
  });

  it("missing runtime events maps to medium", () => {
    expect(
      severityFromIntegrityPayload({
        strict: false,
        missing_runtime_events: 1,
        missing_turns: 0,
        lifecycle_mismatch: 0,
      }),
    ).toBe("medium");
  });

  it("missing billing only maps to low", () => {
    expect(
      severityFromIntegrityPayload({
        strict: false,
        missing_billing_records: 1,
      }),
    ).toBe("low");
  });
});

describe("observability-incidents dedupe window", () => {
  it("marks older siblings in the same span as duplicates", () => {
    const a = buildLoopIncident({
      eventType: "loop_halt",
      openedAt: "2026-03-27T10:00:00.000Z",
      traceId: "t1",
      sessionId: "s1",
      details: { message: "x" },
    });
    const b = buildLoopIncident({
      eventType: "loop_halt",
      openedAt: "2026-03-27T10:02:00.000Z",
      traceId: "t1",
      sessionId: "s1",
      details: { message: "y" },
    });
    const out = applyDedupeWindow([a, b], 300);
    const primary = out.filter((i) => i.suppression.is_primary);
    const dups = out.filter((i) => i.suppression.is_duplicate);
    expect(primary.length).toBe(1);
    expect(dups.length).toBe(1);
    expect(primary[0]!.opened_at).toBe("2026-03-27T10:02:00.000Z");
  });

  it("starts a new cluster when gap exceeds the window", () => {
    const a = buildIntegrityIncident({
      traceId: "t1",
      sessionId: null,
      openedAt: "2026-03-27T10:00:00.000Z",
      userId: "u1",
      details: { strict: false, missing_runtime_events: 1 },
    });
    const b = buildIntegrityIncident({
      traceId: "t1",
      sessionId: null,
      openedAt: "2026-03-27T10:10:00.000Z",
      userId: "u1",
      details: { strict: false, missing_runtime_events: 1 },
    });
    const out = applyDedupeWindow([a, b], 300);
    expect(out.every((i) => i.suppression.is_primary)).toBe(true);
    expect(out.every((i) => !i.suppression.is_duplicate)).toBe(true);
  });
});
