<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/services/api";
  import {
    createTrainingJob,
    listTrainingJobs,
    getTrainingJob,
    type TrainingJob,
    type TrainingConfig,
  } from "$lib/services/training";
  import TrainingStream from "$lib/components/meta-agent/TrainingStream.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";

  let agentName = $derived($page.params.name ?? "");

  // --- Tab state ---
  let activeTab = $state<"tests" | "training">("tests");

  // --- Test state ---
  interface TestCase {
    input: string;
    expected: string;
    grader: "contains" | "exact";
  }

  interface TestResult {
    input: string;
    expected: string;
    passed: boolean;
    actual?: string;
    reason?: string;
  }

  let testCases = $state<TestCase[]>([]);
  let testResults = $state<TestResult[]>([]);
  let runningTests = $state(false);
  let passRate = $state<number | undefined>(undefined);

  // Add test form
  let newInput = $state("");
  let newExpected = $state("");
  let newGrader = $state<"contains" | "exact">("contains");
  let showAddForm = $state(false);

  // --- Training state ---
  let trainingJobs = $state<TrainingJob[]>([]);
  let loadingJobs = $state(false);
  let showTrainingConfig = $state(false);
  let trainingAlgorithm = $state<"hill_climb" | "beam_search" | "genetic">("hill_climb");
  let trainingMaxIter = $state(10);
  let trainingAutoActivate = $state(true);
  let activeStreamJobId = $state<string | null>(null);
  let selectedJob = $state<TrainingJob | null>(null);

  // Load agent's test cases and training jobs
  $effect(() => {
    if (!agentName) return;
    loadTestCases();
    loadTrainingJobs();
  });

  async function loadTestCases() {
    try {
      const data = await api.get<{ agent: Record<string, unknown> }>(
        `/agents/${encodeURIComponent(agentName)}`
      );
      const evalConfig = data.agent?.eval_config as
        | { test_cases?: TestCase[] }
        | undefined;
      testCases = evalConfig?.test_cases ?? [];
    } catch {
      // agent may not have eval config yet
      testCases = [];
    }
  }

  async function loadTrainingJobs() {
    loadingJobs = true;
    try {
      trainingJobs = await listTrainingJobs(agentName);
    } catch {
      trainingJobs = [];
    } finally {
      loadingJobs = false;
    }
  }

  function addTestCase() {
    if (!newInput.trim() || !newExpected.trim()) return;
    testCases = [
      ...testCases,
      { input: newInput.trim(), expected: newExpected.trim(), grader: newGrader },
    ];
    newInput = "";
    newExpected = "";
    newGrader = "contains";
    showAddForm = false;
    saveTestCases();
  }

  function removeTestCase(index: number) {
    testCases = testCases.filter((_, i) => i !== index);
    saveTestCases();
  }

  async function saveTestCases() {
    try {
      await api.updateAgent(agentName, {
        eval_config: { test_cases: testCases },
      });
    } catch (err) {
      toast.error(`Failed to save test cases: ${(err as Error).message}`);
    }
  }

  async function runTests() {
    if (testCases.length === 0) {
      toast.info("Add test cases first");
      return;
    }
    runningTests = true;
    testResults = [];
    passRate = undefined;

    try {
      const res = await api.post<{ results: TestResult[]; pass_rate: number }>(
        `/agents/${encodeURIComponent(agentName)}/eval`,
        { test_cases: testCases }
      );
      testResults = res.results ?? [];
      passRate = res.pass_rate;
      toast.success(`Tests complete: ${passRate?.toFixed(0)}% pass rate`);
    } catch (err) {
      toast.error(`Test run failed: ${(err as Error).message}`);
    } finally {
      runningTests = false;
    }
  }

  async function startTraining() {
    const config: TrainingConfig = {
      algorithm: trainingAlgorithm,
      max_iterations: trainingMaxIter,
      auto_activate: trainingAutoActivate,
    };

    try {
      const job = await createTrainingJob(agentName, config);
      toast.success("Training job started");
      showTrainingConfig = false;
      activeStreamJobId = job.id;
      trainingJobs = [job, ...trainingJobs];
    } catch (err) {
      toast.error(`Failed to start training: ${(err as Error).message}`);
    }
  }

  async function viewJobDetail(jobId: string) {
    try {
      const job = await getTrainingJob(jobId);
      selectedJob = job;
      // If running, show the stream
      if (job.status === "running") {
        activeStreamJobId = job.id;
      }
    } catch (err) {
      toast.error(`Failed to load job: ${(err as Error).message}`);
    }
  }

  function statusColor(status: string): string {
    switch (status) {
      case "completed":
        return "text-success";
      case "running":
        return "text-chart-1";
      case "failed":
        return "text-destructive";
      default:
        return "text-muted-foreground";
    }
  }
