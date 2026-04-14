<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";

  interface Props {
    thead: Snippet;
    tbody: Snippet;
    class?: string;
  }

  let { thead, tbody, class: className }: Props = $props();
</script>

<div class={cn("overflow-x-auto rounded-lg border border-border", className)}>
  <table class="w-full text-sm">
    <thead class="sticky top-0 border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
      {@render thead()}
    </thead>
    <tbody class="divide-y divide-border bg-card">
      {@render tbody()}
    </tbody>
  </table>
</div>
