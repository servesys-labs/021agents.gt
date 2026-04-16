/* eslint-disable */
// Extended for Outbound Workers + DO Facets + Dynamic Workers
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/server");
		durableNamespaces: "ChatAgent" | "AgentSupervisor";
	}
	interface Env {
		AI: Ai;
		ACCESS_CODE: string;
		SANDBOX_TRANSPORT?: string;
		ChatAgent: DurableObjectNamespace<import("./src/server").ChatAgent>;
		ResearchSpecialist: DurableObjectNamespace<import("./src/server").ResearchSpecialist>;
		CodingSpecialist: DurableObjectNamespace<import("./src/server").CodingSpecialist>;
		Sandbox: DurableObjectNamespace<import("./src/server").Sandbox>;
		AgentSupervisor: DurableObjectNamespace<import("./src/server").AgentSupervisor>;
		ReminderAgent: DurableObjectNamespace<import("./src/server").ReminderAgent>;
		McpElicitationServer: DurableObjectNamespace<import("./src/server").McpElicitationServer>;
		VoiceAgent: DurableObjectNamespace<import("./src/server").VoiceAgent>;
		MemorySpecialist: DurableObjectNamespace<import("./src/server").MemorySpecialist>;
		EvalJudge: DurableObjectNamespace<import("./src/server").EvalJudge>;
		/** Browser Rendering API — headless Puppeteer browser */
		MYBROWSER: Fetcher;
		/** Service binding to agent-core worker for DO routing */
		AGENT_CORE: Fetcher;
		/** Workflows binding for durable long-running tasks */
		TASK_WORKFLOW: Workflow;
		/** Email Workers send binding for outbound email */
		EMAIL: SendEmail;
		/** HMAC secret for secure email reply routing */
		EMAIL_SECRET?: string;
		/** Dynamic Worker Loader for CodeMode + extensions */
		LOADER: any;
		/** Railway Postgres via Hyperdrive — durable cross-org data */
		DB: Hyperdrive;
		/** Async telemetry queue → Postgres */
		TELEMETRY_QUEUE: Queue;
		/** Analytics Engine for high-volume metrics */
		ANALYTICS: AnalyticsEngineDataset;
		/** R2 bucket for workspace file spillover (large files beyond SQLite inline threshold) */
		STORAGE: R2Bucket;
		/** Vectorize index for semantic memory search (legacy, prefer AI_SEARCH) */
		VECTORIZE: VectorizeIndex;
		/** AI Search — managed hybrid search primitive (semantic + keyword) */
		AI_SEARCH: AISearchNamespace;
		/** Artifacts — Git-for-agents versioned repos per session */
		ARTIFACTS: ArtifactsNamespace;
		/** Optional API keys injected via outbound Workers — set as secrets */
		/** CF AI Gateway token — authenticates with gateway which injects provider keys via BYOK */
		CF_AIG_TOKEN?: string;
		GITHUB_TOKEN?: string;
		OPENAI_API_KEY?: string;
		ANTHROPIC_API_KEY?: string;
		/** Push notification VAPID keys */
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;
	}
}
interface Env extends Cloudflare.Env {}
type StringifyValues<EnvType extends Record<string, unknown>> = {
	[Binding in keyof EnvType]: EnvType[Binding] extends string ? EnvType[Binding] : string;
};
declare namespace NodeJS {
	interface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, "ACCESS_CODE">> {}
}

// ── Shim types for new CF bindings not yet in @cloudflare/workers-types ──
interface AISearchNamespace {
	create(options: { instance_id: string; description?: string }): Promise<{ instance_id: string }>;
	upload(instance_id: string, files: Array<{ path: string; content: string | ArrayBuffer }>): Promise<{ uploaded: number }>;
	search(options: {
		query: string;
		ai_search_options?: {
			instance_ids?: string[];
			top_k?: number;
			score_threshold?: number;
		};
	}): Promise<{ matches: Array<{ content: string; score: number; metadata?: any }> }>;
	delete(instance_id: string): Promise<void>;
	list(): Promise<Array<{ instance_id: string; description?: string }>>;
}

interface ArtifactsNamespace {
	create(name: string, options?: { description?: string }): Promise<{ name: string; remote: string; token: string }>;
	get(name: string): Promise<{ name: string; remote: string; token: string } | null>;
	fork(name: string, options: { target: string; readonly?: boolean }): Promise<{ name: string; remote: string; token: string }>;
	import(options: { source: string; target: string; token?: string }): Promise<{ name: string; remote: string; token: string }>;
	delete(name: string): Promise<void>;
	list(prefix?: string): Promise<Array<{ name: string; created_at: string }>>;
}
declare module "postgres" {
	const postgres: any;
	export default postgres;
}
declare module "web-push" {
	const webpush: any;
	export default webpush;
}
