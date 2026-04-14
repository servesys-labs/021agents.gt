<script lang="ts">
  import ToolCallInline from "./ToolCallInline.svelte";

  interface ToolCall {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  interface Props {
    toolCalls: ToolCall[];
    agentName?: string;
  }

  let { toolCalls, agentName }: Props = $props();
</script>

{#each toolCalls as tc (tc.call_id)}
  <ToolCallInline toolCall={tc} {agentName} />
{/each}
