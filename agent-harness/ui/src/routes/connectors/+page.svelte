<script lang="ts">
  import { api } from "$lib/services/api";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";

  type Tab = "apps" | "api" | "mcp";
  let activeTab = $state<Tab>("apps");
  let searchQuery = $state("");

  // ── Pre-built App Connectors ──
  const APP_CONNECTORS = [
    { name: "Instagram", icon: "📸", description: "Generate and publish Posts, Stories, or Reels", status: "new" as const },
    { name: "Gmail", icon: "📧", description: "Draft replies, search inbox, summarize threads", connected: true },
    { name: "Google Calendar", icon: "📅", description: "Schedule events, manage calendars", connected: false },
    { name: "Google Drive", icon: "📁", description: "Search files, manage documents", connected: false },
    { name: "Slack", icon: "💬", description: "Send messages, manage channels", connected: false },
    { name: "GitHub", icon: "🐙", description: "Manage repos, issues, PRs", connected: true },
    { name: "Notion", icon: "📝", description: "Search and create pages and databases", connected: false },
    { name: "Outlook Mail", icon: "📬", description: "Read, send, and manage emails", connected: false },
    { name: "WhatsApp", icon: "📱", description: "Send and receive messages", status: "new" as const },
    { name: "Telegram", icon: "✈️", description: "Bot messaging and notifications", connected: false },
    { name: "Stripe", icon: "💳", description: "Manage payments and subscriptions", connected: false },
    { name: "Shopify", icon: "🛍️", description: "Manage products, orders, customers", connected: false },
  ];

  // ── Custom API Providers ──
  const API_PROVIDERS = [
    { name: "OpenAI", icon: "🤖", description: "GPT models for text and code" },
    { name: "Anthropic", icon: "🧠", description: "Claude models for reasoning" },
    { name: "Google Gemini", icon: "💎", description: "Multimodal content processing" },
    { name: "Perplexity", icon: "🔍", description: "Real-time search with citations" },
    { name: "ElevenLabs", icon: "🔊", description: "Voice synthesis and cloning" },
    { name: "Grok", icon: "⚡", description: "xAI's reasoning model" },
    { name: "OpenRouter", icon: "🔀", description: "Access multiple models via one API" },
    { name: "Cohere", icon: "🏢", description: "Enterprise AI for workflows" },
    { name: "Ahrefs", icon: "📊", description: "SEO analysis and keyword tracking" },
    { name: "Replicate", icon: "🎨", description: "Run open-source ML models" },
  ];

  // MCP servers state
  let mcpServers = $state<Array<{ name: string; url: string; status: string }>>([]);
  let newMcpName = $state("");
  let newMcpUrl = $state("");
  let addingMcp = $state(false);

  let filteredApps = $derived(
    searchQuery
      ? APP_CONNECTORS.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : APP_CONNECTORS
  );

  let filteredApis = $derived(
    searchQuery
      ? API_PROVIDERS.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : API_PROVIDERS
  );
</script>

<div class="mx-auto max-w-5xl p-6">
  <div class="mb-6 flex items-center justify-between">
    <h1 class="text-xl font-semibold">Connectors</h1>
    <button onclick={() => history.back()} class="text-sm text-muted-foreground hover:text-foreground">✕</button>
  </div>

  <!-- Tabs + Search -->
  <div class="mb-6 flex items-center gap-4 border-b border-border">
    <div class="flex gap-0">
      {#each [
        { id: "apps", label: "Apps" },
        { id: "api", label: "Custom API" },
        { id: "mcp", label: "Custom MCP" },
      ] as tab}
        <button
          class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors {activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = tab.id as Tab)}
        >{tab.label}</button>
      {/each}
    </div>
    <div class="ml-auto">
      <Input
        placeholder="Search..."
        bind:value={searchQuery}
        class="h-8 w-48 text-sm"
      />
    </div>
  </div>

  <!-- APPS TAB -->
  {#if activeTab === "apps"}
    {#if filteredApps.some(a => a.status === "new")}
      <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Recommended</p>
      <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {#each filteredApps.filter(a => a.status === "new") as app}
          <button class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30 hover:bg-card/80 transition-all">
            <span class="text-2xl">{app.icon}</span>
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm">{app.name}</span>
                <span class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary uppercase">New</span>
              </div>
              <p class="mt-0.5 text-xs text-muted-foreground">{app.description}</p>
            </div>
          </button>
        {/each}
      </div>
    {/if}

    <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Apps</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each filteredApps.filter(a => !a.status) as app}
        <button class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30 hover:bg-card/80 transition-all">
          <span class="text-2xl">{app.icon}</span>
          <div class="flex-1">
            <span class="font-medium text-sm">{app.name}</span>
            <p class="mt-0.5 text-xs text-muted-foreground">{app.description}</p>
          </div>
          {#if app.connected}
            <span class="text-green-500 text-sm">✓</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <!-- CUSTOM API TAB -->
  {#if activeTab === "api"}
    <p class="mb-4 text-sm text-muted-foreground">Connect any third-party service using your own API keys.</p>

    <button class="mb-6 flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors">
      <span>+</span> Add custom API
    </button>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each filteredApis as provider}
        <button class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/30 hover:bg-card/80 transition-all">
          <span class="text-2xl">{provider.icon}</span>
          <div class="flex-1">
            <span class="font-medium text-sm">{provider.name}</span>
            <p class="mt-0.5 text-xs text-muted-foreground">{provider.description}</p>
          </div>
        </button>
      {/each}
    </div>
  {/if}

  <!-- CUSTOM MCP TAB -->
  {#if activeTab === "mcp"}
    <div class="flex flex-col items-center justify-center py-16">
      {#if mcpServers.length === 0}
        <div class="text-4xl mb-4 opacity-30">🔗</div>
        <p class="text-sm text-muted-foreground mb-4">No custom MCP added yet.</p>
      {/if}

      {#each mcpServers as server}
        <div class="mb-2 flex w-full max-w-md items-center gap-3 rounded-lg border border-border p-3">
          <span class="text-sm">🔗</span>
          <div class="flex-1">
            <p class="text-sm font-medium">{server.name}</p>
            <p class="text-xs text-muted-foreground font-mono">{server.url}</p>
          </div>
          <span class="text-xs {server.status === 'connected' ? 'text-green-500' : 'text-muted-foreground'}">{server.status}</span>
        </div>
      {/each}

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => (addingMcp = !addingMcp)}>
          + Add custom MCP
        </Button>
      </div>

      {#if addingMcp}
        <div class="mt-4 w-full max-w-md space-y-3 rounded-lg border border-border p-4">
          <Input placeholder="Server name" bind:value={newMcpName} />
          <Input placeholder="wss://your-mcp-server.com" bind:value={newMcpUrl} />
          <div class="flex gap-2">
            <Button size="sm" onclick={() => {
              if (newMcpName && newMcpUrl) {
                mcpServers = [...mcpServers, { name: newMcpName, url: newMcpUrl, status: "connecting" }];
                newMcpName = ""; newMcpUrl = ""; addingMcp = false;
              }
            }}>Connect</Button>
            <Button variant="ghost" size="sm" onclick={() => (addingMcp = false)}>Cancel</Button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
