<script lang="ts">
  import { api } from "$lib/services/api";
  import { cn } from "$lib/utils";
  import { getToolSummary } from "./toolSummary";
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
    agentName?: string;
  }

  let { toolCall, agentName }: Props = $props();

  let expanded = $state(false);
  let showArgs = $state(false);
  let showFullResult = $state(false);
  let toolCallEl: HTMLDivElement | undefined = $state();

  let isPending = $derived(!toolCall.output && !toolCall.error);
  let hasError = $derived(!!toolCall.error);

  let summary = $derived(
    getToolSummary(toolCall.name, toolCall.input, toolCall.output, toolCall.error)
  );

  let summaryText = $derived(isPending ? summary.pending : summary.completed);

  // ── Live timer for pending tools ──

  let elapsed = $state(0);

  $effect(() => {
    if (!isPending) return;
    const start = Date.now();
    elapsed = 0;
    const id = setInterval(() => {
      elapsed = Date.now() - start;
    }, 100);
    return () => clearInterval(id);
  });

  let elapsedLabel = $derived.by(() => {
    if (!isPending) return "";
    if (elapsed < 1000) return `${Math.floor(elapsed / 100) / 10}s`;
    return `${(elapsed / 1000).toFixed(1)}s`;
  });

  let latencyLabel = $derived.by(() => {
    if (isPending) return elapsedLabel;
    if (!toolCall.latency_ms) return "";
    return toolCall.latency_ms < 1000
      ? `${toolCall.latency_ms}ms`
      : `${(toolCall.latency_ms / 1000).toFixed(1)}s`;
  });

  // ── Arguments formatting ──

  function formatInput(raw: string): { formatted: string; isJson: boolean } {
    try {
      const parsed = JSON.parse(raw);
      return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
    } catch {
      return { formatted: raw, isJson: false };
    }
  }

  let formattedInput = $derived(formatInput(toolCall.input));

  // ── Edit preview (diff) ──

  type DiffLine = { type: "add" | "del" | "ctx"; text: string };
  type EditPreview = {
    filePath: string;
    added: number;
    deleted: number;
    lines: DiffLine[];
  };

  function parseEditPreviewFromPatch(patch: string): EditPreview | null {
    const fileMatch = patch.match(/^\*\*\* (?:Update|Add) File:\s+(.+)$/m);
    if (!fileMatch) return null;
    const filePath = fileMatch[1].trim();
    const lines = patch.split("\n");
    let added = 0;
    let deleted = 0;
    const preview: DiffLine[] = [];
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith("+")) {
        added += 1;
        if (preview.length < 14) preview.push({ type: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        deleted += 1;
        if (preview.length < 14) preview.push({ type: "del", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        if (preview.length < 14) preview.push({ type: "ctx", text: line.slice(1) });
      }
    }
    if (preview.length === 0) return null;
    return { filePath, added, deleted, lines: preview };
  }

  function parseEditPreviewFromStructuredInput(raw: string): EditPreview | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.patch === "string") return parseEditPreviewFromPatch(parsed.patch);
      const path = typeof parsed.path === "string" ? parsed.path : "";
      const content = typeof parsed.new_string === "string"
        ? parsed.new_string
        : typeof parsed.content === "string" ? parsed.content : "";
      if (!path || !content) return null;
      const lines = content.split("\n").slice(0, 12).map((line) => ({ type: "add" as const, text: line }));
      return { filePath: path, added: Math.max(1, content.split("\n").length), deleted: 0, lines };
    } catch {
      return null;
    }
  }

  let editPreview = $derived.by(() => {
    const name = (toolCall.name || "").toLowerCase();
    if (!name.includes("edit") && !name.includes("write") && !name.includes("patch")) return null;
    return parseEditPreviewFromStructuredInput(toolCall.input) || parseEditPreviewFromPatch(toolCall.input);
  });

  // ── Image / media detection ──

  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
  const PDF_EXT_RE = /\.pdf$/i;
  const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|webm)$/i;
  const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v|avi)$/i;
  type PreviewKind = "image" | "pdf" | "audio" | "video";

  function detectPreviewKind(path: string, mimeType = ""): PreviewKind | null {
    const lower = path.toLowerCase();
    if (IMAGE_EXT_RE.test(lower) || mimeType.startsWith("image/")) return "image";
    if (PDF_EXT_RE.test(lower) || mimeType === "application/pdf") return "pdf";
    if (AUDIO_EXT_RE.test(lower) || mimeType.startsWith("audio/")) return "audio";
    if (VIDEO_EXT_RE.test(lower) || mimeType.startsWith("video/")) return "video";
    return null;
  }

  function extractMediaPaths(text: string): string[] {
    const regex = /((?:\/workspace\/|workspace\/)[\w./-]+\.(?:png|jpe?g|gif|webp|svg|pdf|mp3|wav|ogg|m4a|mp4|mov|webm|m4v|avi))/gi;
    const set = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const normalized = match[1].startsWith("/") ? match[1] : `/${match[1]}`;
      set.add(normalized);
    }
    return Array.from(set);
  }

  function isValidResourceUrl(src: string): boolean {
    if (!src || typeof src !== "string") return false;
    if (src.startsWith("data:image/")) return true;
    if (!src.startsWith("http://") && !src.startsWith("https://")) return false;
    try {
      const u = new URL(src);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch { return false; }
  }

  function parseResultImages(text: string): { lines: string[]; images: { src: string; alt: string }[] } {
    const images: { src: string; alt: string }[] = [];
    const urlRegex = /(data:image\/[^;]+;base64,[^\s"']+|https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp|svg))/gi;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const candidate = String(match[1] || "").trim();
      if (isValidResourceUrl(candidate)) {
        images.push({ src: candidate, alt: "Tool result image" });
      }
    }
    const maxLen = 5000;
    const truncated = text.length > maxLen ? text.slice(0, maxLen) + "\n... (truncated)" : text;
    return { lines: truncated.split("\n"), images };
  }

  let parsedResult = $derived(toolCall.output ? parseResultImages(toolCall.output) : null);

  let mediaFilePaths = $derived.by(() => {
    const all = `${toolCall.input || ""}\n${toolCall.output || ""}`;
    return extractMediaPaths(all);
  });

  // ── File preview modal ──

  let previewOpen = $state(false);
  let previewLoading = $state(false);
  let previewError = $state("");
  let previewPath = $state("");
  let previewKind = $state<PreviewKind>("image");
  let previewSrc = $state("");

  function guessMime(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".webm")) return "video/webm";
    return "application/octet-stream";
  }

  function toDataSrc(content: string, mimeType: string): string {
    if (content.startsWith("data:")) return content;
    if (content.startsWith("http://") || content.startsWith("https://")) {
      return isValidResourceUrl(content) ? content : "";
    }
    if (mimeType === "image/svg+xml" && content.includes("<svg")) {
      return `data:image/svg+xml;utf8,${encodeURIComponent(content)}`;
    }
    const compact = content.replace(/\s+/g, "");
    const looksBase64 = /^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 64;
    if (!looksBase64) return "";
    return `data:${mimeType};base64,${compact}`;
  }

  async function openFilePreview(path: string) {
    previewPath = path;
    previewError = "";
    previewSrc = "";
    previewOpen = true;
    previewKind = detectPreviewKind(path) || "image";
    if (!agentName) {
      previewError = "Image preview unavailable: missing agent context.";
      return;
    }
    previewLoading = true;
    try {
      const params = new URLSearchParams({ agent_name: agentName, path });
      const file = await api.get<{ content: string; mime_type?: string }>(`/workspace/files/read?${params.toString()}`);
      const mime = file.mime_type || guessMime(path);
      const kind = detectPreviewKind(path, mime);
      if (!kind) throw new Error(`Preview unsupported for ${mime}`);
      previewKind = kind;
      const src = toDataSrc(file.content || "", mime);
      if (!src) throw new Error("Could not decode file content.");
      previewSrc = src;
    } catch (err: any) {
      previewError = err?.message || "Failed to load preview.";
    } finally {
      previewLoading = false;
    }
  }
