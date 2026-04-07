<script lang="ts">
  import CollapsibleBlock from "./CollapsibleBlock.svelte";
  import SyntaxHighlightedCode from "./SyntaxHighlightedCode.svelte";

  interface ToolCallData {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  interface Props {
    toolCall: ToolCallData;
    expanded: boolean;
  }

  let { toolCall, expanded }: Props = $props();

  let manualToggle = $state<boolean | null>(null);
  let open = $derived(manualToggle !== null ? manualToggle : expanded);

  let isPending = $derived(!toolCall.output && !toolCall.error);
  let hasError = $derived(!!toolCall.error);

  let icon = $derived<"loader" | "wrench" | "error">(
    isPending ? "loader" : hasError ? "error" : "wrench"
  );

  let subtitle = $derived.by(() => {
    if (isPending) return "executing...";
    const parts: string[] = [];
    if (toolCall.latency_ms) {
      parts.push(toolCall.latency_ms < 1000
        ? `${toolCall.latency_ms}ms`
        : `${(toolCall.latency_ms / 1000).toFixed(1)}s`
      );
    }
    if (hasError) parts.push("failed");
    return parts.join(" - ") || undefined;
  });

  /** Try to pretty-print JSON input, return as-is if not valid JSON */
  function formatInput(raw: string): { formatted: string; isJson: boolean } {
    try {
      const parsed = JSON.parse(raw);
      return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
    } catch {
      return { formatted: raw, isJson: false };
    }
  }

  let formattedInput = $derived(formatInput(toolCall.input));

  /** Parse tool result for embedded images (base64 data URIs or URLs) */
  function parseResultImages(text: string): { lines: string[]; images: { src: string; alt: string }[] } {
    const images: { src: string; alt: string }[] = [];
    const urlRegex = /(data:image\/[^;]+;base64,[^\s"']+|https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp|svg))/gi;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      images.push({ src: match[1], alt: "Tool result image" });
    }
    // Truncate long results
    const maxLen = 5000;
    const truncated = text.length > maxLen ? text.slice(0, maxLen) + "\n... (truncated)" : text;
    return { lines: truncated.split("\n"), images };
  }

  let parsedResult = $derived(
    toolCall.output ? parseResultImages(toolCall.output) : null
  );

  function handleToggle() {
    manualToggle = !open;
  }
</script>

<CollapsibleBlock
  bind:open
  title={toolCall.name}
  {subtitle}
  {icon}
  iconSpin={isPending}
  isStreaming={isPending}
  contentMaxHeight="24rem"
  onToggle={handleToggle}
>
  <!-- Arguments section -->
  {#if toolCall.input && toolCall.input !== "{}"}
    <div class="px-3 py-2.5">
      <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Arguments</p>
      <SyntaxHighlightedCode
        code={formattedInput.formatted}
        language={formattedInput.isJson ? "json" : "plaintext"}
        maxHeight="16rem"
      />
    </div>
  {/if}

  <!-- Error section -->
  {#if toolCall.error}
    <div class="border-t border-border bg-destructive/5 px-3 py-2.5">
      <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-destructive">Error</p>
      <pre class="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-destructive">{toolCall.error}</pre>
    </div>

  <!-- Result section -->
  {:else if toolCall.output && parsedResult}
    <div class="border-t border-border px-3 py-2.5">
      <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Result</p>
      <div class="overflow-auto rounded-lg border border-border bg-muted/30 p-3">
        {#each parsedResult.lines as line}
          <div class="font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{line}</div>
        {/each}
        {#if parsedResult.images.length > 0}
          <div class="mt-2 flex flex-wrap gap-2">
            {#each parsedResult.images as img}
              <img
                src={img.src}
                alt={img.alt}
                class="h-auto max-w-full rounded-lg border border-border"
                loading="lazy"
                style="max-height: 12rem;"
              />
            {/each}
          </div>
        {/if}
      </div>
    </div>

  <!-- Pending result -->
  {:else if isPending}
    <div class="border-t border-border px-3 py-2.5">
      <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Result</p>
      <div class="rounded bg-muted/30 p-2 text-xs text-muted-foreground italic">
        Waiting for result...
      </div>
    </div>
  {/if}
</CollapsibleBlock>
