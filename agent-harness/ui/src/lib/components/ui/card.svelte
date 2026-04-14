<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";

  interface Props {
    header?: Snippet;
    children: Snippet;
    footer?: Snippet;
    class?: string;
    onclick?: () => void;
  }

  let { header, children, footer, class: className, onclick }: Props = $props();
</script>

{#if onclick}
  <button
    type="button"
    class={cn(
      "w-full rounded-lg border border-border bg-card text-card-foreground shadow-sm text-left cursor-pointer hover:border-ring transition-colors",
      className
    )}
    onclick={onclick}
  >
    {#if header}
      <div class="flex flex-col space-y-1.5 p-6 pb-0">
        {@render header()}
      </div>
    {/if}
    <div class="p-6">
      {@render children()}
    </div>
    {#if footer}
      <div class="flex items-center p-6 pt-0">
        {@render footer()}
      </div>
    {/if}
  </button>
{:else}
  <div
    class={cn(
      "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
      className
    )}
  >
    {#if header}
      <div class="flex flex-col space-y-1.5 p-6 pb-0">
        {@render header()}
      </div>
    {/if}
    <div class="p-6">
      {@render children()}
    </div>
    {#if footer}
      <div class="flex items-center p-6 pt-0">
        {@render footer()}
      </div>
    {/if}
  </div>
{/if}
