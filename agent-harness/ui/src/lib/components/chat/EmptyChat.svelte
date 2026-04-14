<script lang="ts">
  import { api } from "$lib/services/api";

  interface Props {
    agentName: string;
    tools: string[];
    onSend: (text: string) => void;
  }

  let { agentName, tools, onSend }: Props = $props();

  interface Suggestion {
    icon: string;
    text: string;
  }

  // Cache key includes agent name so different agents get different suggestions
  const CACHE_PREFIX = "oneshots_suggestions_";
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  let suggestions = $state<Suggestion[]>([]);
  let loaded = $state(false);

  // Tool-based fallback suggestions (used while API loads or on failure)
  function fallbackSuggestions(): Suggestion[] {
    const items: Suggestion[] = [];
    if (tools.includes("web-search") || tools.includes("web_search"))
      items.push({ icon: "search", text: "Search for latest AI news" });
    if (tools.includes("python-exec") || tools.includes("python_exec"))
      items.push({ icon: "code", text: "Analyze this CSV data" });
    if (tools.includes("bash") || tools.includes("shell"))
      items.push({ icon: "terminal", text: "List files in workspace" });
    if (tools.includes("read-file") || tools.includes("file_read"))
      items.push({ icon: "file", text: "Read and summarize a document" });
    if (items.length < 4) {
      const defaults: Suggestion[] = [
        { icon: "sparkle", text: "What can you help me with?" },
        { icon: "lightbulb", text: "Explain your capabilities" },
        { icon: "pencil", text: "Help me write a draft" },
      ];
      for (const d of defaults) {
        if (items.length >= 4) break;
        items.push(d);
      }
    }
    return items.slice(0, 4);
  }

  async function loadSuggestions() {
    // Check cache first
    const cacheKey = `${CACHE_PREFIX}${agentName}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { suggestions: s, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL_MS && Array.isArray(s) && s.length > 0) {
          suggestions = s;
          loaded = true;
          return;
        }
      }
    } catch {}

    // Show fallback immediately while API loads
    suggestions = fallbackSuggestions();

    // Fetch from API (non-blocking)
    try {
      const data = await api.get<{ suggestions: Suggestion[] }>(`/agents/${encodeURIComponent(agentName)}/suggestions`);
      if (data.suggestions?.length > 0) {
        suggestions = data.suggestions.slice(0, 4);
        // Cache it
        localStorage.setItem(cacheKey, JSON.stringify({ suggestions, timestamp: Date.now() }));
      }
    } catch {
      // API failed — keep fallback suggestions
    }
    loaded = true;
  }

  $effect(() => {
    if (agentName) loadSuggestions();
  });

  function iconPath(icon: string): string {
    switch (icon) {
      case "search":
        return "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z";
      case "code":
        return "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5";
      case "terminal":
        return "M6.75 7.5l3 2.25-3 2.25m4.5 0h3M3.75 4.875c0-.621.504-1.125 1.125-1.125h14.25c.621 0 1.125.504 1.125 1.125v14.25c0 .621-.504 1.125-1.125 1.125H4.875A1.125 1.125 0 013.75 19.125V4.875z";
      case "file":
        return "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z";
      case "sparkle":
        return "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z";
      case "lightbulb":
        return "M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18";
      case "pencil":
        return "M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125";
      case "globe":
        return "M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418";
      case "calendar":
        return "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5";
      case "chart":
        return "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z";
      default:
        return "M12 4.5v15m7.5-7.5h-15";
    }
  }
</script>

<div class="flex flex-1 flex-col items-center justify-center px-6 py-16">
  <div class="mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
    <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  </div>

  <h3 class="mb-1 text-lg font-semibold text-foreground">Chat with {agentName}</h3>
  <p class="mb-8 text-sm text-muted-foreground">Send a message or try one of these suggestions</p>

  <div class="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
    {#each suggestions as suggestion}
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-accent"
        onclick={() => onSend(suggestion.text)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d={iconPath(suggestion.icon)} />
        </svg>
        <span class="text-foreground">{suggestion.text}</span>
      </button>
    {/each}
  </div>
</div>
