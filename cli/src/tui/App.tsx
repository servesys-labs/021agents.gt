/**
 * OneShots Interactive TUI — Full-screen agent interaction
 *
 * Inspired by Claude Code's REPL.tsx. Provides:
 * - Scrollable message area with tree-rendered tool execution
 * - Persistent status bar (model, cost, context %, elapsed)
 * - Slash commands (/model, /cost, /clear, /agent, /help)
 * - Streaming token display with spinner during tool execution
 * - Multi-turn conversation with history
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { apiStream } from "../lib/api.js";
import { AutopilotController } from "./autopilot.js";
import {
  generateCompanion, createDefaultSoul, renderCompanion, renderSpeechBubble,
  renderCompanionCard, renderStats, getReaction, RARITY_COLORS,
  type Companion, type CompanionBones, type ReactionType,
} from "./companion.js";

// ── Types ───────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  cost?: number;
  tokens?: number;
  toolCalls?: ToolCallDisplay[];
}

interface ToolCallDisplay {
  name: string;
  status: "running" | "success" | "error";
  result?: string;
  error?: string;
  latencyMs?: number;
}

interface AppProps {
  agentName: string;
  systemPrompt?: string;
}

// ── Slash Commands ──────────────────────────────────────────────

const SLASH_COMMANDS: Record<string, { desc: string; handler: string }> = {
  "/help": { desc: "Show available commands", handler: "help" },
  "/cost": { desc: "Show session cost summary", handler: "cost" },
  "/clear": { desc: "Clear conversation history", handler: "clear" },
  "/agent": { desc: "Switch agent (e.g. /agent research)", handler: "agent" },
  "/model": { desc: "Show current model info", handler: "model" },
  "/compact": { desc: "Compress conversation context", handler: "compact" },
  "/history": { desc: "Show conversation turns", handler: "history" },
  "/autopilot": { desc: "Toggle autonomous mode", handler: "autopilot" },
  "/companion": { desc: "Show your companion (pet, stats, rename)", handler: "companion" },
  "/exit": { desc: "Exit the session", handler: "exit" },
};

// ── Main App Component ──────────────────────────────────────────

export default function App({ agentName: initialAgent, systemPrompt }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const termWidth = stdout?.columns || 80;

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentName, setAgentName] = useState(initialAgent);
  const [isStreaming, setIsStreaming] = useState(false);
  const [spinnerText, setSpinnerText] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Session stats
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [turns, setTurns] = useState(0);
  const [model, setModel] = useState("");
  const [startTime] = useState(Date.now());

  // Autopilot
  const autopilotRef = useRef(new AutopilotController());
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);

  // Companion
  const [companionTick, setCompanionTick] = useState(0);
  const [companionReaction, setCompanionReaction] = useState("");
  const [showCompanion, setShowCompanion] = useState(true);
  const companionBonesRef = useRef<CompanionBones | null>(null);
  const companionRef = useRef<Companion | null>(null);

  // Initialize companion on mount
  useEffect(() => {
    const userId = process.env.USER || process.env.USERNAME || "default";
    const bones = generateCompanion(userId);
    const soul = createDefaultSoul(bones);
    companionBonesRef.current = bones;
    companionRef.current = { bones, soul };
    setCompanionReaction(getReaction("greeting"));
  }, []);

  // Companion idle animation (500ms tick)
  useEffect(() => {
    if (!showCompanion) return;
    const id = setInterval(() => setCompanionTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, [showCompanion]);

  // Clear companion reaction after 10s
  useEffect(() => {
    if (!companionReaction) return;
    const id = setTimeout(() => setCompanionReaction(""), 10_000);
    return () => clearTimeout(id);
  }, [companionReaction]);

  // Spinner animation
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setSpinnerFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [isStreaming]);

  // Handle keyboard shortcuts
  useInput((ch, key) => {
    if (key.ctrl && ch === "c") { exit(); return; }
    if (key.ctrl && ch === "d") { exit(); return; }
  });

  // Build conversation history for API
  const buildHistory = useCallback(() => {
    return messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));
  }, [messages]);

  // Handle slash commands
  const handleSlashCommand = useCallback((cmd: string) => {
    const [command, ...args] = cmd.split(" ");

    switch (command) {
      case "/help":
        setMessages(prev => [...prev, {
          role: "system", timestamp: Date.now(),
          content: Object.entries(SLASH_COMMANDS)
            .map(([k, v]) => `  ${k.padEnd(12)} ${v.desc}`)
            .join("\n"),
        }]);
        break;

      case "/cost":
        setMessages(prev => [...prev, {
          role: "system", timestamp: Date.now(),
          content: `Cost: $${totalCost.toFixed(4)} | Turns: ${turns} | Tokens: ${totalTokens} | Elapsed: ${((Date.now() - startTime) / 1000).toFixed(0)}s`,
        }]);
        break;

      case "/clear":
        setMessages([]);
        setTotalCost(0);
        setTotalTokens(0);
        setTurns(0);
        break;

      case "/agent":
        if (args[0]) {
          setAgentName(args[0]);
          setMessages(prev => [...prev, {
            role: "system", timestamp: Date.now(),
            content: `Switched to agent: ${args[0]}`,
          }]);
        } else {
          setMessages(prev => [...prev, {
            role: "system", timestamp: Date.now(),
            content: `Current agent: ${agentName}. Usage: /agent <name>`,
          }]);
        }
        break;

      case "/model":
        setMessages(prev => [...prev, {
          role: "system", timestamp: Date.now(),
          content: `Model: ${model || "auto"} | Agent: ${agentName}`,
        }]);
        break;

      case "/compact":
        setMessages(prev => [...prev, {
          role: "system", timestamp: Date.now(),
          content: "Context compression requested (handled server-side on next turn).",
        }]);
        break;

      case "/history":
        setMessages(prev => [...prev, {
          role: "system", timestamp: Date.now(),
          content: `${turns} turns, ${messages.filter(m => m.role === "user").length} user messages`,
        }]);
        break;

      case "/autopilot": {
        const ap = autopilotRef.current;
        if (ap.isEnabled) {
          ap.stop();
          setAutopilotEnabled(false);
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: "Autopilot disabled." }]);
        } else {
          ap.start(async (tickPrompt) => {
            // Send tick as a system-level message to the agent
            setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: `[tick ${ap.ticks}]` }]);
            try {
              const stream = apiStream("/api/v1/runtime-proxy/agent/run", {
                agent_name: agentName,
                input: tickPrompt,
                stream: true,
                system_prompt: ap.getSystemAddendum(),
                history: buildHistory(),
              });
              let response = "";
              for await (const chunk of stream) {
                try {
                  const lines = chunk.split("\n").filter((l: string) => l.trim());
                  for (const line of lines) {
                    const data = line.startsWith("data: ") ? line.slice(6) : line;
                    const event = JSON.parse(data);
                    if (event.type === "token") response += event.content || "";
                  }
                } catch {}
              }
              if (response.trim()) {
                setMessages(prev => [...prev, { role: "assistant", content: response.trim(), timestamp: Date.now() }]);
                setCompanionReaction(getReaction("thinking"));
              }
            } catch {}
          });
          setAutopilotEnabled(true);
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: "Autopilot enabled. Agent will check in every 30s." }]);
        }
        break;
      }

      case "/companion": {
        const subCmd = args[0];
        const comp = companionRef.current;
        if (!comp) break;

        if (subCmd === "pet") {
          setCompanionReaction("*purrs happily* \u2764");
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: `You pet ${comp.soul.name}. It seems happy!` }]);
        } else if (subCmd === "stats") {
          const statsStr = renderStats(comp.bones).join("\n");
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: `${comp.soul.name} (${comp.bones.rarity} ${comp.bones.species})\n${statsStr}` }]);
        } else if (subCmd === "rename" && args[1]) {
          comp.soul.name = args.slice(1).join(" ");
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: `Companion renamed to ${comp.soul.name}!` }]);
        } else if (subCmd === "card") {
          const card = renderCompanionCard(comp).join("\n");
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: card }]);
        } else if (subCmd === "hide") {
          setShowCompanion(false);
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: `${comp.soul.name} hides.` }]);
        } else if (subCmd === "show") {
          setShowCompanion(true);
          setMessages(prev => [...prev, { role: "system", timestamp: Date.now(), content: `${comp.soul.name} appears!` }]);
          setCompanionReaction(getReaction("greeting"));
        } else {
          setMessages(prev => [...prev, {
            role: "system", timestamp: Date.now(),
            content: `${comp.soul.name} — ${comp.bones.rarity} ${comp.bones.species} (${comp.soul.personality})\n` +
              `Commands: /companion pet | stats | card | rename <name> | hide | show`,
          }]);
        }
        break;
      }

      case "/exit":
        autopilotRef.current.stop();
        exit();
        break;

      default:
        setMessages(prev => [...prev, {
          role: "system", timestamp: Date.now(),
          content: `Unknown command: ${command}. Type /help for available commands.`,
        }]);
    }
  }, [agentName, totalCost, totalTokens, turns, model, messages, startTime, exit]);

  // Send message to agent
  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    // Slash commands
    if (trimmed.startsWith("/")) {
      handleSlashCommand(trimmed);
      setInput("");
      return;
    }

    // Add user message
    setMessages(prev => [...prev, { role: "user", content: trimmed, timestamp: Date.now() }]);
    setInput("");
    setIsStreaming(true);
    setSpinnerText("Thinking...");

    let assistantContent = "";
    let turnCost = 0;
    let turnTokens = 0;
    const toolCalls: ToolCallDisplay[] = [];

    try {
      const stream = apiStream("/api/v1/runtime-proxy/agent/run", {
        agent_name: agentName,
        input: trimmed,
        stream: true,
        system_prompt: systemPrompt,
        history: buildHistory(),
      });

      let buffer = "";

      for await (const chunk of stream) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const t = line.trim();
          if (!t || t === "data: [DONE]") continue;

          let event: any;
          try {
            const data = t.startsWith("data: ") ? t.slice(6) : t;
            event = JSON.parse(data);
          } catch {
            continue;
          }

          switch (event.type) {
            case "session_start":
              break;

            case "turn_start":
              setModel(event.model || "");
              setSpinnerText(`Turn ${event.turn || ""} ${(event.model || "").split("/").pop() || ""}...`);
              break;

            case "tool_call":
              setSpinnerText(`${event.name}${event.args_preview ? " " + event.args_preview.slice(0, 30) : ""}...`);
              toolCalls.push({ name: event.name, status: "running" });
              break;

            case "tool_result": {
              const tc = toolCalls.find(t => t.status === "running" && t.name === event.name);
              if (tc) {
                tc.status = event.error ? "error" : "success";
                tc.result = event.result?.slice(0, 200);
                tc.error = event.error;
                tc.latencyMs = event.latency_ms;
              }
              turnCost += event.cost_usd || 0;
              setSpinnerText("Thinking...");
              // Companion reacts to tool results
              if (showCompanion) {
                setCompanionReaction(getReaction(event.error ? "tool_error" : "tool_success", turnCost * 1000));
              }
              break;
            }

            case "token":
              assistantContent += event.content || "";
              // Live update the assistant message
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && last.timestamp === -1) {
                  return [...prev.slice(0, -1), { ...last, content: assistantContent }];
                }
                return [...prev, { role: "assistant", content: assistantContent, timestamp: -1 }];
              });
              break;

            case "turn_end":
              turnCost += event.cost_usd || 0;
              turnTokens += event.tokens || 0;
              break;

            case "done":
              assistantContent = assistantContent || event.output || "";
              break;

            case "warning":
              setMessages(prev => [...prev, {
                role: "system", timestamp: Date.now(),
                content: `\u26A0 ${event.message || ""}`,
              }]);
              break;

            case "error":
              setMessages(prev => [...prev, {
                role: "system", timestamp: Date.now(),
                content: `\u2717 ${event.message || "Error"}`,
              }]);
              break;
          }
        }
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: "system", timestamp: Date.now(),
        content: `Error: ${err.message || err}`,
      }]);
    }

    // Finalize assistant message
    setMessages(prev => {
      const filtered = prev.filter(m => m.timestamp !== -1);
      return [...filtered, {
        role: "assistant",
        content: assistantContent || "(No response)",
        timestamp: Date.now(),
        cost: turnCost,
        tokens: turnTokens,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      }];
    });

    setTotalCost(c => c + turnCost);
    setTotalTokens(t => t + turnTokens);
    setTurns(t => t + 1);
    setIsStreaming(false);
    setSpinnerText("");
  }, [input, isStreaming, agentName, systemPrompt, buildHistory, handleSlashCommand]);

  // ── Render ──────────────────────────────────────────────────────

  const msgAreaHeight = Math.max(5, termHeight - 5); // Reserve 5 lines for input + status

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header */}
      <Box borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text bold color="blue">{"\u26A1"} {agentName}</Text>
        <Text> </Text>
        <Text dimColor>session</Text>
        {autopilotEnabled && <Text color="magenta"> [AUTOPILOT]</Text>}
        <Box flexGrow={1} />
        <Text dimColor>/help for commands</Text>
      </Box>

      {/* Message Area */}
      <Box flexDirection="column" height={msgAreaHeight} overflow="hidden" paddingX={1}>
        {messages.length === 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Ask anything. The agent has access to tools, web search, code execution, and more.</Text>
            <Text dimColor>Type /help for commands, Ctrl+C to exit.</Text>
          </Box>
        )}
        {messages.slice(-(msgAreaHeight - 1)).map((msg, i) => (
          <MessageRow key={i} message={msg} width={termWidth - 4} />
        ))}
        {isStreaming && spinnerText && (
          <Text color="cyan">{FRAMES[spinnerFrame]} {spinnerText}</Text>
        )}
      </Box>

      {/* Input Area */}
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color="green" bold>{"\u276F"} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={sendMessage}
          placeholder={isStreaming ? "Agent is responding..." : "Ask something..."}
        />
      </Box>

      {/* Status Bar + Companion */}
      <Box>
        <Box flexGrow={1}>
          <StatusBar
            agent={agentName}
            model={model}
            cost={totalCost}
            tokens={totalTokens}
            turns={turns}
            elapsed={Date.now() - startTime}
            width={termWidth}
            autopilot={autopilotEnabled}
          />
        </Box>
        {showCompanion && companionBonesRef.current && termWidth > 60 && (
          <CompanionWidget
            bones={companionBonesRef.current}
            tick={companionTick}
            reaction={companionReaction}
            rarity={companionBonesRef.current.rarity}
          />
        )}
      </Box>
    </Box>
  );
}

