<script lang="ts">
  import { agentStore as agentRpc } from "$lib/stores/agent.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";

  interface Secret {
    key: string;
    category: string;
    description: string;
    created_at?: string;
    expires_at?: string;
  }

  let secrets = $state<Secret[]>([]);
  let loading = $state(true);
  let showAdd = $state(false);

  // Add form
  let newKey = $state("");
  let newValue = $state("");
  let newCategory = $state("api_key");
  let newDescription = $state("");
  let newExpiry = $state("");
  let saving = $state(false);
  let error = $state("");

  // Delete confirmation
  let deletingKey = $state<string | null>(null);

  const CATEGORIES = [
    { value: "api_key", label: "API Key" },
    { value: "oauth_token", label: "OAuth Token" },
    { value: "database", label: "Database Credential" },
    { value: "webhook", label: "Webhook Secret" },
    { value: "encryption", label: "Encryption Key" },
    { value: "other", label: "Other" },
  ];

  const categoryColors: Record<string, string> = {
    api_key: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    oauth_token: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    database: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    webhook: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
    encryption: "bg-red-500/10 text-red-400 border-red-500/20",
    other: "bg-muted text-muted-foreground border-border",
  };

  $effect(() => {
    loadSecrets();
  });

  async function loadSecrets() {
    loading = true;
    try {
      const result = await agentRpc.call<Secret[]>("listSecrets");
      secrets = Array.isArray(result) ? result : [];
    } catch {
      secrets = [];
    }
    loading = false;
  }

  async function addSecret() {
    if (!newKey.trim() || !newValue.trim()) return;
    error = "";
    saving = true;
    try {
      const expirySec = newExpiry ? parseInt(newExpiry) * 86400 : undefined;
      await agentRpc.call("storeSecret", [
        newKey.trim(),
        newValue.trim(),
        newCategory,
        newDescription.trim(),
        expirySec,
      ]);
      newKey = "";
      newValue = "";
      newDescription = "";
      newExpiry = "";
      showAdd = false;
      await loadSecrets();
    } catch (err) {
      error = (err as Error).message || "Failed to store secret";
    }
    saving = false;
  }

  async function deleteSecret(key: string) {
    try {
      await agentRpc.call("deleteSecret", [key]);
      secrets = secrets.filter(s => s.key !== key);
      deletingKey = null;
    } catch (err) {
      error = (err as Error).message || "Failed to delete secret";
    }
  }
</script>

<div class="mx-auto max-w-3xl p-6">
  <div class="mb-2 flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Secrets & Credentials</h1>
      <p class="mt-1 text-sm text-muted-foreground">Manage API keys, tokens, and credentials your agent uses to access external services.</p>
    </div>
    <Button size="sm" onclick={() => (showAdd = !showAdd)}>
      {showAdd ? "Cancel" : "+ Add Secret"}
    </Button>
  </div>

  {#if error}
    <div class="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {error}
      <button class="ml-2 underline" onclick={() => (error = "")}>dismiss</button>
    </div>
  {/if}

  <!-- Add secret form -->
  {#if showAdd}
    <div class="mt-4 rounded-xl border border-border bg-card p-4 space-y-3">
      <p class="text-sm font-medium">New Secret</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-xs text-muted-foreground">Key name</label>
          <Input placeholder="e.g. openai-api-key" bind:value={newKey} />
        </div>
        <div>
          <label class="mb-1 block text-xs text-muted-foreground">Category</label>
          <select
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            bind:value={newCategory}
          >
            {#each CATEGORIES as cat}
              <option value={cat.value}>{cat.label}</option>
            {/each}
          </select>
        </div>
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted-foreground">Value</label>
        <Input type="password" placeholder="Secret value (will be encrypted)" bind:value={newValue} />
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-xs text-muted-foreground">Description (optional)</label>
          <Input placeholder="What this secret is for" bind:value={newDescription} />
        </div>
        <div>
          <label class="mb-1 block text-xs text-muted-foreground">Expires in (days, optional)</label>
          <Input type="number" placeholder="e.g. 90" bind:value={newExpiry} />
        </div>
      </div>
      <div class="flex gap-2 pt-1">
        <Button size="sm" disabled={!newKey.trim() || !newValue.trim() || saving} onclick={addSecret}>
          {saving ? "Saving..." : "Store Secret"}
        </Button>
        <Button variant="ghost" size="sm" onclick={() => (showAdd = false)}>Cancel</Button>
      </div>
    </div>
  {/if}

  <!-- Secrets list -->
  <div class="mt-6">
    {#if loading}
      <div class="flex items-center justify-center py-12">
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
      </div>
    {:else if secrets.length === 0}
      <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12">
        <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
        </div>
        <p class="text-sm text-muted-foreground">No secrets stored</p>
        <p class="mt-1 text-xs text-muted-foreground/70">Add API keys or tokens your agent needs to access services</p>
      </div>
    {:else}
      <div class="space-y-2">
        {#each secrets as secret}
          <div class="flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-border/80">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium font-mono">{secret.key}</span>
                <span class="rounded border px-1.5 py-0.5 text-[10px] {categoryColors[secret.category] || categoryColors.other}">
                  {CATEGORIES.find(c => c.value === secret.category)?.label || secret.category}
                </span>
              </div>
              {#if secret.description}
                <p class="mt-0.5 text-xs text-muted-foreground">{secret.description}</p>
              {/if}
              <p class="mt-0.5 text-[10px] text-muted-foreground/60">
                {secret.created_at ? `Added ${new Date(secret.created_at).toLocaleDateString()}` : ""}
                {secret.expires_at ? ` · Expires ${new Date(secret.expires_at).toLocaleDateString()}` : ""}
              </p>
            </div>
            <div class="flex gap-1">
              {#if deletingKey === secret.key}
                <Button size="sm" variant="destructive" onclick={() => deleteSecret(secret.key)}>
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onclick={() => (deletingKey = null)}>
                  Cancel
                </Button>
              {:else}
                <Button size="sm" variant="ghost" class="text-destructive" onclick={() => (deletingKey = secret.key)}>
                  Delete
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
