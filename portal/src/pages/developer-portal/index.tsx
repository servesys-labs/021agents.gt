import { useState } from "react";
import {
  Code,
  Copy,
  Check,
  ExternalLink,
  Terminal,
  BookOpen,
  Package,
  Key,
  Globe,
  MessageSquare,
  FileJson,
  Zap,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { PageShell } from "../../components/layout/PageShell";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type OrgDomain = {
  custom_domain?: string;
  default_url?: string;
};

/* ── Helpers ────────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={14} className="text-status-success" /> : <Copy size={14} />}
    </button>
  );
}

function CodeBlock({ code, language = "typescript" }: { code: string; language?: string }) {
  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={code} />
      </div>
      <pre className="bg-surface-sunken rounded-lg p-4 overflow-x-auto text-xs font-mono text-text-secondary leading-relaxed border border-border-default">
        <code data-lang={language}>{code}</code>
      </pre>
    </div>
  );
}

/* ── Endpoint reference data ────────────────────────────────────── */

const ENDPOINTS = [
  { method: "POST", path: "/v1/agents", description: "Create a new agent" },
  { method: "GET", path: "/v1/agents", description: "List all agents" },
  { method: "GET", path: "/v1/agents/:id", description: "Get agent details" },
  { method: "POST", path: "/v1/agents/:id/run", description: "Run an agent (blocking)" },
  { method: "POST", path: "/v1/agents/:id/stream", description: "Stream agent response" },
  { method: "GET", path: "/v1/sessions", description: "List sessions" },
  { method: "GET", path: "/v1/sessions/:id", description: "Get session with messages" },
  { method: "POST", path: "/v1/end-user-tokens", description: "Mint an end-user token" },
  { method: "GET", path: "/v1/tools", description: "List available tools" },
  { method: "GET", path: "/v1/billing/usage", description: "Get billing usage" },
];

const METHOD_COLORS: Record<string, string> = {
  GET: "text-status-success bg-status-success/10",
  POST: "text-chart-blue bg-chart-blue/10",
  PUT: "text-chart-yellow bg-chart-yellow/10",
  DELETE: "text-status-error bg-status-error/10",
};

/* ── SDK cards data ─────────────────────────────────────────────── */

const SDKS = [
  {
    name: "TypeScript SDK",
    pkg: "@oneshots/sdk",
    icon: Package,
    status: "available" as const,
    badge: "npm",
    link: "https://www.npmjs.com/package/@oneshots/sdk",
  },
  {
    name: "Python SDK",
    pkg: "agentos-sdk",
    icon: Package,
    status: "coming-soon" as const,
    badge: "Coming Soon",
    link: null,
  },
  {
    name: "Swift SDK",
    pkg: "AgentOS",
    icon: Package,
    status: "coming-soon" as const,
    badge: "Coming Soon",
    link: null,
  },
  {
    name: "Kotlin SDK",
    pkg: "com.agentos:sdk",
    icon: Package,
    status: "coming-soon" as const,
    badge: "Coming Soon",
    link: null,
  },
  {
    name: "Chat Widget",
    pkg: "@oneshots/widget",
    icon: MessageSquare,
    status: "available" as const,
    badge: "npm",
    link: "/chat-widget-preview",
  },
];

/* ── Code snippets ──────────────────────────────────────────────── */

const INSTALL_SNIPPET = `npm install @oneshots/sdk`;

const RUN_SNIPPET = `import { AgentOS } from "@oneshots/sdk";

const client = new AgentOS({
  apiKey: process.env.AGENTOS_API_KEY,
});

const result = await client.agents.run("agent_abc123", {
  input: "Summarize our Q4 metrics",
});

console.log(result.output);`;

const STREAM_SNIPPET = `const stream = await client.agents.stream("agent_abc123", {
  input: "Write a status report",
});

for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}`;

const API_KEY_SNIPPET = `curl -X POST https://api.agentos.dev/v1/agents/agent_abc123/run \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"input": "Hello, Agent!"}'`;

const END_USER_TOKEN_SNIPPET = `// Server-side: mint a scoped token for an end user
const token = await client.endUserTokens.create({
  end_user_id: "user_123",
  agent_ids: ["agent_abc123"],
  expires_in: 3600, // 1 hour
});

// Client-side: use the token directly
const res = await fetch("/v1/agents/agent_abc123/run", {
  headers: {
    Authorization: \`Bearer \${token.token}\`,
    "Content-Type": "application/json",
  },
  method: "POST",
  body: JSON.stringify({ input: "Hello!" }),
});`;

/* ── Page Component ─────────────────────────────────────────────── */

export function DeveloperPortalPage() {
  const domainQuery = useApiQuery<OrgDomain>("/api/v1/org/settings");
  const baseUrl =
    domainQuery.data?.custom_domain
      ? `https://${domainQuery.data.custom_domain}`
      : domainQuery.data?.default_url ?? "https://api.agentos.dev";

  return (
    <PageShell>
      <PageHeader
        title="Developer Portal"
        subtitle="Everything you need to integrate with AgentOS"
        icon={<Code size={18} />}
      />

      {/* ── Quick Start ──────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
          <Zap size={14} className="text-chart-yellow" />
          Quick Start
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Install SDK */}
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-chart-purple/10">
                <Terminal size={16} className="text-chart-purple" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary">Install SDK</h3>
            </div>
            <p className="text-xs text-text-muted">Add the AgentOS SDK to your project.</p>
            <CodeBlock code={INSTALL_SNIPPET} language="bash" />
          </div>

          {/* Run Agent */}
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-chart-green/10">
                <Code size={16} className="text-chart-green" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary">Run Agent</h3>
            </div>
            <p className="text-xs text-text-muted">Execute an agent and get the result.</p>
            <CodeBlock code={RUN_SNIPPET} />
          </div>

          {/* Stream Response */}
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-chart-blue/10">
                <Zap size={16} className="text-chart-blue" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary">Stream Response</h3>
            </div>
            <p className="text-xs text-text-muted">Stream tokens as they are generated.</p>
            <CodeBlock code={STREAM_SNIPPET} />
          </div>
        </div>
      </section>

      {/* ── API Reference ────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
          <BookOpen size={14} className="text-chart-blue" />
          API Reference
        </h2>

        <div className="flex gap-3 mb-4">
          <a
            href="/v1/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary text-xs flex items-center gap-1.5"
          >
            <ExternalLink size={12} />
            Interactive API Docs
          </a>
          <a
            href="/v1/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary text-xs flex items-center gap-1.5"
          >
            <FileJson size={12} />
            Download OpenAPI Spec
          </a>
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-default bg-surface-sunken">
                <th className="text-left px-4 py-2.5 font-semibold text-text-muted uppercase tracking-wider w-20">
                  Method
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-text-muted uppercase tracking-wider">
                  Endpoint
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-text-muted uppercase tracking-wider">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((ep) => (
                <tr
                  key={`${ep.method}-${ep.path}`}
                  className="border-b border-border-default last:border-0 hover:bg-surface-overlay/50 transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${METHOD_COLORS[ep.method] ?? "text-text-muted bg-surface-overlay"}`}
                    >
                      {ep.method}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-text-primary">{ep.path}</td>
                  <td className="px-4 py-2.5 text-text-muted">{ep.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── SDKs & Tools ─────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
          <Package size={14} className="text-chart-purple" />
          SDKs & Tools
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {SDKS.map((sdk) => (
            <div key={sdk.name} className="card p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <sdk.icon size={14} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text-primary">{sdk.name}</span>
                </div>
              </div>
              <p className="text-xs text-text-muted font-mono">{sdk.pkg}</p>
              <div className="flex items-center gap-2 mt-auto pt-2">
                {sdk.status === "available" ? (
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-status-success/10 text-status-success">
                    {sdk.badge}
                  </span>
                ) : (
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-surface-overlay text-text-muted">
                    {sdk.badge}
                  </span>
                )}
                {sdk.link && (
                  <a
                    href={sdk.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline flex items-center gap-1"
                  >
                    View <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Authentication ───────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
          <Key size={14} className="text-chart-yellow" />
          Authentication
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* API Keys */}
          <div className="card p-5 flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text-primary">API Keys</h3>
            <p className="text-xs text-text-muted leading-relaxed">
              Use your API key in the <code className="px-1 py-0.5 bg-surface-sunken rounded text-text-secondary font-mono text-[11px]">Authorization</code> header
              as a Bearer token. API keys carry full org-level access -- use them only server-side.
            </p>
            <CodeBlock code={API_KEY_SNIPPET} language="bash" />
            <a href="/settings" className="text-xs text-accent hover:underline mt-1">
              Manage API Keys in Settings
            </a>
          </div>

          {/* End-User Tokens */}
          <div className="card p-5 flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text-primary">End-User Tokens</h3>
            <p className="text-xs text-text-muted leading-relaxed">
              Mint short-lived, scoped tokens for your end users. These tokens are restricted to
              specific agents and expire automatically. Safe to use client-side.
            </p>
            <CodeBlock code={END_USER_TOKEN_SNIPPET} />
            <a href="/settings" className="text-xs text-accent hover:underline mt-1">
              Configure Token Policies
            </a>
          </div>
        </div>
      </section>

      {/* ── Your API Base URL ────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
          <Globe size={14} className="text-chart-cyan" />
          Your API Base URL
        </h2>
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-surface-sunken px-4 py-2.5 rounded-lg border border-border-default">
                <span className="font-mono text-sm text-text-primary">{baseUrl}</span>
                <CopyButton text={baseUrl} />
              </div>
              {domainQuery.data?.custom_domain ? (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-status-success/10 text-status-success">
                  Custom Domain
                </span>
              ) : (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-surface-overlay text-text-muted">
                  Default
                </span>
              )}
            </div>
            <a
              href="/settings"
              className="text-xs text-accent hover:underline flex items-center gap-1"
            >
              Configure Custom Domain <ExternalLink size={10} />
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
