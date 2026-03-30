import { useState, useRef, useEffect, useCallback } from "react";
import { X, Send, Bot, Wrench, Loader2, Sparkles, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";

interface MetaMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
  isToolActivity?: boolean;
}

interface MetaAgentPanelProps {
  agentName: string;
  open: boolean;
  onClose: () => void;
  /** Current context tab — changes starter prompts */
  context?: "test" | "settings" | "activity" | "tests" | "knowledge" | "channels" | "general";
}

const CONTEXT_STARTERS: Record<string, { label: string; prompt: string }[]> = {
  test: [
    { label: "Why are responses slow?", prompt: "Analyze my agent's response latency and suggest improvements to make it faster." },
    { label: "Improve response quality", prompt: "Review recent conversations and suggest how to improve the system prompt for better, more detailed responses." },
    { label: "Add more tools", prompt: "What tools should this agent have that it's currently missing? Suggest tools based on how users interact with it." },
    { label: "Make it use citations", prompt: "Update the system prompt so the agent always includes source links when citing web search results." },
  ],
  settings: [
    { label: "Review my config", prompt: "Read my agent's full config and tell me if anything looks misconfigured or could be improved." },
    { label: "Optimize for cost", prompt: "Analyze my agent's cost structure. Which models and tools are most expensive? How can I reduce costs without losing quality?" },
    { label: "Change the personality", prompt: "Make my agent more friendly and conversational while keeping it professional. Update the system prompt." },
    { label: "Upgrade the model", prompt: "What model should this agent use? Compare the current model vs alternatives for my use case." },
  ],
  tests: [
    { label: "Generate test cases", prompt: "Generate 5 realistic test cases for this agent based on its description and tools." },
    { label: "Run all tests", prompt: "Run the existing test cases and tell me the results." },
    { label: "Fix failing tests", prompt: "Check which tests are failing and suggest config changes to fix them." },
    { label: "Add edge cases", prompt: "What edge cases should I test for? Generate test cases for unusual or tricky inputs." },
  ],
  activity: [
    { label: "What are users asking?", prompt: "Read recent sessions and summarize what users are asking this agent about most." },
    { label: "Find failures", prompt: "Check recent sessions for errors, failures, or poor responses. What went wrong?" },
    { label: "Usage patterns", prompt: "Analyze usage patterns — when are users active, which tools are used most, what's the average cost per session?" },
    { label: "Suggest improvements", prompt: "Based on actual usage data, what are the top 3 improvements I should make to this agent?" },
  ],
  general: [
    { label: "How is my agent doing?", prompt: "Give me an overall health check of this agent — usage, errors, cost, quality." },
    { label: "Suggest improvements", prompt: "Review the agent config and recent activity, then suggest the most impactful improvements." },
    { label: "Show current config", prompt: "Read and display the full agent configuration." },
    { label: "Optimize everything", prompt: "Do a full audit: check config, recent sessions, test results, and costs. Then make improvements." },
  ],
  knowledge: [
    { label: "What does my agent know?", prompt: "Check what's in this agent's knowledge base. Is it comprehensive enough?" },
    { label: "Add FAQs", prompt: "Based on recent conversations, what FAQs should I add to the knowledge base?" },
    { label: "Improve retrieval", prompt: "How can I improve the agent's knowledge retrieval? Are there gaps in what it knows?" },
  ],
  channels: [
    { label: "Which channels work best?", prompt: "Analyze which messaging channels get the most usage and best response quality." },
    { label: "Optimize for WhatsApp", prompt: "How should I adjust the agent for WhatsApp conversations? Shorter responses? Different tone?" },
    { label: "Set up Telegram", prompt: "Walk me through connecting this agent to Telegram." },
  ],
};

let nextId = 0;
function makeId() { return `meta-${++nextId}-${Date.now()}`; }

export function MetaAgentPanel({ agentName, open, onClose, context = "general" }: MetaAgentPanelProps) {
  const [messages, setMessages] = useState<MetaMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: MetaMessage = { id: makeId(), role: "user", content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      // Build conversation history for the API
      const apiMessages = messages
        .filter(m => !m.isToolActivity)
        .map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id, tool_calls: m.tool_calls }));
      apiMessages.push({ role: "user", content: text, tool_call_id: undefined, tool_calls: undefined });

      const res = await api.post<{ response: string; messages: any[] }>(
        `/agents/${agentPathSegment(agentName)}/meta-chat`,
        { messages: apiMessages },
      );

      // Find tool calls in the response messages for display
      const toolMsgs: MetaMessage[] = [];
      for (const m of res.messages) {
        if (m.role === "assistant" && m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            toolMsgs.push({
              id: makeId(), role: "tool", content: `Called: ${tc.function?.name || "tool"}`,
              isToolActivity: true,
            });
          }
        }
      }

      const assistantMsg: MetaMessage = {
        id: makeId(), role: "assistant", content: res.response,
      };

      setMessages(prev => [...prev, ...toolMsgs, assistantMsg]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: makeId(), role: "assistant",
        content: `Error: ${err.message || "Failed to reach the meta-agent"}`,
      }]);
    } finally {
      setLoading(false);
    }
  }, [agentName, messages, loading]);

  const starters = CONTEXT_STARTERS[context] || CONTEXT_STARTERS.general;

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] max-w-[90vw] bg-surface border-l border-border shadow-2xl z-50 flex flex-col animate-[slideIn_200ms_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
            <Sparkles size={14} className="text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-text">Agent Manager</h2>
            <p className="text-[10px] text-text-muted">Improve {agentName}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-alt transition-colors">
          <X size={16} className="text-text-muted" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs text-text-secondary text-center py-2">
              Chat with the meta-agent to improve your assistant. It can read config, analyze sessions, update prompts, run tests, and more.
            </p>
            <div className="space-y-2">
              {starters.map((s, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(s.prompt)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-left text-text-secondary bg-surface-alt/50 border border-border rounded-lg hover:border-primary/30 hover:text-text transition-all"
                >
                  <ChevronRight size={12} className="text-text-muted shrink-0" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => {
          if (msg.isToolActivity) {
            return (
              <div key={msg.id} className="flex items-center gap-1.5 text-[10px] text-text-muted px-2">
                <Wrench size={10} /> {msg.content}
              </div>
            );
          }

          if (msg.role === "user") {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] px-3 py-2 rounded-xl rounded-br-sm text-xs bg-primary text-white">
                  {msg.content}
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} className="flex justify-start">
              <div className="max-w-[90%] px-3 py-2 rounded-xl rounded-bl-sm text-xs bg-surface-alt border border-border/50 prose prose-xs prose-neutral dark:prose-invert max-w-none [&_p]:my-1 [&_code]:text-[10px] [&_pre]:text-[10px] [&_li]:my-0.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              </div>
            </div>
          );
        })}

        {loading && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-xl bg-surface-alt border border-border/50">
              <Loader2 size={14} className="animate-spin text-purple-500" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border px-3 py-2">
        <form onSubmit={(e) => { e.preventDefault(); sendMessage(input); }} className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the meta-agent..."
            disabled={loading}
            className="flex-1 px-3 py-2 text-xs rounded-lg border border-border bg-surface placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="p-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 transition-colors"
          >
            <Send size={14} />
          </button>
        </form>
      </div>

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
