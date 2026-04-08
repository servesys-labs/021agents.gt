<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth.svelte";
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

  // Recording state
  let isRecording = $state(false);
  let recordingDuration = $state(0);
  let recordedBlob = $state<Blob | null>(null);
  let mediaRecorder = $state<MediaRecorder | null>(null);
  let recordingInterval = $state<ReturnType<typeof setInterval> | null>(null);
  let cloneFileInput = $state<HTMLInputElement | null>(null);

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

  // ── Kokoro voice groups (verified against actual model voices) ───────
  const kokoroVoiceGroups = [
    {
      label: "English (US)",
      voices: [
        { value: "af_heart", label: "Heart — warm, friendly (F)" },
        { value: "af_bella", label: "Bella — bright (F)" },
        { value: "af_nicole", label: "Nicole — clear (F)" },
        { value: "af_sarah", label: "Sarah — soft (F)" },
        { value: "af_sky", label: "Sky — airy (F)" },
        { value: "af_nova", label: "Nova — energetic (F)" },
        { value: "af_jessica", label: "Jessica — neutral (F)" },
        { value: "af_river", label: "River — calm (F)" },
        { value: "am_adam", label: "Adam — deep (M)" },
        { value: "am_michael", label: "Michael — professional (M)" },
        { value: "am_echo", label: "Echo — resonant (M)" },
        { value: "am_eric", label: "Eric — warm (M)" },
        { value: "am_liam", label: "Liam — youthful (M)" },
      ],
    },
    {
      label: "English (UK)",
      voices: [
        { value: "bf_emma", label: "Emma (F)" },
        { value: "bf_isabella", label: "Isabella (F)" },
        { value: "bf_alice", label: "Alice (F)" },
        { value: "bf_lily", label: "Lily (F)" },
        { value: "bm_george", label: "George (M)" },
        { value: "bm_lewis", label: "Lewis (M)" },
        { value: "bm_daniel", label: "Daniel (M)" },
      ],
    },
    {
      label: "French",
      voices: [{ value: "ff_siwis", label: "Siwis (F)" }],
    },
    {
      label: "Japanese",
      voices: [
        { value: "jf_alpha", label: "Alpha (F)" },
        { value: "jf_gongitsune", label: "Gongitsune (F)" },
        { value: "jf_nezumi", label: "Nezumi (F)" },
        { value: "jm_kumo", label: "Kumo (M)" },
      ],
    },
    {
      label: "Chinese",
      voices: [
        { value: "zf_xiaobei", label: "Xiaobei (F)" },
        { value: "zf_xiaoni", label: "Xiaoni (F)" },
        { value: "zf_xiaoxiao", label: "Xiaoxiao (F)" },
        { value: "zf_xiaoyi", label: "Xiaoyi (F)" },
        { value: "zm_yunjian", label: "Yunjian (M)" },
        { value: "zm_yunxi", label: "Yunxi (M)" },
        { value: "zm_yunyang", label: "Yunyang (M)" },
      ],
    },
    {
      label: "Hindi",
      voices: [
        { value: "hf_alpha", label: "Alpha (F)" },
        { value: "hf_beta", label: "Beta (F)" },
        { value: "hm_omega", label: "Omega (M)" },
        { value: "hm_psi", label: "Psi (M)" },
      ],
    },
    {
      label: "Italian",
      voices: [
        { value: "if_sara", label: "Sara (F)" },
        { value: "im_nicola", label: "Nicola (M)" },
      ],
    },
    {
      label: "Portuguese",
      voices: [
        { value: "pf_dora", label: "Dora (F)" },
        { value: "pm_alex", label: "Alex (M)" },
      ],
    },
    {
      label: "Spanish",
      voices: [
        { value: "ef_dora", label: "Dora (F)" },
        { value: "em_alex", label: "Alex (M)" },
      ],
    },
  ];

  // Sesame CSM expects numeric speaker IDs, not "speaker_0" prefix
  const sesameVoiceOptions = [
    { value: "0", label: "Speaker 0 — Primary" },
    { value: "1", label: "Speaker 1" },
    { value: "2", label: "Speaker 2" },
    { value: "3", label: "Speaker 3" },
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
      voice = "0";
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
    let fileToUpload: File | null = null;

    if (recordedBlob) {
      // Convert recorded blob to a File object for the upload API
      fileToUpload = new File([recordedBlob], "recording.webm", { type: "audio/webm" });
    } else if (cloneFile) {
      fileToUpload = cloneFile;
    }

    if (!fileToUpload) {
      toast.error("Record or upload audio first");
      return;
    }

    uploading = true;
    try {
      const result = await uploadVoiceClone(agentName, fileToUpload);
      voiceCloneUrl = result.clone_url;
      voice = result.clone_id;
      cloneFile = null;
      recordedBlob = null;
      recordingDuration = 0;
      // Refresh clone list
      const resp = await listCloneVoices(agentName);
      cloneVoices = resp.clones ?? [];
      toast.success("Voice cloned successfully");
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

  // ── Recording functions ─────────────────────────────────────────────
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        recordedBlob = new Blob(chunks, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start();
      mediaRecorder = recorder;
      isRecording = true;
      recordingDuration = 0;
      recordingInterval = setInterval(() => {
        recordingDuration++;
        if (recordingDuration >= 30) stopRecording();
      }, 1000);
    } catch {
      toast.error("Microphone access denied");
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    isRecording = false;
    if (recordingInterval) {
      clearInterval(recordingInterval);
      recordingInterval = null;
    }
  }

  function clearRecording() {
    recordedBlob = null;
    recordingDuration = 0;
  }

  function playRecording() {
    if (recordedBlob) {
      const url = URL.createObjectURL(recordedBlob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
    }
  }

  function playUploadedFile() {
    if (cloneFile) {
      const url = URL.createObjectURL(cloneFile);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
    }
  }

  async function previewCloneVoice(clone: CloneVoice) {
    try {
      const blob = await previewVoice("chatterbox", clone.clone_id, greeting || undefined);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    }
  }

  // ── Test call state ───────────────────────────────────────────────
  let testCallActive = $state(false);
  let testCallDuration = $state(0);
  let testCallInterval: ReturnType<typeof setInterval> | null = null;
  let testTranscript = $state<Array<{ speaker: "user" | "agent"; text: string }>>([]);
  let testProcessing = $state(false);
  let testStatusMessage = $state("");
  let testAudioQueue: string[] = [];  // URLs queued for sequential playback
  let testAudioPlaying = false;

  function playNextAudioChunk() {
    if (testAudioQueue.length === 0) {
      testAudioPlaying = false;
      // All audio played — resume listening
      if (testCallActive) {
        testListening = true;
        startTestRecordingChunk();
      }
      return;
    }

    testAudioPlaying = true;
    const audioUrl = testAudioQueue.shift()!;
    const audio = new Audio(audioUrl);
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      playNextAudioChunk(); // Play next chunk
    };
    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      playNextAudioChunk(); // Skip failed chunk
    };
    audio.play().catch(() => {
      URL.revokeObjectURL(audioUrl);
      playNextAudioChunk();
    });
  }
  let testListening = $state(false);
  let testMuted = $state(false);
  let testWs: WebSocket | null = null;
  let testMediaRecorder: MediaRecorder | null = null;
  let testStream: MediaStream | null = null;
  let testAudioCtx: AudioContext | null = null;
  let testScrollContainer = $state<HTMLDivElement | null>(null);

  function formatTestDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  async function startTestCall() {
    try {
      // Request microphone access
      testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("Microphone access denied. Please allow microphone access and try again.");
      return;
    }

    try {
      // Build WebSocket URL with current voice settings
      const orgId = authStore.user?.org_id || "";
      const params = new URLSearchParams({
        agent: agentName,
        org_id: orgId,
        tts_engine: ttsEngine,
        voice: voice,
        stt_engine: sttEngine,
        greeting: greeting || "",
        speed: String(speed),
      });

      // Connect to runtime WebSocket (same origin as API, /voice/test path)
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//runtime.oneshots.co/voice/test?${params}`;
      testWs = new WebSocket(wsUrl);

      testWs.onopen = () => {
        testCallActive = true;
        testCallDuration = 0;
        testTranscript = [];
        testProcessing = false;
        testMuted = false;
        testCallInterval = setInterval(() => testCallDuration++, 1000);
        testListening = true;

        // Create AudioContext for playback
        testAudioCtx = new AudioContext();

        // Start recording after a brief delay (let greeting arrive first)
        setTimeout(() => startTestRecordingChunk(), 500);
      };

      testWs.onmessage = (event) => {
        let msg: { type: string; speaker?: string; text?: string; data?: string; message?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "transcript") {
          testTranscript = [
            ...testTranscript,
            { speaker: (msg.speaker as "user" | "agent") || "agent", text: msg.text || "" },
          ];
          if (msg.speaker === "agent") {
            testProcessing = false;
          }
          // Auto-scroll transcript
          requestAnimationFrame(() => {
            if (testScrollContainer) {
              testScrollContainer.scrollTop = testScrollContainer.scrollHeight;
            }
          });
        }

        if (msg.type === "audio" && msg.data) {
          // Queue audio chunks and play them in sequence (sentence-by-sentence streaming)
          testListening = false;
          testProcessing = false;

          // Stop any ongoing recording while agent speaks
          if (testMediaRecorder?.state === "recording") {
            testMediaRecorder.stop();
          }

          try {
            const raw = atob(msg.data);
            const audioBytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) {
              audioBytes[i] = raw.charCodeAt(i);
            }
            const blob = new Blob([audioBytes], { type: "audio/wav" });
            const audioUrl = URL.createObjectURL(blob);

            // Add to audio queue
            testAudioQueue.push(audioUrl);

            // Start playing if not already
            if (!testAudioPlaying) {
              playNextAudioChunk();
            }
          } catch {
            if (testCallActive) {
              testListening = true;
              startTestRecordingChunk();
            }
          }
        }

        if (msg.type === "status") {
          // Show pipeline progress to the user
          testStatusMessage = msg.message || "";
          if (msg.step === "stt" && msg.message?.includes("No speech")) {
            // No speech detected — resume recording
            testProcessing = false;
            testListening = true;
            testStatusMessage = "";
            startTestRecordingChunk();
          }
        }

        if (msg.type === "error") {
          toast.error(msg.message || "Voice test error");
          testProcessing = false;
          testListening = true;
          testStatusMessage = "";
          // Resume recording after error so the user can try again
          if (testCallActive) startTestRecordingChunk();
        }
      };

      testWs.onclose = () => {
        if (testCallActive) endTestCall();
      };

      testWs.onerror = () => {
        toast.error("Connection to voice server failed");
        endTestCall();
      };
    } catch (err) {
      toast.error("Failed to start test call");
      if (testStream) {
        testStream.getTracks().forEach((t) => t.stop());
        testStream = null;
      }
    }
  }

  function startTestRecordingChunk() {
    if (!testStream || testMuted || !testCallActive || !testWs) return;
    if (testWs.readyState !== WebSocket.OPEN) return;

    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(testStream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        if (chunks.length === 0 || !testWs || testWs.readyState !== WebSocket.OPEN) return;

        const blob = new Blob(chunks, { type: mimeType });
        // Only send if VAD detected actual speech (not just ambient noise)
        if (!hasSpeech || speechDuration < SPEECH_MIN_DURATION || blob.size < 1000) {
          // No meaningful speech — restart recording silently
          if (testCallActive && testListening) {
            setTimeout(() => startTestRecordingChunk(), 300);
          }
          return;
        }

        testProcessing = true;
        testListening = false;

        try {
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          // Base64 encode in chunks to avoid call stack issues
          let b64 = "";
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          b64 = btoa(b64);
          testWs.send(JSON.stringify({ type: "audio", data: b64 }));
        } catch {
          testProcessing = false;
          if (testCallActive && testListening) startTestRecordingChunk();
        }
      };

      recorder.start();
      testMediaRecorder = recorder;

      // VAD-inspired recording: record for up to 5 seconds but use AudioAnalyser
      // to detect when speech ends (volume drops below threshold for 1 second)
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(testStream!);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      let silenceStart = 0;
      let hasSpeech = false;
      let speechDuration = 0; // ms of actual speech detected
      const SILENCE_THRESHOLD = 25; // volume level below this = silence (raised from 15)
      const SPEECH_MIN_DURATION = 500; // must have at least 500ms of speech to send
      const SILENCE_DURATION = 1500; // ms of silence before stopping (raised from 1200)
      const MAX_DURATION = 8000; // max recording length
      const NO_SPEECH_TIMEOUT = 6000; // stop recording if no speech after 6s
      const startTime = Date.now();

      const vadCheck = setInterval(() => {
        if (recorder.state !== "recording") { clearInterval(vadCheck); audioCtx.close(); return; }

        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (avg > SILENCE_THRESHOLD) {
          hasSpeech = true;
          speechDuration += 100; // each check is ~100ms
          silenceStart = 0;
        } else if (hasSpeech && silenceStart === 0) {
          silenceStart = Date.now();
        }

        const elapsed = Date.now() - startTime;

        // Auto-stop on prolonged silence (no speech detected at all)
        if (!hasSpeech && elapsed > NO_SPEECH_TIMEOUT) {
          clearInterval(vadCheck);
          audioCtx.close();
          if (recorder.state === "recording") recorder.stop();
          return;
        }

        // Stop when: enough speech + silence pause, OR max duration
        const speechComplete = hasSpeech && speechDuration >= SPEECH_MIN_DURATION && silenceStart > 0 && Date.now() - silenceStart > SILENCE_DURATION;
        if (speechComplete || elapsed > MAX_DURATION) {
          clearInterval(vadCheck);
          audioCtx.close();
          if (recorder.state === "recording") recorder.stop();
        }
      }, 100);
    } catch {
      // MediaRecorder failed
      if (testCallActive && testListening) {
        setTimeout(() => startTestRecordingChunk(), 1000);
      }
    }
  }

  function toggleTestMute() {
    testMuted = !testMuted;
    if (testStream) {
      testStream.getAudioTracks().forEach((t) => (t.enabled = !testMuted));
    }
    if (testMuted) {
      // Stop active recording
      if (testMediaRecorder?.state === "recording") {
        testMediaRecorder.stop();
      }
    } else if (testCallActive && testListening) {
      startTestRecordingChunk();
    }
  }

  function endTestCall() {
    testCallActive = false;
    testListening = false;
    testProcessing = false;

    if (testCallInterval) {
      clearInterval(testCallInterval);
      testCallInterval = null;
    }

    if (testMediaRecorder?.state === "recording") {
      try { testMediaRecorder.stop(); } catch { /* ignore */ }
    }
    testMediaRecorder = null;

    if (testStream) {
      testStream.getTracks().forEach((t) => t.stop());
      testStream = null;
    }

    if (testWs) {
      try { testWs.close(); } catch { /* ignore */ }
      testWs = null;
    }

    if (testAudioCtx) {
      try { testAudioCtx.close(); } catch { /* ignore */ }
      testAudioCtx = null;
    }
  }

  $effect(() => {
    if (agentName) loadVoicePage();
  });
