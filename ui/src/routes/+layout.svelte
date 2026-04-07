<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$lib/stores/auth.svelte";
  import { agentStore } from "$lib/stores/agents.svelte";
  import { conversationStore } from "$lib/stores/conversations.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import { Toaster } from "svelte-sonner";

  let { children } = $props();

  let sidebarOpen = $state(false);
  let sidebarCollapsed = $state(false);
  let isDark = $state(true);
  let connectionError = $state(false);

  // Detect current agent from URL for sidebar conversation list
  let currentAgent = $derived((() => {
    const path = $page.url?.pathname || "";
    const match = path.match(/^\/chat\/([^/]+)/);
    return match ? match[1] : "";
  })());

  // Fetch conversations when viewing an agent chat page
  $effect(() => {
    if (currentAgent && authStore.isAuthenticated) {
      conversationStore.fetchConversations(currentAgent);
    }
  });

  // Group conversations by time
  function groupConversations(convs: typeof conversationStore.conversations) {
    const now = Date.now();
    const dayMs = 86400_000;
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const yesterdayStart = todayStart - dayMs;
    const weekStart = todayStart - 7 * dayMs;

    const groups: { label: string; items: typeof convs }[] = [];
    const today: typeof convs = [];
    const yesterday: typeof convs = [];
    const week: typeof convs = [];
    const older: typeof convs = [];

    for (const c of convs) {
      const t = new Date(c.updated_at).getTime();
      if (t >= todayStart) today.push(c);
      else if (t >= yesterdayStart) yesterday.push(c);
      else if (t >= weekStart) week.push(c);
      else older.push(c);
    }

    if (today.length) groups.push({ label: "Today", items: today });
    if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
    if (week.length) groups.push({ label: "Previous 7 Days", items: week });
    if (older.length) groups.push({ label: "Older", items: older });
    return groups;
  }

  let conversationGroups = $derived(groupConversations(conversationStore.conversations));

  $effect(() => {
    authStore.init().then(() => {
      if (!authStore.loading && !authStore.isAuthenticated) {
        const path = window.location.pathname;
        if (path !== "/login") goto("/login");
      }
      if (authStore.isAuthenticated) {
        agentStore.fetchAgents();
      }
    }).catch(() => {
      connectionError = true;
      authStore.loading = false;
    });
  });

  // Re-fetch agents when auth state changes (e.g., after login redirect)
  $effect(() => {
    if (authStore.isAuthenticated && agentStore.agents.length === 0 && !agentStore.loading) {
      agentStore.fetchAgents();
    }
  });

  $effect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDark);
    }
  });
</script>

<Toaster richColors position="top-right" />

