/**
 * Tests for deploy/src/runtime/config-migrations.ts
 * Phase 10.3: Agent config migration framework
 */
import { describe, it, expect } from "vitest";
import { migrateConfig, getCurrentConfigVersion } from "../src/runtime/config-migrations";

describe("migrateConfig", () => {
  it("migrates v1.0 config to current version", () => {
    const old = { config_version: "1.0", system_prompt: "test", model: "gpt-4" };
    const { config, migrated, from, to } = migrateConfig(old);
    expect(migrated).toBe(true);
    expect(from).toBe("1.0");
    expect(to).toBe(getCurrentConfigVersion());
    expect(config.config_version).toBe(getCurrentConfigVersion());
    expect(config.reasoning_strategy).toBe("auto");
    expect(config.loop_detection_enabled).toBe(true);
    expect(config.context_compression_enabled).toBe(true);
  });

  it("adds defaults for missing fields at each version", () => {
    const old = { config_version: "1.0" };
    const { config } = migrateConfig(old);
    // v1.1 adds reasoning_strategy
    expect(config.reasoning_strategy).toBe("auto");
    // v1.2 adds loop_detection and context_compression
    expect(config.loop_detection_enabled).toBe(true);
    expect(config.context_compression_enabled).toBe(true);
  });

  it("preserves existing field values during migration", () => {
    const old = { config_version: "1.0", reasoning_strategy: "step-back", model: "claude" };
    const { config } = migrateConfig(old);
    // reasoning_strategy was set in v1.0 → migration should NOT overwrite
    expect(config.reasoning_strategy).toBe("step-back");
    expect(config.model).toBe("claude");
  });

  it("does not migrate if already at current version", () => {
    const current = { config_version: getCurrentConfigVersion(), model: "gpt-5" };
    const { config, migrated } = migrateConfig(current);
    expect(migrated).toBe(false);
    expect(config.model).toBe("gpt-5");
  });

  it("handles config without version (treats as 1.0)", () => {
    const noVersion = { model: "test" };
    const { config, migrated } = migrateConfig(noVersion);
    expect(migrated).toBe(true);
    expect(config.config_version).toBe(getCurrentConfigVersion());
  });

  it("handles null/undefined config", () => {
    const { config, migrated } = migrateConfig(null);
    expect(migrated).toBe(true);
    expect(config.config_version).toBe(getCurrentConfigVersion());
  });

  it("migrates from v1.1 to v1.2 only", () => {
    const v11 = { config_version: "1.1", reasoning_strategy: "plan-then-execute" };
    const { config, migrated, from, to } = migrateConfig(v11);
    expect(migrated).toBe(true);
    expect(from).toBe("1.1");
    expect(to).toBe("1.2");
    // v1.1 fields preserved
    expect(config.reasoning_strategy).toBe("plan-then-execute");
    // v1.2 fields added
    expect(config.loop_detection_enabled).toBe(true);
  });
});

describe("getCurrentConfigVersion", () => {
  it("returns a semver-like string", () => {
    const v = getCurrentConfigVersion();
    expect(v).toMatch(/^\d+\.\d+$/);
  });
});
