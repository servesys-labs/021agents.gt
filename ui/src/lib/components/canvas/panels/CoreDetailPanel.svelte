<script lang="ts">
  import type { CanvasStore } from "$lib/stores/canvas.svelte";

  interface Props {
    store: CanvasStore;
  }

  let { store }: Props = $props();

  const plans = [
    { id: "free", label: "Free" },
    { id: "basic", label: "Basic" },
    { id: "standard", label: "Standard" },
    { id: "premium", label: "Premium" },
  ];

  const reasoningOptions = [
    { value: "auto", label: "Auto" },
    { value: "chain-of-thought", label: "Chain of Thought" },
    { value: "plan-then-execute", label: "Plan then Execute" },
    { value: "step-back", label: "Step Back" },
    { value: "decompose", label: "Decompose" },
    { value: "verify-then-respond", label: "Verify then Respond" },
  ];
</script>

<div class="space-y-4">
  <h3 class="text-sm font-semibold text-foreground">Agent Identity</h3>

  <div>
    <label for="cd-desc" class="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
    <textarea
      id="cd-desc"
      rows={3}
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
      placeholder="What does this agent do?"
      bind:value={store.description}
    ></textarea>
  </div>

  <div>
    <label for="cd-plan" class="mb-1 block text-xs font-medium text-muted-foreground">Plan</label>
    <select
      id="cd-plan"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      bind:value={store.plan}
    >
      {#each plans as p}
        <option value={p.id}>{p.label}</option>
      {/each}
    </select>
  </div>

  <div>
    <label for="cd-model" class="mb-1 block text-xs font-medium text-muted-foreground">Model Override</label>
    <input
      id="cd-model"
      type="text"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      placeholder="Leave empty for auto-routing"
      bind:value={store.modelOverride}
    />
  </div>

  <div>
    <label for="cd-temp" class="mb-1 block text-xs font-medium text-muted-foreground">
      Temperature: {store.temperature.toFixed(2)}
    </label>
    <input
      id="cd-temp"
      type="range"
      min="0"
      max="2"
      step="0.05"
      class="w-full accent-primary"
      bind:value={store.temperature}
    />
  </div>

  <div>
    <label for="cd-maxtokens" class="mb-1 block text-xs font-medium text-muted-foreground">Max Tokens</label>
    <input
      id="cd-maxtokens"
      type="number"
      min="256"
      max="128000"
      step="256"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      bind:value={store.maxTokens}
    />
  </div>

  <div>
    <label for="cd-reasoning" class="mb-1 block text-xs font-medium text-muted-foreground">Reasoning Strategy</label>
    <select
      id="cd-reasoning"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      bind:value={store.reasoningStrategy}
    >
      {#each reasoningOptions as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>

  <div>
    <label for="cd-maxturns" class="mb-1 block text-xs font-medium text-muted-foreground">Max Turns</label>
    <input
      id="cd-maxturns"
      type="number"
      min="1"
      max="200"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      bind:value={store.maxTurns}
    />
  </div>

  <div class="flex items-center justify-between">
    <label for="cd-active" class="text-xs font-medium text-muted-foreground">Active</label>
    <button
      id="cd-active"
      type="button"
      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring {store.isActive ? 'bg-primary' : 'bg-muted'}"
      role="switch"
      aria-checked={store.isActive}
      onclick={() => (store.isActive = !store.isActive)}
    >
      <span
        class="pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform {store.isActive ? 'translate-x-4' : 'translate-x-0'}"
      ></span>
    </button>
  </div>
</div>
