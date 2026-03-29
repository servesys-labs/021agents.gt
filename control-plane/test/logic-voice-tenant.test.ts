import { describe, it, expect } from "vitest";
import { extractVapiCallIds } from "../src/logic/voice-tenant";
import { resolveVapiVoiceTenant } from "../src/logic/voice-tenant";

describe("voice-tenant", () => {
  it("extractVapiCallIds reads assistant and phone from message.call", () => {
    expect(
      extractVapiCallIds({
        message: {
          type: "call.started",
          call: { id: "c1", assistantId: "asst_1", phoneNumberId: "pn_1" },
        },
      }),
    ).toEqual({ assistantId: "asst_1", phoneNumberId: "pn_1" });
  });

  it("extractVapiCallIds falls back to top-level call", () => {
    expect(
      extractVapiCallIds({
        call: { id: "c2", assistantId: "asst_x", phoneNumberId: "" },
      }),
    ).toEqual({ assistantId: "asst_x", phoneNumberId: "" });
  });

  it("resolveVapiVoiceTenant returns null when ids empty", async () => {
    const sql = (async (_s: TemplateStringsArray, ..._v: unknown[]) => []) as any;
    expect(await resolveVapiVoiceTenant(sql, "", "")).toBeNull();
  });

  it("resolveVapiVoiceTenant returns first agent row", async () => {
    const sql = (async (_s: TemplateStringsArray, ..._v: unknown[]) => [
      { name: "support-bot", org_id: "org-9" },
    ]) as any;
    expect(await resolveVapiVoiceTenant(sql, "asst_abc", "")).toEqual({
      org_id: "org-9",
      agent_name: "support-bot",
    });
  });
});
