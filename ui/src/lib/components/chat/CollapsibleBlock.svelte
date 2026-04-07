<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Snippet, Component } from "svelte";

  interface Props {
    open?: boolean;
    title: string;
    subtitle?: string;
    icon?: "wrench" | "loader" | "error" | "brain" | "chevron";
    iconSpin?: boolean;
    isStreaming?: boolean;
    class?: string;
    contentMaxHeight?: string;
    children: Snippet;
    onToggle?: () => void;
  }

  let {
    open = $bindable(false),
    title,
    subtitle,
    icon = "chevron",
    iconSpin = false,
    isStreaming = false,
    class: className = "",
    contentMaxHeight = "20rem",
    children,
    onToggle,
  }: Props = $props();

  let contentEl: HTMLDivElement | undefined = $state();

  // Auto-scroll content when streaming and open
  $effect(() => {
    if (open && isStreaming && contentEl) {
      const frame = requestAnimationFrame(() => {
        if (contentEl) {
          contentEl.scrollTop = contentEl.scrollHeight;
        }
      });
      return () => cancelAnimationFrame(frame);
    }
  });

  function toggle() {
    open = !open;
    onToggle?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }
</script>

<div class={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
  <!-- Header / trigger -->
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs transition-colors hover:bg-muted/50"
    onclick={toggle}
    aria-expanded={open}
    aria-label="{title} - click to {open ? 'collapse' : 'expand'}"
  >
    <!-- Icon -->
    {#if icon === "loader" || iconSpin}
      <span class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"></span>
    {:else if icon === "wrench"}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    {:else if icon === "error"}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    {:else if icon === "brain"}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
        <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
        <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
        <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
        <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
        <path d="M6 18a4 4 0 0 1-1.967-.516" />
        <path d="M19.967 17.484A4 4 0 0 1 18 18" />
      </svg>
    {:else}
      <!-- Default chevron -->
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M8 5v14l11-7z" />
      </svg>
    {/if}

    <span class="font-mono font-semibold text-foreground">{title}</span>

    {#if subtitle}
      <span class="text-muted-foreground italic">{subtitle}</span>
    {/if}

    <!-- Expand/collapse chevron on right -->
    <span class="ml-auto">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-180")}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  </button>

  <!-- Content -->
  {#if open}
    <div
      bind:this={contentEl}
      class="overflow-y-auto border-t border-border"
      style="max-height: {contentMaxHeight};"
    >
      {@render children()}
    </div>
  {/if}
</div>
