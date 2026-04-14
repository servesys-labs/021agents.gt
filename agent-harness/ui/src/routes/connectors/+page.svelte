<script lang="ts">
  import { api } from "$lib/services/api";
  import { agentStore as agentRpc } from "$lib/stores/agent.svelte";
  import { getConnectorAuthUrl } from "$lib/services/connectors";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Badge from "$lib/components/ui/badge.svelte";

  type Tab = "apps" | "api" | "mcp";
  let activeTab = $state<Tab>("apps");
  let searchQuery = $state("");

  // ── App Connectors (OAuth-based) ──
  interface AppConnector {
    name: string;
    icon: string;
    description: string;
    status: "new" | "connected" | "disconnected" | "connecting";
    category: string;
  }

  let appConnectors = $state<AppConnector[]>([
    { name: "Instagram", icon: "📸", description: "Generate and publish Posts, Stories, or Reels", status: "new", category: "Social" },
    { name: "Gmail", icon: "📧", description: "Draft replies, search inbox, summarize threads", status: "disconnected", category: "Google" },
    { name: "Google Calendar", icon: "📅", description: "Schedule events, manage calendars", status: "disconnected", category: "Google" },
    { name: "Google Drive", icon: "📁", description: "Search files, manage documents", status: "disconnected", category: "Google" },
    { name: "Slack", icon: "💬", description: "Send messages, manage channels", status: "disconnected", category: "Messaging" },
    { name: "GitHub", icon: "🐙", description: "Manage repos, issues, PRs", status: "disconnected", category: "Dev" },
    { name: "Notion", icon: "📝", description: "Search and create pages and databases", status: "disconnected", category: "Productivity" },
    { name: "Outlook Mail", icon: "📬", description: "Read, send, and manage emails", status: "disconnected", category: "Microsoft" },
    { name: "WhatsApp", icon: "📱", description: "Send and receive messages", status: "new", category: "Messaging" },
    { name: "Telegram", icon: "✈️", description: "Bot messaging and notifications", status: "disconnected", category: "Messaging" },
    { name: "Stripe", icon: "💳", description: "Manage payments and subscriptions", status: "disconnected", category: "Business" },
    { name: "Shopify", icon: "🛍️", description: "Manage products, orders, customers", status: "disconnected", category: "Business" },
  ]);

  // ── Custom API Keys (stored as secrets in DO) ──
  interface ApiProvider {
    name: string;
    icon: string;
    description: string;
    keyPrefix: string;
    connected: boolean;
    keyHint: string;
  }

  let apiProviders = $state<ApiProvider[]>([
    { name: "OpenAI", icon: "🤖", description: "GPT models for text and code", keyPrefix: "sk-", connected: false, keyHint: "sk-..." },
    { name: "Anthropic", icon: "🧠", description: "Claude models for reasoning", keyPrefix: "sk-ant-", connected: false, keyHint: "sk-ant-..." },
    { name: "Google Gemini", icon: "💎", description: "Multimodal content processing", keyPrefix: "AI", connected: false, keyHint: "AIza..." },
    { name: "Perplexity", icon: "🔍", description: "Real-time search with citations", keyPrefix: "pplx-", connected: false, keyHint: "pplx-..." },
    { name: "ElevenLabs", icon: "🔊", description: "Voice synthesis and cloning", keyPrefix: "", connected: false, keyHint: "API key" },
    { name: "Grok", icon: "⚡", description: "xAI's reasoning model", keyPrefix: "xai-", connected: false, keyHint: "xai-..." },
    { name: "OpenRouter", icon: "🔀", description: "Access multiple models via one API", keyPrefix: "sk-or-", connected: false, keyHint: "sk-or-..." },
    { name: "Cohere", icon: "🏢", description: "Enterprise AI for workflows", keyPrefix: "", connected: false, keyHint: "API key" },
    { name: "Ahrefs", icon: "📊", description: "SEO analysis and keyword tracking", keyPrefix: "", connected: false, keyHint: "API key" },
    { name: "Replicate", icon: "🎨", description: "Run open-source ML models", keyPrefix: "r8_", connected: false, keyHint: "r8_..." },
  ]);

  // ── Custom API form ──
  let showApiForm = $state(false);
  let apiFormName = $state("");
  let apiFormKey = $state("");
  let apiFormDesc = $state("");
  let savingApi = $state(false);

  // ── Editing an existing provider ──
  let editingProvider = $state<string | null>(null);
  let editApiKey = $state("");
  let savingEdit = $state(false);

  // ── MCP Servers ──
  interface McpServer {
    id: string;
    name: string;
    url: string;
    status: "connected" | "disconnected" | "connecting" | "error";
    toolCount?: number;
    error?: string;
  }

  let mcpServers = $state<McpServer[]>([]);
  let newMcpName = $state("");
  let newMcpUrl = $state("");
  let addingMcp = $state(false);
  let savingMcp = $state(false);
  let loadingMcp = $state(true);

  // ── Loading state ──
  let loadingSecrets = $state(true);

  // ── Derived filtered lists ──
  let filteredApps = $derived(
    searchQuery
      ? appConnectors.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : appConnectors
  );

  let filteredApis = $derived(
    searchQuery
      ? apiProviders.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : apiProviders
  );

  // ── Load existing secrets & MCP servers from DO ──
  $effect(() => {
    loadConnectorState();
  });

  async function loadConnectorState() {
    loadingSecrets = true;
    loadingMcp = true;

    try {
      // Load secrets via DO RPC to mark connected providers
      const secrets = await agentRpc.call<Array<{ key: string; category: string; description: string }>>("listSecrets");
      if (Array.isArray(secrets)) {
        const secretKeys = new Set(secrets.map(s => s.key.toLowerCase()));
        apiProviders = apiProviders.map(p => ({
          ...p,
          connected: secretKeys.has(p.name.toLowerCase()) ||
                     secretKeys.has(p.name.toLowerCase().replace(/\s+/g, "_")) ||
                     secretKeys.has(p.name.toLowerCase().replace(/\s+/g, "-")),
        }));
      }
    } catch {
      // DO not connected yet — will retry on reconnect
    }
    loadingSecrets = false;

    try {
      // Load MCP servers via DO RPC
      const servers = await agentRpc.call<Array<{ id: string; name: string; url: string; status?: string; tool_count?: number }>>("listServers");
      if (Array.isArray(servers)) {
        mcpServers = servers.map(s => ({
          id: s.id || s.name,
          name: s.name,
          url: s.url,
          status: (s.status as McpServer["status"]) || "connected",
          toolCount: s.tool_count,
        }));
      }
    } catch {}
    loadingMcp = false;
  }

  // ── App Connector Actions ──
  async function connectApp(app: AppConnector) {
    const idx = appConnectors.findIndex(a => a.name === app.name);
    if (idx === -1) return;
    appConnectors[idx] = { ...appConnectors[idx], status: "connecting" };
    appConnectors = [...appConnectors];

    try {
      const result = await getConnectorAuthUrl(app.name.toLowerCase().replace(/\s+/g, "-"));
      if (result.auth_url) {
        // Open OAuth popup
        const popup = window.open(result.auth_url, `connect_${app.name}`, "width=600,height=700,popup=yes");
        // Poll for popup close
        const timer = setInterval(() => {
          if (popup?.closed) {
            clearInterval(timer);
            appConnectors[idx] = { ...appConnectors[idx], status: "connected" };
            appConnectors = [...appConnectors];
          }
        }, 500);
        // Timeout after 2 minutes
        setTimeout(() => {
          clearInterval(timer);
          if (appConnectors[idx].status === "connecting") {
            appConnectors[idx] = { ...appConnectors[idx], status: "disconnected" };
            appConnectors = [...appConnectors];
          }
        }, 120_000);
      } else {
        appConnectors[idx] = { ...appConnectors[idx], status: "disconnected" };
        appConnectors = [...appConnectors];
      }
    } catch {
      appConnectors[idx] = { ...appConnectors[idx], status: "disconnected" };
      appConnectors = [...appConnectors];
    }
  }

  async function disconnectApp(app: AppConnector) {
    const idx = appConnectors.findIndex(a => a.name === app.name);
    if (idx === -1) return;
    try {
      await agentRpc.call("deleteSecret", [app.name.toLowerCase().replace(/\s+/g, "-")]);
      appConnectors[idx] = { ...appConnectors[idx], status: "disconnected" };
      appConnectors = [...appConnectors];
    } catch {}
  }

  // ── Custom API Actions ──
  async function saveApiKey(providerName: string, key: string, description?: string) {
    savingApi = true;
    try {
      const secretKey = providerName.toLowerCase().replace(/\s+/g, "-");
      await agentRpc.call("storeSecret", [secretKey, key, "api_key", description || `${providerName} API key`]);
      // Update provider state
      apiProviders = apiProviders.map(p =>
        p.name === providerName ? { ...p, connected: true } : p
      );
      return true;
    } catch {
      return false;
    } finally {
      savingApi = false;
    }
  }

  async function removeApiKey(providerName: string) {
    try {
      const secretKey = providerName.toLowerCase().replace(/\s+/g, "-");
      await agentRpc.call("deleteSecret", [secretKey]);
      apiProviders = apiProviders.map(p =>
        p.name === providerName ? { ...p, connected: false } : p
      );
    } catch {}
  }

  async function handleSaveCustomApi() {
    if (!apiFormName || !apiFormKey) return;
    const ok = await saveApiKey(apiFormName, apiFormKey, apiFormDesc);
    if (ok) {
      apiFormName = "";
      apiFormKey = "";
      apiFormDesc = "";
      showApiForm = false;
      await loadConnectorState();
    }
  }

  async function handleSaveProviderKey(name: string) {
    if (!editApiKey) return;
    savingEdit = true;
    const ok = await saveApiKey(name, editApiKey);
    if (ok) {
      editingProvider = null;
      editApiKey = "";
    }
    savingEdit = false;
  }

  // ── MCP Actions ──
  async function addMcpServer() {
    if (!newMcpName || !newMcpUrl) return;
    savingMcp = true;
    try {
      const result = await agentRpc.call<{ ok?: boolean; id?: string; error?: string }>("addServer", [newMcpName, newMcpUrl]);
      if (result && (result as any).error) {
        mcpServers = [...mcpServers, {
          id: newMcpName,
          name: newMcpName,
          url: newMcpUrl,
          status: "error",
          error: (result as any).error,
        }];
      } else {
        mcpServers = [...mcpServers, {
          id: (result as any)?.id || newMcpName,
          name: newMcpName,
          url: newMcpUrl,
          status: "connected",
        }];
      }
      newMcpName = "";
      newMcpUrl = "";
      addingMcp = false;
    } catch (err) {
      mcpServers = [...mcpServers, {
        id: newMcpName,
        name: newMcpName,
        url: newMcpUrl,
        status: "error",
        error: (err as Error).message,
      }];
    }
    savingMcp = false;
  }

  async function removeMcpServer(server: McpServer) {
    try {
      await agentRpc.call("removeServer", [server.id]);
      mcpServers = mcpServers.filter(s => s.id !== server.id);
    } catch {}
  }

  async function testMcpServer(server: McpServer) {
    const idx = mcpServers.findIndex(s => s.id === server.id);
    if (idx === -1) return;
    mcpServers[idx] = { ...mcpServers[idx], status: "connecting" };
    mcpServers = [...mcpServers];
    try {
      // Re-add triggers a connection test in the DO
      await agentRpc.call("addServer", [server.name, server.url]);
      mcpServers[idx] = { ...mcpServers[idx], status: "connected", error: undefined };
    } catch (err) {
      mcpServers[idx] = { ...mcpServers[idx], status: "error", error: (err as Error).message };
    }
    mcpServers = [...mcpServers];
  }
