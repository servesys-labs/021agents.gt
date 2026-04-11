<script lang="ts">
  import { api } from "$lib/services/api";
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
    agentName?: string;
  }

  let { toolCall, expanded, agentName }: Props = $props();

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
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
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
      if (typeof parsed.patch === "string") {
        return parseEditPreviewFromPatch(parsed.patch);
      }
      const path = typeof parsed.path === "string" ? parsed.path : "";
      const content =
        typeof parsed.new_string === "string"
          ? parsed.new_string
          : typeof parsed.content === "string"
            ? parsed.content
            : "";
      if (!path || !content) return null;
      const lines = content.split("\n").slice(0, 12).map((line) => ({ type: "add" as const, text: line }));
      return {
        filePath: path,
        added: Math.max(1, content.split("\n").length),
        deleted: 0,
        lines,
      };
    } catch {
      return null;
    }
  }

  let editPreview = $derived.by(() => {
    const name = (toolCall.name || "").toLowerCase();
    if (!name.includes("edit") && !name.includes("write") && !name.includes("patch")) return null;
    return parseEditPreviewFromStructuredInput(toolCall.input) || parseEditPreviewFromPatch(toolCall.input);
  });

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

  /** Parse tool result for embedded images (base64 data URIs or URLs) */
  function isValidResourceUrl(src: string): boolean {
    if (!src || typeof src !== "string") return false;
    if (src.startsWith("data:image/")) return true;
    if (!src.startsWith("http://") && !src.startsWith("https://")) return false;
    try {
      const u = new URL(src);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
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
    // Truncate long results
    const maxLen = 5000;
    const truncated = text.length > maxLen ? text.slice(0, maxLen) + "\n... (truncated)" : text;
    return { lines: truncated.split("\n"), images };
  }

  let parsedResult = $derived(
    toolCall.output ? parseResultImages(toolCall.output) : null
  );

  let mediaFilePaths = $derived.by(() => {
    const all = `${toolCall.input || ""}\n${toolCall.output || ""}`;
    return extractMediaPaths(all);
  });

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

  {#if editPreview}
    <div class="border-t border-border px-3 py-2.5">
      <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Edit Preview</p>
      <div class="overflow-hidden rounded-lg border border-border bg-muted/20">
        <div class="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
          <span class="font-mono text-xs text-foreground">{editPreview.filePath.split("/").pop()}</span>
          {#if editPreview.added > 0}
            <span class="text-[10px] text-green-600">+{editPreview.added}</span>
          {/if}
          {#if editPreview.deleted > 0}
            <span class="text-[10px] text-red-600">-{editPreview.deleted}</span>
          {/if}
        </div>
        <div class="p-2">
          {#each editPreview.lines as line}
            <div
              class={line.type === "add"
                ? "font-mono text-xs whitespace-pre-wrap text-green-700 dark:text-green-400"
                : line.type === "del"
                  ? "font-mono text-xs whitespace-pre-wrap text-red-700 dark:text-red-400"
                  : "font-mono text-xs whitespace-pre-wrap text-muted-foreground"}
            >
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}{line.text}
            </div>
          {/each}
        </div>
      </div>
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
      {#if mediaFilePaths.length > 0}
        <div class="mt-2 flex flex-wrap gap-2">
          {#each mediaFilePaths as path}
            <button
              type="button"
              class="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/60"
              onclick={() => openFilePreview(path)}
            >
              Preview {path.split("/").pop()}
            </button>
          {/each}
        </div>
      {/if}
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

{#if previewOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-label="Image preview">
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
