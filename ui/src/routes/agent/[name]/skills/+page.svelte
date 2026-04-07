<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Switch from "$lib/components/ui/switch.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";
  import { listSkills, toggleSkill, type Skill } from "$lib/services/settings";

  let agentName = $derived($page.params.name ?? "");

  let skills = $state<Skill[]>([]);
  let loading = $state(true);
  let expandedSkill = $state<string | null>(null);

  const BUILTIN_NAMES = new Set([
    "batch", "review", "debug", "verify", "remember", "skillify", "schedule",
    "docs", "research", "report", "design", "chart", "pdf", "spreadsheet",
    "analyze", "website", "game", "docx", "pptx",
  ]);

  const CATEGORY_ORDER = [
    "research", "design", "office", "data", "visualization", "development",
    "orchestration", "diagnostics", "testing", "memory", "meta", "reference",
    "automation", "code-quality", "general",
  ];

  let builtinSkills = $derived(skills.filter((s) => BUILTIN_NAMES.has(s.name)));
  let customSkills = $derived(skills.filter((s) => !BUILTIN_NAMES.has(s.name)));

  let groupedBuiltin = $derived.by(() => {
    const groups = new Map<string, Skill[]>();
    for (const s of builtinSkills) {
      const cat = s.category || "general";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(s);
    }
    return CATEGORY_ORDER
      .filter((c) => groups.has(c))
      .map((c) => ({ category: c, skills: groups.get(c)! }));
  });

  const categoryColors: Record<string, string> = {
    research: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    design: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    office: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    data: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    visualization: "bg-chart-1/15 text-chart-1",
    development: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    orchestration: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    diagnostics: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    testing: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    memory: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    meta: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
    reference: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    automation: "bg-lime-500/15 text-lime-600 dark:text-lime-400",
    "code-quality": "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
    general: "bg-muted text-muted-foreground",
  };

  async function load() {
    loading = true;
    try {
      skills = await listSkills();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      loading = false;
    }
  }

  async function handleToggle(skill: Skill) {
    const newState = !skill.enabled;
    try {
      await toggleSkill(skill.name, newState);
      skill.enabled = newState;
      skills = [...skills];
      toast.success(`${skill.name} ${newState ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update skill");
    }
  }

  function toggleExpand(name: string) {
    expandedSkill = expandedSkill === name ? null : name;
  }

  $effect(() => {
    load();
  });
</script>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8">
      <div class="mb-8">
        <h1>Skills</h1>
        <p class="mt-1.5 text-sm text-muted-foreground">
          {skills.filter((s) => s.enabled).length} of {skills.length} skills enabled
        </p>
      </div>

      {#if loading}
        <div class="flex items-center justify-center py-24">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else}
        <!-- Built-in Skills -->
        <section class="mb-10">
          <h2 class="mb-4">Built-in Skills</h2>
          {#if builtinSkills.length === 0}
            <p class="text-sm text-muted-foreground">No built-in skills loaded.</p>
          {:else}
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {#each builtinSkills as skill}
                <div class="flex flex-col rounded-lg border border-border bg-card transition-colors hover:border-foreground/20">
                  <button
                    class="flex flex-1 flex-col p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onclick={() => toggleExpand(skill.name)}
                  >
                    <div class="flex w-full items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <p class="font-mono text-sm font-semibold text-foreground">/{skill.name}</p>
                        <p class="mt-1 text-xs text-muted-foreground line-clamp-2">{skill.description}</p>
                      </div>
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div onclick={(e: MouseEvent) => { e.stopPropagation(); handleToggle(skill); }}>
                        <Switch checked={skill.enabled} label="Toggle {skill.name}" />
                      </div>
                    </div>
                    <div class="mt-3 flex flex-wrap gap-1.5">
                      <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold {categoryColors[skill.category] ?? categoryColors.general}">
                        {skill.category}
                      </span>
                      {#if skill.allowed_tools.length > 0}
                        <span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {skill.allowed_tools.length} tool{skill.allowed_tools.length !== 1 ? "s" : ""}
                        </span>
                      {/if}
                    </div>
                  </button>

                  {#if expandedSkill === skill.name && skill.prompt_template}
                    <div class="border-t border-border p-4">
                      <p class="mb-2 text-xs font-medium text-muted-foreground">Prompt Template</p>
                      <div class="max-h-64 overflow-auto rounded-md bg-code-background p-3">
                        <pre class="whitespace-pre-wrap font-mono text-xs text-code-foreground">{skill.prompt_template.slice(0, 2000)}{skill.prompt_template.length > 2000 ? "\n\n... (truncated)" : ""}</pre>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <!-- Custom Skills -->
        <section>
          <h2 class="mb-4">Custom Skills</h2>
          {#if customSkills.length === 0}
            <div class="rounded-lg border border-dashed border-border py-16 text-center">
              <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
              <h3 class="mt-4 text-foreground">No custom skills</h3>
              <p class="mt-1.5 text-sm text-muted-foreground">Use the meta-agent to create one, or invoke <code class="font-mono text-xs">/skillify</code> in chat.</p>
            </div>
          {:else}
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {#each customSkills as skill}
                <div class="flex flex-col rounded-lg border border-border bg-card transition-colors hover:border-foreground/20">
                  <button
                    class="flex flex-1 flex-col p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onclick={() => toggleExpand(skill.name)}
                  >
                    <div class="flex w-full items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <p class="font-mono text-sm font-semibold text-foreground">/{skill.name}</p>
                        <p class="mt-1 text-xs text-muted-foreground line-clamp-2">{skill.description}</p>
                      </div>
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div onclick={(e: MouseEvent) => { e.stopPropagation(); handleToggle(skill); }}>
                        <Switch checked={skill.enabled} label="Toggle {skill.name}" />
                      </div>
                    </div>
                    <div class="mt-3 flex flex-wrap gap-1.5">
                      <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold {categoryColors[skill.category] ?? categoryColors.general}">
                        {skill.category}
                      </span>
                      {#if skill.allowed_tools.length > 0}
                        <span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {skill.allowed_tools.length} tool{skill.allowed_tools.length !== 1 ? "s" : ""}
                        </span>
                      {/if}
                    </div>
                  </button>

                  {#if expandedSkill === skill.name && skill.prompt_template}
                    <div class="border-t border-border p-4">
                      <p class="mb-2 text-xs font-medium text-muted-foreground">Prompt Template</p>
                      <div class="max-h-64 overflow-auto rounded-md bg-code-background p-3">
                        <pre class="whitespace-pre-wrap font-mono text-xs text-code-foreground">{skill.prompt_template.slice(0, 2000)}{skill.prompt_template.length > 2000 ? "\n\n... (truncated)" : ""}</pre>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    </div>
  </div>
</div>