</script>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="w-full px-6 py-8 lg:px-8">
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
          <!-- 1. Text-to-Speech -->
          <section>
            <div class="mb-4">
              <h2>Text-to-Speech</h2>
              <p class="mt-1 text-sm text-muted-foreground">How your agent sounds when speaking</p>
            </div>
            <div class="space-y-6 rounded-lg border border-border p-6">

              <!-- Engine selector as visual cards -->
              <div>
                <p class="mb-3 text-sm font-medium text-foreground">Engine</p>
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <!-- Kokoro -->
                  <button
                    type="button"
                    class="relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 {ttsEngine === 'kokoro' ? 'ring-2 ring-primary border-primary' : 'border-border'}"
                    onclick={() => { ttsEngine = 'kokoro'; handleEngineChange(); }}
                  >
                    <div class="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-lg">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    </div>
                    <p class="text-sm font-semibold text-foreground">Kokoro</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">Fast · 54 voices · 9 languages</p>
                    <Badge variant="secondary" class="mt-2 text-[10px]">GPU · Free</Badge>
                  </button>

                  <!-- Chatterbox -->
                  <button
                    type="button"
                    class="relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 {ttsEngine === 'chatterbox' ? 'ring-2 ring-primary border-primary' : 'border-border'}"
                    onclick={() => { ttsEngine = 'chatterbox'; handleEngineChange(); }}
                  >
                    <div class="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-violet-500/10 text-lg">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>
                    </div>
                    <p class="text-sm font-semibold text-foreground">Chatterbox</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">Voice cloning · 23 languages</p>
                    <Badge variant="secondary" class="mt-2 text-[10px]">GPU</Badge>
                  </button>

                  <!-- Sesame CSM -->
                  <button
                    type="button"
                    class="relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 {ttsEngine === 'sesame' ? 'ring-2 ring-primary border-primary' : 'border-border'}"
                    onclick={() => { ttsEngine = 'sesame'; handleEngineChange(); }}
                  >
                    <div class="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/10 text-lg">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                    </div>
                    <p class="text-sm font-semibold text-foreground">Sesame CSM</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">Most natural · Conversational</p>
                    <Badge variant="secondary" class="mt-2 text-[10px]">GPU · Premium</Badge>
                  </button>

                  <!-- Workers AI (Cloud) -->
                  <button
                    type="button"
                    class="relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 {ttsEngine === 'workers-ai' ? 'ring-2 ring-primary border-primary' : 'border-border'}"
                    onclick={() => { ttsEngine = 'workers-ai'; handleEngineChange(); }}
                  >
                    <div class="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-sky-500/10 text-lg">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-sky-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 17.929H6.862c-2.13 0-3.862-1.591-3.862-3.571 0-1.98 1.731-3.572 3.862-3.572h.286C7.631 8.07 10.054 6 13 6c3.314 0 6 2.686 6 6v.286c1.727.444 3 2.01 3 3.857 0 1.98-1.731 3.571-3.862 3.571H16" /></svg>
                    </div>
                    <p class="text-sm font-semibold text-foreground">Cloud</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">Deepgram Aura · Fallback</p>
                    <Badge variant="secondary" class="mt-2 text-[10px]">Cloud</Badge>
                  </button>
                </div>
              </div>

              <!-- Voice + Speed + Preview row -->
              <div class="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_auto]">
                <!-- Voice selector -->
                <div>
                  <label for="voice-select" class="mb-2 block text-sm font-medium text-foreground">Voice</label>
                  {#if ttsEngine === "kokoro"}
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

                <!-- Speed (compact) -->
                <div class="w-28">
                  <label for="speed-slider" class="mb-2 block text-sm font-medium text-foreground">Speed</label>
                  <div class="flex items-center gap-2">
                    <input
                      id="speed-slider"
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.1"
                      class="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
                      bind:value={speed}
                    />
                    <span class="w-8 text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
                  </div>
                </div>

                <!-- Preview button -->
                <Button
                  variant="outline"
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

              <!-- Voice Clone panel (Chatterbox only) -->
              {#if ttsEngine === "chatterbox"}
                <div class="mt-6 rounded-lg border border-border bg-card/50 p-6">
                  <div class="mb-4 flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-full bg-violet-500/10">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>
                    </div>
                    <div>
                      <h3 class="text-sm font-semibold">Voice Cloning</h3>
                      <p class="text-xs text-muted-foreground">Record or upload 5-30 seconds of clear speech to clone a voice</p>
                    </div>
                  </div>

                  <!-- Two options: Record or Upload -->
                  <div class="mb-4 grid gap-4 sm:grid-cols-2">

                    <!-- Option 1: Record from microphone -->
                    <div class="rounded-lg border border-dashed border-border p-4 text-center">
                      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-8 w-8 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>
                      <p class="mt-2 text-sm font-medium">Record Voice</p>
                      <p class="mb-3 text-xs text-muted-foreground">Use your microphone</p>

                      {#if !isRecording}
                        <Button variant="outline" size="sm" onclick={startRecording}>
                          <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-3 w-3 text-red-500" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /></svg>
                          Start Recording
                        </Button>
                      {:else}
                        <div class="space-y-2">
                          <div class="flex items-center justify-center gap-2">
                            <span class="h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
                            <span class="text-sm font-medium text-red-500">Recording... {recordingDuration}s</span>
                          </div>
                          <Button variant="destructive" size="sm" onclick={stopRecording}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                            Stop Recording
                          </Button>
                        </div>
                      {/if}

                      {#if recordedBlob}
                        <div class="mt-3 flex items-center justify-center gap-2">
                          <Button variant="ghost" size="sm" onclick={playRecording}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                            Play
                          </Button>
                          <Button variant="ghost" size="sm" onclick={clearRecording}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                            Clear
                          </Button>
                        </div>
                        <p class="mt-1 text-xs text-muted-foreground">{recordingDuration}s recorded</p>
                      {/if}
                    </div>

                    <!-- Option 2: Upload file -->
                    <div class="rounded-lg border border-dashed border-border p-4 text-center">
                      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-8 w-8 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                      <p class="mt-2 text-sm font-medium">Upload Audio</p>
                      <p class="mb-3 text-xs text-muted-foreground">WAV or MP3 file</p>
                      <input
                        type="file"
                        accept="audio/wav,audio/mp3,audio/mpeg,audio/x-wav,audio/*"
                        class="hidden"
                        bind:this={cloneFileInput}
                        onchange={handleFileInput}
                      />
                      <Button variant="outline" size="sm" onclick={() => cloneFileInput?.click()}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                        Choose File
                      </Button>
                      {#if cloneFile}
                        <p class="mt-2 text-xs text-muted-foreground truncate max-w-[200px] mx-auto">
                          {cloneFile.name} ({(cloneFile.size / 1024).toFixed(0)} KB)
                        </p>
                        <div class="mt-1 flex items-center justify-center gap-2">
                          <Button variant="ghost" size="sm" onclick={playUploadedFile}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                            Play
                          </Button>
                          <Button variant="ghost" size="sm" onclick={() => { cloneFile = null; }}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="mr-1 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            Remove
                          </Button>
                        </div>
                      {/if}
                    </div>
                  </div>

                  <!-- Clone button (shown when we have audio from either source) -->
                  {#if recordedBlob || cloneFile}
                    <Button class="w-full" disabled={uploading} onclick={handleUploadClone}>
                      {#if uploading}
                        <span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
                        Cloning Voice...
                      {:else}
                        <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>
                        Clone This Voice
                      {/if}
                    </Button>
                  {/if}

                  <!-- Existing cloned voices -->
                  {#if cloneVoices.length > 0}
                    <div class="mt-6">
                      <p class="mb-2 text-xs font-semibold text-muted-foreground">Your Cloned Voices</p>
                      {#each cloneVoices as clone}
                        <div class="mb-2 flex items-center justify-between rounded-md border border-border px-3 py-2">
                          <div class="flex items-center gap-3">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>
                            <div>
                              <p class="text-sm font-medium text-foreground">{clone.name}</p>
                              <p class="text-xs text-muted-foreground">{new Date(clone.created_at).toLocaleDateString()}</p>
                            </div>
                          </div>
                          <div class="flex items-center gap-1">
                            <Button size="icon" variant="ghost" onclick={() => previewCloneVoice(clone)}>
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                            </Button>
                            <Button size="sm" variant="ghost" onclick={() => { voice = clone.clone_id; voiceCloneUrl = clone.clone_url; }}>
                              Use
                            </Button>
                            <Button
                              size="icon"
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
            </div>
          </section>

          <!-- 2. Speech Recognition -->
          <section>
            <div class="mb-4">
              <h2>Speech Recognition</h2>
              <p class="mt-1 text-sm text-muted-foreground">How your agent understands speech</p>
            </div>
            <div class="space-y-6 rounded-lg border border-border p-6">
              <div class="grid gap-6 sm:grid-cols-2">
                <!-- STT Engine -->
                <div>
                  <label for="stt-engine" class="mb-2 block text-sm font-medium text-foreground">Engine</label>
                  <Select id="stt-engine" options={sttEngineOptions} bind:value={sttEngine} />
                  <p class="mt-1.5 text-xs text-muted-foreground">
                    {#if sttEngine === "whisper-gpu"}
                      Whisper V3 Turbo on GPU · 99 languages · ~170ms latency
                    {:else if sttEngine === "groq"}
                      Groq Cloud API · Fast · Requires API key
                    {:else}
                      Cloudflare Workers AI · Free fallback
                    {/if}
                  </p>
                </div>

                <!-- Language -->
                <div>
                  <label for="lang-select" class="mb-2 block text-sm font-medium text-foreground">Language</label>
                  <Select id="lang-select" options={languageOptions} bind:value={language} />
                </div>
              </div>
            </div>
          </section>

          <!-- 3. Call Settings -->
          <section>
            <div class="mb-4">
              <h2>Call Settings</h2>
              <p class="mt-1 text-sm text-muted-foreground">Configure how phone calls work</p>
            </div>
            <div class="space-y-6 rounded-lg border border-border p-6">
              <!-- Greeting -->
              <div>
                <label for="voice-greeting" class="mb-2 block text-sm font-medium text-foreground">Greeting Message</label>
                <p class="mb-2 text-xs text-muted-foreground">What callers hear when they connect</p>
                <Textarea id="voice-greeting" rows={3} placeholder="Hello! How can I help you today?" bind:value={greeting} />
              </div>

              <!-- Max Duration -->
              <div class="max-w-xs">
                <label for="max-dur" class="mb-2 block text-sm font-medium text-foreground">Max Call Duration</label>
                <Select id="max-dur" options={durationOptions} bind:value={maxDuration} />
              </div>
            </div>
          </section>

          <!-- Save button for all sections -->
          <div class="flex justify-end pt-4">
            <Button disabled={savingConfig} onclick={saveVoiceSettings}>
              {#if savingConfig}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
              Save Voice Settings
            </Button>
          </div>

          <!-- Test Call -->
          <section>
            <div class="mb-4">
              <h2>Test Your Voice Agent</h2>
              <p class="mt-1 text-sm text-muted-foreground">
                Talk to your agent directly from the browser — no phone needed
              </p>
            </div>

            <div class="rounded-lg border border-border bg-card/50 p-6">
              {#if !testCallActive}
                <!-- Idle state -->
                <div class="flex flex-col items-center py-6">
                  <div class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
                    </svg>
                  </div>
                  <p class="mb-1 text-sm font-medium text-foreground">Browser Voice Test</p>
                  <p class="mb-5 max-w-sm text-center text-xs text-muted-foreground">
                    Test your agent's voice, personality, and response quality with a live conversation using your microphone and speakers.
                  </p>
                  <Button size="lg" onclick={startTestCall}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
                    </svg>
                    Start Test Call
                  </Button>
                </div>
              {:else}
                <!-- Active call state -->
                <div class="flex flex-col items-center">
                  <!-- Call status indicator -->
                  <div class="mb-3">
                    <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10">
                      <div class="h-10 w-10 rounded-full bg-green-500/20 flex items-center justify-center animate-pulse">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                  <p class="mb-1 text-sm font-semibold text-green-600 dark:text-green-400">Call Active</p>
                  <p class="mb-4 text-xs tabular-nums text-muted-foreground">{formatTestDuration(testCallDuration)}</p>

                  <!-- Conversation transcript -->
                  <div
                    bind:this={testScrollContainer}
                    class="mb-4 w-full max-w-lg rounded-lg border border-border bg-background p-4 text-left"
                    style="max-height: 280px; overflow-y: auto;"
                  >
                    {#if testTranscript.length === 0 && !testProcessing}
                      <p class="py-4 text-center text-xs text-muted-foreground">
                        {#if testListening}
                          Listening... start speaking.
                        {:else}
                          Connecting...
                        {/if}
                      </p>
                    {/if}

                    {#each testTranscript as msg, i}
                      <div class="mb-2 flex {msg.speaker === 'user' ? 'justify-end' : 'justify-start'}">
                        <div class="max-w-[85%]">
                          <p class="mb-0.5 text-[10px] font-medium uppercase tracking-wider {msg.speaker === 'user' ? 'text-right text-muted-foreground' : 'text-muted-foreground'}">
                            {msg.speaker === "user" ? "You" : agentName}
                          </p>
                          <span
                            class="inline-block rounded-2xl px-3.5 py-2 text-sm leading-relaxed {msg.speaker === 'user'
                              ? 'rounded-br-md bg-primary text-primary-foreground'
                              : 'rounded-bl-md bg-muted text-foreground'}"
                          >
                            {msg.text}
                          </span>
                        </div>
                      </div>
                    {/each}

                    {#if testProcessing}
                      <div class="flex justify-start">
                        <div>
                          <p class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{agentName}</p>
                          <span class="inline-block rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm text-muted-foreground">
                            <span class="inline-flex items-center gap-1">
                              <span class="h-1.5 w-1.5 rounded-full bg-current animate-bounce" style="animation-delay: 0ms"></span>
                              <span class="h-1.5 w-1.5 rounded-full bg-current animate-bounce" style="animation-delay: 150ms"></span>
                              <span class="h-1.5 w-1.5 rounded-full bg-current animate-bounce" style="animation-delay: 300ms"></span>
                            </span>
                          </span>
                        </div>
                      </div>
                    {/if}
                  </div>

                  <!-- Recording / speaking indicator -->
                  <div class="mb-4 flex items-center gap-2">
                    {#if testListening && !testMuted}
                      <span class="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse"></span>
                      <span class="text-xs text-muted-foreground">Listening...</span>
                    {:else if testProcessing}
                      <span class="h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse"></span>
                      <span class="text-xs text-muted-foreground">{testStatusMessage || "Processing..."}</span>
                    {:else if testMuted}
                      <span class="h-2.5 w-2.5 rounded-full bg-gray-400"></span>
                      <span class="text-xs text-muted-foreground">Muted</span>
                    {:else}
                      <span class="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse"></span>
                      <span class="text-xs text-muted-foreground">Agent speaking...</span>
                    {/if}
                  </div>

                  <!-- Controls -->
                  <div class="flex items-center gap-3">
                    <Button variant="outline" size="sm" onclick={toggleTestMute}>
                      {#if testMuted}
                        <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 19L5 5m14 0l-3.5 3.5M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v4m-4 1v1a7 7 0 0011.46 5.38M5 10v1a7 7 0 001.54 4.38" />
                        </svg>
                        Unmute
                      {:else}
                        <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 10v1a7 7 0 01-14 0v-1" />
                          <line x1="12" y1="18" x2="12" y2="22" />
                          <line x1="8" y1="22" x2="16" y2="22" />
                        </svg>
                        Mute
                      {/if}
                    </Button>
                    <Button variant="destructive" size="sm" onclick={endTestCall}>
                      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 4.478v.227a48.816 48.816 0 013.878.512.75.75 0 01.572.894l-.372 1.86a.75.75 0 01-.94.554 47.383 47.383 0 00-12.28 0 .75.75 0 01-.94-.554l-.372-1.86a.75.75 0 01.572-.894 48.816 48.816 0 013.878-.512v-.227a2.25 2.25 0 014.5 0z" />
                      </svg>
                      End Call
                    </Button>
                  </div>
                </div>
              {/if}
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
