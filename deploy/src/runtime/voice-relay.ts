/**
 * Twilio Media Stream ↔ GPU STT/TTS voice relay.
 *
 * Replaces Vapi for real-time voice agent conversations.
 *
 * Flow:
 *   Twilio call → TwiML connects WebSocket → this relay
 *   → audio chunks → Whisper STT (GPU) → text
 *   → agent processes text → response text
 *   → Kokoro/Sesame TTS (GPU) → audio
 *   → relay streams audio back to Twilio → caller hears response
 *
 * Twilio Media Stream protocol:
 *   - Sends "connected", "start", "media", "stop" events
 *   - "media" events contain base64 mulaw 8kHz audio
 *   - We send back "media" events with base64 audio to play to the caller
 */

import type { RuntimeEnv } from "./types";

// ── Types ───────────────────────────────────────────────────────────────────

interface TwilioMediaMessage {
  event: "connected" | "start" | "media" | "stop" | "mark";
  sequenceNumber?: string;
  start?: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    tracks: string[];
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64 mulaw audio
  };
  stop?: { accountSid: string; callSid: string };
  mark?: { name: string };
  streamSid?: string;
}

interface VoiceRelayConfig {
  ttsEngine: string;       // "kokoro" | "chatterbox" | "sesame"
  ttsVoice: string;        // voice ID within the engine
  sttEngine: string;       // "whisper-gpu" | "groq" | "workers-ai"
  greeting: string;
  agentName: string;
  serviceToken: string;
  speed: number;
}

// ── Audio buffer for STT ────────────────────────────────────────────────────

const BUFFER_DURATION_MS = 2000; // Send to STT every 2 seconds of audio
const MULAW_SAMPLE_RATE = 8000;
const MULAW_BYTES_PER_MS = MULAW_SAMPLE_RATE / 1000;
const BUFFER_SIZE = BUFFER_DURATION_MS * MULAW_BYTES_PER_MS; // 16000 bytes

// ── TTS endpoint mapping ────────────────────────────────────────────────────

const TTS_ENDPOINTS: Record<string, string> = {
  kokoro: "https://tts.oneshots.co/v1/audio/speech",
  chatterbox: "https://tts-clone.oneshots.co/v1/audio/speech",
  sesame: "https://tts-voice.oneshots.co/v1/audio/speech",
};

// ── Main relay handler ──────────────────────────────────────────────────────

/**
 * Handle a Twilio Media Stream WebSocket connection.
 * Called from the Durable Object's WebSocket handler.
 */
