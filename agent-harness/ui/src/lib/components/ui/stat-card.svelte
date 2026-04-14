<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    value: string;
    label: string;
    subtitle?: string;
    trend?: { direction: "up" | "down"; value: string };
    accentColor?: "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";
    class?: string;
  }

  let { value, label, subtitle, trend, accentColor, class: className }: Props = $props();

  const accentMap: Record<string, string> = {
    "chart-1": "border-t-chart-1",
    "chart-2": "border-t-chart-2",
    "chart-3": "border-t-chart-3",
    "chart-4": "border-t-chart-4",
    "chart-5": "border-t-chart-5",
  };

  let accentClass = $derived(accentColor ? `border-t-2 ${accentMap[accentColor]}` : "");
</script>

<div
  class={cn(
    "rounded-lg border border-border bg-card p-5 shadow-sm",
    accentClass,
    className
  )}
>
  <div class="flex items-start justify-between">
    <p class="text-2xl font-bold tracking-tight text-card-foreground">{value}</p>
    {#if trend}
      <span
        class={cn(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium",
          trend.direction === "up"
            ? "bg-success/10 text-success"
            : "bg-destructive/10 text-destructive"
        )}
      >
        {trend.direction === "up" ? "\u2191" : "\u2193"}{trend.value}
      </span>
    {/if}
  </div>
  <p class="mt-1 text-sm text-muted-foreground">{label}</p>
  {#if subtitle}
    <p class="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
  {/if}
</div>
