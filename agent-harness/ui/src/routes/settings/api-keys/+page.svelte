<script lang="ts">
  import { toast } from "svelte-sonner";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import Dialog from "$lib/components/ui/dialog.svelte";
  import {
    listApiKeys,
    createApiKey,
    deleteApiKey,
    type ApiKey,
    type ApiKeyCreateResponse,
  } from "$lib/services/settings";
  import { timeAgo } from "$lib/utils/time";

  let keys = $state<ApiKey[]>([]);
  let loading = $state(true);

  // Create dialog
  let createOpen = $state(false);
  let newKeyName = $state("");
  let creating = $state(false);

  // Result dialog — shows the full key once
  let resultOpen = $state(false);
  let createdKey = $state<ApiKeyCreateResponse | null>(null);
  let copied = $state(false);

  // Delete dialog
  let deleteOpen = $state(false);
  let deletingKey = $state<ApiKey | null>(null);
  let deleting = $state(false);

  async function load() {
    loading = true;
    try {
      keys = await listApiKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    if (!newKeyName.trim()) {
      toast.error("Please enter a name for the key");
      return;
    }
    creating = true;
    try {
      const result = await createApiKey(newKeyName.trim());
      createdKey = result;
      createOpen = false;
      newKeyName = "";
      resultOpen = true;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      creating = false;
    }
  }

  async function handleDelete() {
    if (!deletingKey) return;
    deleting = true;
    try {
      await deleteApiKey(deletingKey.id);
      toast.success(`Deleted key "${deletingKey.name}"`);
      deleteOpen = false;
      deletingKey = null;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete API key");
    } finally {
      deleting = false;
    }
  }

  function confirmDelete(key: ApiKey) {
    deletingKey = key;
    deleteOpen = true;
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      copied = true;
      toast.success("Copied to clipboard");
      setTimeout(() => (copied = false), 2000);
    } catch {
      toast.error("Failed to copy — please select and copy manually");
    }
  }

  $effect(() => {
    load();
  });
</script>

<!-- Delete confirmation -->
<Dialog
  bind:open={deleteOpen}
  title="Delete API Key"
  description={`This will permanently revoke the key "${deletingKey?.name ?? ""}". Any integrations using it will stop working.`}
  confirmText={deleting ? "Deleting..." : "Delete Key"}
  variant="destructive"
  onConfirm={handleDelete}
/>

<div class="w-full px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1>API Keys</h1>
      <p class="mt-1.5 text-sm text-muted-foreground">
        Manage API keys for programmatic access to the OneShots API.
      </p>
    </div>
    <Button onclick={() => (createOpen = true)}>
      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      Create API Key
    </Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else if keys.length === 0}
    <!-- Empty state -->
    <div class="rounded-lg border border-dashed border-border py-16 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
      </svg>
      <h3 class="mt-4 text-foreground">No API keys yet</h3>
      <p class="mt-1.5 text-sm text-muted-foreground">Create one to use the OneShots SDK.</p>
      <div class="mt-6">
        <Button onclick={() => (createOpen = true)}>Create API Key</Button>
      </div>
    </div>
  {:else}
    <Table>
      {#snippet thead()}
        <tr>
          <th class="px-4 py-3">Name</th>
          <th class="px-4 py-3">Key</th>
          <th class="px-4 py-3">Created</th>
          <th class="px-4 py-3">Last Used</th>
          <th class="px-4 py-3 text-right">Actions</th>
        </tr>
      {/snippet}
      {#snippet tbody()}
        {#each keys as key}
          <tr class="hover:bg-muted/30">
            <td class="px-4 py-3 font-medium text-foreground">{key.name}</td>
            <td class="px-4 py-3">
              <code class="rounded bg-code-background px-2 py-0.5 font-mono text-xs text-code-foreground">
                {key.prefix}
              </code>
            </td>
            <td class="px-4 py-3 text-muted-foreground">{timeAgo(key.created_at)}</td>
            <td class="px-4 py-3 text-muted-foreground">
              {key.last_used_at ? timeAgo(key.last_used_at) : "Never"}
            </td>
            <td class="px-4 py-3 text-right">
              <Button variant="ghost" size="sm" onclick={() => confirmDelete(key)}>
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

  <!-- Usage example -->
  <div class="mt-10">
    <h3 class="mb-3 text-foreground">Usage</h3>
    <div class="overflow-x-auto rounded-lg bg-code-background p-4">
      <pre class="font-mono text-sm text-code-foreground"><code>curl -H "Authorization: Bearer os_..." \
  https://api.oneshots.co/v1/agents</code></pre>
    </div>
  </div>
</div>

<!-- Create dialog -->
{#if createOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
    onclick={(e) => { if (e.target === e.currentTarget) createOpen = false; }}
    onkeydown={(e) => { if (e.key === "Escape") createOpen = false; }}
  >
    <div class="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg" role="dialog" aria-modal="true">
      <h3 class="text-lg font-semibold text-foreground">Create API Key</h3>
      <p class="mt-2 text-sm text-muted-foreground">Give your key a descriptive name so you can identify it later.</p>
      <div class="mt-4">
        <Input
          placeholder="e.g. Production SDK, CI/CD Pipeline"
          bind:value={newKeyName}
          onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") handleCreate(); }}
        />
      </div>
      <div class="mt-6 flex justify-end gap-3">
        <Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
        <Button disabled={creating || !newKeyName.trim()} onclick={handleCreate}>
          {#if creating}
            <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
          {/if}
          Create Key
        </Button>
      </div>
    </div>
  </div>
{/if}

<!-- Result dialog — show key once -->
{#if resultOpen && createdKey}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
    onclick={(e) => { if (e.target === e.currentTarget) { resultOpen = false; createdKey = null; } }}
    onkeydown={(e) => { if (e.key === "Escape") { resultOpen = false; createdKey = null; } }}
  >
    <div class="mx-4 w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg" role="dialog" aria-modal="true">
      <h3 class="text-lg font-semibold text-foreground">API Key Created</h3>
      <div class="mt-4 rounded-lg border border-chart-4/30 bg-chart-4/5 p-4">
        <div class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0 text-chart-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <p class="text-sm font-medium text-chart-4">Save this key now — you will not be able to see it again.</p>
        </div>
      </div>
      <div class="mt-4">
        <p class="mb-1.5 text-sm font-medium text-foreground">Your API Key</p>
        <div class="flex gap-2">
          <code class="flex-1 overflow-x-auto rounded-lg bg-code-background px-3 py-2.5 font-mono text-sm text-code-foreground">
            {createdKey.key}
          </code>
          <Button variant="outline" size="icon" onclick={copyKey}>
            {#if copied}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-success" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            {/if}
          </Button>
        </div>
      </div>
      <div class="mt-6 flex justify-end">
        <Button onclick={() => { resultOpen = false; createdKey = null; }}>Done</Button>
      </div>
    </div>
  </div>
{/if}
