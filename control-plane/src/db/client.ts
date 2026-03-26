/**
 * Hyperdrive Postgres connection — same pattern as runtime worker.
 *
 * Creates a fresh connection per call. Hyperdrive handles server-side pooling.
 */
import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export async function getDb(hyperdrive: Hyperdrive): Promise<Sql> {
  const pg = (await import("postgres")).default;
  return pg(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false, // Hyperdrive requires prepare:false (transaction-mode pooling)
    idle_timeout: 5,
    connect_timeout: 3,
  });
}
