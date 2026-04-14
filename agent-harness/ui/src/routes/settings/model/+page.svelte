<script lang="ts">
  import { api } from "$lib/services/api";
  import Badge from "$lib/components/ui/badge.svelte";

  type Model = { id: string; name: string; provider: string; tier: string; costPer1kTokens: number };

  let models = $state<Model[]>([]);
  let currentModel = $state("");
  let loading = $state(true);
  let saving = $state(false);

  const tierColors: Record<string, string> = {
    free: "bg-green-500/10 text-green-400 border-green-500/20",
    budget: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    standard: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    premium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    speed: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  };

  const tierLabels: Record<string, string> = {
    free: "Free",
    budget: "Budget",
    standard: "Standard",
    premium: "Premium",
    speed: "Fast",
  };

  $effect(() => {
    loadModels();
  });

  async function loadModels() {
    loading = true;
    try {
      const [catalog, current] = await Promise.all([
        fetch(`${api.baseUrl.replace('/api/v1', '')}/api/v1/models`).then(r => r.json()) as Promise<Model[]>,
        api.get<{ model: string }>(`/agents/default/model`).catch(() => ({ model: "@cf/moonshotai/kimi-k2.5" })),
      ]);
      models = catalog;
      currentModel = (current as any).model || "@cf/moonshotai/kimi-k2.5";
    } catch {
      models = [];
    }
    loading = false;
  }

  async function selectModel(modelId: string) {
    saving = true;
    try {
      await api.put("/agents/default/model", { model: modelId });
      currentModel = modelId;
    } catch (err) {
      console.error("Failed to set model:", err);
    }
    saving = false;
  }

  // Group by tier
  let tiers = $derived(
    ["free", "budget", "standard", "premium", "speed"].map(tier => ({
      tier,
      label: tierLabels[tier] || tier,
      models: models.filter(m => m.tier === tier),
    })).filter(g => g.models.length > 0)
  );
</script>

<div class="mx-auto max-w-3xl p-6">
  <h1 class="mb-2 text-xl font-semibold">AI Model</h1>
  <p class="mb-6 text-sm text-muted-foreground">Choose the AI model for your personal agent. Free models have no cost. Premium models are charged per token.</p>

  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
    </div>
  {:else}
    {#each tiers as group}
      <div class="mb-6">
        <div class="mb-3 flex items-center gap-2">
          <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</span>
          {#if group.tier === "free"}
            <span class="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] text-green-400">No cost</span>
          {/if}
        </div>

        <div class="space-y-2">
          {#each group.models as model}
            {@const isSelected = model.id === currentModel}
            <button
              class="flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-all
                {isSelected ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border bg-card hover:border-primary/20 hover:bg-card/80'}"
              onclick={() => selectModel(model.id)}
              disabled={saving}
            >
              <!-- Radio indicator -->
              <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 {isSelected ? 'border-primary' : 'border-muted-foreground/30'}">
                {#if isSelected}
                  <div class="h-2.5 w-2.5 rounded-full bg-primary"></div>
                {/if}
              </div>

              <!-- Model info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-sm">{model.name}</span>
                  <span class="rounded border px-1.5 py-0.5 text-[10px] {tierColors[model.tier] || 'border-border text-muted-foreground'}">
                    {model.provider}
                  </span>
                </div>
                <p class="mt-0.5 text-xs text-muted-foreground font-mono">{model.id}</p>
              </div>

              <!-- Price -->
              <div class="shrink-0 text-right">
                {#if model.costPer1kTokens === 0}
                  <span class="text-sm font-medium text-green-400">Free</span>
                {:else}
                  <span class="text-sm font-medium">${model.costPer1kTokens}</span>
                  <span class="block text-[10px] text-muted-foreground">/1k tokens</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>
