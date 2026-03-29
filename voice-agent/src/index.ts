/**
 * OneShots Voice Agent — Cloudflare Realtime Agents
 *
 * Pipeline: Deepgram STT → Our Agent (via API) → ElevenLabs TTS
 * Runs on Cloudflare Workers edge network.
 */
import {
  DeepgramSTT,
  TextComponent,
  RealtimeKitTransport,
  ElevenLabsTTS,
  RealtimeAgent,
} from "@cloudflare/realtime-agents";

export interface Env {
  ACCOUNT_ID: string;
  CF_TOKEN: string;
  DEEPGRAM_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  AI: Ai;
  VOICE_AGENT: DurableObjectNamespace;
  RTK_APP_ID: string;
  ONESHOTS_API_URL: string;
  ONESHOTS_SERVICE_TOKEN: string;
}

class OneShotsProcessor extends TextComponent {
  private env: Env;
  private agentName: string;
  private orgId: string;

  constructor(env: Env, agentName: string, orgId: string) {
    super();
    this.env = env;
    this.agentName = agentName;
    this.orgId = orgId;
  }

  async onTranscript(text: string, reply: (text: string) => void): Promise<void> {
    const userText = text.trim();
    if (!userText) return;

    try {
      const apiUrl = this.env.ONESHOTS_API_URL || "https://api.oneshots.co";
      const resp = await fetch(`${apiUrl}/api/v1/runtime-proxy/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.ONESHOTS_SERVICE_TOKEN}`,
        },
        body: JSON.stringify({
          agent_name: this.agentName,
          task: userText,
          input: userText,
          channel: "voice",
        }),
      });

      if (!resp.ok) {
        reply("Sorry, I couldn't process that. Could you try again?");
        return;
      }

      const result = (await resp.json()) as { output?: string };
      let response = result.output || "I didn't catch that.";

      // Strip markdown for voice
      response = response
        .replace(/#{1,6}\s*/g, "")
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
        .replace(/`{1,3}[^`]*`{1,3}/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/^[-*•]\s*/gm, "")
        .replace(/\n/g, " ")
        .trim();

      reply(response);
    } catch (err) {
      console.error("[VoiceAgent] Error:", err);
      reply("Sorry, something went wrong.");
    }
  }
}

export class VoiceAgent extends RealtimeAgent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async init(
    agentId: string,
    meetingId: string,
    authToken: string,
    workerUrl: string,
    accountId: string,
    apiToken: string,
    agentName: string = "default",
    orgId: string = "",
  ): Promise<void> {
    const processor = new OneShotsProcessor(this.env, agentName, orgId);
    const transport = new RealtimeKitTransport(meetingId, authToken);

    await this.initPipeline(
      [
        transport,
        new DeepgramSTT(this.env.DEEPGRAM_API_KEY),
        processor,
        new ElevenLabsTTS(this.env.ELEVENLABS_API_KEY),
        transport,
      ],
      agentId,
      workerUrl,
      accountId,
      apiToken,
    );

    const { meeting } = transport;

    meeting.participants.joined.on("participantJoined", (participant: any) => {
      processor.speak(`Hello! I'm your AI assistant. How can I help you?`);
    });

    await meeting.join();
  }

  async deinit(): Promise<void> {
    await this.deinitPipeline();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "voice-agent" });
    }

    const meetingId = url.searchParams.get("meetingId");

    // Internal agent routes (WebSocket etc)
    if (url.pathname.startsWith("/agentsInternal") && meetingId) {
      const id = env.VOICE_AGENT.idFromName(meetingId);
      const stub = env.VOICE_AGENT.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/init" && request.method === "POST") {
      if (!meetingId) return Response.json({ error: "meetingId required" }, { status: 400 });

      const body = (await request.json().catch(() => ({}))) as {
        auth_token?: string;
        agent_name?: string;
        org_id?: string;
      };

      const authToken = body.auth_token || request.headers.get("Authorization")?.split(" ")[1] || "";
      if (!authToken) return Response.json({ error: "auth_token required" }, { status: 400 });

      const agentName = body.agent_name || "default";
      const orgId = body.org_id || "";

      try {
        const id = env.VOICE_AGENT.idFromName(meetingId);
        const stub = env.VOICE_AGENT.get(id) as any;

        await stub.init(
          meetingId,
          meetingId,
          authToken,
          url.host,
          env.ACCOUNT_ID,
          env.CF_TOKEN,
          agentName,
          orgId,
        );

        return Response.json({ status: "initialized", meeting_id: meetingId });
      } catch (err: any) {
        console.error("[VoiceAgent] Init failed:", err?.message || err);
        return Response.json({
          error: "Init failed",
          message: err?.message || String(err),
          stack: err?.stack?.slice(0, 500),
        }, { status: 500 });
      }
    }

    if (url.pathname === "/deinit" && meetingId) {
      const id = env.VOICE_AGENT.idFromName(meetingId);
      const stub = env.VOICE_AGENT.get(id) as any;
      await stub.deinit();
      return Response.json({ status: "deinitialized" });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
