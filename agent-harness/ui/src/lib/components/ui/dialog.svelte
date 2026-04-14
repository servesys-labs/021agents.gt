<script lang="ts">
  import { cn } from "$lib/utils";
  import Button from "./button.svelte";

  interface Props {
    open?: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
    variant?: "default" | "destructive";
  }

  let {
    open = $bindable(false),
    title,
    description = "",
    confirmText = "Confirm",
    cancelText = "Cancel",
    onConfirm,
    variant = "default",
  }: Props = $props();

  function handleConfirm() {
    onConfirm();
    open = false;
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) open = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
    onclick={handleBackdrop}
    onkeydown={handleKeydown}
  >
    <div
      class="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <h3 id="dialog-title" class="font-semibold text-foreground">{title}</h3>
      {#if description}
        <p class="mt-2 text-sm text-muted-foreground">{description}</p>
      {/if}
      <div class="mt-6 flex justify-end gap-3">
        <Button variant="outline" onclick={() => (open = false)}>{cancelText}</Button>
        <Button variant={variant === "destructive" ? "destructive" : "default"} onclick={handleConfirm}>
          {confirmText}
        </Button>
      </div>
    </div>
  </div>
{/if}
