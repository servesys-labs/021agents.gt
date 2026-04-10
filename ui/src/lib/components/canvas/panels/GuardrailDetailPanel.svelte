<script lang="ts">
  import type { CanvasStore } from "$lib/stores/canvas.svelte";

  interface Props {
    store: CanvasStore;
  }

  let { store }: Props = $props();
</script>

<div class="space-y-4">
  <h3 class="text-sm font-semibold text-foreground">Guardrails</h3>

  <!-- Budget -->
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <label for="gd-budget-toggle" class="text-xs font-medium text-muted-foreground">Budget Limit</label>
      <button
        id="gd-budget-toggle"
        type="button"
        class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring {store.budgetEnabled ? 'bg-primary' : 'bg-muted'}"
        role="switch"
        aria-checked={store.budgetEnabled}
        aria-label="Toggle budget limit"
        onclick={() => (store.budgetEnabled = !store.budgetEnabled)}
      >
        <span
          class="pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform {store.budgetEnabled ? 'translate-x-4' : 'translate-x-0'}"
        ></span>
      </button>
    </div>

    {#if store.budgetEnabled}
      <div>
        <label for="gd-budget-amount" class="mb-1 block text-xs text-muted-foreground">
          Amount (USD)
        </label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <input
            id="gd-budget-amount"
            type="number"
            min="0.5"
            max="1000"
            step="0.5"
            class="w-full rounded-md border border-input bg-background py-2 pl-7 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            bind:value={store.budgetLimit}
          />
        </div>
      </div>
    {/if}
  </div>

  <!-- Timeout -->
  <div>
    <label for="gd-timeout" class="mb-1 block text-xs font-medium text-muted-foreground">
      Timeout (seconds)
    </label>
    <input
      id="gd-timeout"
      type="number"
      min="0"
      max="3600"
      step="30"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      bind:value={store.timeoutSeconds}
    />
    <p class="mt-1 text-[10px] text-muted-foreground">
      {#if store.timeoutSeconds > 0}
        {Math.round(store.timeoutSeconds / 60)} min {store.timeoutSeconds % 60}s
      {:else}
        No timeout
      {/if}
    </p>
  </div>
</div>
