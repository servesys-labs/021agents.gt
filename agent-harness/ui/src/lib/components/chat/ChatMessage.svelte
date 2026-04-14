<script lang="ts">
  import { renderStreamingMarkdown, wrapCodeBlocksWithHeader } from "$lib/markdown";
  import { cn } from "$lib/utils";
  import ToolCallGroup from "./ToolCallGroup.svelte";
  import ChatMessageActions from "./ChatMessageActions.svelte";
  import { SPINNER_VERBS, randomVerbIndex } from "$lib/data/spinner-verbs";

  interface ToolCall {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  type Segment =
    | { type: "thinking"; content: string }
    | { type: "tool_calls"; calls: ToolCall[] };

  interface MessageData {
    role: "user" | "assistant";
    content: string;
    toolCalls?: ToolCall[];
    thinking?: string;
    segments?: Segment[];
    model?: string;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    latency_ms?: number;
  }

  interface Props {
    message: MessageData;
    streaming: boolean;
    agentName?: string;
    index?: number;
    onEdit?: (index: number) => void;
    onRegenerate?: (index: number) => void;
    onDelete?: (index: number) => void;
  }

  let { message, streaming, agentName, index = 0, onEdit, onRegenerate, onDelete }: Props = $props();

  function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  let renderedHtml = $state("");

  // ── Spinning verb + timer for streaming state ──
  let verbIdx = $state(randomVerbIndex());
  let streamStart = $state(Date.now());
  let streamElapsed = $state(0);

  $effect(() => {
    if (!streaming || message.role !== "assistant") return;
    streamStart = Date.now();
    streamElapsed = 0;
    verbIdx = randomVerbIndex();

    const timer = setInterval(() => {
      streamElapsed = Date.now() - streamStart;
    }, 100);
    const verbRotator = setInterval(() => {
      verbIdx = randomVerbIndex();
    }, 3000);

    return () => { clearInterval(timer); clearInterval(verbRotator); };
  });

  let streamElapsedLabel = $derived.by(() => {
    if (streamElapsed < 1000) return "0s";
    return `${Math.floor(streamElapsed / 1000)}s`;
  });

  let streamVerb = $derived(SPINNER_VERBS[verbIdx]);

  // Token count for inline display
  let inlineTokenCount = $derived.by(() => {
    const inTok = toFiniteNumber(message.input_tokens);
    const outTok = toFiniteNumber(message.output_tokens);
    if (!outTok) return "";
    const label = outTok >= 1000 ? `${(outTok / 1000).toFixed(1)}k` : `${outTok}`;
    return `\u2193 ${label} tokens`;
  });

  // Render markdown reactively
  $effect(() => {
    if (message.role === "assistant" && message.content) {
      renderStreamingMarkdown(message.content).then((html) => {
        renderedHtml = wrapCodeBlocksWithHeader(html);
      });
    }
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
  }

  let toolTurns = $derived.by((): ToolTurn[] => {
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) return [];
    // For now, group all tool calls into a single turn (we only have one assistant message)
    // Multi-turn grouping would require message-level turn boundaries
    return [{ toolCalls: calls }];
  });

  // Statistics
  let hasStats = $derived(
    message.model || (toFiniteNumber(message.cost_usd) ?? 0) > 0 ||
    toFiniteNumber(message.input_tokens) || toFiniteNumber(message.output_tokens) || toFiniteNumber(message.latency_ms)
  );

  let totalToolLatency = $derived(
    (message.toolCalls ?? []).reduce((sum, tc) => sum + (tc.latency_ms ?? 0), 0)
  );

  // ── Follow-up suggestion extraction ──
  // Detects "## Follow-up" sections with bullet points and extracts them
  // as clickable suggestions (rendered separately from markdown content)
  let followUps = $derived.by(() => {
    if (!message.content || streaming) return [];
    const text = message.content;
    // Match "## Follow-up" or "Follow-up:" sections
    const followUpMatch = text.match(/(?:##\s*Follow-up|Follow-up:?)\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (!followUpMatch) return [];
    return followUpMatch[1]
      .split("\n")
      .map(line => line.replace(/^\s*[-*]\s+/, "").trim())
      .filter(line => line.length > 10);
  });

  // Remove follow-up section from rendered content (we render it separately)
  let contentWithoutFollowUps = $derived.by(() => {
    if (followUps.length === 0) return message.content;
    return (message.content || "").replace(/(?:##\s*Follow-up|Follow-up:?)\s*\n(?:\s*[-*]\s+.+\n?)+/i, "").trim();
  });

  let safeInputTokens = $derived(toFiniteNumber(message.input_tokens));
  let safeOutputTokens = $derived(toFiniteNumber(message.output_tokens));
  let safeLatencyMs = $derived(toFiniteNumber(message.latency_ms));
  let safeCostUsd = $derived(toFiniteNumber(message.cost_usd));

  // ── Streaming phase detection ──
  // Determines what the agent is currently doing for richer UX feedback
  type StreamPhase = "thinking" | "calling_tools" | "generating" | "idle";

  let streamPhase = $derived.by((): StreamPhase => {
    if (!streaming || message.role !== "assistant") return "idle";
    const segs = message.segments || [];
    const lastSeg = segs[segs.length - 1];
    if (lastSeg?.type === "thinking") return "thinking";
    if (lastSeg?.type === "tool_calls") {
      const calls = lastSeg.calls || [];
      const hasRunning = calls.some(tc => !tc.output);
      if (hasRunning) return "calling_tools";
    }
    if (message.content && message.content.length > 0) return "generating";
    return "thinking"; // default during streaming
  });

  let phaseLabel = $derived.by(() => {
    switch (streamPhase) {
      case "thinking": return "Thinking";
      case "calling_tools": return "Running tools";
      case "generating": return "Writing";
      default: return streamVerb;
    }
  });

  let phaseIcon = $derived.by(() => {
    switch (streamPhase) {
      case "thinking": return "🧠";
      case "calling_tools": return "⚡";
      case "generating": return "✍️";
      default: return "✦";
    }
  });

  // Token-per-second estimate (rough: ~4 chars per token)
  let tokensPerSec = $derived.by(() => {
    if (!streaming || streamElapsed < 2000) return 0;
    const chars = (message.content || "").length;
    const estimatedTokens = Math.floor(chars / 4);
    return Math.round(estimatedTokens / (streamElapsed / 1000));
  });

  // Tool progress: completed / total
  let toolProgress = $derived.by(() => {
    const calls = message.toolCalls || [];
    if (calls.length === 0) return null;
    const completed = calls.filter(tc => tc.output || tc.error).length;
    return { completed, total: calls.length };
  });
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

      <!-- Interleaved segments: reasoning + tool calls in order -->
      {#if message.segments && message.segments.length > 0}
        <div class="mb-3 space-y-1.5">
          {#each message.segments as seg}
            {#if seg.type === "thinking"}
              <p class="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/70 italic">{seg.content}</p>
            {:else if seg.type === "tool_calls"}
              <ToolCallGroup toolCalls={seg.calls} {agentName} compact={seg.calls.length > 1} />
            {/if}
          {/each}
        </div>
      {:else}
        <!-- Fallback for messages loaded from history (no segments) -->
        {#if message.thinking}
          <p class="mb-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/70 italic">{message.thinking}</p>
        {/if}
        {#if toolTurns.length > 0}
          <div class="mb-3 space-y-1.5">
            {#each toolTurns as turn}
              <ToolCallGroup toolCalls={turn.toolCalls} {agentName} compact={turn.toolCalls.length > 1} />
            {/each}
          </div>
        {/if}
      {/if}

      <!-- Content (without follow-up section — rendered separately below) -->
      {#if contentWithoutFollowUps}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="prose-chat text-sm leading-relaxed text-foreground"
          onclick={handleContentClick}
        >
          {@html renderedHtml}
        </div>
      {/if}

      <!-- Follow-up suggestions (clickable buttons that pre-fill chat input) -->
      {#if followUps.length > 0}
        <div class="mt-4 space-y-2">
          <p class="text-xs font-semibold text-muted-foreground">Follow-up</p>
          {#each followUps as suggestion}
            <button
              class="group flex w-full items-start gap-2 rounded-lg border border-border/50 bg-card/30 px-3 py-2.5 text-left text-sm text-primary/80 hover:border-primary/30 hover:bg-primary/5 hover:text-primary transition-all"
              onclick={() => {
                // Dispatch event to pre-fill chat input with this suggestion
                window.dispatchEvent(new CustomEvent("chat:followup", { detail: suggestion }));
              }}
            >
              <span class="mt-0.5 text-primary/40 group-hover:text-primary/70 transition-colors">↵</span>
              <span>{suggestion}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Streaming progress (enhanced with phase + tokens/sec + tool progress) -->
      {#if streaming}
        <div class="mt-3 space-y-2">
          <!-- Phase indicator -->
          <div class="flex items-center gap-2">
            <span class="text-sm">{phaseIcon}</span>
            <span class="bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-xs font-medium text-transparent animate-shimmer">
              {phaseLabel}...
            </span>
            <span class="text-[10px] text-muted-foreground/40">{streamElapsedLabel}</span>
            {#if tokensPerSec > 0}
              <span class="text-[10px] text-muted-foreground/40">{tokensPerSec} tok/s</span>
            {/if}
          </div>

          <!-- Tool progress bar (if tools are running) -->
          {#if toolProgress && toolProgress.total > 0}
            <div class="flex items-center gap-2">
              <div class="h-1 flex-1 rounded-full bg-muted overflow-hidden">
                <div
                  class="h-full rounded-full bg-primary transition-all duration-300"
                  style="width: {(toolProgress.completed / toolProgress.total) * 100}%"
                ></div>
              </div>
              <span class="text-[10px] text-muted-foreground/50">
                {toolProgress.completed}/{toolProgress.total} tools
              </span>
            </div>
          {/if}
        </div>

        <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <!-- Keep the rotating verb for variety -->
          <span class="text-[10px] text-muted-foreground/30 italic">{streamVerb}</span>
          {#if inlineTokenCount}
            <span class="text-[10px] text-muted-foreground/30">{inlineTokenCount}</span>
          {/if}
        </div>
      {/if}

      <!-- Statistics row -->
      {#if hasStats || totalToolLatency > 0}
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          {#if message.model}
            <span class="flex items-center gap-1 font-medium">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/></svg>
              {message.model}
            </span>
          {/if}
          {#if safeInputTokens !== undefined || safeOutputTokens !== undefined}
            <span class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              {#if safeInputTokens !== undefined}{safeInputTokens.toLocaleString()} in{/if}
              {#if safeInputTokens !== undefined && safeOutputTokens !== undefined} / {/if}
              {#if safeOutputTokens !== undefined}{safeOutputTokens.toLocaleString()} out{/if}
            </span>
          {/if}
          {#if safeLatencyMs !== undefined}
            <span class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              {safeLatencyMs < 1000 ? `${safeLatencyMs}ms` : `${(safeLatencyMs / 1000).toFixed(1)}s`}
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
          {#if safeCostUsd !== undefined && safeCostUsd > 0}
            <span>${safeCostUsd < 0.01 ? safeCostUsd.toFixed(4) : safeCostUsd.toFixed(3)}</span>
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
