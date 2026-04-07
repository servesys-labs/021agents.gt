<script lang="ts">
  import { page } from "$app/stores";
  import AgentCanvas from "$lib/components/canvas/AgentCanvas.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";

  const agentName = $derived($page.params.name);
  const activePath = $derived($page.url.pathname);
</script>

<AgentNav {agentName} {activePath} />

<div class="h-[calc(100dvh-3.5rem)]">
  <AgentCanvas {agentName} />
</div>
