<script lang="ts">
  import { renderStreamingMarkdown, wrapCodeBlocksWithHeader } from "$lib/markdown";
  import { cn } from "$lib/utils";
  import ToolCallBlock from "./ToolCallBlock.svelte";
  import CollapsibleBlock from "./CollapsibleBlock.svelte";
  import ChatMessageActions from "./ChatMessageActions.svelte";

  const SPINNER_VERBS = [
    "Accomplishing",
    "Architecting",
    "Baking",
    "Beaming",
    "Boondoggling",
    "Booping",
    "Brewing",
    "Calculating",
    "Cerebrating",
    "Churning",
    "Clauding",
    "Coalescing",
    "Cogitating",
    "Concocting",
    "Considering",
    "Contemplating",
    "Cooking",
    "Crafting",
    "Crunching",
    "Deciphering",
    "Deliberating",
    "Discombobulating",
    "Doodling",
    "Dreaming",
    "Enchanting",
    "Envisioning",
    "Fermenting",
    "Frolicking",
    "Generating",
    "Harmonizing",
    "Hashing",
    "Hyperspacing",
    "Ideating",
    "Imagining",
    "Incubating",
    "Inferring",
    "Marinating",
    "Meandering",
    "Mulling",
    "Musing",
    "Noodling",
    "Orbiting",
    "Orchestrating",
    "Percolating",
    "Pondering",
    "Pontificating",
    "Processing",
    "Puzzling",
    "Reticulating",
    "Ruminating",
    "Simmering",
    "Sketching",
    "Spinning",
    "Stewing",
    "Synthesizing",
    "Tempering",
    "Thinking",
    "Tinkering",
    "Transmuting",
    "Vibing",
    "Wandering",
    "Whirring",
    "Whisking",
    "Wibbling",
    "Working",
    "Wrangling",
    "Zesting",
  ] as const;

  interface ToolCall {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  interface MessageData {
    role: "user" | "assistant";
    content: string;
    toolCalls?: ToolCall[];
    thinking?: string;
    model?: string;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    latency_ms?: number;
  }

  interface Props {
    message: MessageData;
    streaming: boolean;
    index?: number;
    onEdit?: (index: number) => void;
    onRegenerate?: (index: number) => void;
    onDelete?: (index: number) => void;
  }

  let { message, streaming, index = 0, onEdit, onRegenerate, onDelete }: Props = $props();

  let renderedHtml = $state("");
  let spinnerVerbIndex = $state(Math.floor(Math.random() * SPINNER_VERBS.length));

  // Render markdown reactively
  $effect(() => {
    if (message.role === "assistant" && message.content) {
      renderStreamingMarkdown(message.content).then((html) => {
        renderedHtml = wrapCodeBlocksWithHeader(html);
      });
    }
  });

  // Claude-style rotating status verbs while the assistant is still working.
  $effect(() => {
    const shouldRotate =
      streaming &&
      message.role === "assistant" &&
      !message.content;

    if (!shouldRotate) return;

    spinnerVerbIndex = Math.floor(Math.random() * SPINNER_VERBS.length);
    const timer = setInterval(() => {
      spinnerVerbIndex = (spinnerVerbIndex + 1) % SPINNER_VERBS.length;
    }, 1150);

    return () => clearInterval(timer);
  });

  // Copy code button event delegation
  function handleContentClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const btn = target.closest(".copy-code-btn") as HTMLButtonElement | null;
    if (!btn) return;

    const wrapper = btn.closest(".code-block-wrapper");
    const pre = wrapper?.querySelector("pre");
    if (!pre) return;

    const code = pre.textContent ?? "";
    navigator.clipboard.writeText(code);
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = "Copy";
    }, 1500);
  }

  // Copy message content
  function handleCopyMessage() {
    const text = message.content || message.thinking || "";
    navigator.clipboard.writeText(text);
  }

  // Group tool calls into "turns" - a turn = consecutive tool calls before text
  interface ToolTurn {
    toolCalls: ToolCall[];
    totalLatencyMs: number;
  }

  let toolTurns = $derived.by((): ToolTurn[] => {
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) return [];
    // For now, group all tool calls into a single turn (we only have one assistant message)
    // Multi-turn grouping would require message-level turn boundaries
    const totalMs = calls.reduce((sum, tc) => sum + (tc.latency_ms ?? 0), 0);
    return [{ toolCalls: calls, totalLatencyMs: totalMs }];
  });

  let showCursor = $derived(
    streaming &&
    message.role === "assistant" &&
    !message.content &&
    (!message.toolCalls || message.toolCalls.length === 0) &&
    !message.thinking
  );

  let isProcessing = $derived(
    streaming &&
    message.role === "assistant" &&
    !message.content &&
    (message.toolCalls?.some(tc => !tc.output && !tc.error) || false)
  );

  let spinnerLabel = $derived(`${SPINNER_VERBS[spinnerVerbIndex]}...`);

  // Statistics
  let hasStats = $derived(
    message.model || (message.cost_usd !== undefined && message.cost_usd > 0) ||
    message.input_tokens || message.output_tokens || message.latency_ms
  );

  let totalToolLatency = $derived(
    (message.toolCalls ?? []).reduce((sum, tc) => sum + (tc.latency_ms ?? 0), 0)
  );
