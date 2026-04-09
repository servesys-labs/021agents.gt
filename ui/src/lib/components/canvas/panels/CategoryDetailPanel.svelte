<script lang="ts">
  import type { CanvasStore } from "$lib/stores/canvas.svelte";
  import { AVAILABLE_TOOLS, getToolById } from "$lib/data/tools";

  interface Props {
    store: CanvasStore;
    categoryNodeId: string;
  }

  let { store, categoryNodeId }: Props = $props();

  // Derive category label from node ID
  const categoryLabels: Record<string, { label: string; color: string; icon: string }> = {
    "cat-voice": { label: "Voice", color: "bg-pink-500/20 text-pink-400", icon: "M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" },
    "cat-web-&-data": { label: "Web & Data", color: "bg-blue-500/20 text-blue-400", icon: "M21 21l-5.2-5.2M17 10a7 7 0 11-14 0 7 7 0 0114 0z" },
    "cat-code-&-files": { label: "Code & Files", color: "bg-emerald-500/20 text-emerald-400", icon: "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" },
    "cat-memory-&-knowledge": { label: "Memory & Knowledge", color: "bg-purple-500/20 text-purple-400", icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" },
    "cat-media": { label: "Media", color: "bg-amber-500/20 text-amber-400", icon: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z" },
    "cat-agents-&-automation": { label: "Agents & Automation", color: "bg-cyan-500/20 text-cyan-400", icon: "M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197" },
    "cat-other": { label: "Other", color: "bg-rose-500/20 text-rose-400", icon: "M11.42 15.17l-5.648-3.177a1.144 1.144 0 01-.002-2.01L11.42 6.83a2.25 2.25 0 012.16 0l5.648 3.177a1.144 1.144 0 01.002 2.01l-5.648 3.177a2.25 2.25 0 01-2.16-.001z" },
  };

  let categoryData = $derived(categoryLabels[categoryNodeId] || { label: categoryNodeId, color: "bg-muted text-muted-foreground", icon: "" });

  // Map category node IDs to tool ID prefixes for filtering
  const categoryToolMap: Record<string, string[]> = {
    "cat-web-&-data": ["web-search", "browse", "http-request", "web-crawl"],
    "cat-code-&-files": ["python-exec", "bash", "read-file", "write-file", "edit-file"],
    "cat-memory-&-knowledge": ["memory-save", "memory-recall", "knowledge-search", "store-knowledge", "ingest-document"],
    "cat-media": ["image-generate", "vision-analyze", "text-to-speech", "speech-to-text"],
    "cat-agents-&-automation": ["create-agent", "run-agent", "list-agents", "a2a-send", "marketplace-search", "create-schedule", "list-schedules", "delete-schedule", "mcp-call", "feed-post"],
  };

  let toolIds = $derived(categoryToolMap[categoryNodeId] || []);

  let toolItems = $derived(
    toolIds.map(id => {
      const tool = getToolById(id);
      return tool ? { id: tool.id, name: tool.name, description: tool.description, icon: tool.icon, enabled: store.tools.includes(tool.id) } : null;
    }).filter(Boolean) as Array<{ id: string; name: string; description: string; icon: string; enabled: boolean }>
  );

  let isToolCategory = $derived(
    categoryNodeId !== "cat-voice" && toolItems.length > 0
  );
</script>

<div class="space-y-4">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {categoryData.color}">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d={categoryData.icon} />
      </svg>
    </span>
    <div>
      <h3 class="text-sm font-semibold text-foreground">{categoryData.label}</h3>
      <p class="text-xs text-muted-foreground">{toolItems.filter(t => t.enabled).length} of {toolItems.length} active</p>
    </div>
  </div>

  <!-- Voice config (special case) -->
  {#if categoryNodeId === "cat-voice"}
    <div class="space-y-3">
      <div class="rounded-md bg-muted p-3">
        <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Speech-to-Text</p>
        <p class="text-xs text-foreground">Whisper V3 Turbo (GPU)</p>
        <p class="text-[10px] text-muted-foreground">99 languages, self-hosted</p>
      </div>
      <div class="rounded-md bg-muted p-3">
        <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Text-to-Speech</p>
        <p class="text-xs text-foreground">Kokoro (54 voices)</p>
        <p class="text-[10px] text-muted-foreground">+ Chatterbox (clone) + Sesame (conversational)</p>
      </div>
      <div class="rounded-md bg-muted p-3">
        <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Phone</p>
        <p class="text-xs text-foreground">Twilio SIP Trunk</p>
        <p class="text-[10px] text-muted-foreground">$0.0085/min inbound/outbound</p>
      </div>
      <a
        href="/agent/{store.agentName}/voice"
        class="block w-full rounded-md border border-border bg-accent/30 px-3 py-2 text-center text-xs font-medium text-foreground hover:bg-accent transition-colors"
      >
        Configure Voice Settings →
      </a>
    </div>

  <!-- Tool category -->
  {:else if isToolCategory}
    <div class="space-y-1">
      {#each toolItems as tool}
        {#if tool}
          <button
            class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
            onclick={() => store.toggleTool(tool.id)}
          >
            <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d={tool.icon} />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-medium text-foreground">{tool.name}</p>
              <p class="truncate text-[10px] text-muted-foreground">{tool.description}</p>
            </div>
            {#if tool.enabled}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            {:else}
              <div class="h-4 w-4 shrink-0 rounded border border-muted-foreground/30"></div>
            {/if}
          </button>
        {/if}
      {/each}
    </div>

  <!-- Fallback: empty category -->
  {:else if !isToolCategory && categoryNodeId !== "cat-voice"}
    <div class="rounded-md bg-muted p-4 text-center">
      <p class="text-xs text-muted-foreground">No items in this category</p>
    </div>
  {/if}
</div>
