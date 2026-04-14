<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$lib/stores/auth.svelte";
  import { agentStore } from "$lib/stores/agents.svelte";
  import { conversationStore } from "$lib/stores/conversations.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import { untrack } from "svelte";
  import { Toaster } from "svelte-sonner";

  let { children } = $props();

  let sidebarOpen = $state(false);
  let sidebarCollapsed = $state(false);
  // Theme persists in localStorage. Default to dark when no preference
  // exists, but respect a previously-chosen value across reloads.
  // Reading happens lazily inside an onMount in the existing init effect
  // so SSR doesn't crash on `localStorage`.
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

  // Load persisted theme preference once on the client. Default to dark
  // (the previous hardcoded behaviour) when nothing is stored.
  $effect(() => {
    if (typeof localStorage === "undefined") return;
    const stored = localStorage.getItem("oneshots_theme");
    if (stored === "light") isDark = false;
    else if (stored === "dark") isDark = true;
    // First-time visitors keep the existing default (dark)
  });

  // Run auth init ONCE on mount. Use untrack to prevent reactive cascades.
  let authInitDone = false;
  $effect(() => {
    if (authInitDone) return;
    authInitDone = true;
    untrack(() => {
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
  });

  $effect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDark);
    }
    // Persist theme so it survives reloads. Skipped on SSR.
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("oneshots_theme", isDark ? "dark" : "light");
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
        <div class="flex h-14 items-center px-2.5">
          <a href="/" class="flex items-center gap-2.5" onclick={() => (sidebarOpen = false)}>
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-sm font-bold text-foreground">
              0
            </span>
            {#if !sidebarCollapsed}
              <span class="text-sm font-semibold tracking-tight text-sidebar-foreground">021agents</span>
            {/if}
          </a>
        </div>

        <!-- Navigation -->
        <nav class="flex-1 overflow-y-auto p-2 space-y-1">

          <!-- ═══ PERSONAL AGENT — always first, prominent ═══ -->
          <a
            href="/chat/default"
            class="flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-semibold transition-colors
              {$page.url?.pathname?.startsWith('/chat/default') ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}"
            class:justify-center={sidebarCollapsed}
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Personal Agent" : undefined}
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 text-primary text-sm">
              ✦
            </span>
            {#if !sidebarCollapsed}
              <div class="flex-1 min-w-0">
                <div class="truncate">Personal Agent</div>
                <div class="text-[10px] text-muted-foreground font-normal">Chat, code, research, create agents</div>
              </div>
            {/if}
          </a>

          <div class="my-2 border-t border-border/50"></div>

          <!-- ═══ YOUR AGENTS — business agents you created ═══ -->
          {#if !sidebarCollapsed}
            <p class="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Your Agents
            </p>
          {/if}

          {#each agentStore.agents.filter(a => a.name !== 'default') as agent, i}
            {@const colors = ['bg-blue-500/15 text-blue-400', 'bg-emerald-500/15 text-emerald-400', 'bg-amber-500/15 text-amber-400', 'bg-purple-500/15 text-purple-400', 'bg-rose-500/15 text-rose-400', 'bg-cyan-500/15 text-cyan-400']}
            {@const color = colors[i % colors.length]}
            {@const isActive = $page.url?.pathname === `/chat/${agent.name}` || $page.url?.pathname?.startsWith(`/agent/${agent.name}`)}
            <a
              href="/chat/{agent.name}"
              class="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors
                {isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}"
              class:justify-center={sidebarCollapsed}
              onclick={() => (sidebarOpen = false)}
              title={sidebarCollapsed ? agent.display_name || agent.name : undefined}
            >
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold {color}">
                {(agent.display_name || agent.name).charAt(0).toUpperCase()}
              </span>
              {#if !sidebarCollapsed}
                <span class="flex-1 truncate text-[13px]">{agent.display_name || agent.name}</span>
                <span class="h-1.5 w-1.5 shrink-0 rounded-full {agent.is_active ? 'bg-green-500' : 'bg-muted-foreground/30'}"></span>
              {/if}
            </a>
            <!-- Agent sub-pages (shown when active) -->
            {#if isActive && !sidebarCollapsed}
              <div class="ml-8 space-y-0.5 border-l border-border/30 pl-2">
                {#each [
                  { href: `/agent/${agent.name}/settings`, label: "Settings" },
                  { href: `/agent/${agent.name}/tests`, label: "Tests" },
                  { href: `/agent/${agent.name}/activity`, label: "Activity" },
                  { href: `/agent/${agent.name}/channels`, label: "Channels" },
                ] as sub}
                  <a
                    href={sub.href}
                    class="block rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors
                      {$page.url?.pathname === sub.href ? 'text-foreground bg-muted/50' : ''}"
                    onclick={() => (sidebarOpen = false)}
                  >{sub.label}</a>
                {/each}
              </div>
            {/if}
          {/each}

          {#if agentStore.agents.filter(a => a.name !== 'default').length === 0 && !sidebarCollapsed}
            <p class="px-3 py-2 text-[11px] text-muted-foreground/50 italic">No agents yet. Ask your Personal Agent to create one.</p>
          {/if}

          <a
            href="/agent/new"
            class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-foreground"
            class:justify-center={sidebarCollapsed}
            onclick={() => (sidebarOpen = false)}
            title={sidebarCollapsed ? "Create Agent" : undefined}
          >
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-border/50 text-[10px]">+</span>
            {#if !sidebarCollapsed}<span>Create Agent</span>{/if}
          </a>

          <div class="my-2 border-t border-border/50"></div>

          <!-- ═══ DISCOVER — marketplace + connectors ═══ -->
          {#if !sidebarCollapsed}
            <p class="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Discover
            </p>
          {/if}

          {#each [
            { href: "/marketplace", icon: "🏪", label: "Marketplace" },
            { href: "/connectors", icon: "🔗", label: "Connectors" },
            { href: "/sessions", icon: "📊", label: "Activity" },
          ] as link}
            <a
              href={link.href}
              class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              class:justify-center={sidebarCollapsed}
              onclick={() => (sidebarOpen = false)}
              title={sidebarCollapsed ? link.label : undefined}
            >
              {#if sidebarCollapsed}
                <span class="text-sm">{link.icon}</span>
              {:else}
                <span class="text-sm">{link.icon}</span>
                <span>{link.label}</span>
              {/if}
            </a>
          {/each}
        </nav>

        <!-- Bottom: Settings + Billing (compact) -->
        <div class="p-2 space-y-0.5 border-t border-border/30">
          {#each [
            { href: "/settings/account", icon: "⚙️", label: "Settings" },
            { href: "/settings/secrets", icon: "🔐", label: "Secrets" },
            { href: "/settings/billing", icon: "💳", label: "Billing" },
            { href: "/settings/api-keys", icon: "🔑", label: "API Keys" },
          ] as link}
            <a
              href={link.href}
              class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              class:justify-center={sidebarCollapsed}
              onclick={() => (sidebarOpen = false)}
              title={sidebarCollapsed ? link.label : undefined}
            >
              {#if sidebarCollapsed}
                <span class="text-sm">{link.icon}</span>
              {:else}
                <span class="text-sm">{link.icon}</span>
                <span>{link.label}</span>
              {/if}
            </a>
          {/each}
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