</script>

{#if message.role === "user"}
  <!-- User message -->
  <div class="group relative flex justify-end">
    <div class="max-w-[85%]">
      <ChatMessageActions
        role="user"
        onCopy={handleCopyMessage}
        onEdit={onEdit ? () => onEdit!(index) : undefined}
        onDelete={onDelete ? () => onDelete!(index) : undefined}
      />
      <div class="rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground">
        <div class="whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    </div>
  </div>
{:else}
  <!-- Assistant message -->
  <div class="group relative flex justify-start">
    <div class="w-full max-w-none">
      <ChatMessageActions
        role="assistant"
        onCopy={handleCopyMessage}
        onRegenerate={onRegenerate ? () => onRegenerate!(index) : undefined}
        onDelete={onDelete ? () => onDelete!(index) : undefined}
      />

      <!-- Thinking / Reasoning -->
      {#if message.thinking}
        <div class="mb-3">
          <CollapsibleBlock
            title={streaming ? "Reasoning..." : "Reasoning"}
            icon="brain"
            isStreaming={streaming && !message.content}
          >
            <div class="px-3 py-2.5">
              <pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{message.thinking}</pre>
            </div>
          </CollapsibleBlock>
        </div>
      {/if}

      <!-- Tool calls grouped by turn -->
      {#if toolTurns.length > 0}
        <div class="mb-3 space-y-2">
          {#each toolTurns as turn, turnIdx}
            {#if toolTurns.length > 1}
              <div class="relative my-3 rounded-xl border border-dashed border-muted-foreground/30 p-3 pt-5">
                <span class="absolute -top-2.5 left-3 bg-background px-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Turn {turnIdx + 1}
                </span>
                {#each turn.toolCalls as tc}
                  <div class="mb-2 last:mb-0">
                    <ToolCallBlock
                      toolCall={tc}
                      expanded={!tc.output && streaming}
                    />
                  </div>
                {/each}
                <div class="mt-2 flex items-center gap-3 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
                  <span>{turn.toolCalls.length} tool call{turn.toolCalls.length > 1 ? "s" : ""}</span>
                  {#if turn.totalLatencyMs > 0}
                    <span>{turn.totalLatencyMs < 1000 ? `${turn.totalLatencyMs}ms` : `${(turn.totalLatencyMs / 1000).toFixed(1)}s`}</span>
                  {/if}
                </div>
              </div>
            {:else}
              {#each turn.toolCalls as tc}
                <ToolCallBlock
                  toolCall={tc}
                  expanded={!tc.output && streaming}
                />
              {/each}
            {/if}
          {/each}
        </div>
      {/if}

      <!-- Processing shimmer animation -->
      {#if isProcessing}
        <div class="mb-3">
          <span class="inline-block bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-sm font-medium text-transparent animate-shimmer">
            {spinnerLabel}
          </span>
        </div>
      {/if}

      <!-- Content -->
      {#if message.content}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="prose-chat text-sm leading-relaxed text-foreground"
          onclick={handleContentClick}
        >
          {@html renderedHtml}
        </div>
      {/if}

      <!-- Blinking cursor while waiting for first token -->
      {#if showCursor}
        <div class="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
          <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground"></span>
          <span class="inline-block bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text font-medium text-transparent animate-shimmer">
            {spinnerLabel}
          </span>
          <span class="inline-block h-4 w-0.5 animate-pulse bg-foreground"></span>
        </div>
      {/if}

      <!-- Statistics row -->
      {#if hasStats || totalToolLatency > 0}
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <!-- Model name hidden for MVP -->
          {#if message.input_tokens || message.output_tokens}
            <span class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              {#if message.input_tokens}{message.input_tokens.toLocaleString()} in{/if}
              {#if message.input_tokens && message.output_tokens} / {/if}
              {#if message.output_tokens}{message.output_tokens.toLocaleString()} out{/if}
            </span>
          {/if}
          {#if message.latency_ms}
            <span class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              {message.latency_ms < 1000 ? `${message.latency_ms}ms` : `${(message.latency_ms / 1000).toFixed(1)}s`}
            </span>
          {/if}
          {#if totalToolLatency > 0}
            <span class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
              {(message.toolCalls ?? []).length} tools, {totalToolLatency < 1000 ? `${totalToolLatency}ms` : `${(totalToolLatency / 1000).toFixed(1)}s`}
            </span>
          {/if}
          {#if message.cost_usd !== undefined && message.cost_usd > 0}
            <span>${message.cost_usd < 0.01 ? message.cost_usd.toFixed(4) : message.cost_usd.toFixed(3)}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  :global(.prose-chat p) {
    margin-top: 0.5em;
    margin-bottom: 0.5em;
  }
  :global(.prose-chat p:first-child) {
    margin-top: 0;
  }
  :global(.prose-chat p:last-child) {
    margin-bottom: 0;
  }
  :global(.prose-chat a) {
    color: oklch(0.55 0.15 250);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.dark .prose-chat a) {
    color: oklch(0.7 0.15 250);
  }
  :global(.prose-chat a:hover) {
    opacity: 0.8;
  }
  :global(.prose-chat strong) {
    font-weight: 600;
  }
  :global(.prose-chat em) {
    font-style: italic;
  }
  :global(.prose-chat code:not(pre code)) {
    background: var(--code-background);
    color: var(--code-foreground);
    padding: 0.15em 0.35em;
    border-radius: 0.25rem;
    font-size: 0.85em;
    font-family: var(--font-mono);
  }
  :global(.prose-chat pre) {
    margin: 0;
  }
  :global(.prose-chat pre code) {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.6;
  }
  :global(.prose-chat ul) {
    list-style-type: disc;
    padding-left: 1.5em;
    margin: 0.5em 0;
  }
  :global(.prose-chat ol) {
    list-style-type: decimal;
    padding-left: 1.5em;
    margin: 0.5em 0;
  }
  :global(.prose-chat li) {
    margin: 0.25em 0;
  }
  :global(.prose-chat blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1em;
    margin: 0.75em 0;
    color: var(--muted-foreground);
    font-style: italic;
  }
  :global(.prose-chat h1) {
    font-size: 1.375rem;
    font-weight: 600;
    margin: 1em 0 0.5em;
    letter-spacing: -0.01em;
  }
  :global(.prose-chat h2) {
    font-size: 1.175rem;
    font-weight: 600;
    margin: 0.875em 0 0.375em;
    letter-spacing: -0.01em;
  }
  :global(.prose-chat h3) {
    font-size: 1rem;
    font-weight: 600;
    margin: 0.75em 0 0.25em;
  }
  :global(.prose-chat table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0.75em 0;
    font-size: 0.8125rem;
  }
  :global(.prose-chat th) {
    text-align: left;
    font-weight: 600;
    border-bottom: 2px solid var(--border);
    padding: 0.5em 0.75em;
  }
  :global(.prose-chat td) {
    border-bottom: 1px solid var(--border);
    padding: 0.5em 0.75em;
  }
  :global(.prose-chat hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.5em 0;
  }

  /* highlight.js overrides to use design tokens */
  :global(.prose-chat .hljs) {
    background: transparent;
    color: var(--code-foreground);
  }

  /* Shimmer animation for processing state */
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  :global(.animate-shimmer) {
    animation: shimmer 2s linear infinite;
  }
</style>
