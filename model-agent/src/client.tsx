/**
 * Model Agent Client — uses SDK hooks (useAgent, useAgentChat)
 *
 * Follows the canonical pattern from cloudflare/agents examples.
 * useAgentChat provides:
 * - WebSocket transport (primary, bidirectional)
 * - Automatic reconnection
 * - Real-time state sync with server
 * - Message history from server SQLite
 * - Streaming response rendering
 * - Tool call/result display
 */

import { useAgent, useAgentChat } from "agents/react";
import { useVoiceAgent } from "@cloudflare/voice/react";
import { useState, useRef, useEffect } from "react";

export default function App() {
  const [input, setInput] = useState("");
  const [voiceMode, setVoiceMode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // SDK hook: connects to ModelAgent DO via WebSocket
  // State auto-syncs between server and client
  const agent = useAgent({
    agent: "ModelAgent",
    name: "default",
  });

  // SDK hook: wraps useAgent with AI SDK chat protocol
  const {
    messages,
    handleSubmit,
    isLoading,
    error,
    stop,
  } = useAgentChat({
    agent,
  });

  // SDK hook: voice agent (Workers AI STT + TTS, no external keys)
  const voice = useVoiceAgent({
    agent: "ModelAgent",
    name: "default",
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Model Agent</h1>
          <p className="text-xs text-gray-500">
            Reference implementation — AIChatAgent + Workspace + CodeMode + MCP
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Voice toggle */}
          <button
            onClick={() => {
              if (voiceMode) {
                voice.endCall();
                setVoiceMode(false);
              } else {
                voice.startCall();
                setVoiceMode(true);
              }
            }}
            className={`px-3 py-1 rounded text-xs ${
              voiceMode
                ? "bg-red-100 text-red-700 border border-red-300"
                : "bg-gray-100 text-gray-600 border"
            }`}
          >
            {voiceMode ? `Voice: ${voice.status}` : "Voice Off"}
          </button>

          <span
            className={`w-2 h-2 rounded-full ${
              agent.ready ? "bg-green-500" : "bg-yellow-500"
            }`}
          />
          <span className="text-xs text-gray-500">
            {agent.ready ? "Connected" : "Connecting..."}
          </span>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-20">
            <p className="text-lg">Send a message to get started</p>
            <p className="text-sm mt-2">
              This agent has workspace files, git, code execution, web search, and browser tools.
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-white border shadow-sm"
              }`}
            >
              {/* Text content */}
              {message.parts?.map((part, i) => {
                if (part.type === "text") {
                  return (
                    <p key={i} className="whitespace-pre-wrap">
                      {part.text}
                    </p>
                  );
                }
                if (part.type === "tool-invocation") {
                  return (
                    <div
                      key={i}
                      className="mt-2 p-2 bg-gray-50 rounded text-xs border"
                    >
                      <div className="font-mono font-semibold text-gray-700">
                        {part.toolInvocation.toolName}
                      </div>
                      {part.toolInvocation.state === "result" && (
                        <pre className="mt-1 text-gray-600 overflow-x-auto">
                          {JSON.stringify(part.toolInvocation.result, null, 2)?.slice(0, 500)}
                        </pre>
                      )}
                      {part.toolInvocation.state === "call" && (
                        <span className="text-yellow-600">Running...</span>
                      )}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border shadow-sm rounded-lg px-4 py-2">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-red-700 text-sm">
            {error.message}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || isLoading) return;
          handleSubmit(e);
          setInput("");
        }}
        className="border-t bg-white px-6 py-4"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            name="prompt"
            placeholder="Send a message..."
            className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={!agent.ready}
          />
          {isLoading ? (
            <button
              type="button"
              onClick={stop}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || !agent.ready}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