</script>

<div class="mx-auto max-w-5xl p-6">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Connectors</h1>
      <p class="mt-1 text-sm text-muted-foreground">Connect apps, APIs, and MCP servers to your agent</p>
    </div>
    <button onclick={() => history.back()} class="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <!-- Tabs + Search -->
  <div class="mb-6 flex items-center gap-4 border-b border-border">
    <div class="flex gap-0">
      {#each [
        { id: "apps", label: "Apps", count: appConnectors.filter(a => a.status === "connected").length },
        { id: "api", label: "Custom API", count: apiProviders.filter(a => a.connected).length },
        { id: "mcp", label: "Custom MCP", count: mcpServers.filter(s => s.status === "connected").length },
      ] as tab}
        <button
          class="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
            {activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = tab.id as Tab)}
        >
          {tab.label}
          {#if tab.count > 0}
            <span class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{tab.count}</span>
          {/if}
        </button>
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

  <!-- ═══════════ APPS TAB ═══════════ -->
  {#if activeTab === "apps"}
    {#if filteredApps.some(a => a.status === "new")}
      <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Recommended</p>
      <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {#each filteredApps.filter(a => a.status === "new") as app}
          <div class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/20">
            <span class="text-2xl">{app.icon}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm">{app.name}</span>
                <span class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary uppercase">New</span>
              </div>
              <p class="mt-0.5 text-xs text-muted-foreground">{app.description}</p>
            </div>
            <Button size="sm" variant="outline" onclick={() => connectApp(app)}>
              Connect
            </Button>
          </div>
        {/each}
      </div>
    {/if}

    {#if filteredApps.some(a => a.status === "connected")}
      <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Connected</p>
      <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {#each filteredApps.filter(a => a.status === "connected") as app}
          <div class="flex items-start gap-3 rounded-xl border border-green-500/20 bg-green-500/5 p-4">
            <span class="text-2xl">{app.icon}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm">{app.name}</span>
                <span class="flex items-center gap-1 text-[10px] text-green-500">
                  <span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>
                  Connected
                </span>
              </div>
              <p class="mt-0.5 text-xs text-muted-foreground">{app.description}</p>
            </div>
            <Button size="sm" variant="ghost" class="text-xs text-muted-foreground" onclick={() => disconnectApp(app)}>
              Disconnect
            </Button>
          </div>
        {/each}
      </div>
    {/if}

    <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Available</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each filteredApps.filter(a => a.status === "disconnected") as app}
        <div class="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/20">
          <span class="text-2xl">{app.icon}</span>
          <div class="flex-1 min-w-0">
            <span class="font-medium text-sm">{app.name}</span>
            <p class="mt-0.5 text-xs text-muted-foreground">{app.description}</p>
          </div>
          <Button size="sm" variant="outline" onclick={() => connectApp(app)}>
            Connect
          </Button>
        </div>
      {/each}
      {#each filteredApps.filter(a => a.status === "connecting") as app}
        <div class="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <span class="text-2xl">{app.icon}</span>
          <div class="flex-1 min-w-0">
            <span class="font-medium text-sm">{app.name}</span>
            <p class="mt-0.5 text-xs text-muted-foreground">{app.description}</p>
          </div>
          <div class="flex items-center gap-2 text-xs text-amber-500">
            <div class="h-3 w-3 animate-spin rounded-full border border-amber-500 border-t-transparent"></div>
            Connecting...
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- ═══════════ CUSTOM API TAB ═══════════ -->
  {#if activeTab === "api"}
    <p class="mb-4 text-sm text-muted-foreground">Store API keys securely. Your agent uses them to access third-party services.</p>

    <!-- Add custom API button -->
    <button
      class="mb-6 flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors w-full"
      onclick={() => (showApiForm = !showApiForm)}
    >
      <span>{showApiForm ? "−" : "+"}</span>
      <span>{showApiForm ? "Cancel" : "Add custom API key"}</span>
    </button>

    <!-- Custom API form -->
    {#if showApiForm}
      <div class="mb-6 rounded-xl border border-border bg-card p-4 space-y-3">
        <p class="text-sm font-medium">Add Custom API Key</p>
        <Input placeholder="Service name (e.g. My API)" bind:value={apiFormName} />
        <Input type="password" placeholder="API key or token" bind:value={apiFormKey} />
        <Input placeholder="Description (optional)" bind:value={apiFormDesc} />
        <div class="flex gap-2">
          <Button size="sm" disabled={!apiFormName || !apiFormKey || savingApi} onclick={handleSaveCustomApi}>
            {savingApi ? "Saving..." : "Save Key"}
          </Button>
          <Button variant="ghost" size="sm" onclick={() => { showApiForm = false; apiFormName = ""; apiFormKey = ""; apiFormDesc = ""; }}>
            Cancel
          </Button>
        </div>
      </div>
    {/if}

    {#if loadingSecrets}
      <div class="flex items-center justify-center py-12">
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
      </div>
    {:else}
      <!-- Connected providers first -->
      {#if apiProviders.some(p => p.connected)}
        <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Connected</p>
        <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {#each apiProviders.filter(p => p.connected) as provider}
            <div class="flex items-start gap-3 rounded-xl border border-green-500/20 bg-green-500/5 p-4">
              <span class="text-2xl">{provider.icon}</span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-sm">{provider.name}</span>
                  <span class="flex items-center gap-1 text-[10px] text-green-500">
                    <span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>
                    Active
                  </span>
                </div>
                <p class="mt-0.5 text-xs text-muted-foreground">{provider.description}</p>
              </div>
              <div class="flex gap-1">
                <Button size="sm" variant="ghost" class="text-xs"
                  onclick={() => { editingProvider = provider.name; editApiKey = ""; }}>
                  Update
                </Button>
                <Button size="sm" variant="ghost" class="text-xs text-destructive"
                  onclick={() => removeApiKey(provider.name)}>
                  Remove
                </Button>
              </div>
            </div>
            {#if editingProvider === provider.name}
              <div class="col-span-full rounded-lg border border-border bg-card/50 p-3 flex gap-2 items-end sm:col-span-2">
                <div class="flex-1">
                  <p class="text-xs text-muted-foreground mb-1">New API key for {provider.name}</p>
                  <Input type="password" placeholder={provider.keyHint} bind:value={editApiKey} />
                </div>
                <Button size="sm" disabled={!editApiKey || savingEdit} onclick={() => handleSaveProviderKey(provider.name)}>
                  {savingEdit ? "..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onclick={() => { editingProvider = null; editApiKey = ""; }}>
                  Cancel
                </Button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      <!-- Available providers -->
      <p class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Available</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {#each apiProviders.filter(p => !p.connected) as provider}
          <div class="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/20">
            <span class="text-2xl">{provider.icon}</span>
            <div class="flex-1 min-w-0">
              <span class="font-medium text-sm">{provider.name}</span>
              <p class="mt-0.5 text-xs text-muted-foreground">{provider.description}</p>
            </div>
            {#if editingProvider === provider.name}
              <div class="flex items-end gap-2">
                <Input type="password" placeholder={provider.keyHint} bind:value={editApiKey} class="h-8 w-40 text-xs" />
                <Button size="sm" disabled={!editApiKey || savingEdit} onclick={() => handleSaveProviderKey(provider.name)}>
                  {savingEdit ? "..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onclick={() => { editingProvider = null; editApiKey = ""; }}>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Button>
              </div>
            {:else}
              <Button size="sm" variant="outline" class="opacity-0 group-hover:opacity-100 transition-opacity"
                onclick={() => { editingProvider = provider.name; editApiKey = ""; }}>
                Add Key
              </Button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- ═══════════ CUSTOM MCP TAB ═══════════ -->
  {#if activeTab === "mcp"}
    <p class="mb-4 text-sm text-muted-foreground">Connect Model Context Protocol servers to extend your agent's capabilities.</p>

    {#if loadingMcp}
      <div class="flex items-center justify-center py-12">
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
      </div>
    {:else}
      <!-- Connected servers -->
      {#if mcpServers.length > 0}
        <div class="mb-6 space-y-2">
          {#each mcpServers as server}
            <div class="flex items-center gap-3 rounded-xl border p-4 transition-all
              {server.status === 'connected' ? 'border-green-500/20 bg-green-500/5' :
               server.status === 'error' ? 'border-destructive/20 bg-destructive/5' :
               'border-border bg-card'}">
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm">
                {#if server.status === "connecting"}
                  <div class="h-3 w-3 animate-spin rounded-full border border-foreground border-t-transparent"></div>
                {:else if server.status === "connected"}
                  <span class="text-green-500">&#10003;</span>
                {:else if server.status === "error"}
                  <span class="text-destructive">&#10007;</span>
                {:else}
                  <span class="text-muted-foreground">&#8226;</span>
                {/if}
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <p class="text-sm font-medium">{server.name}</p>
                  {#if server.toolCount}
                    <span class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{server.toolCount} tools</span>
                  {/if}
                </div>
                <p class="mt-0.5 text-xs text-muted-foreground font-mono truncate">{server.url}</p>
                {#if server.error}
                  <p class="mt-1 text-xs text-destructive">{server.error}</p>
                {/if}
              </div>
              <div class="flex gap-1">
                <Button size="sm" variant="ghost" class="text-xs" onclick={() => testMcpServer(server)}>
                  Test
                </Button>
                <Button size="sm" variant="ghost" class="text-xs text-destructive" onclick={() => removeMcpServer(server)}>
                  Remove
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="mb-6 flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12">
          <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </div>
          <p class="text-sm text-muted-foreground">No MCP servers connected</p>
          <p class="mt-1 text-xs text-muted-foreground/70">Add a server to give your agent access to external tools</p>
        </div>
      {/if}

      <!-- Add MCP form -->
      {#if addingMcp}
        <div class="rounded-xl border border-border bg-card p-4 space-y-3">
          <p class="text-sm font-medium">Add MCP Server</p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input placeholder="Server name" bind:value={newMcpName} />
            <Input placeholder="wss://your-server.com/mcp" bind:value={newMcpUrl} />
          </div>
          <p class="text-[11px] text-muted-foreground">
            Supports WebSocket (wss://) and HTTP (https://) MCP endpoints. The server must implement the MCP protocol.
          </p>
          <div class="flex gap-2">
            <Button size="sm" disabled={!newMcpName || !newMcpUrl || savingMcp} onclick={addMcpServer}>
              {savingMcp ? "Connecting..." : "Connect"}
            </Button>
            <Button variant="ghost" size="sm" onclick={() => { addingMcp = false; newMcpName = ""; newMcpUrl = ""; }}>
              Cancel
            </Button>
          </div>
        </div>
      {:else}
        <Button variant="outline" onclick={() => (addingMcp = true)}>
          + Add MCP Server
        </Button>
      {/if}
    {/if}
  {/if}
</div>
