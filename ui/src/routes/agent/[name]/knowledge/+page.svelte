<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import Dialog from "$lib/components/ui/dialog.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";
  import {
    listDocuments,
    uploadDocument,
    deleteDocument,
    type RagDocument,
  } from "$lib/services/settings";
  import { timeAgo } from "$lib/utils/time";

  let agentName = $derived($page.params.name ?? "");

  let documents = $state<RagDocument[]>([]);
  let loading = $state(true);
  let uploading = $state(false);
  let searchQuery = $state("");
  let dragOver = $state(false);

  // Delete
  let deleteOpen = $state(false);
  let deletingDoc = $state<RagDocument | null>(null);
  let deleting = $state(false);

  let fileInput: HTMLInputElement;

  const ACCEPTED = ".pdf,.txt,.md,.csv,.json,.doc,.docx";

  let filteredDocs = $derived(
    searchQuery.trim()
      ? documents.filter((d) => d.filename.toLowerCase().includes(searchQuery.toLowerCase()))
      : documents
  );

  let totalChunks = $derived(documents.reduce((sum, d) => sum + d.chunk_count, 0));

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusVariant(status: RagDocument["status"]): "default" | "secondary" | "destructive" {
    if (status === "ready") return "default";
    if (status === "processing") return "secondary";
    return "destructive";
  }

  async function load() {
    loading = true;
    try {
      documents = await listDocuments(agentName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      loading = false;
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    uploading = true;
    let successCount = 0;
    let failCount = 0;

    for (const file of Array.from(files)) {
      try {
        await uploadDocument(agentName, file);
        successCount++;
      } catch (err) {
        failCount++;
        toast.error(`Failed to upload ${file.name}: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }

    if (successCount > 0) {
      toast.success(`Uploaded ${successCount} file${successCount !== 1 ? "s" : ""}`);
      await load();
    }
    uploading = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer?.files ?? null);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function confirmDelete(doc: RagDocument) {
    deletingDoc = doc;
    deleteOpen = true;
  }

  async function handleDelete() {
    if (!deletingDoc) return;
    deleting = true;
    try {
      await deleteDocument(agentName, deletingDoc.filename || deletingDoc.id);
      toast.success(`Deleted "${deletingDoc.filename}"`);
      deleteOpen = false;
      deletingDoc = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete document");
    } finally {
      deleting = false;
    }
  }

  $effect(() => {
    if (agentName) load();
  });
</script>

<Dialog
  bind:open={deleteOpen}
  title="Delete Document"
  description={`This will permanently delete "${deletingDoc?.filename ?? ""}" and all its chunks. This cannot be undone.`}
  confirmText={deleting ? "Deleting..." : "Delete Document"}
  variant="destructive"
  onConfirm={handleDelete}
/>

<input
  bind:this={fileInput}
  type="file"
  accept={ACCEPTED}
  multiple
  class="hidden"
  onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
/>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="w-full px-6 py-8 lg:px-8">
      <!-- Header -->
      <div class="mb-8">
        <h1>Knowledge Base</h1>
        <p class="mt-1.5 text-sm text-muted-foreground">
          {documents.length} document{documents.length !== 1 ? "s" : ""} &middot; {totalChunks} chunk{totalChunks !== 1 ? "s" : ""}
        </p>
      </div>

      <!-- Upload zone -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="mb-8 rounded-lg border-2 border-dashed p-8 text-center transition-colors
          {dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-foreground/20'}"
        ondrop={handleDrop}
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
      >
        {#if uploading}
          <div class="flex items-center justify-center gap-3">
            <div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
            <span class="text-sm text-muted-foreground">Uploading...</span>
          </div>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-10 w-10 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p class="mt-3 text-sm text-foreground">
            Drag and drop files here, or
            <button class="font-medium text-primary underline-offset-4 hover:underline" onclick={() => fileInput.click()}>browse files</button>
          </p>
          <p class="mt-1.5 text-xs text-muted-foreground">
            PDF, TXT, Markdown, CSV, JSON, DOC, DOCX
          </p>
        {/if}
      </div>

      {#if loading}
        <div class="flex items-center justify-center py-16">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else if documents.length === 0}
        <div class="rounded-lg border border-dashed border-border py-16 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <h3 class="mt-4 text-foreground">No documents yet</h3>
          <p class="mt-1.5 text-sm text-muted-foreground">Upload files to give your agent domain knowledge.</p>
        </div>
      {:else}
        <!-- Search -->
        <div class="mb-4">
          <Input placeholder="Search documents..." bind:value={searchQuery} class="max-w-sm" />
        </div>

        <Table>
          {#snippet thead()}
            <tr>
              <th class="px-4 py-3">Filename</th>
              <th class="px-4 py-3">Size</th>
              <th class="px-4 py-3">Chunks</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3">Uploaded</th>
              <th class="px-4 py-3 text-right">Actions</th>
            </tr>
          {/snippet}
          {#snippet tbody()}
            {#each filteredDocs as doc}
              <tr class="hover:bg-muted/30">
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span class="font-medium text-foreground">{doc.filename}</span>
                  </div>
                </td>
                <td class="px-4 py-3 text-muted-foreground">{formatSize(doc.size_bytes)}</td>
                <td class="px-4 py-3 text-muted-foreground">{doc.chunk_count}</td>
                <td class="px-4 py-3">
                  <Badge variant={statusVariant(doc.status)}>{doc.status}</Badge>
                </td>
                <td class="px-4 py-3 text-muted-foreground">{timeAgo(doc.created_at)}</td>
                <td class="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onclick={() => confirmDelete(doc)}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </Button>
                </td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      {/if}
    </div>
  </div>
</div>
