<script lang="ts">
  import type { CanvasStore } from "$lib/stores/canvas.svelte";

  interface Props {
    store: CanvasStore;
  }

  let { store }: Props = $props();
</script>

<div class="space-y-3">
  <h3 class="text-sm font-semibold text-foreground">System Prompt</h3>
  <p class="text-xs text-muted-foreground">
    Define your agent's personality, capabilities, and constraints.
  </p>
  <textarea
    rows={16}
    class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y leading-relaxed"
    placeholder="You are a helpful AI assistant..."
    bind:value={store.systemPrompt}
  ></textarea>
</div>
