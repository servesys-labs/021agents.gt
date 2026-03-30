import { useState, useRef, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Send, Bot, Wrench, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";

/* ── Types ──────────────────────────────────────────────────────── */

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  isToolActivity?: boolean; // collapsed tool call/result messages
}

interface MetaChatResponse {
  response: string;
  messages: ChatMessage[];
}

/* ── Starter prompts ────────────────────────────────────────────── */

const STARTERS = [
  { label: "How is my agent doing?", icon: "chart" },
  { label: "What are users asking about?", icon: "users" },
  { label: "Suggest improvements", icon: "sparkle" },
  { label: "Show me the current config", icon: "config" },
];

/* ── Page component ─────────────────────────────────────────────── */

export default function AgentManagerPage() {
  const { id } = useParams<{ id: string }>();
  const seg = id ? agentPathSegment(id) : "";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  if (!id) return <AgentNotFound />;

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    setError(null);

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text.trim(),
    };

    // Build conversation for API: only user and assistant text messages
    const apiMessages = [...messages, userMsg]
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.isToolActivity))
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const data = await api.post<MetaChatResponse>(`/agents/${seg}/meta-chat`, {
        messages: apiMessages,
      });

      // Process response messages: collapse tool calls into activity indicators
      const newMessages: ChatMessage[] = [];
      const toolNames: string[] = [];

      for (const msg of data.messages) {
        if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
          // Collect tool names for the activity indicator
          for (const tc of msg.tool_calls) {
            toolNames.push(formatToolName(tc.function.name));
          }
          continue; // Skip the raw tool-call message
        }
        if (msg.role === "tool") {
          continue; // Skip raw tool results
        }
        if (msg.role === "assistant" && msg.content) {
          // If tools were called before this response, add an activity indicator
          if (toolNames.length > 0) {
            newMessages.push({
              id: `tool-activity-${Date.now()}`,
              role: "assistant",
              content: `Checked: ${toolNames.join(", ")}`,
              isToolActivity: true,
            });
            toolNames.length = 0;
          }
          newMessages.push({
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: msg.content,
          });
        }
      }

      // If there are tool names but no final text, still show activity
      if (toolNames.length > 0) {
        newMessages.push({
          id: `tool-activity-${Date.now()}`,
          role: "assistant",
          content: `Checked: ${toolNames.join(", ")}`,
          isToolActivity: true,
        });
      }

      setMessages((prev) => [...prev, ...newMessages]);
    } catch (err: any) {
      setError(err.message || "Failed to get response");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleTextareaInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <AgentNav agentName={id?.replace(/-/g, " ") || "Agent"} />

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 space-y-6">
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center">
                <Bot size={28} className="text-primary" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold text-text">Agent Manager</h3>
                <p className="text-sm text-text-secondary max-w-md">
                  Talk to me about your agent. I can check its performance, update its settings,
                  review conversations, and suggest improvements.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 max-w-md w-full">
                {STARTERS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => sendMessage(s.label)}
                    className="text-left px-4 py-3 rounded-xl border border-border text-sm text-text-secondary hover:bg-surface-alt hover:border-primary/30 hover:text-text transition-all"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.isToolActivity) {
              return (
                <div key={msg.id} className="flex justify-start animate-[fadeInUp_200ms_ease-out]">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-warning-light border border-warning text-xs text-warning-dark">
                    <Wrench size={12} />
                    {msg.content}
                  </div>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-[fadeInUp_200ms_ease-out]`}
              >
                <div
                  className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-primary text-white rounded-br-md whitespace-pre-wrap"
                      : "bg-neutral-light text-text rounded-bl-md prose prose-sm prose-neutral max-w-none [&_pre]:bg-gray-800 [&_pre]:text-gray-100 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_code]:bg-gray-200 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-primary [&_a]:underline"
                  }`}
                >
                  {msg.role === "user" ? msg.content : <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>}
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-surface-alt rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <Loader2 size={14} className="animate-spin" />
                  Analyzing your agent...
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-start">
              <div className="bg-danger-light border border-danger text-danger text-sm px-4 py-2.5 rounded-2xl rounded-bl-md max-w-[80%]">
                {error}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-border px-4 py-3 bg-surface">
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleTextareaInput}
              placeholder="Ask about your agent..."
              rows={1}
              className="flex-1 resize-none rounded-xl border border-border px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="p-2.5 rounded-xl bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={18} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
