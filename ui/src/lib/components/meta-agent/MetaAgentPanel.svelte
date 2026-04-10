<script lang="ts">
  import { metaAgentStore, type MetaAgentMessage } from "$lib/stores/meta-agent.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import ToolCallBlock from "$lib/components/chat/ToolCallBlock.svelte";
  import TrainingStream from "./TrainingStream.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import { SPINNER_VERBS, randomVerbIndex } from "$lib/data/spinner-verbs";

  interface Props {
    agentName: string;
    open?: boolean;
    onClose: () => void;
    width?: number;
    onWidthChange?: (w: number) => void;
  }

  let { agentName, open = $bindable(false), onClose, width = $bindable(400), onWidthChange }: Props = $props();

  let input = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let messagesEl: HTMLDivElement | undefined = $state();
  let resizing = $state(false);
  let copiedIndex = $state<number | null>(null);

  function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  function copyMessage(content: string, index: number) {
    navigator.clipboard.writeText(content);
    copiedIndex = index;
    setTimeout(() => { if (copiedIndex === index) copiedIndex = null; }, 2000);
  }

  /** Active training job shown inline */
  let activeTrainingJobId = $state<string | null>(null);

  const starterPrompts = [
    "How is my agent doing?",
    "Suggest improvements",
    "Run my test suite",
    "Start training",
  ];

  // Load history when panel opens or agent changes
  $effect(() => {
    if (open && agentName) {
      metaAgentStore.loadHistory(agentName);
    }
  });

  let messages = $derived(metaAgentStore.getMessages(agentName));
  let streaming = $derived(metaAgentStore.streaming);
  let statusText = $derived(metaAgentStore.statusText);

  // One random verb per turn, not rotating — matches Claude Code style
  let spinnerLabel = $state(`${SPINNER_VERBS[randomVerbIndex()]}...`);
  $effect(() => {
    if (streaming) {
      spinnerLabel = `${SPINNER_VERBS[randomVerbIndex()]}...`;
    }
  });

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function handleSend() {
    const text = input.trim();
    if (!text || streaming) return;
    input = "";
    metaAgentStore.sendMessage(agentName, text);
    requestAnimationFrame(scrollToBottom);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === "Escape") onClose();
  }

  function handleBackdropClick() { onClose(); }
  function handleBackdropKeydown(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }

  // Markdown render cache
  let renderedCache = $state(new Map<number, string>());
  $effect(() => {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.content && !renderedCache.has(i)) {
        renderMarkdown(msg.content).then((html) => {
          renderedCache.set(i, html);
          renderedCache = new Map(renderedCache);
        });
      }
    }
  });

  // Detect training job from tool calls
  $effect(() => {
    for (const msg of messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.name === "start_training" && tc.output) {
            try {
              const parsed = JSON.parse(tc.output);
              if (parsed.job_id) activeTrainingJobId = parsed.job_id;
            } catch {}
          }
        }
      }
    }
  });

  // ── Resize handle ──
  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = width;

    function onMove(ev: MouseEvent) {
      const dx = startX - ev.clientX;
      const newW = Math.max(300, Math.min(800, startW + dx));
      width = newW;
      onWidthChange?.(newW);
    }

    function onUp() {
      resizing = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
</script>

{#if open}
  <!-- Backdrop for mobile only -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-40 bg-black/40 md:hidden"
    onclick={handleBackdropClick}
    onkeydown={handleBackdropKeydown}
  ></div>

  <!-- Resize handle (desktop only) -->
  <div
    class="hidden md:flex w-1.5 cursor-col-resize items-center justify-center hover:bg-accent/50 active:bg-accent transition-colors shrink-0 {resizing ? 'bg-accent' : ''}"
    role="separator"
    aria-label="Resize panel"
    onmousedown={startResize}
  >
    <div class="h-8 w-0.5 rounded-full bg-muted-foreground/20"></div>
  </div>

  <!-- Panel — in flex flow on desktop, fixed overlay on mobile -->
  <div
    class="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-sidebar shadow-[-4px_0_12px_0_rgba(0,0,0,0.08)] md:static md:z-auto md:shadow-none"
    style="width: {width}px; min-width: 300px; max-width: 800px;"
    role="complementary"
    aria-label="Improve agent panel"
  >
    <!-- Header -->
    <div class="flex items-center gap-3 bg-sidebar-accent px-4 py-3 shadow-sm">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
        </svg>
        <span class="truncate text-sm font-semibold text-foreground">Improve {agentName}</span>
      </div>
      <button
        class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => { metaAgentStore.clearHistory(agentName); }}
        aria-label="Clear history"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      </button>
      <button
        class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={onClose}
        aria-label="Close panel"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6 6 18" /><path d="m6 6 12 12" />
        </svg>
      </button>
    </div>

    <!-- Messages -->
    <div bind:this={messagesEl} class="flex-1 overflow-y-auto">
      <div class="space-y-3 px-4 py-3">
        {#if messages.length === 0}
          <!-- Starter prompts -->
          <div class="flex flex-col items-center py-8 text-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="mb-3 h-8 w-8 text-muted-foreground/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
            </svg>
            <p class="text-sm text-muted-foreground">
              Ask the meta-agent to analyze, improve, or train <strong class="text-foreground">{agentName}</strong>.
            </p>
            <div class="mt-4 w-full space-y-2">
              {#each starterPrompts as prompt}
                <button
                  class="w-full rounded-lg bg-card px-4 py-2.5 text-left text-sm text-foreground shadow-sm transition-colors hover:bg-accent"
                  onclick={() => { input = prompt; handleSend(); }}
                >
                  {prompt}
                </button>
              {/each}
            </div>
          </div>
        {:else}
          {#each messages as msg, i}
            {#if msg.role === "user"}
              <div class="flex justify-end">
                <div class="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-1.5 text-[13px] text-primary-foreground">
                  {msg.content}
                </div>
              </div>
            {:else}
              <!-- Thinking / reasoning block -->
              {#if msg.thinking}
                <details class="group rounded-lg bg-muted/30 text-xs">
                  <summary class="cursor-pointer px-3 py-1.5 text-muted-foreground select-none">
                    Reasoning <span class="text-muted-foreground/50">({msg.thinking.length} chars)</span>
                  </summary>
                  <div class="whitespace-pre-wrap px-3 pb-2 text-muted-foreground/70 font-mono text-[11px]">
                    {msg.thinking}
                  </div>
                </details>
              {/if}

              <!-- Tool calls -->
              {#if msg.toolCalls?.length}
                <div class="space-y-2">
                  {#each msg.toolCalls as tc}
                    <ToolCallBlock toolCall={tc} expanded={false} />
                  {/each}
                </div>
              {/if}

              <!-- Training stream -->
              {#if activeTrainingJobId && msg.toolCalls?.some(tc => tc.name === "start_training")}
                <TrainingStream jobId={activeTrainingJobId} {agentName} onComplete={() => { activeTrainingJobId = null; }} />
              {/if}

              <!-- Assistant content -->
              {#if msg.content}
                <div class="group relative">
                  <div class="prose-chat text-[13px]">
                    {#if renderedCache.has(i)}
                      {@html renderedCache.get(i) ?? ""}
                    {:else}
                      <div class="whitespace-pre-wrap">{msg.content}</div>
                    {/if}
                  </div>
                  <!-- Copy button -->
                  <button
                    class="absolute right-1 top-1 rounded p-1 text-muted-foreground transition-opacity hover:text-foreground {copiedIndex === i ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
                    onclick={() => copyMessage(msg.content, i)}
                    aria-label="Copy"
                  >
                    {#if copiedIndex === i}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                    {/if}
                  </button>
                </div>
                <!-- Meta line: model badge, cost, elapsed time -->
                <div class="flex items-center gap-2 mt-0.5">
                  {#if msg.model}
                    <span class="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{msg.model}</span>
                  {/if}
                  {#if msg.cost_usd !== undefined && msg.cost_usd > 0}
                    <span class="text-[10px] text-muted-foreground">${(msg.cost_usd ?? 0).toFixed(4)}</span>
                  {/if}
                  {#if msg.elapsedMs}
                    <span class="text-[10px] text-muted-foreground">took {formatElapsed(msg.elapsedMs)}</span>
                  {/if}
                </div>
              {/if}

              <!-- Streaming indicator with rotating verbs -->
              {#if streaming && i === messages.length - 1}
                <div class="flex items-center gap-2 mt-1">
                  <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground"></span>
                  <span class="inline-block bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-sm font-medium text-transparent animate-shimmer">
                    {statusText || spinnerLabel}
                  </span>
                </div>
              {/if}
            {/if}
          {/each}
        {/if}
      </div>
    </div>

    <!-- Input -->
    <div class="p-3 shadow-[0_-1px_3px_0_rgba(0,0,0,0.06)]">
      <div class="flex items-end gap-2">
        <textarea
          bind:this={textareaEl}
          class="flex-1 resize-none rounded-lg bg-background px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          rows="1"
          placeholder="Ask about your agent..."
          bind:value={input}
          onkeydown={handleKeydown}
          disabled={streaming}
        ></textarea>
        {#if streaming}
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
            onclick={() => metaAgentStore.stopStreaming()}
            aria-label="Stop"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
          </button>
        {:else}
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            onclick={handleSend}
            disabled={!input.trim()}
            aria-label="Send"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
