<script lang="ts">
  import { page } from "$app/stores";

  let slug = $derived($page.params.slug ?? "");
  let agent = $state<any>(null);
  let loading = $state(true);
  let error = $state("");
  let chatOpen = $state(false);
  let chatInput = $state("");
  let chatMessages = $state<Array<{ role: string; text: string }>>([]);
  let chatLoading = $state(false);

  $effect(() => {
    if (!slug) return;
    loadAgent(slug);
  });

  async function loadAgent(name: string) {
    loading = true;
    error = "";
    try {
      const res = await fetch(`https://api.021agents.ai/api/v1/agents/${encodeURIComponent(name)}`);
      if (!res.ok) { error = "Agent not found"; loading = false; return; }
      const data = await res.json();
      agent = data;
      // Check if public page is enabled
      if (agent && !agent.public_page_enabled && !agent.is_active) {
        error = "This agent page is not available";
      }
    } catch {
      error = "Could not load agent";
    }
    loading = false;
  }

  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return;
    const text = chatInput.trim();
    chatInput = "";
    chatMessages = [...chatMessages, { role: "user", text }];
    chatLoading = true;

    try {
      const res = await fetch("https://app.021agents.ai/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: Date.now(),
          method: "tasks/send",
          params: { skill: slug, message: { parts: [{ type: "text", text }] } }
        }),
      });
      const data = await res.json();
      const reply = data?.result?.messages?.[0]?.parts?.[0]?.text || "No response";
      chatMessages = [...chatMessages, { role: "agent", text: reply }];
    } catch {
      chatMessages = [...chatMessages, { role: "agent", text: "Sorry, I couldn't process that." }];
    }
    chatLoading = false;
  }

  // Derive display info
  let displayName = $derived(agent?.display_name || agent?.name || slug);
  let description = $derived(agent?.description || "An AI agent on 021agents");
  let icon = $derived(agent?.icon || displayName?.charAt(0)?.toUpperCase() || "A");
  let skills = $derived(agent?.skills || []);
  let channels = $derived(agent?.channels || []);
</script>

<svelte:head>
  <title>{displayName} — 021agents</title>
  <meta name="description" content={description} />
  <meta property="og:title" content="{displayName} — 021agents" />
  <meta property="og:description" content={description} />
  <meta property="og:type" content="profile" />
</svelte:head>

{#if loading}
  <div class="flex min-h-dvh items-center justify-center bg-background">
    <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
  </div>
{:else if error}
  <div class="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6">
    <div class="text-5xl opacity-30">404</div>
    <h1 class="text-xl font-semibold text-foreground">{error}</h1>
    <a href="/" class="text-sm text-primary hover:underline">Go to 021agents</a>
  </div>
{:else}
  <div class="min-h-dvh bg-background">
    <!-- Header -->
    <header class="border-b border-border/50 bg-card/50 backdrop-blur-sm">
      <div class="mx-auto flex max-w-2xl items-center justify-between px-6 py-4">
        <a href="/" class="text-xs text-muted-foreground hover:text-foreground transition-colors">021agents</a>
        <span class="flex items-center gap-1.5 text-xs text-green-500">
          <span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>
          Online
        </span>
      </div>
    </header>

    <!-- Agent Profile -->
    <main class="mx-auto max-w-2xl px-6 py-12">
      <!-- Identity -->
      <div class="mb-10 text-center">
        <div class="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-3xl text-primary">
          {icon}
        </div>
        <h1 class="text-2xl font-bold text-foreground">{displayName}</h1>
        <p class="mt-2 text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">{description}</p>
      </div>

      <!-- Skills -->
      {#if skills.length > 0}
        <div class="mb-8">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Capabilities</h2>
          <div class="flex flex-wrap gap-2">
            {#each skills as skill}
              <span class="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                {typeof skill === "string" ? skill : skill.name || skill.id}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Channels -->
      {#if channels.length > 0}
        <div class="mb-8">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Available on</h2>
          <div class="flex flex-wrap gap-2">
            {#each channels as channel}
              <span class="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                {typeof channel === "string" ? channel : channel.name || channel.type}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Agent Card (A2A) -->
      <div class="mb-8 rounded-xl border border-border bg-card/50 p-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-xs font-medium text-muted-foreground">A2A Discovery</p>
            <p class="mt-0.5 text-[11px] text-muted-foreground/60 font-mono">app.021agents.ai/.well-known/agent.json</p>
          </div>
          <span class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">A2A v0.3</span>
        </div>
      </div>

      <!-- Chat Widget -->
      <div class="rounded-xl border border-border bg-card overflow-hidden">
        <button
          class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
          onclick={() => (chatOpen = !chatOpen)}
        >
          <span class="text-sm font-medium text-foreground">Chat with {displayName}</span>
          <span class="text-muted-foreground text-xs">{chatOpen ? "Close" : "Open"}</span>
        </button>

        {#if chatOpen}
          <div class="border-t border-border">
            <!-- Messages -->
            <div class="max-h-80 overflow-y-auto p-4 space-y-3">
              {#if chatMessages.length === 0}
                <p class="text-center text-xs text-muted-foreground py-6">Send a message to start chatting</p>
              {/if}
              {#each chatMessages as msg}
                <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
                  <div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm
                    {msg.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-md'
                      : 'bg-muted text-foreground rounded-bl-md'}">
                    {msg.text}
                  </div>
                </div>
              {/each}
              {#if chatLoading}
                <div class="flex justify-start">
                  <div class="rounded-2xl rounded-bl-md bg-muted px-3 py-2">
                    <div class="flex gap-1">
                      <span class="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce"></span>
                      <span class="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style="animation-delay: 0.1s"></span>
                      <span class="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style="animation-delay: 0.2s"></span>
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Input -->
            <div class="flex items-center gap-2 border-t border-border p-3">
              <input
                type="text"
                placeholder="Ask anything..."
                class="flex-1 rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary/30"
                bind:value={chatInput}
                onkeydown={(e) => { if (e.key === "Enter") sendChat(); }}
              />
              <button
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                onclick={sendChat}
                disabled={!chatInput.trim() || chatLoading}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="mt-12 text-center">
        <p class="text-[11px] text-muted-foreground/40">
          Powered by <a href="https://021agents.ai" class="hover:text-primary transition-colors">021agents</a>
        </p>
      </div>
    </main>
  </div>
{/if}
