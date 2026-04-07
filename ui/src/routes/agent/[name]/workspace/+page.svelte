<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Dialog from "$lib/components/ui/dialog.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";
  import {
    listWorkspaceFiles,
    getFileContent,
    deleteFile,
    type WorkspaceFile,
  } from "$lib/services/settings";
  import { timeAgo } from "$lib/utils/time";

  let agentName = $derived($page.params.name ?? "");

  let files = $state<WorkspaceFile[]>([]);
  let loading = $state(true);
  let viewMode = $state<"list" | "tree">("list");

  // Preview
  let selectedFile = $state<WorkspaceFile | null>(null);
  let previewContent = $state("");
  let previewMime = $state("");
  let loadingPreview = $state(false);

  // Delete
  let deleteOpen = $state(false);
  let deletingFile = $state<WorkspaceFile | null>(null);
  let deleting = $state(false);

  let totalSize = $derived(files.reduce((sum, f) => sum + f.size_bytes, 0));

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function fileExtension(path: string): string {
    const parts = path.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  }

  function isTextFile(path: string): boolean {
    const textExts = new Set(["txt", "md", "json", "csv", "html", "css", "js", "ts", "py", "sh", "yaml", "yml", "toml", "xml", "svg", "log", "env", "sql"]);
    return textExts.has(fileExtension(path));
  }

  function isImageFile(path: string): boolean {
    const imgExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
    return imgExts.has(fileExtension(path));
  }

  function fileIcon(path: string): string {
    const ext = fileExtension(path);
    if (isImageFile(path)) return "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z";
    if (["pdf"].includes(ext)) return "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z";
    if (["js", "ts", "py", "sh", "json"].includes(ext)) return "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4";
    return "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z";
  }

  // Group files into tree structure
  let fileTree = $derived.by(() => {
    const tree = new Map<string, WorkspaceFile[]>();
    for (const f of files) {
      const parts = f.path.split("/");
      const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "/";
      if (!tree.has(dir)) tree.set(dir, []);
      tree.get(dir)!.push(f);
    }
    return [...tree.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  async function load() {
    loading = true;
    try {
      files = await listWorkspaceFiles(agentName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load workspace files");
    } finally {
      loading = false;
    }
  }

  async function selectFile(file: WorkspaceFile) {
    selectedFile = file;
    previewContent = "";
    previewMime = "";

    if (!isTextFile(file.path) && !isImageFile(file.path)) {
      return;
    }

    loadingPreview = true;
    try {
      const result = await getFileContent(agentName, file.path);
      previewContent = result.content;
      previewMime = result.mime_type;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load file content");
    } finally {
      loadingPreview = false;
    }
  }

  function confirmDelete(file: WorkspaceFile) {
    deletingFile = file;
    deleteOpen = true;
  }

  async function handleDelete() {
    if (!deletingFile) return;
    deleting = true;
    try {
      await deleteFile(agentName, deletingFile.path);
      toast.success(`Deleted "${deletingFile.path}"`);
      deleteOpen = false;
      if (selectedFile?.path === deletingFile.path) {
        selectedFile = null;
        previewContent = "";
      }
      deletingFile = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete file");
    } finally {
      deleting = false;
    }
  }

  function downloadFile(file: WorkspaceFile) {
    const url = `${import.meta.env.VITE_API_URL ?? "https://api.oneshots.co/api/v1"}/workspace/files/${encodeURIComponent(file.path)}?agent_name=${encodeURIComponent(agentName)}&download=true`;
    window.open(url, "_blank");
  }

  $effect(() => {
    if (agentName) load();
  });
</script>

<Dialog
  bind:open={deleteOpen}
  title="Delete File"
  description={`This will permanently delete "${deletingFile?.path ?? ""}" — this cannot be undone.`}
  confirmText={deleting ? "Deleting..." : "Delete File"}
  variant="destructive"
  onConfirm={handleDelete}
/>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-6xl px-6 py-8 lg:px-8">
      <!-- Header -->
      <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>Workspace Files</h1>
          <p class="mt-1.5 text-sm text-muted-foreground">
            {files.length} file{files.length !== 1 ? "s" : ""} &middot; {formatSize(totalSize)}
          </p>
        </div>
        <div class="flex gap-2">
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="sm"
            onclick={() => (viewMode = "list")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
          </Button>
          <Button
            variant={viewMode === "tree" ? "secondary" : "ghost"}
            size="sm"
            onclick={() => (viewMode = "tree")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </Button>
        </div>
      </div>

      {#if loading}
        <div class="flex items-center justify-center py-24">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else if files.length === 0}
        <div class="rounded-lg border border-dashed border-border py-16 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <h3 class="mt-4 text-foreground">No workspace files</h3>
          <p class="mt-1.5 text-sm text-muted-foreground">Files created by your agent during sessions will appear here.</p>
        </div>
      {:else}
        <div class="flex gap-6 {selectedFile ? '' : ''}">
          <!-- File list -->
          <div class="min-w-0 flex-1">
            {#if viewMode === "list"}
              <div class="divide-y divide-border rounded-lg border border-border bg-card">
                {#each files as file}
                  <button
                    class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                      {selectedFile?.path === file.path ? 'bg-primary/5' : ''}"
                    onclick={() => selectFile(file)}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d={fileIcon(file.path)} />
                    </svg>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-foreground">{file.path}</p>
                      <p class="text-xs text-muted-foreground">{formatSize(file.size_bytes)} &middot; {timeAgo(file.modified_at)}</p>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon" onclick={(e: MouseEvent) => { e.stopPropagation(); downloadFile(file); }}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </Button>
                      <Button variant="ghost" size="icon" onclick={(e: MouseEvent) => { e.stopPropagation(); confirmDelete(file); }}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </Button>
                    </div>
                  </button>
                {/each}
              </div>
            {:else}
              <!-- Tree view -->
              {#each fileTree as [dir, dirFiles]}
                <div class="mb-4">
                  <div class="mb-1 flex items-center gap-2 px-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span class="text-xs font-medium text-muted-foreground">{dir}</span>
                  </div>
                  <div class="divide-y divide-border rounded-lg border border-border bg-card">
                    {#each dirFiles as file}
                      <button
                        class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                          {selectedFile?.path === file.path ? 'bg-primary/5' : ''}"
                        onclick={() => selectFile(file)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d={fileIcon(file.path)} />
                        </svg>
                        <span class="min-w-0 flex-1 truncate text-sm text-foreground">{file.path.split("/").pop()}</span>
                        <span class="shrink-0 text-xs text-muted-foreground">{formatSize(file.size_bytes)}</span>
                        <div class="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="icon" onclick={(e: MouseEvent) => { e.stopPropagation(); downloadFile(file); }}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                          </Button>
                          <Button variant="ghost" size="icon" onclick={(e: MouseEvent) => { e.stopPropagation(); confirmDelete(file); }}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </Button>
                        </div>
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <!-- Preview panel -->
          {#if selectedFile}
            <div class="hidden w-96 shrink-0 overflow-hidden rounded-lg border border-border bg-card lg:block">
              <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-foreground">{selectedFile.path.split("/").pop()}</p>
                  <p class="text-xs text-muted-foreground">{formatSize(selectedFile.size_bytes)} &middot; {timeAgo(selectedFile.modified_at)}</p>
                </div>
                <Button variant="ghost" size="icon" onclick={() => (selectedFile = null)}>
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Button>
              </div>
              <div class="max-h-[calc(100vh-16rem)] overflow-auto p-4">
                {#if loadingPreview}
                  <div class="flex items-center justify-center py-12">
                    <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
                  </div>
                {:else if isImageFile(selectedFile.path) && previewContent}
                  <img src="data:{previewMime};base64,{previewContent}" alt={selectedFile.path} class="w-full rounded" />
                {:else if isTextFile(selectedFile.path) && previewContent}
                  <pre class="whitespace-pre-wrap rounded-md bg-code-background p-3 font-mono text-xs text-code-foreground">{previewContent}</pre>
                {:else}
                  <div class="py-8 text-center">
                    <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-10 w-10 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p class="mt-3 text-sm text-muted-foreground">Preview not available for this file type</p>
                    <p class="mt-1 text-xs text-muted-foreground">{selectedFile.type || fileExtension(selectedFile.path).toUpperCase() || "Unknown"}</p>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
