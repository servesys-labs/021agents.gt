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
    previewVoice,
    uploadVoiceClone,
    listCloneVoices,
    deleteCloneVoice,
    type PhoneNumber,
    type AvailableNumber,
    type CallLog,
    type CloneVoice,
  } from "$lib/services/voice";

  let agentName = $derived($page.params.name ?? "");

  // ── Page state ─────────────────────────────────────────────────────
  let loading = $state(true);
  let savingConfig = $state(false);

  // Voice settings
  let ttsEngine = $state<"kokoro" | "chatterbox" | "sesame" | "workers-ai">("kokoro");
  let voice = $state("af_heart");
  let voiceCloneUrl = $state("");
  let sttEngine = $state<"whisper-gpu" | "groq" | "workers-ai">("whisper-gpu");
  let greeting = $state("Hello! How can I help you today?");
  let language = $state("en");
  let maxDuration = $state("900");
  let speed = $state(1.0);

  // Voice clone
  let cloneVoices = $state<CloneVoice[]>([]);
  let cloneFile = $state<File | null>(null);
  let uploading = $state(false);

  // Preview
  let previewing = $state(false);
  let previewAudioUrl = $state<string | null>(null);

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

  // ── TTS Engine options ───────────────────────────────────────────────
  const ttsEngineOptions = [
    { value: "kokoro", label: "Kokoro — Fast, 54 voices, free" },
    { value: "chatterbox", label: "Chatterbox — Voice Cloning, 23 languages" },
    { value: "sesame", label: "Sesame CSM — Conversational, most natural" },
    { value: "workers-ai", label: "Workers AI — Cloud fallback" },
  ];

  const sttEngineOptions = [
    { value: "whisper-gpu", label: "Whisper V3 Turbo — GPU, 99 languages" },
    { value: "groq", label: "Groq — Cloud, fast" },
    { value: "workers-ai", label: "Workers AI — Cloud fallback" },
  ];

  // ── Kokoro voice groups ──────────────────────────────────────────────
  const kokoroVoiceGroups = [
    {
      label: "English (US)",
      voices: [
        { value: "af_heart", label: "af_heart — Heart (warm)" },
        { value: "af_bella", label: "af_bella — Bella (friendly)" },
        { value: "af_nicole", label: "af_nicole — Nicole (clear)" },
        { value: "af_sarah", label: "af_sarah — Sarah (bright)" },
        { value: "af_sky", label: "af_sky — Sky (airy)" },
        { value: "am_adam", label: "am_adam — Adam (deep)" },
        { value: "am_michael", label: "am_michael — Michael (professional)" },
      ],
    },
    {
      label: "English (UK)",
      voices: [
        { value: "bf_emma", label: "bf_emma — Emma" },
        { value: "bf_isabella", label: "bf_isabella — Isabella" },
        { value: "bm_george", label: "bm_george — George" },
        { value: "bm_lewis", label: "bm_lewis — Lewis" },
      ],
    },
    {
      label: "French",
      voices: [{ value: "ff_siwis", label: "ff_siwis — Siwis" }],
    },
    {
      label: "Japanese",
      voices: [
        { value: "jf_alpha", label: "jf_alpha — Alpha" },
        { value: "jm_gamma", label: "jm_gamma — Gamma" },
      ],
    },
    {
      label: "Chinese",
      voices: [
        { value: "zf_xiaobai", label: "zf_xiaobai — Xiaobai" },
        { value: "zf_xiaoni", label: "zf_xiaoni — Xiaoni" },
        { value: "zm_yunjian", label: "zm_yunjian — Yunjian" },
      ],
    },
    {
      label: "Korean",
      voices: [{ value: "kf_soeun", label: "kf_soeun — Soeun" }],
    },
    {
      label: "Hindi",
      voices: [
        { value: "hf_alpha", label: "hf_alpha — Alpha" },
        { value: "hm_omega", label: "hm_omega — Omega" },
      ],
    },
    {
      label: "Italian",
      voices: [{ value: "if_sara", label: "if_sara — Sara" }],
    },
    {
      label: "Portuguese",
      voices: [{ value: "pf_dora", label: "pf_dora — Dora" }],
    },
  ];

  const sesameVoiceOptions = [
    { value: "speaker_0", label: "Speaker 0" },
    { value: "speaker_1", label: "Speaker 1" },
    { value: "speaker_2", label: "Speaker 2" },
    { value: "speaker_3", label: "Speaker 3" },
  ];

  const workersAiVoiceOptions = [
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
    { value: "ko", label: "Korean" },
    { value: "hi", label: "Hindi" },
    { value: "it", label: "Italian" },
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

  // Build chatterbox voice options from clone voices + default
  let chatterboxVoiceOptions = $derived([
    { value: "default", label: "Default" },
    ...cloneVoices.map((c) => ({ value: c.clone_id, label: c.name })),
  ]);

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

  /** Set default voice when TTS engine changes */
  function handleEngineChange() {
    if (ttsEngine === "kokoro") {
      voice = "af_heart";
    } else if (ttsEngine === "chatterbox") {
      voice = "default";
    } else if (ttsEngine === "sesame") {
      voice = "speaker_0";
    } else if (ttsEngine === "workers-ai") {
      voice = "alloy";
    }
    // Clean up preview audio
    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
      previewAudioUrl = null;
    }
  }

  // ── Load ───────────────────────────────────────────────────────────
  async function loadVoicePage() {
    loading = true;
    try {
      const [config, numbersResp, callsResp, clonesResp] = await Promise.allSettled([
        getVoiceConfig(agentName),
        listPhoneNumbers(agentName),
        listCalls(agentName),
        listCloneVoices(agentName),
      ]);

      if (config.status === "fulfilled") {
        const c = config.value;
        if (c.tts_engine) ttsEngine = c.tts_engine;
        if (c.voice) voice = c.voice;
        if (c.voice_clone_url) voiceCloneUrl = c.voice_clone_url;
        if (c.stt_engine) sttEngine = c.stt_engine;
        if (c.greeting) greeting = c.greeting;
        if (c.language) language = c.language;
        if (c.max_duration != null) maxDuration = String(c.max_duration);
        if (c.speed != null) speed = c.speed;
      }

      if (numbersResp.status === "fulfilled") {
        phoneNumbers = numbersResp.value.numbers ?? [];
      }

      if (callsResp.status === "fulfilled") {
        calls = callsResp.value.calls ?? [];
      }

      if (clonesResp.status === "fulfilled") {
        cloneVoices = clonesResp.value.clones ?? [];
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
        tts_engine: ttsEngine,
        voice,
        voice_clone_url: ttsEngine === "chatterbox" ? voiceCloneUrl : undefined,
        stt_engine: sttEngine,
        greeting,
        language,
        max_duration: parseInt(maxDuration, 10) || 900,
        speed,
      });
      toast.success("Voice settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save voice settings");
    } finally {
      savingConfig = false;
    }
  }

  // ── Preview voice ──────────────────────────────────────────────────
  async function handlePreview() {
    previewing = true;
    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
      previewAudioUrl = null;
    }
    try {
      const blob = await previewVoice(ttsEngine, voice, greeting || undefined);
      previewAudioUrl = URL.createObjectURL(blob);
      // Auto-play
      const audio = new Audio(previewAudioUrl);
      await audio.play();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      previewing = false;
    }
  }

  // ── Upload clone voice ─────────────────────────────────────────────
  async function handleUploadClone() {
    if (!cloneFile) {
      toast.error("Select an audio file first");
      return;
    }
    uploading = true;
    try {
      const result = await uploadVoiceClone(agentName, cloneFile);
      voiceCloneUrl = result.clone_url;
      voice = result.clone_id;
      cloneFile = null;
      // Refresh clone list
      const resp = await listCloneVoices(agentName);
      cloneVoices = resp.clones ?? [];
      toast.success("Voice clone uploaded successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      uploading = false;
    }
  }

  // ── Delete clone voice ─────────────────────────────────────────────
  async function handleDeleteClone(clone: CloneVoice) {
    try {
      await deleteCloneVoice(clone.clone_id);
      cloneVoices = cloneVoices.filter((c) => c.clone_id !== clone.clone_id);
      if (voice === clone.clone_id) {
        voice = "default";
        voiceCloneUrl = "";
      }
      toast.success("Clone voice deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete clone");
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

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      cloneFile = input.files[0];
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

              <!-- TTS Engine -->
              <div>
                <label for="tts-engine" class="mb-2 block text-sm font-medium text-foreground">TTS Engine</label>
                <div class="flex items-start gap-3">
                  <div class="flex-1">
                    <Select
                      id="tts-engine"
                      options={ttsEngineOptions}
                      bind:value={ttsEngine}
                      onchange={handleEngineChange}
                    />
                  </div>
                  <Badge variant="secondary">
                    {#if ttsEngine === "kokoro"}GPU{:else if ttsEngine === "chatterbox"}GPU{:else if ttsEngine === "sesame"}GPU{:else}Cloud{/if}
                  </Badge>
                </div>
              </div>

              <!-- Voice Selector (dynamic by engine) -->
              <div>
                <label for="voice-select" class="mb-2 block text-sm font-medium text-foreground">Voice</label>
                <div class="flex items-center gap-3">
                  <div class="flex-1">
                    {#if ttsEngine === "kokoro"}
                      <!-- Kokoro: grouped native select for optgroup support -->
                      <select
                        id="voice-select"
                        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        bind:value={voice}
                      >
                        {#each kokoroVoiceGroups as group}
                          <optgroup label={group.label}>
                            {#each group.voices as v}
                              <option value={v.value}>{v.label}</option>
                            {/each}
                          </optgroup>
                        {/each}
                      </select>
                    {:else if ttsEngine === "chatterbox"}
                      <Select id="voice-select" options={chatterboxVoiceOptions} bind:value={voice} />
                    {:else if ttsEngine === "sesame"}
                      <Select id="voice-select" options={sesameVoiceOptions} bind:value={voice} />
                    {:else}
                      <Select id="voice-select" options={workersAiVoiceOptions} bind:value={voice} />
                    {/if}
                  </div>
                  <!-- Preview button -->
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={previewing}
                    onclick={handlePreview}
                  >
                    {#if previewing}
                      <span class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground border-t-transparent"></span>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    {/if}
                    Preview
                  </Button>
                </div>
              </div>

              <!-- Voice Clone Section (Chatterbox only) -->
              {#if ttsEngine === "chatterbox"}
                <div class="rounded-lg border border-dashed border-border p-5">
                  <h3 class="mb-3 text-sm font-semibold text-foreground">Voice Cloning</h3>
                  <p class="mb-4 text-xs text-muted-foreground">
                    Upload reference audio (WAV or MP3, 5-30 seconds) to clone a voice.
                  </p>

                  <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div class="flex-1">
                      <label for="clone-upload" class="mb-2 block text-xs font-medium text-muted-foreground">Reference Audio</label>
                      <input
                        id="clone-upload"
                        type="file"
                        accept="audio/wav,audio/mp3,audio/mpeg,audio/x-wav"
                        class="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted"
                        onchange={handleFileInput}
                      />
                    </div>
                    <Button
                      variant="secondary"
                      disabled={uploading || !cloneFile}
                      onclick={handleUploadClone}
                    >
                      {#if uploading}
                        <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent"></span>
                      {:else}
                        <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                      {/if}
                      Upload & Clone
                    </Button>
                  </div>

                  <!-- Existing clone voices -->
                  {#if cloneVoices.length > 0}
                    <div class="mt-4 space-y-2">
                      <p class="text-xs font-medium text-muted-foreground">Cloned Voices</p>
                      {#each cloneVoices as clone}
                        <div class="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
                          <div class="flex items-center gap-3">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>
                            <div>
                              <p class="text-sm font-medium text-foreground">{clone.name}</p>
                              <p class="text-xs text-muted-foreground">{new Date(clone.created_at).toLocaleDateString()}</p>
                            </div>
                          </div>
                          <div class="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onclick={() => { voice = clone.clone_id; voiceCloneUrl = clone.clone_url; }}
                            >
                              Use
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              class="text-destructive hover:text-destructive"
                              onclick={() => handleDeleteClone(clone)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                            </Button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- STT Engine -->
              <div>
                <label for="stt-engine" class="mb-2 block text-sm font-medium text-foreground">STT Engine</label>
                <div class="flex items-start gap-3">
                  <div class="flex-1">
                    <Select id="stt-engine" options={sttEngineOptions} bind:value={sttEngine} />
                  </div>
                  <Badge variant="secondary">
                    {#if sttEngine === "whisper-gpu"}GPU{:else}Cloud{/if}
                  </Badge>
                </div>
              </div>

              <div class="grid gap-6 sm:grid-cols-2">
                <!-- Language -->
                <div>
                  <label for="lang-select" class="mb-2 block text-sm font-medium text-foreground">Language</label>
                  <Select id="lang-select" options={languageOptions} bind:value={language} />
                </div>

                <!-- Max Duration -->
                <div>
                  <label for="max-dur" class="mb-2 block text-sm font-medium text-foreground">Max Call Duration</label>
                  <Select id="max-dur" options={durationOptions} bind:value={maxDuration} />
                </div>
              </div>

              <!-- Greeting -->
              <div>
                <label for="voice-greeting" class="mb-2 block text-sm font-medium text-foreground">Greeting Message</label>
                <Textarea id="voice-greeting" rows={3} placeholder="Hello! How can I help you today?" bind:value={greeting} />
              </div>

              <!-- Speed Slider -->
              <div>
                <label for="speed-slider" class="mb-2 block text-sm font-medium text-foreground">
                  Speech Speed
                  <span class="ml-2 text-xs font-normal text-muted-foreground">{speed.toFixed(1)}x</span>
                </label>
                <div class="flex items-center gap-3">
                  <span class="text-xs text-muted-foreground">0.5x</span>
                  <input
                    id="speed-slider"
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    class="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
                    bind:value={speed}
                  />
                  <span class="text-xs text-muted-foreground">2.0x</span>
                </div>
              </div>

              <!-- Save Button -->
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
