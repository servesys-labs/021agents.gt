<script lang="ts">
  import { goto } from "$app/navigation";
  import { api } from "$lib/services/api";
  import { agentStore } from "$lib/stores/agents.svelte";
  import { toast } from "svelte-sonner";
  import Button from "$lib/components/ui/button.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";

  import { listSkills, type Skill } from "$lib/services/settings";

  type Mode = "describe" | "template";
  let mode = $state<Mode>("describe");

  // Templates
  let templates = $state<Skill[]>([]);
  let templatesLoading = $state(false);
  let selectedTemplate = $state<Skill | null>(null);

  async function loadTemplates() {
    templatesLoading = true;
    try {
      const skills = await listSkills();
      templates = skills.filter(s => s.category === "template");
    } catch { templates = []; }
    finally { templatesLoading = false; }
  }

  async function handleTemplateCreate() {
    if (!selectedTemplate) { toast.error("Select a template first."); return; }
    quickLoading = true;
    try {
      const config = JSON.parse(selectedTemplate.prompt_template || "{}");
      const suffix = Math.random().toString(16).slice(2, 5);
      const name = `${selectedTemplate.name.replace("template-", "")}-${suffix}`;
      await api.post("/agents", {
        name,
        description: config.description || selectedTemplate.description,
        system_prompt: config.system_prompt || "",
        plan: config.plan || quickPlan,
        tools: config.tools || [],
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        reasoning_strategy: config.reasoning_strategy,
        max_turns: config.max_turns,
        budget_limit_usd: config.budget_limit_usd,
        timeout_seconds: config.timeout_seconds,
      });
      toast.success(`Agent "${name}" created from template!`);
      await agentStore.fetchAgents();
      goto(`/chat/${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create from template");
    } finally { quickLoading = false; }
  }

  // Quick mode state
  let quickName = $state("");
  let quickDescription = $state("");
  let quickPlan = $state("free");
  let quickLoading = $state(false);
  let progressStep = $state(0);
  let progressTimer = $state<ReturnType<typeof setInterval> | null>(null);

  const PROGRESS_STEPS = [
    { label: "Analyzing your description", detail: "Understanding intent, domain, and requirements" },
    { label: "Designing system prompt", detail: "Crafting detailed instructions and persona" },
    { label: "Selecting tools", detail: "Matching capabilities to your use case" },
    { label: "Configuring governance", detail: "Setting budget limits and safety guardrails" },
    { label: "Building agent package", detail: "Assembling sub-agents, skills, and integrations" },
    { label: "Running quality checks", detail: "Validating configuration and eval criteria" },
    { label: "Finalizing", detail: "Saving agent and preparing workspace" },
  ];

  function startProgress() {
    progressStep = 0;
    progressTimer = setInterval(() => {
      if (progressStep < PROGRESS_STEPS.length - 1) progressStep++;
    }, 8000); // advance every 8s — total ~56s before cycling through all
  }

  function stopProgress() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
  }

  const plans = [
    { id: "free", label: "Free", description: "Gemma 4 on edge — zero cost", color: "bg-muted text-muted-foreground border-border" },
    { id: "basic", label: "Basic", description: "DeepSeek V3.2 — near-free", color: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30" },
    { id: "standard", label: "Standard", description: "Claude Sonnet 4.6 — best value", color: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30" },
    { id: "premium", label: "Premium", description: "Claude Opus 4.6 — top quality", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  ];

  const personalityOptions = [
    { value: "professional", label: "Professional" },
    { value: "friendly", label: "Friendly" },
    { value: "technical", label: "Technical" },
    { value: "creative", label: "Creative" },
  ];

  const responseLengthOptions = [
    { value: "concise", label: "Concise" },
    { value: "balanced", label: "Balanced" },
    { value: "detailed", label: "Detailed" },
  ];

  const availableTools = [
    { id: "web-search", name: "Web Search", description: "Search the web for current information" },
    { id: "browse", name: "Browse", description: "Navigate and read web pages" },
    { id: "python-exec", name: "Python", description: "Execute Python code in a sandbox" },
    { id: "bash", name: "Bash", description: "Run shell commands securely" },
    { id: "read-file", name: "Read File", description: "Read files from the workspace" },
    { id: "write-file", name: "Write File", description: "Create or overwrite files" },
    { id: "edit-file", name: "Edit File", description: "Make targeted edits to files" },
    { id: "memory-save", name: "Memory Save", description: "Persist information across sessions" },
    { id: "memory-recall", name: "Memory Recall", description: "Retrieve previously saved memories" },
    { id: "knowledge-search", name: "Knowledge Search", description: "Search uploaded knowledge base" },
    { id: "image-generate", name: "Image Generate", description: "Create images from text descriptions" },
    { id: "http-request", name: "HTTP Request", description: "Make arbitrary HTTP API calls" },
  ];

  const toolIcons: Record<string, string> = {
    "web-search": "M21 21l-5.2-5.2M17 10a7 7 0 11-14 0 7 7 0 0114 0z",
    "browse": "M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    "python-exec": "M17 8V5a2 2 0 00-2-2H9a2 2 0 00-2 2v3m10 0H7m10 0l1 12H6L7 8m3 4v4m4-4v4",
    "bash": "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
    "read-file": "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
    "write-file": "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    "edit-file": "M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z",
    "memory-save": "M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4",
    "memory-recall": "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4-4m0 0L8 12m4-4v12",
    "knowledge-search": "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
    "image-generate": "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z",
    "http-request": "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1",
  };

  let selectedTools = $state<string[]>([]);

  function toggleTool(id: string) {
    if (selectedTools.includes(id)) {
      selectedTools = selectedTools.filter((t) => t !== id);
    } else {
      selectedTools = [...selectedTools, id];
    }
  }

  async function handleQuickCreate() {
    if (!quickDescription.trim()) {
      toast.error("Please describe what your agent should do.");
      return;
    }
    quickLoading = true;
    startProgress();
    try {
      // Use explicit name or generate from description
      const rawName = quickName.trim() || quickDescription.trim().split(/\s+/).slice(0, 3).join("-");
      const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").slice(0, 40) || "my-agent";

      // Create agent via LLM-powered create-from-description endpoint
      // This does query enrichment: expands vague descriptions into detailed configs,
      // generates a proper system prompt, selects appropriate tools, fixes spelling, etc.
      const res = await api.post<{ name: string }>("/agents/create-from-description", {
        description: quickDescription.trim(),
        name,
        plan: quickPlan,
        tools: "auto",
      });
      const agentName = res.name || name;
      await agentStore.fetchAgents();

      // Redirect to chat with setup flag — meta-agent will refine further
      const setupMsg = encodeURIComponent(quickDescription.trim());
      goto(`/chat/${agentName}?setup=${setupMsg}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      stopProgress();
      quickLoading = false;
    }
  }

</script>

<div class="w-full px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8">
    <h1>Create Agent</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Build a new AI agent from a description or configure every detail.
    </p>
  </div>

  <!-- Mode toggle -->
  <div class="mb-8 flex gap-1 rounded-lg bg-muted p-1">
    <button
      class="flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors {mode === 'describe' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => (mode = "describe")}
    >
      Describe
    </button>
    <button
      class="flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors {mode === 'template' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => { mode = "template"; loadTemplates(); }}
    >
      From Template
    </button>
  </div>

  {#if mode === "describe"}
    <!-- Quick Mode -->
    <div class="space-y-6">
      <div>
        <label for="agent-name" class="mb-2 block text-sm font-medium text-foreground">
          Agent Name
        </label>
        <input
          id="agent-name"
          type="text"
          placeholder="e.g. job-hunter, support-bot, research-agent"
          bind:value={quickName}
          class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <p class="mt-1 text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens. Leave blank to auto-generate.</p>
      </div>
      <div>
        <label for="quick-desc" class="mb-2 block text-sm font-medium text-foreground">
          Describe what your agent should do
        </label>
        <Textarea
          id="quick-desc"
          rows={6}
          placeholder="A customer support agent that answers billing questions, can look up account info, and escalates complex issues to a human"
          bind:value={quickDescription}
          class="resize-none"
        />
      </div>

      <!-- Plan selector hidden for MVP -->

      {#if quickLoading}
        <!-- Progress indicator -->
        <div class="rounded-xl border border-border bg-card p-6">
          <div class="space-y-4">
            {#each PROGRESS_STEPS as step, i}
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full {i < progressStep ? 'bg-primary' : i === progressStep ? 'bg-primary animate-pulse' : 'bg-muted'}">
                  {#if i < progressStep}
                    <svg class="h-3 w-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  {:else if i === progressStep}
                    <span class="h-2 w-2 rounded-full bg-primary-foreground"></span>
                  {/if}
                </div>
                <div>
                  <p class="text-sm font-medium {i <= progressStep ? 'text-foreground' : 'text-muted-foreground'}">{step.label}</p>
                  {#if i === progressStep}
                    <p class="text-xs text-muted-foreground">{step.detail}</p>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
          <p class="mt-5 text-xs text-muted-foreground">This takes about a minute — the AI is designing a detailed agent configuration.</p>
        </div>
      {:else}
        <Button
          class="w-full sm:w-auto"
          disabled={!quickDescription.trim()}
          onclick={handleQuickCreate}
        >
          Create Agent
        </Button>
      {/if}
    </div>
  {:else if mode === "template"}
    <!-- Template Mode -->
    <div class="space-y-6">
      {#if templatesLoading}
        <div class="flex items-center justify-center py-16">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else if templates.length === 0}
        <div class="rounded-lg bg-muted/50 py-16 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <p class="text-sm text-muted-foreground">No templates yet.</p>
          <p class="mt-1 text-xs text-muted-foreground">Save an agent as a template from its Settings page.</p>
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">Choose a template to create a pre-configured agent.</p>
        <div class="grid gap-3 sm:grid-cols-2">
          {#each templates as tmpl}
            <button
              class="flex flex-col items-start rounded-xl p-5 text-left transition-all
                {selectedTemplate?.name === tmpl.name ? 'bg-primary/10 ring-2 ring-primary' : 'bg-card shadow-sm hover:shadow-md'}"
              onclick={() => (selectedTemplate = tmpl)}
            >
              <span class="text-sm font-medium text-foreground">{tmpl.name.replace("template-", "")}</span>
              <span class="mt-1 line-clamp-2 text-xs text-muted-foreground">{tmpl.description}</span>
            </button>
          {/each}
        </div>

        {#if selectedTemplate}
          <div class="rounded-lg bg-muted/50 p-4">
            <p class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Template config</p>
            <pre class="max-h-48 overflow-auto rounded bg-code-background p-3 font-mono text-xs text-code-foreground">{selectedTemplate.prompt_template}</pre>
          </div>
        {/if}

        <Button disabled={!selectedTemplate || quickLoading} onclick={handleTemplateCreate}>
          {#if quickLoading}
            <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
          {/if}
          Create from Template
        </Button>
      {/if}
    </div>
  {/if}
</div>
