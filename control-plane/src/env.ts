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

  // KV — runtime agent progress events (shared with deploy worker)
  AGENT_PROGRESS_KV?: KVNamespace;

  // Secrets (set via `wrangler secret put`)
  AUTH_JWT_SECRET: string;
  OPENROUTER_API_KEY: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SERVICE_TOKEN: string;

  /** Growth controls */
  OPEN_SIGNUPS?: string;          // "true" = anyone can sign up. Default: invite-only.
  SEED_ADMIN_CODE?: string;       // Bootstrap: first signup uses this as invite code
  TRAINING_ENABLED?: string;      // "true" = training system active

  /** Voice integrations (optional secrets) */
  VAPI_API_KEY?: string;
  VAPI_WEBHOOK_SECRET?: string;
  TAVUS_API_KEY?: string;
  TAVUS_WEBHOOK_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;

  /** Chat platform integrations (optional secrets) */
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_VERIFY_TOKEN?: string;
  FACEBOOK_VERIFY_TOKEN?: string;
  FACEBOOK_APP_SECRET?: string;

  // Cloudflare Access (optional)
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g. "crucial-lemur-88.cloudflareaccess.com"
  CF_ACCESS_AUD?: string;         // Application AUD tag

  // Pipedream MCP Connectors (optional)
  PIPEDREAM_CLIENT_ID?: string;
  PIPEDREAM_CLIENT_SECRET?: string;
  PIPEDREAM_PROJECT_ID?: string;

  // Vars
  RUNTIME_WORKER_URL: string;
  AUTH_ALLOW_PASSWORD?: string;
  AI_SCORING_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  APPROVAL_WORKFLOWS_ENABLED?: string;
  DB_PROXY_ENABLED?: string;
}
