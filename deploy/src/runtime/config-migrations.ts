/**
 * Phase 10.3: Agent Config Migration Framework
 *
 * Versioned migrations for agent.config. When the runtime adds new fields
 * or renames existing ones, old configs get automatically migrated on load.
 *
 * Inspired by Claude Code's explicit migration files per config version.
 */

interface ConfigMigration {
  from_version: string;
  to_version: string;
  migrate: (config: any) => any;
}

/**
 * Migration registry. Add new migrations here as the config schema evolves.
 * Each migration transforms from one version to the next.
 */
const MIGRATIONS: ConfigMigration[] = [
  {
    from_version: "1.0",
    to_version: "1.1",
    migrate: (c) => ({
      ...c,
      // New fields with sensible defaults
      reasoning_strategy: c.reasoning_strategy || "auto",
      config_version: "1.1",
    }),
  },
  {
    from_version: "1.1",
    to_version: "1.2",
    migrate: (c) => ({
      ...c,
      // Phase 1.4: loop detection enabled by default
      loop_detection_enabled: c.loop_detection_enabled ?? true,
      // Phase 2.4: context compression enabled by default
      context_compression_enabled: c.context_compression_enabled ?? true,
      config_version: "1.2",
    }),
  },
];

const CURRENT_VERSION = "1.2";

/**
 * Migrate a config through all applicable migrations.
 * Returns the migrated config and whether any migration was applied.
 */
export function migrateConfig(config: any): { config: any; migrated: boolean; from?: string; to?: string } {
  if (!config || typeof config !== "object") {
    return { config: { ...config, config_version: CURRENT_VERSION }, migrated: true, from: "unknown", to: CURRENT_VERSION };
  }

  const originalVersion = config.config_version || "1.0";
  let current = { ...config };
  if (!current.config_version) current.config_version = "1.0";

  let migrated = false;
  for (const m of MIGRATIONS) {
    if (current.config_version === m.from_version) {
      current = m.migrate(current);
      migrated = true;
    }
  }

  return {
    config: current,
    migrated,
    from: migrated ? originalVersion : undefined,
    to: migrated ? current.config_version : undefined,
  };
}

/**
 * Get the current config version.
 */
export function getCurrentConfigVersion(): string {
  return CURRENT_VERSION;
}
