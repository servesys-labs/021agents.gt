<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    listWorkspaceFiles,
    getFileContent,
    downloadFile as downloadFileUrl,
    type WorkspaceFile,
  } from "$lib/services/settings";

  interface Props {
    agentName: string;
    open: boolean;
    onClose: () => void;
    width?: number;
  }

  let { agentName, open, onClose, width = $bindable(384) }: Props = $props();

  let files = $state<WorkspaceFile[]>([]);
  let loading = $state(false);
  let error = $state("");
  let resizing = $state(false);
  let fullPage = $state(false);

  // ── Resize handle ──
  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = width;

    function onMove(ev: MouseEvent) {
      const dx = startX - ev.clientX;
      width = Math.max(280, Math.min(800, startW + dx));
    }

    function onUp() {
      resizing = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Preview
  let selectedFile = $state<WorkspaceFile | null>(null);
  let previewContent = $state("");
  let previewMime = $state("");
  let previewLoading = $state(false);

  // Collapsed folders
  let collapsedDirs = $state(new Set<string>());

  // ── File helpers ──

  function fileExtension(path: string): string {
    const parts = path.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  }

  function isTextFile(path: string): boolean {
    const textExts = new Set(["txt", "md", "json", "csv", "html", "css", "js", "ts", "py", "sh", "yaml", "yml", "toml", "xml", "svg", "log", "env", "sql", "rs", "go", "java", "rb", "php", "c", "cpp", "h"]);
    return textExts.has(fileExtension(path));
  }

  function isImageFile(path: string): boolean {
    const imgExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
    return imgExts.has(fileExtension(path));
  }

  function isHtmlFile(path: string): boolean {
    return fileExtension(path) === "html" || fileExtension(path) === "htm";
  }

  function isPdfFile(path: string): boolean {
    return fileExtension(path) === "pdf";
  }

  function basename(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileIconPath(path: string): string {
    const ext = fileExtension(path);
    if (isImageFile(path)) return "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z";
    if (isPdfFile(path)) return "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z";
    if (["js", "ts", "py", "sh", "json", "rs", "go"].includes(ext)) return "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4";
    return "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z";
  }

  // ── Tree structure ──

  interface TreeNode {
    name: string;
    path: string;
    isDir: boolean;
    file?: WorkspaceFile;
    children: TreeNode[];
  }

  let tree = $derived.by((): TreeNode[] => {
    const root: TreeNode[] = [];
    const dirMap = new Map<string, TreeNode>();

    function ensureDir(dirPath: string): TreeNode {
      if (dirMap.has(dirPath)) return dirMap.get(dirPath)!;
      const parts = dirPath.split("/");
      const name = parts[parts.length - 1];
      const node: TreeNode = { name, path: dirPath, isDir: true, children: [] };
      dirMap.set(dirPath, node);

      if (parts.length > 1) {
        const parentPath = parts.slice(0, -1).join("/");
        const parent = ensureDir(parentPath);
        parent.children.push(node);
      } else {
        root.push(node);
      }
      return node;
    }

    for (const f of files) {
      const parts = f.path.split("/");
      const fileName = parts[parts.length - 1];
      const fileNode: TreeNode = { name: fileName, path: f.path, isDir: false, file: f, children: [] };

      if (parts.length > 1) {
        const dirPath = parts.slice(0, -1).join("/");
        const parent = ensureDir(dirPath);
        parent.children.push(fileNode);
      } else {
        root.push(fileNode);
      }
    }

    // Sort: dirs first, then files, alphabetical
    function sortNodes(nodes: TreeNode[]) {
      nodes.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const n of nodes) {
        if (n.children.length > 0) sortNodes(n.children);
      }
    }
    sortNodes(root);
    return root;
  });

  // ── Actions ──

  export async function refresh() {
    loading = true;
    error = "";
    try {
      files = await listWorkspaceFiles(agentName);
    } catch (err: any) {
      error = err?.message || "Failed to load files";
    } finally {
      loading = false;
    }
  }

  // Auto-load when opened
  $effect(() => {
    if (open && agentName) {
      refresh();
    }
  });

  async function selectFile(file: WorkspaceFile) {
    selectedFile = file;
    previewContent = "";
    previewMime = "";

    if (!isTextFile(file.path) && !isImageFile(file.path) && !isPdfFile(file.path) && !isHtmlFile(file.path)) {
      return;
    }

    previewLoading = true;
    try {
      const result = await getFileContent(agentName, file.path);
      previewContent = result.content;
      previewMime = result.mime_type;
    } catch (err: any) {
      previewContent = `Error: ${err?.message || "Failed to load"}`;
      previewMime = "";
    } finally {
      previewLoading = false;
    }
  }

  function downloadFile(file: WorkspaceFile) {
    const url = downloadFileUrl(agentName, file.path);
    window.open(url, "_blank");
  }

  function toggleDir(dirPath: string) {
    const next = new Set(collapsedDirs);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
    }
    collapsedDirs = next;
  }

  function closePreview() {
    selectedFile = null;
    previewContent = "";
    previewMime = "";
  }
