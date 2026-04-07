<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api } from "$lib/services/api";
  import { agentStore } from "$lib/stores/agents.svelte";
  import { toast } from "svelte-sonner";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import MetaAgentPanel from "$lib/components/meta-agent/MetaAgentPanel.svelte";
  import { metaAgentStore } from "$lib/stores/meta-agent.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Switch from "$lib/components/ui/switch.svelte";
  import Dialog from "$lib/components/ui/dialog.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";

  let agentName = $derived($page.params.name ?? "");

  let loading = $state(true);
  let saving = $state(false);
  let deleteDialogOpen = $state(false);
  let deleting = $state(false);
  let cloning = $state(false);
  let savingTemplate = $state(false);
  let improveOpen = $state(false);

  // Identity
  let description = $state("");
  let version = $state(0);
  let isActive = $state(true);

  // Behavior
  let systemPrompt = $state("");
  let plan = $state("standard");
  let modelOverride = $state("");
  let temperature = $state(0.7);
  let maxTokens = $state(4096);
  let reasoningStrategy = $state("auto");
  let maxTurns = $state(15);

  // Tools
  let selectedTools = $state<string[]>([]);

  // Budget
  let budgetEnabled = $state(false);
  let budgetLimit = $state(5);
  let timeoutSeconds = $state(300);

  // Handoff
  let handoffEnabled = $state(false);
  let handoffTriggers = $state<string[]>([]);
  let handoffCustomTrigger = $state("");
  let handoffMessage = $state("I'm connecting you with a human agent who can help further...");
  let handoffEmail = $state("");
  let handoffPhone = $state("");
  let handoffSlack = $state("");

  // Deployment copy
  let copied = $state<string | null>(null);

  const defaultTriggers = [
    { id: "angry_customer", label: "Customer is angry or frustrated" },
    { id: "refund_request", label: "Refund or billing dispute" },
    { id: "technical_problem", label: "Technical issue agent can't solve" },
    { id: "human_request", label: "Customer explicitly asks for human" },
    { id: "sensitive_topic", label: "Sensitive personal/medical/legal topic" },
  ];

  let widgetEmbedCode = $derived(
    `<script src="https://api.oneshots.co/widget.js" data-agent="${agentName}"><\/script>`
  );
  let apiEndpointUrl = $derived(
    `POST https://api.oneshots.co/v1/agents/${agentName}/run`
  );

  const plans = [
    { id: "free", label: "Free", description: "Gemma 4 on edge — zero cost", color: "bg-muted text-muted-foreground border-border" },
    { id: "basic", label: "Basic", description: "DeepSeek V3.2 — near-free", color: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30" },
    { id: "standard", label: "Standard", description: "Claude Sonnet 4.6 — best value", color: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30" },
    { id: "premium", label: "Premium", description: "Claude Opus 4.6 — top quality", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  ];

  const reasoningOptions = [
    { value: "auto", label: "Auto" },
    { value: "chain-of-thought", label: "Chain of Thought" },
    { value: "plan-then-execute", label: "Plan then Execute" },
    { value: "step-back", label: "Step Back" },
    { value: "decompose", label: "Decompose" },
    { value: "verify-then-respond", label: "Verify then Respond" },
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

  function toggleTool(id: string) {
    if (selectedTools.includes(id)) {
      selectedTools = selectedTools.filter((t) => t !== id);
    } else {
      selectedTools = [...selectedTools, id];
    }
  }

  async function loadAgent() {
    loading = true;
    try {
      const data = await api.getAgentDetail(agentName);
      // API returns flat object, not { agent: {...} }
      const a = ((data as any).agent ?? data) as Record<string, any>;
      description = a.description ?? "";
      version = a.version ?? 0;
      isActive = a.is_active ?? true;
      systemPrompt = a.system_prompt ?? a.config_json?.system_prompt ?? "";
      plan = a.plan ?? "standard";
      modelOverride = a.model_override ?? a.config_json?.model_override ?? "";
      temperature = a.temperature ?? a.config_json?.temperature ?? 0.7;
      maxTokens = a.max_tokens ?? a.config_json?.max_tokens ?? 4096;
      reasoningStrategy = a.reasoning_strategy ?? a.config_json?.reasoning_strategy ?? "auto";
      maxTurns = a.max_turns ?? a.config_json?.max_turns ?? 15;
      selectedTools = a.tools ?? [];
      const rawBudget = a.budget_limit_usd ?? a.budget_limit ?? a.config_json?.budget_limit;
      budgetEnabled = rawBudget != null && rawBudget > 0 && rawBudget < 999;
      budgetLimit = rawBudget ?? 5;
      timeoutSeconds = a.timeout_seconds ?? a.config_json?.timeout_seconds ?? 300;

      // Handoff
      const hc = a.handoff_config ?? a.config_json?.handoff_config;
      if (hc) {
        handoffEnabled = hc.enabled ?? false;
        handoffTriggers = hc.triggers ?? [];
        handoffMessage = hc.message ?? handoffMessage;
        handoffEmail = hc.email ?? "";
        handoffPhone = hc.phone ?? "";
        handoffSlack = hc.slack ?? "";
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load agent");
    } finally {
      loading = false;
    }
  }

  async function handleSave() {
    saving = true;
    try {
      await api.updateAgent(agentName, {
        description,
        is_active: isActive,
        system_prompt: systemPrompt,
        plan,
        model_override: modelOverride || undefined,
        temperature,
        max_tokens: maxTokens,
        reasoning_strategy: reasoningStrategy,
        max_turns: maxTurns,
        tools: selectedTools,
        budget_limit_usd: budgetEnabled ? budgetLimit : 0,
        timeout_seconds: timeoutSeconds,
        handoff_config: handoffEnabled ? {
          enabled: true,
          triggers: handoffTriggers,
          message: handoffMessage,
          email: handoffEmail || undefined,
          phone: handoffPhone || undefined,
          slack: handoffSlack || undefined,
        } : { enabled: false },
      });
      toast.success("Agent settings saved.");
      await agentStore.fetchAgents();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    deleting = true;
    try {
      await agentStore.removeAgent(agentName);
      toast.success("Agent deleted.");
      goto("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      deleting = false;
    }
  }

  async function handleClone() {
    cloning = true;
    try {
      const suffix = Math.random().toString(16).slice(2, 5);
      const cloneName = `${agentName}-clone-${suffix}`;
      await api.post("/agents", {
        name: cloneName,
        description: description || `Clone of ${agentName}`,
        system_prompt: systemPrompt,
        plan,
        tools: selectedTools,
        temperature,
        max_tokens: maxTokens,
        reasoning_strategy: reasoningStrategy,
        max_turns: maxTurns,
        budget_limit_usd: budgetLimit,
        timeout_seconds: timeoutSeconds,
      });
      toast.success(`Cloned as "${cloneName}"`);
      await agentStore.fetchAgents();
      goto(`/agent/${cloneName}/settings`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clone agent");
    } finally {
      cloning = false;
    }
  }

  async function handleSaveTemplate() {
    savingTemplate = true;
    try {
      const templateName = `template-${agentName}`;
      // Save as a skill with the full agent config as the prompt_template
      const templateContent = JSON.stringify({
        description,
        system_prompt: systemPrompt,
        plan,
        tools: selectedTools,
        temperature,
        max_tokens: maxTokens,
        reasoning_strategy: reasoningStrategy,
        max_turns: maxTurns,
        budget_limit_usd: budgetLimit,
        timeout_seconds: timeoutSeconds,
      }, null, 2);
      await api.post("/skills", {
        name: templateName,
        description: `Template from ${agentName}: ${description?.slice(0, 100) || "Agent template"}`,
        category: "template",
        prompt_template: templateContent,
        enabled: true,
      });
      toast.success(`Saved as template "${templateName}". Available in the agent builder.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      savingTemplate = false;
    }
  }

  $effect(() => {
    if (agentName) loadAgent();
  });

  function toggleHandoffTrigger(id: string) {
    if (handoffTriggers.includes(id)) {
      handoffTriggers = handoffTriggers.filter((t) => t !== id);
    } else {
      handoffTriggers = [...handoffTriggers, id];
    }
  }

  function addCustomTrigger() {
    const trimmed = handoffCustomTrigger.trim();
    if (trimmed && !handoffTriggers.includes(trimmed)) {
      handoffTriggers = [...handoffTriggers, trimmed];
      handoffCustomTrigger = "";
    }
  }

  function handleCopy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    copied = label;
    setTimeout(() => (copied = null), 2000);
    toast.success("Copied to clipboard");
  }

  function planVariant(p: string): "free" | "basic" | "standard" | "premium" {
    if (p === "free") return "free";
    if (p === "basic") return "basic";
    if (p === "premium") return "premium";
    return "standard";
  }
</script>

<Dialog
  bind:open={deleteDialogOpen}
  title="Delete Agent"
  description="This will permanently delete {agentName} and all its data. This action cannot be undone."
  confirmText={deleting ? "Deleting..." : "Delete Agent"}
  variant="destructive"
  onConfirm={handleDelete}
/>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex flex-1 overflow-hidden">
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8">
      {#if loading}
        <div class="flex items-center justify-center py-24">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else}
        <!-- Header -->
        <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-3">
              <h1>Settings</h1>
              <Badge variant={planVariant(plan)}>{plan}</Badge>
              {#if version}
                <Badge variant="outline">v{version}</Badge>
              {/if}
            </div>
            <p class="mt-1.5 text-sm text-muted-foreground">Agent configuration and settings</p>
          </div>
          <div class="flex gap-3">
            <Button variant="outline" onclick={() => goto(`/chat/${agentName}`)}>Open Chat</Button>
            <Button disabled={saving} onclick={handleSave}>
              {#if saving}
                <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
              {/if}
              Save Changes
            </Button>
          </div>
        </div>

        <div class="space-y-10">
          <!-- Identity Section -->
          <section>
            <h2 class="mb-4">Identity</h2>
            <div class="space-y-4 rounded-lg border border-border p-6">
              <div>
                <label for="desc" class="mb-2 block text-sm font-medium text-foreground">Description</label>
                <Textarea id="desc" rows={3} placeholder="What does this agent do?" bind:value={description} />
              </div>
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-foreground">Active</p>
                  <p class="text-xs text-muted-foreground">When inactive, agent is in draft mode and cannot be used.</p>
                </div>
                <Switch bind:checked={isActive} />
              </div>
            </div>
          </section>

          <!-- Deployment Section -->
          <section>
            <h2 class="mb-4">Deployment</h2>
            <div class="space-y-4 rounded-lg border border-border p-6">
              <div>
                <p class="mb-2 text-sm font-medium text-foreground">Widget Embed Code</p>
                <div class="relative">
                  <pre class="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs text-foreground">{widgetEmbedCode}</pre>
                  <button
                    class="absolute right-2 top-2 rounded-md bg-secondary p-1.5 text-secondary-foreground hover:bg-secondary/80"
                    onclick={() => handleCopy(widgetEmbedCode, "widget")}
                  >
                    {#if copied === "widget"}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                    {/if}
                  </button>
                </div>
              </div>
              <div>
                <p class="mb-2 text-sm font-medium text-foreground">API Endpoint</p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-sm text-foreground">{apiEndpointUrl}</code>
                  <button
                    class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80"
                    onclick={() => handleCopy(apiEndpointUrl, "api")}
                  >
                    {#if copied === "api"}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                    {/if}
                  </button>
                </div>
              </div>
              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                <span>Manage API keys in <a href="/settings/api-keys" class="text-primary hover:underline">Settings &rarr; API Keys</a></span>
              </div>
            </div>
          </section>

          <!-- Behavior Section -->
          <section>
            <h2 class="mb-4">Behavior</h2>
            <div class="space-y-6 rounded-lg border border-border p-6">
              <div>
                <label for="sys-prompt" class="mb-2 block text-sm font-medium text-foreground">System Prompt</label>
                <Textarea
                  id="sys-prompt"
                  rows={20}
                  placeholder="You are a helpful assistant that..."
                  bind:value={systemPrompt}
                  class="font-mono text-sm"
                />
              </div>

              <!-- Plan selector hidden for MVP — everything runs on free plan -->

              <div class="grid gap-6 sm:grid-cols-2">
                <div>
                  <label for="reasoning" class="mb-2 block text-sm font-medium text-foreground">Reasoning Strategy</label>
                  <Select id="reasoning" options={reasoningOptions} bind:value={reasoningStrategy} />
                </div>
              </div>

              <div class="grid gap-6 sm:grid-cols-3">
                <div>
                  <label for="temperature" class="mb-2 block text-sm font-medium text-foreground">
                    Temperature <span class="font-mono text-xs text-muted-foreground">{(temperature ?? 0).toFixed(1)}</span>
                  </label>
                  <input
                    id="temperature"
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    bind:value={temperature}
                    class="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
                  />
                  <div class="mt-1 flex justify-between text-xs text-muted-foreground">
                    <span>0.0</span>
                    <span>2.0</span>
                  </div>
                </div>
                <div>
                  <label for="max-tokens" class="mb-2 block text-sm font-medium text-foreground">Max Tokens</label>
                  <Input id="max-tokens" type="number" min={1} max={200000} bind:value={maxTokens} />
                </div>
                <div>
                  <label for="max-turns" class="mb-2 block text-sm font-medium text-foreground">Max Turns</label>
                  <Input id="max-turns" type="number" min={1} max={100} bind:value={maxTurns} />
                </div>
              </div>
            </div>
          </section>

          <!-- Tools Section -->
          <section>
            <div class="mb-4">
              <h2>Tools</h2>
              <p class="mt-1 text-sm text-muted-foreground">{selectedTools.length} tool{selectedTools.length !== 1 ? "s" : ""} enabled</p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {#each availableTools as tool}
                <button
                  class="flex items-start gap-3 rounded-lg border-2 p-4 text-left transition-all
                    {selectedTools.includes(tool.id) ? 'border-primary bg-primary/5' : 'border-border hover:border-foreground/20'}"
                  onclick={() => toggleTool(tool.id)}
                >
                  <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md {selectedTools.includes(tool.id) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d={toolIcons[tool.id] ?? "M13 10V3L4 14h7v7l9-11h-7z"} />
                    </svg>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-foreground">{tool.name}</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                  </div>
                  {#if selectedTools.includes(tool.id)}
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0 text-primary" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                    </svg>
                  {/if}
                </button>
              {/each}
            </div>
          </section>

          <!-- Budget & Limits -->
          <section>
            <h2 class="mb-4">Budget & Limits</h2>
            <div class="space-y-4 rounded-lg bg-muted/30 p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-foreground">Enable budget limit</p>
                  <p class="text-xs text-muted-foreground">Cap spending per session. Off = unlimited.</p>
                </div>
                <Switch bind:checked={budgetEnabled} />
              </div>

              {#if budgetEnabled}
                <div class="grid gap-6 sm:grid-cols-2">
                  <div>
                    <label for="budget" class="mb-2 block text-sm font-medium text-foreground">Budget Limit (USD)</label>
                    <div class="relative">
                      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input id="budget" type="number" min={0.5} step={0.5} class="pl-7" bind:value={budgetLimit} />
                    </div>
                  </div>
                  <div>
                    <label for="timeout" class="mb-2 block text-sm font-medium text-foreground">Timeout (seconds)</label>
                    <Input id="timeout" type="number" min={1} max={3600} bind:value={timeoutSeconds} />
                  </div>
                </div>
              {:else}
                <div>
                  <label for="timeout" class="mb-2 block text-sm font-medium text-foreground">Timeout (seconds)</label>
                  <Input id="timeout" type="number" min={1} max={3600} bind:value={timeoutSeconds} />
                </div>
              {/if}
            </div>
          </section>

          <!-- Live Handoff -->
          <section>
            <h2 class="mb-4">Live Handoff</h2>
            <div class="space-y-4 rounded-lg border border-border p-6">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-foreground">Enable live handoff</p>
                  <p class="text-xs text-muted-foreground">Escalate to a human when the agent cannot help</p>
                </div>
                <Switch bind:checked={handoffEnabled} />
              </div>

              {#if handoffEnabled}
                <div class="space-y-4 border-t border-border pt-4">
                  <!-- Escalation triggers -->
                  <div>
                    <label class="mb-3 block text-sm font-medium text-foreground">Escalation Triggers</label>
                    <div class="flex flex-wrap gap-2">
                      {#each defaultTriggers as trigger}
                        <button
                          class="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors
                            {handoffTriggers.includes(trigger.id)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:border-foreground/20'}"
                          onclick={() => toggleHandoffTrigger(trigger.id)}
                        >
                          {trigger.label}
                        </button>
                      {/each}
                      <!-- Show custom triggers -->
                      {#each handoffTriggers.filter((t) => !defaultTriggers.some((d) => d.id === t)) as custom}
                        <button
                          class="rounded-lg border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors"
                          onclick={() => toggleHandoffTrigger(custom)}
                        >
                          {custom} &times;
                        </button>
                      {/each}
                    </div>
                    <div class="mt-3 flex gap-2">
                      <Input
                        placeholder="Add custom trigger..."
                        class="max-w-xs"
                        bind:value={handoffCustomTrigger}
                        onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomTrigger(); } }}
                      />
                      <Button size="sm" variant="outline" onclick={addCustomTrigger} disabled={!handoffCustomTrigger.trim()}>
                        Add
                      </Button>
                    </div>
                  </div>

                  <!-- Handoff message -->
                  <div>
                    <label for="handoff-msg" class="mb-2 block text-sm font-medium text-foreground">Handoff Message</label>
                    <Textarea
                      id="handoff-msg"
                      rows={2}
                      placeholder="I'm connecting you with a human agent..."
                      bind:value={handoffMessage}
                    />
                  </div>

                  <!-- Destinations -->
                  <div>
                    <label class="mb-3 block text-sm font-medium text-foreground">Notification Destinations</label>
                    <div class="grid gap-4 sm:grid-cols-3">
                      <div>
                        <label for="handoff-email" class="mb-1 block text-xs text-muted-foreground">Email</label>
                        <Input id="handoff-email" type="email" placeholder="support@company.com" bind:value={handoffEmail} />
                      </div>
                      <div>
                        <label for="handoff-phone" class="mb-1 block text-xs text-muted-foreground">Phone / SMS</label>
                        <Input id="handoff-phone" placeholder="+1 555 000 0000" bind:value={handoffPhone} />
                      </div>
                      <div>
                        <label for="handoff-slack" class="mb-1 block text-xs text-muted-foreground">Slack Channel</label>
                        <Input id="handoff-slack" placeholder="#support-alerts" bind:value={handoffSlack} />
                      </div>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </section>

          <!-- Clone & Template -->
          <section>
            <h2 class="mb-4">Clone & Templates</h2>
            <div class="space-y-4 rounded-lg bg-muted/30 p-6">
              <!-- Clone -->
              <div class="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium text-foreground">Clone this agent</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    Create an exact copy with a new name. All settings, tools, and prompt are duplicated.
                  </p>
                </div>
                <Button variant="outline" disabled={cloning} onclick={handleClone}>
                  {#if cloning}
                    <span class="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground border-t-transparent"></span>
                  {/if}
                  Clone Agent
                </Button>
              </div>

              <!-- Save as Template -->
              <div class="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium text-foreground">Save as template</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    Save this agent's configuration as a reusable template. Others in your org can create agents from it.
                  </p>
                </div>
                <Button variant="outline" disabled={savingTemplate} onclick={handleSaveTemplate}>
                  {#if savingTemplate}
                    <span class="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground border-t-transparent"></span>
                  {/if}
                  Save as Template
                </Button>
              </div>
            </div>
          </section>

          <!-- Danger Zone — hidden for personal agents -->
          {#if agentName !== "my-assistant"}
            <section>
              <h2 class="mb-4 text-destructive">Danger Zone</h2>
              <div class="rounded-lg border border-destructive/30 p-6">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p class="text-sm font-medium text-foreground">Delete this agent</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      Permanently remove {agentName} and all associated data. This cannot be undone.
                    </p>
                  </div>
                  <Button variant="destructive" onclick={() => (deleteDialogOpen = true)}>
                    Delete Agent
                  </Button>
                </div>
              </div>
            </section>
          {/if}
        </div>

        <!-- Sticky save bar -->
        <div class="sticky bottom-0 mt-8 flex justify-end border-t border-border bg-background/95 py-4 backdrop-blur-sm">
          <div class="flex gap-3">
            <Button variant="outline" onclick={() => goto(`/chat/${agentName}`)}>Cancel</Button>
            <Button disabled={saving} onclick={handleSave}>
              {#if saving}
                <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
              {/if}
              Save Changes
            </Button>
          </div>
        </div>
      {/if}
      </div>
    </div>

    {#if improveOpen}
      <MetaAgentPanel
        {agentName}
        bind:open={improveOpen}
        onClose={() => (improveOpen = false)}
      />
    {/if}
  </div>
</div>

<!-- Floating Improve button -->
{#if !improveOpen}
  <button
    class="fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-all hover:bg-primary/90 hover:shadow-xl"
    onclick={() => (improveOpen = true)}
  >
    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
    Improve
  </button>
{/if}