// ── Message Row Component ───────────────────────────────────────

function MessageRow({ message, width }: { message: Message; width: number }) {
  const maxContentWidth = Math.max(20, width - 10);

  if (message.role === "system") {
    return (
      <Box>
        <Text dimColor>{"\u2502"} </Text>
        <Text dimColor>{message.content.slice(0, maxContentWidth)}</Text>
      </Box>
    );
  }

  if (message.role === "user") {
    return (
      <Box>
        <Text color="green" bold>{"\u276F"} </Text>
        <Text>{message.content.slice(0, maxContentWidth)}</Text>
      </Box>
    );
  }

  // Assistant message
  const lines = message.content.split("\n");
  const costLabel = message.cost ? ` ($${message.cost.toFixed(4)})` : "";

  return (
    <Box flexDirection="column">
      {/* Tool calls */}
      {message.toolCalls?.map((tc, i) => (
        <Box key={i}>
          <Text dimColor>{"\u251C\u2500"} </Text>
          <Text color={tc.status === "error" ? "red" : tc.status === "success" ? "green" : "cyan"}>
            {tc.status === "error" ? "\u2717" : tc.status === "success" ? "\u2713" : "\u2022"} {tc.name}
          </Text>
          {tc.latencyMs != null && <Text dimColor> {tc.latencyMs}ms</Text>}
        </Box>
      ))}
      {/* Content */}
      {lines.slice(0, 20).map((line, i) => (
        <Box key={i}>
          <Text dimColor>{i === 0 ? "\u23BF " : "  "}</Text>
          <Text>{line.slice(0, maxContentWidth)}</Text>
        </Box>
      ))}
      {lines.length > 20 && <Text dimColor>  ... ({lines.length - 20} more lines)</Text>}
      {costLabel && <Text dimColor>  {costLabel}</Text>}
    </Box>
  );
}

