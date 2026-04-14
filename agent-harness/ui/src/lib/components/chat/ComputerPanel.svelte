<script lang="ts">
  /**
   * ComputerPanel — Manus-style agent workspace viewer.
   *
   * Tabbed interface showing what the agent is doing in real-time:
   *   Code   — syntax-highlighted file viewer (from write-file/edit-file tool calls)
   *   Preview — live iframe from expose_preview URLs
   *   Terminal — streaming tool output (bash, python-exec, start_process)
   *   Files  — workspace file tree browser
   *
   * Data comes from WebSocket tool call streaming — no polling.
   * Opens automatically when the agent starts doing workspace operations.
   */

  import { cn } from "$lib/utils";
  import { agentStore } from "$lib/stores/agent.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Active tool calls from the chat — drives what's shown */
    toolCalls?: Array<{ name: string; input: string; output?: string; call_id: string }>;
    /** Preview URL from expose_preview tool */
    previewUrl?: string;
    /** Current file being edited (from write-file/edit-file args) */
    activeFile?: { path: string; content: string; language: string } | null;
    /** Terminal output lines */
    terminalLines?: string[];
    /** File list from workspace */
    files?: Array<{ path: string; size: number; modified?: string }>;
  }

  let {
    open,
    onClose,
    toolCalls = [],
    previewUrl = "",
    activeFile = null,
    terminalLines = [],
    files = [],
  }: Props = $props();

  // ── Tab state ──
  type Tab = "code" | "preview" | "terminal" | "files" | "settings";
  let activeTab = $state<Tab>("code");

  // Auto-switch tabs based on agent activity
  $effect(() => {
    if (previewUrl && !activeFile) activeTab = "preview";
    else if (activeFile) activeTab = "code";
    else if (terminalLines.length > 0 && !activeFile) activeTab = "terminal";
  });

  // ── Panel width (resizable) ──
  let width = $state(480);
  let resizing = $state(false);

  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = width;
    function onMove(ev: MouseEvent) { width = Math.max(320, Math.min(900, startW + (startX - ev.clientX))); }
    function onUp() { resizing = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Language detection for syntax highlighting ──
  function detectLanguage(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
      py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
      css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
      md: "markdown", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
      svelte: "html", vue: "html", dockerfile: "dockerfile",
    };
    return map[ext] || "plaintext";
  }

  // ── Syntax highlighting (basic token coloring) ──
  function highlightCode(code: string, language: string): string {
    // Simple keyword highlighting — production would use highlight.js
    if (!code) return "";
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    if (["typescript", "javascript"].includes(language)) {
      return escaped
        .replace(/\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|class|extends|new|this|type|interface)\b/g, '<span class="text-purple-400">$1</span>')
        .replace(/\b(true|false|null|undefined|void)\b/g, '<span class="text-amber-400">$1</span>')
        .replace(/(\/\/.*$)/gm, '<span class="text-muted-foreground">$1</span>')
        .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="text-green-400">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="text-cyan-400">$1</span>');
    }
    if (language === "python") {
      return escaped
        .replace(/\b(def|class|import|from|return|if|elif|else|for|while|with|as|try|except|finally|raise|yield|async|await|lambda|pass|break|continue)\b/g, '<span class="text-purple-400">$1</span>')
        .replace(/\b(True|False|None)\b/g, '<span class="text-amber-400">$1</span>')
        .replace(/(#.*$)/gm, '<span class="text-muted-foreground">$1</span>')
        .replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span class="text-green-400">$1</span>');
    }
    return escaped;
  }

  // ── File icon ──
  function fileIcon(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (["ts", "tsx", "js", "jsx"].includes(ext)) return "📄";
    if (["py"].includes(ext)) return "🐍";
    if (["md"].includes(ext)) return "📝";
    if (["json", "yaml", "yml", "toml"].includes(ext)) return "⚙️";
    if (["css", "html", "svelte", "vue"].includes(ext)) return "🎨";
    if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "🖼️";
    if (["pdf"].includes(ext)) return "📕";
    return "📄";
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  // Selected file in file tree
  let selectedFilePath = $state("");
</script>

{#if open}
  <div
    class="flex h-full flex-col border-l border-border bg-background"
    style="width: {width}px; min-width: 320px;"
  >
    <!-- Resize handle -->
    <div
      class="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 transition-colors z-10"
      class:bg-primary/50={resizing}
      onmousedown={startResize}
    ></div>

    <!-- Header with tabs -->
    <div class="flex items-center justify-between border-b border-border bg-card px-2">
      <div class="flex items-center gap-0.5">
        {#each [
          { id: "code", label: "Code", icon: "⌨️" },
          { id: "preview", label: "Preview", icon: "👁️" },
          { id: "terminal", label: "Terminal", icon: "▶️" },
          { id: "files", label: "Files", icon: "📁" },
        ] as tab}
          <button
            class={cn(
              "px-3 py-2 text-xs font-medium transition-colors border-b-2",
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onclick={() => (activeTab = tab.id as Tab)}
          >
            <span class="mr-1">{tab.icon}</span>
            {tab.label}
            {#if tab.id === "terminal" && terminalLines.length > 0}
              <span class="ml-1 rounded-full bg-primary/20 px-1.5 text-[10px] text-primary">{terminalLines.length}</span>
            {/if}
          </button>
        {/each}
      </div>
      <button
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        onclick={onClose}
        aria-label="Close panel"
      >✕</button>
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-hidden">
      <!-- CODE TAB -->
      {#if activeTab === "code"}
        <div class="flex h-full flex-col">
          {#if activeFile}
            <!-- File header -->
            <div class="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-1.5">
              <span class="text-xs">{fileIcon(activeFile.path)}</span>
              <span class="text-xs font-mono text-muted-foreground truncate">{activeFile.path}</span>
              <span class="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{detectLanguage(activeFile.path)}</span>
            </div>
            <!-- Code content with line numbers -->
            <div class="flex-1 overflow-auto">
              <div class="flex font-mono text-xs leading-5">
                <!-- Line numbers -->
                <div class="flex-shrink-0 select-none border-r border-border bg-card/30 px-2 py-3 text-right text-muted-foreground/50">
                  {#each activeFile.content.split("\n") as _, i}
                    <div>{i + 1}</div>
                  {/each}
                </div>
                <!-- Code -->
                <pre class="flex-1 overflow-x-auto py-3 px-3"><code>{@html highlightCode(activeFile.content, detectLanguage(activeFile.path))}</code></pre>
              </div>
            </div>
          {:else}
            <div class="flex h-full items-center justify-center">
              <div class="text-center">
                <div class="text-3xl mb-2 opacity-30">⌨️</div>
                <p class="text-sm text-muted-foreground">No file being edited</p>
                <p class="text-xs text-muted-foreground/60 mt-1">Files will appear here when the agent creates or edits them</p>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- PREVIEW TAB -->
      {#if activeTab === "preview"}
        <div class="flex h-full flex-col">
          {#if previewUrl}
            <div class="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-1.5">
              <span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
              <span class="text-xs font-mono text-muted-foreground truncate">{previewUrl}</span>
              <a href={previewUrl} target="_blank" rel="noopener" class="ml-auto text-xs text-primary hover:underline">Open ↗</a>
            </div>
            <iframe
              src={previewUrl}
              class="flex-1 w-full border-0"
              title="Live preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            ></iframe>
          {:else}
            <div class="flex h-full items-center justify-center">
              <div class="text-center">
                <div class="text-3xl mb-2 opacity-30">👁️</div>
                <p class="text-sm text-muted-foreground">No preview available</p>
                <p class="text-xs text-muted-foreground/60 mt-1">Preview appears when the agent starts a dev server</p>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- TERMINAL TAB -->
      {#if activeTab === "terminal"}
        <div class="flex h-full flex-col bg-[#1a1a2e]">
          <div class="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
            <div class="flex gap-1">
              <span class="h-2.5 w-2.5 rounded-full bg-red-500/80"></span>
              <span class="h-2.5 w-2.5 rounded-full bg-yellow-500/80"></span>
              <span class="h-2.5 w-2.5 rounded-full bg-green-500/80"></span>
            </div>
            <span class="text-xs text-muted-foreground/60 font-mono">agent@sandbox</span>
          </div>
          <div class="flex-1 overflow-auto p-3 font-mono text-xs text-green-400/90 leading-5">
            {#if terminalLines.length > 0}
              {#each terminalLines as line}
                <div class="whitespace-pre-wrap">{line}</div>
              {/each}
            {:else}
              <div class="text-muted-foreground/40">
                <div>$ <span class="animate-pulse">_</span></div>
                <div class="mt-2 text-muted-foreground/30">Terminal output appears when the agent runs commands</div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- FILES TAB -->
      {#if activeTab === "files"}
        <div class="flex h-full flex-col">
          <div class="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-1.5">
            <span class="text-xs text-muted-foreground">{files.length} files</span>
          </div>
          <div class="flex-1 overflow-auto">
            {#if files.length > 0}
              <div class="py-1">
                {#each files as file}
                  <button
                    class={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50 transition-colors",
                      selectedFilePath === file.path && "bg-muted"
                    )}
                    onclick={() => { selectedFilePath = file.path; }}
                  >
                    <span>{fileIcon(file.path)}</span>
                    <span class="flex-1 truncate font-mono">{file.path}</span>
                    <span class="text-muted-foreground/50">{formatSize(file.size)}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <div class="flex h-full items-center justify-center">
                <div class="text-center">
                  <div class="text-3xl mb-2 opacity-30">📁</div>
                  <p class="text-sm text-muted-foreground">Workspace empty</p>
                  <p class="text-xs text-muted-foreground/60 mt-1">Files appear when the agent creates them</p>
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <!-- Status bar -->
    <div class="flex items-center gap-3 border-t border-border bg-card/50 px-3 py-1">
      {#if activeFile}
        <span class="text-[10px] text-muted-foreground">{activeFile.content.split("\n").length} lines</span>
      {/if}
      {#if previewUrl}
        <span class="flex items-center gap-1 text-[10px] text-green-400">
          <span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>
          Live
        </span>
      {/if}
      <span class="ml-auto text-[10px] text-muted-foreground">{files.length} files</span>
    </div>
  </div>
{/if}
