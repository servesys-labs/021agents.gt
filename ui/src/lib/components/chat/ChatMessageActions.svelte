<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    role: "user" | "assistant";
    onCopy: () => void;
    onEdit?: () => void;
    onRegenerate?: () => void;
    onDelete?: () => void;
  }

  let { role, onCopy, onEdit, onRegenerate, onDelete }: Props = $props();

  let copied = $state(false);
  let confirmingDelete = $state(false);

  function handleCopy() {
    onCopy();
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  function handleDelete() {
    if (confirmingDelete) {
      onDelete?.();
      confirmingDelete = false;
    } else {
      confirmingDelete = true;
      setTimeout(() => { confirmingDelete = false; }, 3000);
    }
  }
</script>

<div
  class={cn(
    "absolute -bottom-4 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-popover px-1 py-0.5 shadow-md",
    "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
  )}
  role="toolbar"
  aria-label="Message actions"
>
  <!-- Copy -->
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    onclick={handleCopy}
    aria-label={copied ? "Copied" : "Copy message"}
    title={copied ? "Copied!" : "Copy"}
  >
    {#if copied}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
    {/if}
  </button>

  <!-- Edit (user messages only) -->
  {#if role === "user" && onEdit}
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onclick={onEdit}
      aria-label="Edit message"
      title="Edit"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      </svg>
    </button>
  {/if}

  <!-- Regenerate (assistant messages only) -->
  {#if role === "assistant" && onRegenerate}
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onclick={onRegenerate}
      aria-label="Regenerate response"
      title="Regenerate"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
    </button>
  {/if}

  <!-- Delete -->
  {#if onDelete}
    <button
      type="button"
      class={cn(
        "flex h-7 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        confirmingDelete
          ? "gap-1 px-2 bg-destructive text-destructive-foreground text-xs font-medium"
          : "w-7 text-muted-foreground hover:bg-accent hover:text-destructive"
      )}
      onclick={handleDelete}
      aria-label={confirmingDelete ? "Confirm delete" : "Delete message"}
      title={confirmingDelete ? "Click again to confirm" : "Delete"}
    >
      {#if confirmingDelete}
        <span>Delete?</span>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      {/if}
    </button>
  {/if}
</div>
