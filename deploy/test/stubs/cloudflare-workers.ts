// Test-only stub for the `cloudflare:workers` virtual module.
//
// The runtime imports DurableObject / WorkerEntrypoint from
// `cloudflare:workers`, which is a virtual module provided by the workerd
// runtime. Under vitest (Node), there is no such module, so any transitive
// import chain that touches it (e.g. @cloudflare/containers → Container
// extends DurableObject) fails to resolve.
//
// This stub provides empty base classes so the chain loads. Tests that
// exercise Container behavior would need a real workerd harness; tests that
// merely walk through `tools.ts` for unrelated exports load cleanly.

export class DurableObject<Env = unknown> {
  readonly ctx: any;
  readonly env: Env | undefined;
  constructor(state?: unknown, env?: Env) {
    this.ctx = state;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  readonly ctx: any;
  readonly env: Env | undefined;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}