export function createVoiceRelay(
  ws: WebSocket,
  config: VoiceRelayConfig,
  onTranscript: (text: string) => Promise<string>, // agent callback: text in → response text out
) {
  let streamSid = "";
  let callSid = "";
  let audioBuffer = new Uint8Array(0);
  let isProcessing = false;
  let isSpeaking = false;
  const pendingSpeech: string[] = [];
  const authHeaders: Record<string, string> = config.serviceToken
    ? { Authorization: `Bearer ${config.serviceToken}` }
    : {};

  // Send greeting on connect
  let greetingSent = false;
  let greetingTimer: ReturnType<typeof setTimeout> | null = null;

  async function sendAudioToTwilio(audioBase64: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: audioBase64 },
    }));
  }

  async function sendMarkToTwilio(name: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      event: "mark",
      streamSid,
      mark: { name },
    }));
  }

  async function speakText(text: string) {
    if (!text.trim()) return;
    if (isSpeaking) {
      pendingSpeech.push(text);
      return;
    }
    isSpeaking = true;

    try {
      const ttsUrl = TTS_ENDPOINTS[config.ttsEngine] || TTS_ENDPOINTS.kokoro;
      const resp = await fetch(ttsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          input: text,
          voice: config.ttsVoice,
          model: config.ttsEngine,
          response_format: "mulaw",  // Twilio needs mulaw 8kHz
          sample_rate: 8000,
        }),
      });

      if (resp.ok) {
        const audioBytes = new Uint8Array(await resp.arrayBuffer());
        // Send in chunks of 320 bytes (20ms of 8kHz mulaw)
        const chunkSize = 320;
        for (let i = 0; i < audioBytes.length; i += chunkSize) {
          const chunk = audioBytes.slice(i, i + chunkSize);
          const b64 = btoa(String.fromCharCode(...chunk));
          await sendAudioToTwilio(b64);
        }
        await sendMarkToTwilio("speech-done");
      }
    } catch (err) {
      console.error("[voice-relay] TTS failed:", err);
    } finally {
      isSpeaking = false;
      // Process next queued speech
      const next = pendingSpeech.shift();
      if (next) {
        speakText(next);
      }
    }
  }

  async function processAudioBuffer() {
    if (isProcessing || audioBuffer.length < BUFFER_SIZE) return;
    isProcessing = true;

    try {
      // Extract buffer for STT
      const chunk = audioBuffer.slice(0, BUFFER_SIZE);
      audioBuffer = audioBuffer.slice(BUFFER_SIZE);

      // Convert mulaw buffer to WAV for Whisper
      const wavBytes = mulawToWav(chunk, MULAW_SAMPLE_RATE);

      // Send to STT
      const formData = new FormData();
      formData.append("file", new Blob([wavBytes], { type: "audio/wav" }), "audio.wav");
      formData.append("response_format", "json");

      const sttUrl = "https://stt.oneshots.co/v1/audio/transcriptions";
      const resp = await fetch(sttUrl, {
        method: "POST",
        headers: authHeaders,
        body: formData,
      });

      if (resp.ok) {
        const data = await resp.json() as { text?: string };
        const transcript = (data.text || "").trim();

        if (transcript.length > 2) {
          // Got valid transcript — send to agent
          const agentResponse = await onTranscript(transcript);
          if (agentResponse.trim()) {
            await speakText(agentResponse);
          }
        }
      }
    } catch (err) {
      console.error("[voice-relay] STT processing failed:", err);
    } finally {
      isProcessing = false;
    }
  }

  // Handle incoming Twilio messages
  return {
    async handleMessage(data: string) {
      let msg: TwilioMediaMessage;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      switch (msg.event) {
        case "connected":
          console.log("[voice-relay] Twilio connected");
          break;

        case "start":
          streamSid = msg.start?.streamSid || "";
          callSid = msg.start?.callSid || "";
          console.log(`[voice-relay] Stream started: ${streamSid}, call: ${callSid}`);

          // Send greeting
          if (config.greeting && !greetingSent) {
            greetingSent = true;
            greetingTimer = setTimeout(() => {
              greetingTimer = null;
              speakText(config.greeting);
            }, 500);
          }
          break;

        case "media":
          if (msg.media?.payload) {
            // Decode base64 mulaw audio
            const decoded = Uint8Array.from(atob(msg.media.payload), c => c.charCodeAt(0));

            // Append to buffer
            const newBuffer = new Uint8Array(audioBuffer.length + decoded.length);
            newBuffer.set(audioBuffer);
            newBuffer.set(decoded, audioBuffer.length);
            audioBuffer = newBuffer;

            // Process when buffer is full
            if (audioBuffer.length >= BUFFER_SIZE) {
              processAudioBuffer();
            }
          }
          break;

        case "stop":
          console.log(`[voice-relay] Stream stopped: ${callSid}`);
          if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
          // Process any remaining audio
          if (audioBuffer.length > MULAW_BYTES_PER_MS * 500) { // at least 500ms
            processAudioBuffer();
          }
          break;

        case "mark":
          // Audio playback completed
          break;
      }
    },

    getStreamSid() { return streamSid; },
    getCallSid() { return callSid; },
  };
}

// ── TwiML generator ─────────────────────────────────────────────────────────

/**
 * Generate TwiML that connects an inbound call to our Media Stream WebSocket.
 */
export function generateMediaStreamTwiML(wsUrl: string, greeting?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greeting ? `<Say>${escapeXml(greeting)}</Say>` : ""}
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Mulaw to WAV conversion ─────────────────────────────────────────────────

/**
 * Convert raw mulaw bytes to a WAV file (PCM 16-bit, mono).
 * Whisper needs WAV, Twilio sends mulaw.
 */
export function mulawToWav(mulaw: Uint8Array, sampleRate: number): Uint8Array {
  const pcmSamples = new Int16Array(mulaw.length);

  // Mulaw decode table
  for (let i = 0; i < mulaw.length; i++) {
    pcmSamples[i] = mulawDecode(mulaw[i]);
  }

  // Build WAV header + PCM data
  const pcmBytes = new Uint8Array(pcmSamples.buffer);
  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);         // chunk size
  view.setUint16(20, 1, true);          // PCM format
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);  // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, pcmBytes.length, true);

  const wav = new Uint8Array(44 + pcmBytes.length);
  wav.set(new Uint8Array(wavHeader));
  wav.set(pcmBytes, 44);
  return wav;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Mulaw decode (ITU G.711)
export function mulawDecode(mulaw: number): number {
  mulaw = ~mulaw & 0xFF;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  const sample = ((mantissa << 3) + 0x84) << exponent;
  return sign * (sample - 0x84);
}
