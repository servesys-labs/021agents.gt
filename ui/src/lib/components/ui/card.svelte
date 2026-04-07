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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={cn(
    "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
    onclick && "cursor-pointer hover:border-ring transition-colors",
    className
  )}
  onclick={onclick}
  onkeydown={onclick ? (e) => e.key === "Enter" && onclick() : undefined}
  role={onclick ? "button" : undefined}
  tabindex={onclick ? 0 : undefined}
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
