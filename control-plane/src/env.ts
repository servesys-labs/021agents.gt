/**
 * Worker environment bindings — typed for all control-plane routes.
 */
export interface Env {
  // Hyperdrive — Supabase Postgres connection pool
  HYPERDRIVE: Hyperdrive;

  // Workers AI — LLM inference for meta-agent, issue classifier, etc.
  AI: Ai;

  // R2 — eval datasets, agent artifacts, document storage
  STORAGE: R2Bucket;

  // Vectorize — RAG embeddings
  VECTORIZE: VectorizeIndex;

  // Service Binding — zero-latency calls to runtime worker
  RUNTIME: Fetcher;
  // Optional service binding for approval workflow orchestrator
  WORKFLOWS?: Fetcher;

  // Queue — async job processing
  JOB_QUEUE: Queue;

  // Secrets (set via `wrangler secret put`)
  AUTH_JWT_SECRET: string;
  OPENROUTER_API_KEY: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SERVICE_TOKEN: string;

  /** Voice integrations (optional secrets) */
  VAPI_API_KEY?: string;
  VAPI_WEBHOOK_SECRET?: string;
  TAVUS_API_KEY?: string;
  TAVUS_WEBHOOK_SECRET?: string;

  // Cloudflare Access (optional)
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g. "crucial-lemur-88.cloudflareaccess.com"
  CF_ACCESS_AUD?: string;         // Application AUD tag

  // Vars
  RUNTIME_WORKER_URL: string;
  AUTH_ALLOW_PASSWORD?: string;
  AI_SCORING_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  APPROVAL_WORKFLOWS_ENABLED?: string;
  DB_PROXY_ENABLED?: string;
}