{#if connectionError}
  <div class="flex h-dvh flex-col items-center justify-center gap-4 bg-background">
    <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
    <h2 class="text-lg font-semibold text-foreground">Connection Error</h2>
    <p class="text-sm text-muted-foreground">Unable to connect to the server. Please try again.</p>
    <Button onclick={() => window.location.reload()}>Retry</Button>
  </div>
{:else if authStore.loading}
  <div class="flex h-dvh items-center justify-center bg-background">
    <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
  </div>
{:else}
  <!-- Mobile overlay -->
  {#if sidebarOpen}
    <button
      class="fixed inset-0 z-40 bg-black/50 lg:hidden"
      onclick={() => (sidebarOpen = false)}
      aria-label="Close sidebar"
    ></button>
  {/if}

  <div class="flex h-dvh overflow-hidden bg-background">
    <!-- Sidebar -->
    {#if authStore.isAuthenticated}
      <aside
        class="fixed inset-y-0 left-0 z-50 flex flex-col bg-sidebar shadow-[1px_0_3px_0_rgba(0,0,0,0.08)] transition-all duration-200 lg:static lg:translate-x-0
          {sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          {sidebarCollapsed ? 'w-16' : 'w-60'}"
      >
        <!-- Logo -->
        <div class="flex h-14 items-center gap-2 px-4">
          {#if !sidebarCollapsed}
            <span class="text-lg font-semibold tracking-tight text-sidebar-foreground">OneShots</span>
          {:else}
            <span class="mx-auto text-lg font-bold text-sidebar-foreground">O</span>
          {/if}
        </div>

        <!-- Navigation -->
        <nav class="flex-1 overflow-y-auto p-2">
          <!-- Dashboard link -->
          <a
            href="/"
            class="mb-2 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Dashboard" : undefined}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
            </svg>
            {#if !sidebarCollapsed}
              <span>Dashboard</span>
            {/if}
          </a>

          <!-- Agent list -->
          {#if !sidebarCollapsed}
            <p class="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Agents
            </p>
          {/if}
          {#each agentStore.agents as agent}
            <a
              href="/chat/{agent.name}"
              class="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onclick={() => (sidebarOpen = false)}
              title={sidebarCollapsed ? agent.name : undefined}
            >
              <span class="h-2 w-2 shrink-0 rounded-full {agent.is_active ? 'bg-success' : 'bg-muted-foreground/40'}"></span>
              {#if !sidebarCollapsed}
                <span class="truncate">{agent.name}</span>
                <!-- Plan badges hidden for MVP -->
              {/if}
            </a>
          {/each}

          <a
            href="/"
            class="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onclick={() => (sidebarOpen = false)}
          >
            {#if sidebarCollapsed}
              <span class="mx-auto">+</span>
            {:else}
              <span>+</span>
              <span>New Agent</span>
            {/if}
          </a>

          <!-- Conversation history for current agent -->
          {#if currentAgent && !sidebarCollapsed && conversationGroups.length > 0}
            <div class="mt-4 border-t border-border pt-3">
              <p class="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                Conversations
              </p>
              {#each conversationGroups as group}
                <p class="mt-2 px-2 text-[10px] font-medium text-muted-foreground/60">
                  {group.label}
                </p>
                {#each group.items as conv}
                  <a
                    href="/chat/{currentAgent}?c={conv.id}"
                    class="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground
                      {conversationStore.activeConversationId === conv.id ? 'bg-sidebar-accent/50 text-sidebar-accent-foreground' : ''}"
                    onclick={() => (sidebarOpen = false)}
                    title={conv.title}
                  >
                    <span class="truncate">{conv.title}</span>
                  </a>
                {/each}
              {/each}
            </div>
          {/if}
        </nav>

        <!-- Platform links -->
        <div class="p-2 space-y-0.5">
          {#if !sidebarCollapsed}
            <p class="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Platform
            </p>
          {/if}
          <a
            href="/sessions"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Sessions" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Sessions</span>
            {/if}
          </a>
          <a
            href="/evals"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Evals" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Evals</span>
            {/if}
          </a>
          <a
            href="/marketplace"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Marketplace" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
              </svg>
              <span>Marketplace</span>
            {/if}
          </a>
          <a
            href="/observability"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Observability" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span>Observability</span>
            {/if}
          </a>
        </div>

        <!-- Settings links -->
        <div class="p-2 space-y-0.5">
          {#if !sidebarCollapsed}
            <p class="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Settings
            </p>
          {/if}
          <a
            href="/settings/account"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Account" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span>Account</span>
            {/if}
          </a>
          <a
            href="/settings/api-keys"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "API Keys" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <span>API Keys</span>
            {/if}
          </a>
          <a
            href="/settings/billing"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Billing" : undefined}
          >
            {#if sidebarCollapsed}
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              <span>Billing</span>
            {/if}
          </a>
        </div>

        <!-- Bottom controls -->
        <div class="p-2 space-y-1">
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent"
            onclick={() => (isDark = !isDark)}
          >
            {#if sidebarCollapsed}
              <span class="mx-auto">{isDark ? "☀" : "☾"}</span>
            {:else}
              <span>{isDark ? "☀" : "☾"}</span>
              <span>{isDark ? "Light" : "Dark"}</span>
            {/if}
          </button>
          <button
            class="hidden w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent lg:flex"
            onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
          >
            {#if sidebarCollapsed}
              <span class="mx-auto">→</span>
            {:else}
              <span>←</span>
              <span>Collapse</span>
            {/if}
          </button>
          {#if !sidebarCollapsed}
            <div class="flex items-center justify-between px-2.5 py-1">
              <span class="truncate text-xs text-muted-foreground">
                {authStore.user?.email ?? ""}
              </span>
              <Button variant="ghost" size="sm" onclick={() => authStore.logout()}>
                Logout
              </Button>
            </div>
          {/if}
        </div>
      </aside>
    {/if}

    <!-- Main content -->
    <main class="flex flex-1 flex-col overflow-hidden">
      {#if authStore.isAuthenticated}
        <!-- Mobile header -->
        <div class="flex h-14 items-center gap-3 bg-background px-4 shadow-sm lg:hidden">
          <button
            class="p-1 text-muted-foreground hover:text-foreground"
            onclick={() => (sidebarOpen = !sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span class="text-base font-semibold tracking-tight">OneShots</span>
        </div>
      {/if}

      <div class="flex-1 overflow-auto">
        {@render children()}
      </div>
    </main>
  </div>
{/if}