</script>

<!-- Inline tool call — bare text, no card -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={toolCallEl}
  class={cn("flex items-center gap-1.5 py-0.5 text-xs cursor-pointer", hasError && "text-destructive")}
  onclick={() => {
    const wasExpanded = expanded;
    const scrollContainer = toolCallEl?.closest("[data-chat-scroll]") ?? document.scrollingElement ?? document.documentElement;
    const savedTop = toolCallEl?.getBoundingClientRect().top ?? 0;
    expanded = !expanded;
    if (!expanded) { showArgs = false; showFullResult = false; }
    // On collapse, restore scroll so the element stays in the same viewport position
    if (wasExpanded && toolCallEl && scrollContainer) {
      requestAnimationFrame(() => {
        const newTop = toolCallEl!.getBoundingClientRect().top;
        const drift = newTop - savedTop;
        if (Math.abs(drift) > 2) {
          scrollContainer.scrollTop -= drift;
        }
      });
    }
  }}
>
  <!-- Status icon -->
  {#if isPending}
    <span class="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/50 border-t-transparent"></span>
  {:else if hasError}
    <span class="shrink-0 text-destructive">✗</span>
  {:else}
    <span class="shrink-0 text-green-600 dark:text-green-400">✓</span>
  {/if}

  <!-- Tool name -->
  <span class="shrink-0 font-mono font-medium text-muted-foreground">{toolCall.name}</span>

  <!-- Summary -->
  <span class={cn("truncate", hasError ? "text-destructive/70" : "text-muted-foreground/60")}>
    {summaryText}
  </span>

  <!-- Latency / live timer -->
  {#if latencyLabel}
    <span class="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground/40">{latencyLabel}</span>
  {/if}
</div>

  <!-- Expanded detail -->
  {#if expanded}
    <div class="ml-5 mr-2 mt-1 mb-2 border-l-2 border-border pl-3 animate-expand">

      <!-- Edit preview (diff) — shown immediately, compact -->
      {#if editPreview}
        <div class="overflow-hidden rounded border border-border bg-muted/20 mt-1">
          <div class="flex items-center gap-2 bg-muted/40 px-2 py-1">
            <span class="font-mono text-[11px] text-foreground">{editPreview.filePath.split("/").pop()}</span>
            {#if editPreview.added > 0}
              <span class="text-[10px] text-green-600">+{editPreview.added}</span>
            {/if}
            {#if editPreview.deleted > 0}
              <span class="text-[10px] text-red-600">-{editPreview.deleted}</span>
            {/if}
          </div>
          <div class="px-2 py-1">
            {#each editPreview.lines as line}
              <div class={line.type === "add"
                ? "font-mono text-[11px] whitespace-pre-wrap text-green-700 dark:text-green-400"
                : line.type === "del"
                  ? "font-mono text-[11px] whitespace-pre-wrap text-red-700 dark:text-red-400"
                  : "font-mono text-[11px] whitespace-pre-wrap text-muted-foreground"}>
                {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}{line.text}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Error — always visible inline -->
      {#if toolCall.error}
        <pre class="mt-1 whitespace-pre-wrap break-all rounded bg-destructive/5 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-destructive">{toolCall.error}</pre>

      <!-- Result — compact preview, truncated -->
      {:else if toolCall.output && parsedResult}
        <div class="mt-1">
          <!-- Show first 8 lines, "show more" for the rest -->
          <div class="rounded bg-muted/20 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground" style="max-height: {showFullResult ? '24rem' : 'none'}; overflow-y: {showFullResult ? 'auto' : 'hidden'};">
            {#each (showFullResult ? parsedResult.lines : parsedResult.lines.slice(0, 8)) as line}
              <div class="whitespace-pre-wrap">{line}</div>
            {/each}
          </div>
          {#if parsedResult.lines.length > 8 && !showFullResult}
            <button
              type="button"
              class="mt-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground"
              onclick={() => (showFullResult = true)}
            >
              +{parsedResult.lines.length - 8} more lines
            </button>
          {/if}
          {#if showFullResult && parsedResult.lines.length > 8}
            <button
              type="button"
              class="mt-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground"
              onclick={() => (showFullResult = false)}
            >
              collapse
            </button>
          {/if}
          {#if parsedResult.images.length > 0}
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              {#each parsedResult.images as img}
                <img src={img.src} alt={img.alt} class="h-auto max-w-full rounded border border-border" loading="lazy" style="max-height: 10rem;" />
              {/each}
            </div>
          {/if}
          {#if mediaFilePaths.length > 0}
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              {#each mediaFilePaths as path}
                <button
                  type="button"
                  class="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/60"
                  onclick={() => openFilePreview(path)}
                >
                  {path.split("/").pop()}
                </button>
              {/each}
            </div>
          {/if}
        </div>

      <!-- Pending -->
      {:else if isPending}
        <p class="mt-1 text-[11px] text-muted-foreground/60 italic">Waiting for result...</p>
      {/if}

      <!-- Arguments — hidden by default, toggle to show -->
      {#if toolCall.input && toolCall.input !== "{}"}
        <button
          type="button"
          class="mt-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
          onclick={() => (showArgs = !showArgs)}
        >
          {showArgs ? "hide" : "show"} arguments
        </button>
        {#if showArgs}
          <div class="mt-1">
            <SyntaxHighlightedCode
              code={formattedInput.formatted}
              language={formattedInput.isJson ? "json" : "plaintext"}
              maxHeight="12rem"
            />
          </div>
        {/if}
      {/if}
    </div>
  {/if}

<!-- File preview modal -->
{#if previewOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-label="File preview">
    <button class="absolute inset-0" aria-label="Close preview" onclick={() => (previewOpen = false)}></button>
    <div class="relative z-10 max-h-[90vh] max-w-[90vw] overflow-auto rounded-lg border border-border bg-background p-3">
      <div class="mb-2 flex items-center justify-between gap-4">
        <p class="text-xs text-muted-foreground">{previewPath}</p>
        <button
          type="button"
          class="rounded border border-border px-2 py-1 text-xs hover:bg-muted/60"
          onclick={() => (previewOpen = false)}
        >
          Close
        </button>
      </div>
      {#if previewLoading}
        <p class="text-sm text-muted-foreground">Loading preview...</p>
      {:else if previewError}
        <p class="text-sm text-destructive">{previewError}</p>
      {:else if previewSrc}
        {#if previewKind === "image"}
          <img src={previewSrc} alt={previewPath} class="h-auto max-w-full rounded border border-border" />
        {:else if previewKind === "pdf"}
          <iframe title={previewPath} src={previewSrc} class="h-[70vh] w-[80vw] rounded border border-border"></iframe>
        {:else if previewKind === "audio"}
          <audio controls src={previewSrc} class="w-[70vw] max-w-xl"></audio>
        {:else if previewKind === "video"}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video controls src={previewSrc} class="h-auto max-h-[70vh] w-[80vw] rounded border border-border"></video>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .animate-expand {
    animation: expandIn 150ms ease-out;
    transform-origin: top;
  }
  @keyframes expandIn {
    from {
      opacity: 0;
      transform: scaleY(0.95) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: scaleY(1) translateY(0);
    }
  }
</style>
