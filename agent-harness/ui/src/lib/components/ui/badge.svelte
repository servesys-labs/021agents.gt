<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";

  type Variant = "default" | "secondary" | "destructive" | "outline" | "free" | "basic" | "standard" | "premium";

  interface Props {
    variant?: Variant;
    children: Snippet;
    class?: string;
  }

  let { variant = "default", children, class: className }: Props = $props();

  const variantClasses: Record<Variant, string> = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    destructive: "bg-destructive text-destructive-foreground",
    outline: "border border-border text-foreground",
    free: "bg-muted text-muted-foreground",
    basic: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    standard: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    premium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  };
</script>

<span
  class={cn(
    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
    "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
    variantClasses[variant],
    className
  )}
>
  {@render children()}
</span>