</script>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="w-full px-6 py-8 lg:px-8">
      <!-- Page header -->
      <div class="mb-8">
        <h1>Tests & Training</h1>
        <p class="mt-1.5 text-sm text-muted-foreground">Evaluate and optimize your agent</p>
      </div>

      <!-- Tab bar -->
      <div class="mb-6 flex gap-1 rounded-lg bg-muted p-1">
        <button
          type="button"
          class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeTab === 'tests'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = "tests")}
        >
          Tests
        </button>
        <button
          type="button"
          class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeTab === 'training'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = "training")}
        >
          Training
        </button>
      </div>

      <!-- TESTS TAB -->
      {#if activeTab === "tests"}
        <div class="space-y-4">
          <!-- Controls -->
          <div class="flex items-center justify-between">
            <span class="text-sm text-muted-foreground">{testCases.length} test case{testCases.length !== 1 ? "s" : ""}</span>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={() => (showAddForm = !showAddForm)}>
                <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
                Add Test
              </Button>
              <Button size="sm" onclick={runTests} disabled={runningTests || testCases.length === 0}>
                {#if runningTests}
                  <span class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
                  Running...
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="6 3 20 12 6 21 6 3" />
                  </svg>
                  Run Tests
                {/if}
              </Button>
            </div>
          </div>

          <!-- Pass rate banner -->
          {#if passRate !== undefined}
            <div class="rounded-lg border border-border p-4 {passRate >= 80 ? 'bg-success/10' : passRate >= 50 ? 'bg-chart-4/10' : 'bg-destructive/10'}">
              <div class="flex items-center gap-3">
                {#if passRate >= 80}
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                {/if}
                <div>
                  <p class="text-sm font-semibold text-foreground">{(passRate ?? 0).toFixed(0)}% pass rate</p>
                  <p class="text-xs text-muted-foreground">
                    {testResults.filter((r) => r.passed).length}/{testResults.length} tests passed
                  </p>
                </div>
              </div>
            </div>
          {/if}

          <!-- Add test form -->
          {#if showAddForm}
            <div class="rounded-lg border border-border bg-card p-4">
              <h4 class="mb-3 text-sm font-medium">New Test Case</h4>
              <div class="space-y-3">
                <div>
                  <label for="test-input" class="mb-1 block text-xs font-medium text-muted-foreground">Input</label>
                  <Textarea
                    id="test-input"
                    bind:value={newInput}
                    rows={2}
                    placeholder="User message to test with..."
                  />
                </div>
                <div>
                  <label for="test-expected" class="mb-1 block text-xs font-medium text-muted-foreground">Expected Output</label>
                  <Textarea
                    id="test-expected"
                    bind:value={newExpected}
                    rows={2}
                    placeholder="Expected response or substring..."
                  />
                </div>
                <div>
                  <label for="test-grader" class="mb-1 block text-xs font-medium text-muted-foreground">Grader</label>
                  <div class="flex gap-3">
                    <label class="flex items-center gap-1.5 text-sm">
                      <input
                        type="radio"
                        name="grader"
                        value="contains"
                        bind:group={newGrader}
                        class="accent-primary"
                      />
                      Contains
                    </label>
                    <label class="flex items-center gap-1.5 text-sm">
                      <input
                        type="radio"
                        name="grader"
                        value="exact"
                        bind:group={newGrader}
                        class="accent-primary"
                      />
                      Exact match
                    </label>
                  </div>
                </div>
                <div class="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onclick={() => (showAddForm = false)}>Cancel</Button>
                  <Button size="sm" onclick={addTestCase} disabled={!newInput.trim() || !newExpected.trim()}>
                    Add
                  </Button>
                </div>
              </div>
            </div>
          {/if}

          <!-- Test case list -->
          {#if testCases.length === 0}
            <div class="rounded-lg border border-dashed border-border py-12 text-center">
              <p class="text-sm text-muted-foreground">No test cases yet. Add one to get started.</p>
            </div>
          {:else}
            <div class="space-y-2">
              {#each testCases as tc, i}
                {@const result = testResults[i]}
                <div class="rounded-lg border border-border bg-card">
                  <div class="flex items-start gap-3 px-4 py-3">
                    <!-- Status indicator -->
                    <div class="mt-0.5 shrink-0">
                      {#if result}
                        {#if result.passed}
                          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        {:else}
                          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        {/if}
                      {:else}
                        <div class="h-4 w-4 rounded-full border-2 border-muted-foreground/30"></div>
                      {/if}
                    </div>

                    <div class="min-w-0 flex-1">
                      <div class="mb-1 text-sm text-foreground">
                        <span class="font-medium">Input:</span>
                        <span class="text-muted-foreground">{tc.input}</span>
                      </div>
                      <div class="text-sm text-foreground">
                        <span class="font-medium">Expected ({tc.grader}):</span>
                        <span class="text-muted-foreground">{tc.expected}</span>
                      </div>
                      {#if result?.reason}
                        <div class="mt-1.5 text-xs text-muted-foreground">
                          {result.reason}
                        </div>
                      {/if}
                    </div>

                    <button
                      type="button"
                      class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onclick={() => removeTestCase(i)}
                      aria-label="Remove test case"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- TRAINING TAB -->
      {#if activeTab === "training"}
        <div class="space-y-4">
          <!-- Controls -->
          <div class="flex items-center justify-between">
            <span class="text-sm text-muted-foreground">
              {trainingJobs.length} training job{trainingJobs.length !== 1 ? "s" : ""}
            </span>
            <Button size="sm" onclick={() => (showTrainingConfig = !showTrainingConfig)}>
              <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
              Start Training
            </Button>
          </div>

          <!-- Training config dialog -->
          {#if showTrainingConfig}
            <div class="rounded-lg border border-border bg-card p-4">
              <h4 class="mb-3 text-sm font-medium">Training Configuration</h4>
              <div class="space-y-3">
                <div>
                  <label for="train-algo" class="mb-1 block text-xs font-medium text-muted-foreground">Algorithm</label>
                  <Select
                    id="train-algo"
                    bind:value={trainingAlgorithm}
                    options={[
                      { value: "hill_climb", label: "Hill Climb" },
                      { value: "beam_search", label: "Beam Search" },
                      { value: "genetic", label: "Genetic" },
                    ]}
                  />
                </div>
                <div>
                  <label for="train-iter" class="mb-1 block text-xs font-medium text-muted-foreground">Max Iterations</label>
                  <Input
                    id="train-iter"
                    type="number"
                    min={1}
                    max={100}
                    bind:value={trainingMaxIter}
                  />
                </div>
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    bind:checked={trainingAutoActivate}
                    class="accent-primary"
                  />
                  Auto-activate best prompt when training completes
                </label>
                <div class="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onclick={() => (showTrainingConfig = false)}>Cancel</Button>
                  <Button size="sm" onclick={startTraining}>Start</Button>
                </div>
              </div>
            </div>
          {/if}

          <!-- Active training stream -->
          {#if activeStreamJobId}
            <div class="rounded-lg border border-border p-4">
              <h4 class="mb-3 text-sm font-medium">Live Training</h4>
              <TrainingStream
                jobId={activeStreamJobId}
                {agentName}
                onComplete={() => {
                  activeStreamJobId = null;
                  loadTrainingJobs();
                }}
              />
            </div>
          {/if}

          <!-- Job list -->
          {#if loadingJobs}
            <div class="py-8 text-center text-sm text-muted-foreground">Loading jobs...</div>
          {:else if trainingJobs.length === 0}
            <div class="rounded-lg border border-dashed border-border py-12 text-center">
              <p class="text-sm text-muted-foreground">No training jobs yet. Start one to optimize your agent.</p>
            </div>
          {:else}
            <div class="space-y-2">
              {#each trainingJobs as job}
                <button
                  type="button"
                  class="w-full rounded-lg border border-border bg-card text-left transition-colors hover:bg-accent/50"
                  onclick={() => viewJobDetail(job.id)}
                >
                  <div class="flex items-center gap-3 px-4 py-3">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-medium text-foreground">{job.algorithm}</span>
                        <span class="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase {statusColor(job.status)}">
                          {job.status}
                        </span>
                      </div>
                      <div class="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                        <span>{job.current_iteration}/{job.max_iterations} iterations</span>
                        {#if job.best_score > 0}
                          <span>Best: {(job.best_score ?? 0).toFixed(3)}</span>
                        {/if}
                        <span>{new Date(job.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </div>
                </button>
              {/each}
            </div>
          {/if}

          <!-- Selected job detail -->
          {#if selectedJob}
            <div class="rounded-lg border border-border bg-card p-4">
              <div class="mb-3 flex items-center justify-between">
                <h4 class="text-sm font-medium">Job Detail: {selectedJob.algorithm}</h4>
                <button
                  type="button"
                  class="text-xs text-muted-foreground hover:text-foreground"
                  onclick={() => (selectedJob = null)}
                >
                  Close
                </button>
              </div>

              {#if selectedJob.error}
                <div class="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {selectedJob.error}
                </div>
              {/if}

              {#if selectedJob.iterations && selectedJob.iterations.length > 0}
                <div class="space-y-2">
                  {#each selectedJob.iterations as iter}
                    <div class="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-xs">
                      <span class="font-medium">Iteration {iter.iteration}</span>
                      <div class="flex gap-3 text-muted-foreground">
                        <span>Pass: {(iter.pass_rate ?? 0).toFixed(0)}%</span>
                        <span>Reward: {(iter.reward_score ?? 0).toFixed(3)}</span>
                        <span>${(iter.cost_usd ?? 0).toFixed(4)}</span>
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="text-xs text-muted-foreground">No iterations recorded yet.</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
