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
		Sandbox: DurableObjectNamespace<import("./src/server").Sandbox>;
		AgentSupervisor: DurableObjectNamespace<import("./src/server").AgentSupervisor>;
		/** Browser Rendering API — headless Puppeteer browser */
		MYBROWSER: Fetcher;
		/** Optional API keys injected via outbound Workers — set as secrets */
		GITHUB_TOKEN?: string;
		OPENAI_API_KEY?: string;
		ANTHROPIC_API_KEY?: string;
	}
}
interface Env extends Cloudflare.Env {}
type StringifyValues<EnvType extends Record<string, unknown>> = {
	[Binding in keyof EnvType]: EnvType[Binding] extends string ? EnvType[Binding] : string;
};
declare namespace NodeJS {
	interface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, "ACCESS_CODE">> {}
}