// ── Status Bar Component ────────────────────────────────────────

function StatusBar({ agent, model, cost, tokens, turns, elapsed, width, autopilot }: {
  agent: string; model: string; cost: number; tokens: number; turns: number; elapsed: number; width: number; autopilot?: boolean;
}) {
  const elapsedStr = `${Math.round(elapsed / 1000)}s`;
  const costStr = `$${cost.toFixed(4)}`;
  const modelShort = model ? model.split("/").pop() || model : "auto";
  const tokenStr = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);

  return (
    <Box paddingX={1}>
      <Text dimColor>{agent}</Text>
      <Text dimColor> {"\u2502"} </Text>
      <Text dimColor>{modelShort}</Text>
      <Text dimColor> {"\u2502"} </Text>
      <Text color="yellow">{costStr}</Text>
      <Text dimColor> {"\u2502"} </Text>
      <Text color="cyan">{tokenStr} tokens</Text>
      <Text dimColor> {"\u2502"} </Text>
      <Text dimColor>T{turns}</Text>
      <Text dimColor> {"\u2502"} </Text>
      <Text dimColor>{elapsedStr}</Text>
      {autopilot && <><Text dimColor> {"\u2502"} </Text><Text color="magenta">AP</Text></>}
    </Box>
  );
}

// ── Companion Widget ────────────────────────────────────────────

function CompanionWidget({ bones, tick, reaction, rarity }: {
  bones: CompanionBones; tick: number; reaction: string; rarity: string;
}) {
  const spriteLines = renderCompanion(bones, tick);
  const bubbleLines = reaction ? renderSpeechBubble(reaction, 24) : [];
  const color = RARITY_COLORS[rarity as keyof typeof RARITY_COLORS] || "white";

  return (
    <Box flexDirection="column" marginLeft={1}>
      {bubbleLines.map((line, i) => (
        <Text key={`b${i}`} dimColor>{line}</Text>
      ))}
      {spriteLines.map((line, i) => (
        <Text key={`s${i}`} color={color}>{line}</Text>
      ))}
    </Box>
  );
}
