<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    checked?: boolean;
    disabled?: boolean;
    label?: string;
    class?: string;
  }

  let { checked = $bindable(false), disabled = false, label, class: className }: Props = $props();
</script>

<label class={cn("inline-flex items-center gap-3", disabled && "cursor-not-allowed opacity-50", className)}>
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label ?? "Toggle"}
    {disabled}
    class={cn(
      "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed",
      checked ? "bg-primary" : "bg-input"
    )}
    onclick={() => { if (!disabled) checked = !checked; }}
  >
    <span
      class={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform",
        checked ? "translate-x-5" : "translate-x-0"
      )}
    ></span>
  </button>
  {#if label}
    <span class="text-sm font-medium text-foreground">{label}</span>
  {/if}
</label>
