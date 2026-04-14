<script lang="ts">
  import Button from "$lib/components/ui/button.svelte";
  import type { Agent } from "$lib/stores/agents.svelte";

  interface Props {
    agent: Agent | null;
    agentName: string;
  }

  let { agent, agentName }: Props = $props();
</script>

<div class="flex items-center gap-3 px-4 py-2.5 shadow-sm sm:px-6">
  <div class="flex min-w-0 flex-1 items-center gap-2.5">
    <h2 class="shrink-0 text-base font-semibold">{agentName}</h2>

    {#if agent?.description}
      <span class="hidden max-w-xs truncate text-sm text-muted-foreground md:inline">{agent.description}</span>
    {/if}
  </div>

  <div class="flex items-center gap-1.5">
    <Button
      variant="ghost"
      size="sm"
      onclick={() => window.dispatchEvent(new CustomEvent("chat:improve"))}
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      </svg>
      <span class="hidden sm:inline">Improve</span>
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={() => window.dispatchEvent(new CustomEvent("chat:new"))}
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14" /><path d="M5 12h14" />
      </svg>
      <span class="hidden sm:inline">New Chat</span>
    </Button>

    <a
      href="/agent/{agentName}/settings"
      class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="Agent settings"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </a>
  </div>
</div>
