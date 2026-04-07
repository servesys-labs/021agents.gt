<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import StatCard from "$lib/components/ui/stat-card.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import {
    getVoiceConfig,
    updateVoiceConfig,
    listPhoneNumbers,
    searchPhoneNumbers,
    buyPhoneNumber,
    releasePhoneNumber,
    listCalls,
    type PhoneNumber,
    type AvailableNumber,
    type CallLog,
  } from "$lib/services/voice";

  let agentName = $derived($page.params.name ?? "");

  // ── Page state ─────────────────────────────────────────────────────
  let loading = $state(true);
  let savingConfig = $state(false);

  // Voice settings
  let voice = $state("alloy");
  let greeting = $state("Hello! How can I help you today?");
  let language = $state("en");
  let maxDuration = $state("900");

  // Phone numbers
  let phoneNumbers = $state<PhoneNumber[]>([]);
  let showNumberSearch = $state(false);
  let searchAreaCode = $state("");
  let searching = $state(false);
  let availableNumbers = $state<AvailableNumber[]>([]);
  let hasSearched = $state(false);
  let purchasing = $state(false);
  let buyTarget = $state<AvailableNumber | null>(null);

  // Calls
  let calls = $state<CallLog[]>([]);
  let expandedCallId = $state<string | null>(null);

  // ── Voice options ──────────────────────────────────────────────────
  const voiceOptions = [
    { value: "alloy", label: "Alloy — Warm & friendly" },
    { value: "echo", label: "Echo — Clear & professional" },
    { value: "nova", label: "Nova — Bright & energetic" },
    { value: "onyx", label: "Onyx — Deep & authoritative" },
    { value: "shimmer", label: "Shimmer — Soft & approachable" },
    { value: "fable", label: "Fable — Expressive & storytelling" },
  ];

  const languageOptions = [
    { value: "en", label: "English" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
    { value: "pt", label: "Portuguese" },
    { value: "ja", label: "Japanese" },
    { value: "zh", label: "Chinese (Mandarin)" },
  ];

  const durationOptions = [
    { value: "300", label: "5 minutes" },
    { value: "600", label: "10 minutes" },
    { value: "900", label: "15 minutes (default)" },
    { value: "1200", label: "20 minutes" },
    { value: "1800", label: "30 minutes" },
  ];

  // ── Derived ────────────────────────────────────────────────────────
  let activeNumbers = $derived(phoneNumbers.filter((n) => n.status === "active"));
  let totalMinutes = $derived(Math.round(calls.reduce((s, c) => s + c.duration_seconds, 0) / 60));

  // ── Helpers ────────────────────────────────────────────────────────
  function formatDuration(seconds: number): string {
    if (seconds === 0) return "--";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function formatPhone(raw: string): string {
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return raw;
  }

  function copyNumber(num: string) {
    navigator.clipboard.writeText(num.replace(/[^+\d]/g, ""));
    toast.success("Copied to clipboard");
  }

  // ── Load ───────────────────────────────────────────────────────────
  async function loadVoicePage() {
    loading = true;
    try {
      const [config, numbersResp, callsResp] = await Promise.allSettled([
        getVoiceConfig(agentName),
        listPhoneNumbers(agentName),
        listCalls(agentName),
      ]);

      if (config.status === "fulfilled") {
        const c = config.value;
        if (c.voice) voice = c.voice;
        if (c.greeting) greeting = c.greeting;
        if (c.language) language = c.language;
        if (c.max_duration != null) maxDuration = String(c.max_duration);
      }

      if (numbersResp.status === "fulfilled") {
        phoneNumbers = numbersResp.value.numbers ?? [];
      }

      if (callsResp.status === "fulfilled") {
        calls = callsResp.value.calls ?? [];
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load voice settings");
    } finally {
      loading = false;
    }
  }

  // ── Save voice settings ────────────────────────────────────────────
  async function saveVoiceSettings() {
    savingConfig = true;
    try {
      await updateVoiceConfig(agentName, {
        voice,
        greeting,
        language,
        max_duration: parseInt(maxDuration, 10) || 900,
      });
      toast.success("Voice settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save voice settings");
    } finally {
      savingConfig = false;
    }
  }

  // ── Search numbers ─────────────────────────────────────────────────
  async function handleSearchNumbers() {
    searching = true;
    hasSearched = true;
    try {
      const resp = await searchPhoneNumbers(agentName, searchAreaCode);
      availableNumbers = resp.numbers ?? [];
      if (availableNumbers.length === 0) {
        toast.info("No numbers found. Try a different area code.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
      availableNumbers = [];
    } finally {
      searching = false;
    }
  }

  // ── Buy a number ───────────────────────────────────────────────────
  async function handleBuyNumber() {
    if (!buyTarget) return;
    purchasing = true;
    try {
      await buyPhoneNumber(agentName, buyTarget.phone_number);
      toast.success(`Number ${formatPhone(buyTarget.phone_number)} purchased!`);
      buyTarget = null;
      availableNumbers = [];
      hasSearched = false;
      showNumberSearch = false;
      await loadVoicePage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Purchase failed");
    } finally {
      purchasing = false;
    }
  }

  // ── Release a number ───────────────────────────────────────────────
  async function handleReleaseNumber(num: PhoneNumber) {
    try {
      await releasePhoneNumber(num.provider_sid);
      toast.success("Number released");
      await loadVoicePage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to release number");
    }
  }

  $effect(() => {
    if (agentName) loadVoicePage();
  });
</script>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8">
      {#if loading}
        <div class="flex items-center justify-center py-24">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else}
        <!-- Header -->
        <div class="mb-8">
          <h1>Voice</h1>
          <p class="mt-1.5 text-sm text-muted-foreground">
            Configure voice calling, phone numbers, and call settings
          </p>
        </div>

        <!-- Stats -->
        <div class="mb-8 grid gap-4 sm:grid-cols-3">
          <StatCard value={String(activeNumbers.length)} label="Active Numbers" accentColor="chart-1" />
          <StatCard value={String(calls.length)} label="Total Calls" accentColor="chart-2" />
          <StatCard value={String(totalMinutes)} label="Total Minutes" accentColor="chart-3" />
        </div>

        <div class="space-y-10">
          <!-- Voice Settings -->
          <section>
            <h2 class="mb-4">Voice Settings</h2>
            <div class="space-y-6 rounded-lg border border-border p-6">
              <div class="grid gap-6 sm:grid-cols-2">
                <div>
                  <label for="voice-select" class="mb-2 block text-sm font-medium text-foreground">TTS Voice</label>
                  <Select id="voice-select" options={voiceOptions} bind:value={voice} />
                </div>
                <div>
                  <label for="lang-select" class="mb-2 block text-sm font-medium text-foreground">Language</label>
                  <Select id="lang-select" options={languageOptions} bind:value={language} />
                </div>
              </div>
              <div>
                <label for="voice-greeting" class="mb-2 block text-sm font-medium text-foreground">Greeting Message</label>
                <Textarea id="voice-greeting" rows={3} placeholder="Hello! How can I help you today?" bind:value={greeting} />
              </div>
              <div class="max-w-xs">
                <label for="max-dur" class="mb-2 block text-sm font-medium text-foreground">Max Call Duration</label>
                <Select id="max-dur" options={durationOptions} bind:value={maxDuration} />
              </div>
              <div class="flex justify-end">
                <Button disabled={savingConfig} onclick={saveVoiceSettings}>
                  {#if savingConfig}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                  Save Voice Settings
                </Button>
              </div>
            </div>
          </section>

          <!-- Phone Numbers -->
          <section>
            <div class="mb-4 flex items-center justify-between">
              <div>
                <h2>Phone Numbers</h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {activeNumbers.length} number{activeNumbers.length !== 1 ? "s" : ""} assigned
                </p>
              </div>
              <Button variant="outline" onclick={() => (showNumberSearch = !showNumberSearch)}>
                {#if showNumberSearch}
                  Cancel
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                  Get a Phone Number
                {/if}
              </Button>
            </div>

            <!-- Existing numbers -->
            {#if activeNumbers.length > 0}
              <div class="mb-4 space-y-3">
                {#each activeNumbers as num}
                  <div class="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success/10">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-semibold text-foreground">{formatPhone(num.phone_number)}</p>
                      <p class="text-xs text-muted-foreground">
                        {num.provider} &middot; Since {new Date(num.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge variant="default">{num.status}</Badge>
                    <div class="flex gap-2">
                      <Button size="sm" variant="ghost" onclick={() => copyNumber(num.phone_number)}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                      </Button>
                      <Button size="sm" variant="destructive" onclick={() => handleReleaseNumber(num)}>
                        Release
                      </Button>
                    </div>
                  </div>
                {/each}
              </div>
            {:else if !showNumberSearch}
              <div class="mb-4 rounded-lg border border-dashed border-border p-8 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-8 w-8 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                <p class="mt-3 text-sm font-medium text-foreground">No phone numbers assigned</p>
                <p class="mt-1 text-xs text-muted-foreground">Get a phone number to enable voice calling for your agent.</p>
              </div>
            {/if}

            <!-- Number search -->
            {#if showNumberSearch}
              <div class="rounded-lg border border-border bg-card p-6">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div class="max-w-xs flex-1">
                    <label for="area-code" class="mb-2 block text-sm font-medium text-foreground">Area Code (optional)</label>
                    <Input
                      id="area-code"
                      placeholder="e.g. 415, 212, 310"
                      maxlength={3}
                      bind:value={searchAreaCode}
                    />
                  </div>
                  <Button disabled={searching} onclick={handleSearchNumbers}>
                    {#if searching}
                      <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    {/if}
                    Search Available Numbers
                  </Button>
                </div>

                {#if hasSearched && availableNumbers.length > 0}
                  <div class="mt-6">
                    <p class="mb-3 text-xs text-muted-foreground">
                      {availableNumbers.length} numbers available{searchAreaCode ? ` in area code ${searchAreaCode}` : ""}
                    </p>
                    <div class="max-h-96 space-y-2 overflow-y-auto">
                      {#each availableNumbers as num}
                        <div class="flex items-center justify-between rounded-lg border border-border p-3 transition-colors hover:border-ring">
                          <div class="flex items-center gap-3">
                            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                            </div>
                            <div>
                              <p class="text-sm font-medium text-foreground">{formatPhone(num.phone_number)}</p>
                              <p class="text-xs text-muted-foreground">
                                {[num.locality, num.region].filter(Boolean).join(", ") || "United States"}
                              </p>
                            </div>
                          </div>
                          <Button size="sm" variant="secondary" onclick={() => (buyTarget = num)}>
                            Select
                          </Button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if hasSearched && availableNumbers.length === 0 && !searching}
                  <p class="mt-4 py-4 text-center text-sm text-muted-foreground">No numbers found. Try a different area code.</p>
                {/if}
              </div>
            {/if}

            <!-- Buy confirmation -->
            {#if buyTarget}
              <div class="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-6">
                <div class="text-center">
                  <p class="text-lg font-semibold text-foreground">{formatPhone(buyTarget.phone_number)}</p>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {[buyTarget.locality, buyTarget.region].filter(Boolean).join(", ") || "United States"}
                  </p>
                  <p class="mt-3 text-xs text-muted-foreground">
                    Buy this number and assign to <strong class="text-foreground">{agentName}</strong>? ($1.00/month)
                  </p>
                  <div class="mt-4 flex justify-center gap-3">
                    <Button variant="outline" onclick={() => (buyTarget = null)} disabled={purchasing}>Cancel</Button>
                    <Button disabled={purchasing} onclick={handleBuyNumber}>
                      {#if purchasing}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                      Buy Number
                    </Button>
                  </div>
                </div>
              </div>
            {/if}
          </section>

          <!-- Call Log -->
          <section>
            <h2 class="mb-4">Recent Calls</h2>
            {#if calls.length === 0}
              <div class="rounded-lg border border-dashed border-border p-8 text-center">
                <p class="text-sm text-muted-foreground">
                  No calls yet. {activeNumbers.length > 0 ? "Try making a test call!" : "Get a phone number first."}
                </p>
              </div>
            {:else}
              <Table>
                {#snippet thead()}
                  <tr>
                    <th class="px-4 py-3">Date</th>
                    <th class="px-4 py-3">Phone Number</th>
                    <th class="px-4 py-3">Duration</th>
                    <th class="px-4 py-3">Status</th>
                    <th class="px-4 py-3 text-right">Cost</th>
                  </tr>
                {/snippet}
                {#snippet tbody()}
                  {#each calls as call}
                    <tr
                      class="cursor-pointer transition-colors hover:bg-muted/50"
                      onclick={() => (expandedCallId = expandedCallId === call.id ? null : call.id)}
                    >
                      <td class="px-4 py-3 text-sm text-foreground">
                        {call.started_at ? new Date(call.started_at).toLocaleDateString() : "--"}
                      </td>
                      <td class="px-4 py-3 text-sm text-foreground">{call.caller || "--"}</td>
                      <td class="px-4 py-3 text-sm text-foreground">{formatDuration(call.duration_seconds)}</td>
                      <td class="px-4 py-3">
                        <Badge variant={call.status === "completed" ? "default" : call.status === "missed" ? "destructive" : "secondary"}>
                          {call.status}
                        </Badge>
                      </td>
                      <td class="px-4 py-3 text-right text-sm text-muted-foreground">
                        {call.cost_usd != null ? `$${call.cost_usd.toFixed(2)}` : "--"}
                      </td>
                    </tr>
                    {#if expandedCallId === call.id && call.summary}
                      <tr>
                        <td colspan="5" class="bg-muted/30 px-4 py-4">
                          <p class="text-xs font-medium text-muted-foreground">Call Summary</p>
                          <p class="mt-1 text-sm leading-relaxed text-foreground">{call.summary}</p>
                        </td>
                      </tr>
                    {/if}
                  {/each}
                {/snippet}
              </Table>
            {/if}
          </section>
        </div>
      {/if}
    </div>
  </div>
</div>
