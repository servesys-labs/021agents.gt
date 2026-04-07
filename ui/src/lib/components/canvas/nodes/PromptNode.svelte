<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";

  interface Props {
    data: {
      systemPrompt: string;
    };
  }

  let { data }: Props = $props();

  let preview = $derived(
    data.systemPrompt.length > 150
      ? data.systemPrompt.slice(0, 150) + "..."
      : data.systemPrompt
  );
</script>

<div
  class="rounded-lg border border-border bg-muted p-4 shadow-sm"
  style="width: 280px; min-height: 120px;"
>
  <Handle type="source" position={Position.Bottom} class="!bg-muted-foreground !w-2.5 !h-2.5" />

  <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
    System Prompt
  </p>
  <pre class="whitespace-pre-wrap break-words font-mono text-xs text-foreground leading-relaxed">{preview}</pre>
</div>