</script>

{#if open}
  <!-- Resize handle (desktop only) -->
  <button
    type="button"
    class={cn(
      "hidden md:flex w-1.5 cursor-col-resize items-center justify-center hover:bg-accent/50 active:bg-accent transition-colors shrink-0",
      resizing && "bg-accent"
    )}
    aria-label="Resize workspace panel"
    onmousedown={startResize}
  >
    <div class="h-8 w-0.5 rounded-full bg-muted-foreground/20"></div>
  </button>

  <!-- Sidebar panel -->
  <div class="flex h-full flex-col border-l border-border bg-background" style="width: {width}px;">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-border px-3 py-2.5">
      <div class="flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span class="text-sm font-medium text-foreground">Workspace</span>
        {#if files.length > 0}
          <span class="text-[10px] text-muted-foreground">{files.length} files</span>
        {/if}
      </div>
      <div class="flex items-center gap-1">
        <!-- Expand to full page -->
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onclick={() => (fullPage = true)}
          aria-label="Expand to full view"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
        <!-- Refresh -->
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onclick={refresh}
          aria-label="Refresh files"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class={cn("h-3.5 w-3.5", loading && "animate-spin")} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>
        <!-- Close -->
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onclick={onClose}
          aria-label="Close workspace"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex flex-1 flex-col overflow-hidden">
      {#if selectedFile}
        <!-- File preview view -->
        <div class="flex flex-col overflow-hidden h-full">
          <!-- Preview header -->
          <div class="flex items-center gap-2 border-b border-border px-3 py-2">
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:text-foreground"
              onclick={closePreview}
              aria-label="Back to file list"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{basename(selectedFile.path)}</span>
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:text-foreground"
              onclick={() => selectedFile && downloadFile(selectedFile)}
              aria-label="Download file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>

          <!-- Preview content -->
          <div class="flex-1 overflow-auto p-3">
            {#if previewLoading}
              <div class="flex items-center justify-center py-8">
                <div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
              </div>
            {:else if isImageFile(selectedFile.path) && previewContent}
              {#if previewContent.startsWith("data:")}
                <img src={previewContent} alt={selectedFile.path} class="h-auto max-w-full rounded border border-border" />
              {:else}
                <img src="data:{previewMime};base64,{previewContent}" alt={selectedFile.path} class="h-auto max-w-full rounded border border-border" />
              {/if}
            {:else if isHtmlFile(selectedFile.path) && previewContent}
              <iframe
                title={selectedFile.path}
                srcdoc={previewContent}
                sandbox="allow-scripts allow-same-origin"
                class="h-[60vh] w-full rounded border border-border bg-white"
              ></iframe>
            {:else if isPdfFile(selectedFile.path) && previewContent}
              {#if previewContent.startsWith("data:")}
                <iframe title={selectedFile.path} src={previewContent} class="h-[60vh] w-full rounded border border-border"></iframe>
              {:else}
                <p class="text-xs text-muted-foreground">PDF preview — <button type="button" class="underline" onclick={() => selectedFile && downloadFile(selectedFile)}>download</button></p>
              {/if}
            {:else if previewContent}
              <pre class="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">{previewContent}</pre>
            {:else}
              <div class="flex flex-col items-center gap-2 py-8 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-muted-foreground/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d={fileIconPath(selectedFile.path)} stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <p class="text-xs text-muted-foreground">{formatSize(selectedFile.size_bytes)}</p>
                <button
                  type="button"
                  class="mt-1 rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                  onclick={() => selectedFile && downloadFile(selectedFile)}
                >
                  Download
                </button>
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <!-- File tree view -->
        <div class="flex-1 overflow-y-auto">
          {#if loading && files.length === 0}
            <div class="flex items-center justify-center py-8">
              <div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
            </div>
          {:else if error}
            <div class="px-3 py-6 text-center text-xs text-destructive">{error}</div>
          {:else if files.length === 0}
            <div class="px-3 py-8 text-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <p class="text-xs text-muted-foreground">No files yet</p>
              <p class="mt-1 text-[10px] text-muted-foreground/60">Files created by the agent will appear here</p>
            </div>
          {:else}
            <div class="py-1">
              {#each tree as node}
                {@render treeNode(node, 0)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

{#snippet treeNode(node: TreeNode, depth: number)}
  {#if node.isDir}
    <!-- Directory -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/50"
      style="padding-left: {depth * 12 + 8}px;"
      onclick={() => toggleDir(node.path)}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-100", !collapsedDirs.has(node.path) && "rotate-90")}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M8 5v14l11-7z" />
      </svg>
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span class="truncate font-medium text-foreground">{node.name}</span>
    </button>
    {#if !collapsedDirs.has(node.path)}
      {#each node.children as child}
        {@render treeNode(child, depth + 1)}
      {/each}
    {/if}
  {:else if node.file}
    <!-- File -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/50"
      style="padding-left: {depth * 12 + 20}px;"
      onclick={() => node.file && selectFile(node.file)}
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d={fileIconPath(node.path)} />
      </svg>
      <span class="min-w-0 flex-1 truncate text-foreground">{node.name}</span>
      <span class="shrink-0 pr-2 text-[10px] tabular-nums text-muted-foreground/50">{formatSize(node.file.size_bytes)}</span>
    </button>
  {/if}
{/snippet}

<!-- Full-page workspace modal -->
{#if fullPage}
  <div class="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-label="Workspace files">
    <!-- Modal header -->
    <div class="flex items-center justify-between border-b border-border px-6 py-3">
      <div class="flex items-center gap-3">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span class="text-base font-semibold text-foreground">Workspace</span>
        {#if files.length > 0}
          <span class="text-xs text-muted-foreground">{files.length} files</span>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onclick={refresh}
          aria-label="Refresh"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class={cn("h-4 w-4", loading && "animate-spin")} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>
        <button
          type="button"
          class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onclick={() => (fullPage = false)}
          aria-label="Close full view"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Two-column layout: tree + preview -->
    <div class="flex flex-1 overflow-hidden">
      <!-- File tree column -->
      <div class="w-72 shrink-0 overflow-y-auto border-r border-border lg:w-80">
        {#if loading && files.length === 0}
          <div class="flex items-center justify-center py-12">
            <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
          </div>
        {:else if files.length === 0}
          <div class="px-4 py-12 text-center text-sm text-muted-foreground">No files yet</div>
        {:else}
          <div class="py-1">
            {#each tree as node}
              {@render treeNode(node, 0)}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Preview column -->
      <div class="flex-1 overflow-auto p-6">
        {#if selectedFile}
          <div class="mb-4 flex items-center gap-3">
            <span class="font-mono text-sm text-foreground">{selectedFile.path}</span>
            <span class="text-xs text-muted-foreground">{formatSize(selectedFile.size_bytes)}</span>
            <button
              type="button"
              class="ml-auto rounded-md border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-muted"
              onclick={() => selectedFile && downloadFile(selectedFile)}
            >
              Download
            </button>
          </div>
          {#if previewLoading}
            <div class="flex items-center justify-center py-12">
              <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
            </div>
          {:else if isImageFile(selectedFile.path) && previewContent}
            {#if previewContent.startsWith("data:")}
              <img src={previewContent} alt={selectedFile.path} class="h-auto max-w-full rounded border border-border" />
            {:else}
              <img src="data:{previewMime};base64,{previewContent}" alt={selectedFile.path} class="h-auto max-w-full rounded border border-border" />
            {/if}
          {:else if isHtmlFile(selectedFile.path) && previewContent}
            <iframe
              title={selectedFile.path}
              srcdoc={previewContent}
              sandbox="allow-scripts allow-same-origin"
              class="h-[85vh] w-full rounded border border-border bg-white"
            ></iframe>
          {:else if isPdfFile(selectedFile.path) && previewContent}
            {#if previewContent.startsWith("data:")}
              <iframe title={selectedFile.path} src={previewContent} class="h-[85vh] w-full rounded border border-border"></iframe>
            {:else}
              <p class="text-sm text-muted-foreground">PDF preview not available — <button type="button" class="underline" onclick={() => selectedFile && downloadFile(selectedFile)}>download instead</button></p>
            {/if}
          {:else if previewContent}
            <pre class="whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/20 p-4 font-mono text-xs leading-relaxed text-muted-foreground">{previewContent}</pre>
          {:else}
            <div class="flex flex-col items-center gap-3 py-12 text-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-muted-foreground/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d={fileIconPath(selectedFile.path)} stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <p class="text-sm text-muted-foreground">No preview available</p>
              <button
                type="button"
                class="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                onclick={() => selectedFile && downloadFile(selectedFile)}
              >
                Download File
              </button>
            </div>
          {/if}
        {:else}
          <div class="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
            <svg xmlns="http://www.w3.org/2000/svg" class="mb-3 h-10 w-10 text-muted-foreground/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p class="text-sm">Select a file to preview</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
