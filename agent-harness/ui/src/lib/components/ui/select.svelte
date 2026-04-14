<script lang="ts">
  import { cn } from "$lib/utils";
  import type { HTMLSelectAttributes } from "svelte/elements";

  interface Option {
    value: string;
    label: string;
  }

  interface Props extends HTMLSelectAttributes {
    class?: string;
    options: Option[];
    value?: string;
  }

  let { class: className, options, value = $bindable(""), disabled = false, ...rest }: Props = $props();
</script>

<select
  class={cn(
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
    "ring-offset-background",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed disabled:opacity-50",
    className
  )}
  bind:value
  {disabled}
  {...rest}
>
  {#each options as opt}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</select>
