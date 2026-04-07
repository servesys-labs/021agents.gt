import { streamMetaAgent } from "$lib/services/meta-agent";
import type { ChatEvent } from "$lib/services/chat";

interface ToolCall {
  name: string;
  input: string;
  output?: string;
  call_id: string;
  latency_ms?: number;
  error?: string;
}

export interface MetaAgentMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  model?: string;
  cost_usd?: number;
}

const STORAGE_PREFIX = "oneshots_meta_agent_";

function storageKey(agentName: string): string {
  return `${STORAGE_PREFIX}${agentName}`;
}

function sessionKey(agentName: string): string {
  return `${STORAGE_PREFIX}session_${agentName}`;
}

class MetaAgentStore {
  /** Per-agent message histories, keyed by agent name */
  messages = $state<Record<string, MetaAgentMessage[]>>({});
  /** Per-agent session IDs */
  sessionIds = $state<Record<string, string | undefined>>({});
  /** Is the meta-agent currently streaming */
  streaming = $state(false);
  /** Is the panel open */
  panelOpen = $state(false);

  private abortFn: (() => void) | null = null;

  getMessages(agentName: string): MetaAgentMessage[] {
    return this.messages[agentName] ?? [];
  }

  loadHistory(agentName: string) {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(storageKey(agentName));
      if (raw) {
        this.messages[agentName] = JSON.parse(raw);
      }
      const sid = localStorage.getItem(sessionKey(agentName));
      if (sid) {
        this.sessionIds[agentName] = sid;
      }
    } catch {
      // ignore corrupt data
    }
  }

  saveHistory(agentName: string) {
    if (typeof window === "undefined") return;
    try {
      const msgs = this.messages[agentName] ?? [];
      localStorage.setItem(storageKey(agentName), JSON.stringify(msgs));
      const sid = this.sessionIds[agentName];
      if (sid) {
        localStorage.setItem(sessionKey(agentName), sid);
      }
    } catch {
      // storage full, ignore
    }
  }

  clearHistory(agentName: string) {
    this.messages[agentName] = [];
    this.sessionIds[agentName] = undefined;
    if (typeof window === "undefined") return;
    localStorage.removeItem(storageKey(agentName));
    localStorage.removeItem(sessionKey(agentName));
  }

  sendMessage(agentName: string, text: string, mode?: "demo" | "live") {
    if (!text.trim() || this.streaming) return;

    // Ensure array exists
    if (!this.messages[agentName]) {
      this.messages[agentName] = [];
    }

    // Add user message
    this.messages[agentName] = [
      ...this.messages[agentName],
      { role: "user", content: text },
    ];

    // Add empty assistant message for streaming
    const assistantMsg: MetaAgentMessage = {
      role: "assistant",
      content: "",
      toolCalls: [],
      thinking: "",
    };
    this.messages[agentName] = [...this.messages[agentName], assistantMsg];
    this.streaming = true;

    // Build history from previous messages for multi-turn context
    const history = this.messages[agentName].slice(0, -2).map(m => ({
      role: m.role,
      content: m.content,
    }));

    const { abort } = streamMetaAgent(
      agentName,
      text,
      (event: ChatEvent) => {
        const msgs = this.messages[agentName];
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== "assistant") return;

        const d = event.data;

        switch (event.type) {
          case "turn_start": {
            const model = (d as { model?: string }).model;
            if (model) last.model = model;
            this.messages[agentName] = [...msgs];
            break;
          }
          case "token": {
            const content =
              (d as { content?: string; text?: string }).content ??
              (d as { text?: string }).text ??
              "";
            last.content += content;
            this.messages[agentName] = [...msgs];
            break;
          }
          case "thinking": {
            const content = (d as { content?: string }).content ?? "";
            last.thinking = (last.thinking || "") + content;
            this.messages[agentName] = [...msgs];
            break;
          }
          case "tool_call": {
            const tc = d as {
              name: string;
              tool_call_id?: string;
              call_id?: string;
              args_preview?: string;
              input?: Record<string, unknown>;
            };
            const callId = tc.tool_call_id ?? tc.call_id ?? crypto.randomUUID();
            const inputStr =
              tc.args_preview ??
              (tc.input ? JSON.stringify(tc.input, null, 2) : "{}");
            last.toolCalls = [
              ...(last.toolCalls ?? []),
              { name: tc.name, input: inputStr, call_id: callId },
            ];
            this.messages[agentName] = [...msgs];
            break;
          }
          case "tool_result": {
            const tr = d as {
              tool_call_id?: string;
              call_id?: string;
              result?: string;
              output?: string;
              latency_ms?: number;
              error?: string;
            };
            const callId = tr.tool_call_id ?? tr.call_id;
            const tc = last.toolCalls?.find((t) => t.call_id === callId);
            if (tc) {
              tc.output = tr.result ?? tr.output ?? "";
              tc.latency_ms = tr.latency_ms;
              if (tr.error) tc.error = tr.error;
            }
            this.messages[agentName] = [...msgs];
            break;
          }
          case "done": {
            const done = d as {
              cost_usd?: number;
              session_id?: string;
              output?: string;
            };
            if (done.cost_usd !== undefined) last.cost_usd = done.cost_usd;
            if (done.session_id) this.sessionIds[agentName] = done.session_id;
            if (done.output && !last.content) last.content = done.output;
            this.messages[agentName] = [...msgs];
            this.streaming = false;
            this.abortFn = null;
            this.saveHistory(agentName);
            break;
          }
          case "error": {
            const err = (d as { message?: string }).message ?? "Unknown error";
            last.content += `\n\n**Error:** ${err}`;
            this.messages[agentName] = [...msgs];
            this.streaming = false;
            this.abortFn = null;
            break;
          }
        }
      },
      this.sessionIds[agentName],
      history,
      mode,
    );

    this.abortFn = abort;
  }

  stopStreaming() {
    this.abortFn?.();
    this.streaming = false;
    this.abortFn = null;
  }

  openPanel() {
    this.panelOpen = true;
  }

  closePanel() {
    this.panelOpen = false;
  }

  togglePanel() {
    this.panelOpen = !this.panelOpen;
  }
}

export const metaAgentStore = new MetaAgentStore();
