<script lang="ts">
  import { page } from "$app/stores";
  import { agentStore as agentListStore } from "$lib/stores/agents.svelte";
  import { agentStore as agentRpc } from "$lib/stores/agent.svelte";
  // SDK-first: AgentClient for WebSocket RPC, no SSE streaming
  import { conversationStore } from "$lib/stores/conversations.svelte";
  import { createAutoScrollController } from "$lib/utils/auto-scroll";
  import ChatHeader from "$lib/components/chat/ChatHeader.svelte";
  import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
  import ChatInput from "$lib/components/chat/ChatInput.svelte";
  import EmptyChat from "$lib/components/chat/EmptyChat.svelte";
  import MetaAgentPanel from "$lib/components/meta-agent/MetaAgentPanel.svelte";
  import WorkspacePanel from "$lib/components/chat/WorkspacePanel.svelte";
  import ComputerPanel from "$lib/components/chat/ComputerPanel.svelte";
  import { metaAgentStore } from "$lib/stores/meta-agent.svelte";

  interface ToolCall {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  /** Ordered segment types for interleaved rendering */
  type Segment =
    | { type: "thinking"; content: string }
    | { type: "tool_calls"; calls: ToolCall[] };

  interface Message {
    role: "user" | "assistant";
    content: string;
    toolCalls?: ToolCall[];
    thinking?: string;
    /** Ordered segments for interleaved thinking + tool call rendering */
    segments?: Segment[];
    model?: string;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    latency_ms?: number;
  }

  let agentName = $derived($page.params.agent ?? "");
  let agent = $derived(agentListStore.agents.find((a) => a.name === agentName) ?? null);

  // ── Connect to Agent DO via WebSocket RPC (SDK pattern) ──
  // The agentRpc store maintains a persistent connection for:
  //   - Chat streaming (SDK chat protocol)
  //   - MCP management (addServer, removeServer, listServers)
  //   - Skill overlays (appendSkillRule, getSkillOverlays)
  //   - State sync (agent state pushed from server)
  // REST (api.ts) is still used for control-plane: auth, billing, org, marketplace.
  let rpcConnected = $derived(agentRpc.connected);

  // ── Connect to Agent DO via SDK AgentClient (WebSocket) ──
  $effect(() => {
    if (!agentName) return;
    agentRpc.connect(agentName);

    // Listen for SDK chat protocol messages from the Agent DO.
    // These feed the same UI state (messages, segments, toolCalls, thinking)
    // that ToolCallInline, ToolCallGroup, and ChatMessage render.
    const unsubscribe = agentRpc.onMessage((data: any) => {
      // cf_agent_chat_messages — full message list sync from server
      if (data.type === "cf_agent_chat_messages") {
        // Server sends complete message history — reconcile with local
        // For now, use server as source of truth on reconnect
        if (!streaming && data.messages) {
          // TODO: convert UIMessage parts to our Message shape
        }
        return;
      }

      // cf_agent_use_chat_response — streaming response chunks
      if (data.type === "cf_agent_use_chat_response") {
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return;

        // The server streams UIMessage[] updates — extract text + tool parts
        if (data.messages) {
          const serverMsgs = data.messages as any[];
          const lastServer = serverMsgs[serverMsgs.length - 1];
          if (lastServer?.parts) {
            // Rebuild content + segments from UIMessage parts
            let textContent = "";
            const newToolCalls: ToolCall[] = [];
            const newSegments: Segment[] = [];

            for (const part of lastServer.parts) {
              if (part.type === "text" && part.text) {
                textContent += part.text;
              }
              if (part.type === "reasoning" && part.text) {
                const lastSeg = newSegments[newSegments.length - 1];
                if (lastSeg?.type === "thinking") {
                  (lastSeg as any).content += part.text;
                } else {
                  newSegments.push({ type: "thinking", content: part.text });
                }
              }
              if (part.type === "tool-invocation") {
                const tc: ToolCall = {
                  name: part.toolName || "tool",
                  input: JSON.stringify(part.args || {}),
                  call_id: part.toolCallId || crypto.randomUUID(),
                  output: part.result ? JSON.stringify(part.result) : undefined,
                };
                newToolCalls.push(tc);
                // Add to segments
                const lastSeg = newSegments[newSegments.length - 1];
                if (lastSeg?.type === "tool_calls") {
                  lastSeg.calls.push(tc);
                } else {
                  newSegments.push({ type: "tool_calls", calls: [tc] });
                }
              }
            }

            last.content = textContent;
            last.toolCalls = newToolCalls.length > 0 ? newToolCalls : last.toolCalls;
            last.segments = newSegments.length > 0 ? newSegments : last.segments;
            scheduleMessageFlush(true);

            // ── Computer Panel: extract workspace data from tool calls ──
            for (const tc of newToolCalls) {
              const args = tc.input ? (() => { try { return JSON.parse(tc.input); } catch { return {}; } })() : {};
              const result = tc.output ? (() => { try { return JSON.parse(tc.output); } catch { return tc.output; } })() : null;

              // File write/edit → show in Code tab
              if (["write", "write-file", "edit", "edit-file"].includes(tc.name)) {
                const path = args.path || args.file || "";
                const content = args.content || args.text || tc.output || "";
                if (path && content) {
                  activeFile = { path, content, language: "" };
                  computerOpen = true;
                }
              }

              // Bash/python → show in Terminal tab
              if (["bash", "python-exec", "execute-code", "start_process", "run_code_persistent"].includes(tc.name)) {
                const output = typeof result === "string" ? result : (result?.output || result?.stdout || tc.output || "");
                if (output) {
                  terminalLines = [...terminalLines, `$ ${args.command || args.code || tc.name}`, output].slice(-200);
                  computerOpen = true;
                }
              }

              // Preview URL → show in Preview tab
              if (tc.name === "expose_preview" && result?.url) {
                previewUrl = result.url;
                computerOpen = true;
              }

              // Git clone → show in Terminal
              if (tc.name === "git_clone" && result) {
                terminalLines = [...terminalLines, `$ git clone ${args.url}`, JSON.stringify(result)].slice(-200);
                computerOpen = true;
              }
            }
          }
        }

        // Check if streaming is done
        if (data.done) {
          streaming = false;
          abortFn = null;
          if (workspaceOpen && workspacePanelRef) workspacePanelRef.refresh();
        }
        return;
      }

      // streaming_done broadcast from agent
      if (data.type === "streaming_done") {
        streaming = false;
        abortFn = null;
      }
    });

    return () => { unsubscribe(); };
  });

  let messages = $state<Message[]>([]);
  let streaming = $state(false);
  let abortFn = $state<(() => void) | null>(null);
  let messagesEl: HTMLDivElement | undefined = $state();
  let sessionId = $state<string | undefined>(undefined);
  let conversationId = $state<string | undefined>(undefined);
  let improveOpen = $state(false);
  let workspaceOpen = $state(false);
  let workspacePanelRef: WorkspacePanel | undefined = $state();

  // ── Computer Panel state (driven by tool call streaming) ──
  let computerOpen = $state(false);
  let activeFile = $state<{ path: string; content: string; language: string } | null>(null);
  let previewUrl = $state("");
  let terminalLines = $state<string[]>([]);
  let workspaceFiles = $state<Array<{ path: string; size: number }>>([]);

  let messageFlushScheduled = $state(false);
  let messageFlushNeedsScroll = $state(false);

  function scheduleMessageFlush(scroll = false) {
    messageFlushNeedsScroll = messageFlushNeedsScroll || scroll;
    if (messageFlushScheduled) return;
    messageFlushScheduled = true;
    requestAnimationFrame(() => {
      messageFlushScheduled = false;
      const shouldScroll = messageFlushNeedsScroll;
      messageFlushNeedsScroll = false;
      messages = [...messages];
      if (shouldScroll && autoScroll.isEnabled()) {
        autoScroll.scrollToBottom(false);
      }
    });
  }

  // Clean up WS connection on page destroy
  $effect(() => {
    return () => {
      // Don't close the connection — let it stay alive for reconnection
      // Only close on explicit navigation away
    };
  });

  // On mount: check URL for ?c=<conversation_id> and load from server
  $effect(() => {
    if (typeof window === "undefined" || !agentName) return;
    const params = new URLSearchParams(window.location.search);
    const cId = params.get("c");
    if (cId && cId !== conversationId) {
      conversationId = cId;
      conversationStore.setActiveId(cId);
      loadConversationFromServer(cId);
    }
    // Fetch conversations list for sidebar
    conversationStore.fetchConversations(agentName);
  });

  async function loadConversationFromServer(cId: string) {
    try {
      await conversationStore.loadConversation(cId);
      // Convert server messages to local Message format
      const serverMsgs = conversationStore.messages;
      const converted: Message[] = [];
      for (const sm of serverMsgs) {
        if (sm.role === "user" || sm.role === "assistant") {
          // Map persisted tool_calls back to ToolCall[]
          const rawToolCalls = Array.isArray(sm.tool_calls) ? sm.tool_calls : [];
          const toolCalls: ToolCall[] = rawToolCalls.map((tc: any, idx: number) => ({
            name: String(tc.name || "tool"),
            input: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
            output: tc.output ? String(tc.output) : undefined,
            call_id: String(tc.call_id || tc.tool_call_id || `tc-${idx}`),
            latency_ms: typeof tc.latency_ms === "number" ? tc.latency_ms : undefined,
            error: tc.error ? String(tc.error) : undefined,
          }));

          // Extract thinking from metadata
          const meta = (sm as any).metadata;
          const thinking = meta && typeof meta === "object" && typeof meta.thinking === "string"
            ? meta.thinking : undefined;

          converted.push({
            role: sm.role,
            content: sm.content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            thinking,
            model: sm.model || undefined,
            cost_usd: sm.cost_usd ? Number(sm.cost_usd) : undefined,
          });
        }
      }
      messages = converted;
    } catch {
      messages = [];
    }
  }
  let panelWidth = $state(400);
  let selectedPlan = $derived<"free" | "basic" | "standard" | "premium">(
    (agent?.plan as "free" | "basic" | "standard" | "premium") || "standard"
  );

  // Auto-scroll controller
  const autoScroll = createAutoScrollController();

  // Attach container to auto-scroll controller when available
  $effect(() => {
    autoScroll.setContainer(messagesEl);
  });

  // Reactive state for scroll-to-bottom button visibility
  let showScrollBtn = $state(false);

  function handleContainerScroll() {
    autoScroll.onScroll();
    showScrollBtn = !autoScroll.isAtBottom();
  }

  // History
  let historyOpen = $state(false);

  $effect(() => {
    if (agentName) agentListStore.setActive(agentName);
  });

  // Listen for "New Chat" from header
  $effect(() => {
    function onNewChat() {
      handleNewChat();
    }
    window.addEventListener("chat:new", onNewChat);
    return () => window.removeEventListener("chat:new", onNewChat);
  });

  // Listen for "Improve" from header
  $effect(() => {
    function onImprove() {
      improveOpen = !improveOpen;
    }
    window.addEventListener("chat:improve", onImprove);
    return () => window.removeEventListener("chat:improve", onImprove);
  });

  // Listen for follow-up suggestion clicks (from ChatMessage)
  $effect(() => {
    function onFollowUp(e: Event) {
      const suggestion = (e as CustomEvent).detail;
      if (suggestion && !streaming) {
        handleSend(suggestion);
      }
    }
    window.addEventListener("chat:followup", onFollowUp);
    return () => window.removeEventListener("chat:followup", onFollowUp);
  });

  // Auto-setup: when redirected from agent builder with ?setup=description,
  // open the Improve panel and send the description to the meta-agent in demo mode
  // so it configures the agent (system prompt, tools, eval cases, governance).
  let setupHandled = $state(false);
  $effect(() => {
    if (setupHandled || !agentName) return;
    const params = new URLSearchParams(window.location.search);
    const setupMsg = params.get("setup");
    if (setupMsg) {
      setupHandled = true;
      // Clean the URL
      window.history.replaceState({}, "", `/chat/${agentName}`);
      // Open the Improve panel and send the setup message to the meta-agent
      improveOpen = true;
      // Wait for panel to mount, then send setup message
      setTimeout(() => {
        metaAgentStore.sendMessage(
          agentName,
          `I just created this agent. Here's what I want it to do:\n\n${decodeURIComponent(setupMsg)}\n\nPlease configure it — set up the system prompt, pick the right tools, and set governance.`,
          "demo",
        );
      }, 500);
    }
  });

  function toggleHistory() {
    historyOpen = !historyOpen;
    if (historyOpen) {
      conversationStore.fetchConversations(agentName);
    }
  }

  function handleNewChat() {
    if (streaming) {
      abortFn?.();
      streaming = false;
      abortFn = null;
    }
    messages = [];
    sessionId = undefined;
    conversationId = undefined;
    conversationStore.startNew();
    // Update URL to remove conversation parameter
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", `/chat/${agentName}`);
    }
  }

  function handleSend(text: string) {
    if (!text.trim() || streaming) return;
    sendMessage(text);
  }

  function sendMessage(text: string, replaceFromIndex?: number) {
    if (replaceFromIndex !== undefined) {
      messages = messages.slice(0, replaceFromIndex);
    }

    // Add user message optimistically
    messages = [...messages, { role: "user", content: text }];
    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [],
      thinking: "",
      segments: [],
    };
    messages = [...messages, assistantMsg];
    streaming = true;
    autoScroll.onNewMessage();

    // SDK pattern: send chat request via AgentClient WebSocket RPC.
    // The agent DO (Think) processes this via its chat protocol and
    // streams responses back as cf_agent_use_chat_response messages.
    const client = agentRpc.client;
    if (!client) {
      const last = messages[messages.length - 1];
      if (last) last.content = "**Error:** Not connected to agent. Please refresh.";
      streaming = false;
      messages = [...messages];
      return;
    }

    // SDK chat protocol: Think expects init.body wrapper with stringified JSON
    // and UIMessage format with parts[] instead of content
    const requestBody = JSON.stringify({
      messages: [{
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      }],
      trigger: "submit-message",
    });
    client.send(JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: requestBody },
    }));
  }

  function handleStop() {
    // SDK pattern: send cancel message via WebSocket
    agentRpc.client?.send(JSON.stringify({ type: "cf_agent_chat_request_cancel" }));
    streaming = false;
    abortFn = null;
  }

  // --- Message action handlers ---

  function handleEditMessage(idx: number) {
    const msg = messages[idx];
    if (!msg || msg.role !== "user") return;
    // Prompt user for new content (inline editing would require more UI)
    const newContent = prompt("Edit message:", msg.content);
    if (newContent === null || newContent.trim() === "") return;
    // Re-send from this point: truncate messages from idx onward and send new text
    sendMessage(newContent.trim(), idx);
  }

  function handleRegenerateMessage(idx: number) {
    // Find the user message preceding this assistant message
    const msg = messages[idx];
    if (!msg || msg.role !== "assistant") return;
    // Find previous user message
    let userIdx = idx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;
    const userText = messages[userIdx].content;
    // Remove from the assistant message onward and re-send
    sendMessage(userText, idx);
  }

  function handleDeleteMessage(idx: number) {
    // Delete this message and all subsequent messages
    messages = messages.slice(0, idx);
  }
</script>

<div class="flex h-full">
  <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
    <ChatHeader {agent} {agentName} />

    <!-- History dropdown (server-backed conversations) -->
    <div class="relative">
      <div class="flex items-center justify-end gap-1 px-4 py-1.5 sm:px-6">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onclick={() => { workspaceOpen = !workspaceOpen; }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Files
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onclick={toggleHistory}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 8v4l3 3" />
            <circle cx="12" cy="12" r="10" />
          </svg>
          History
        </button>
      </div>
      {#if historyOpen}
        <div class="absolute right-4 top-full z-20 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg sm:right-6">
          {#if conversationStore.loading}
            <div class="flex items-center justify-center py-6">
              <div class="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
            </div>
          {:else if conversationStore.conversations.length === 0}
            <div class="px-4 py-6 text-center text-sm text-muted-foreground">No conversations yet</div>
          {:else}
            <div class="max-h-72 overflow-y-auto">
              {#each conversationStore.conversations as conv}
                {@const convTitle = typeof conv.title === "string" && conv.title.trim().length > 0 ? conv.title : "Untitled conversation"}
                <button
                  type="button"
                  class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent {conversationId === conv.id ? 'bg-primary/5' : ''}"
                  onclick={() => {
                    historyOpen = false;
                    conversationId = conv.id;
                    window.history.pushState({}, "", `/chat/${agentName}?c=${conv.id}`);
                    loadConversationFromServer(conv.id);
                  }}
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs font-medium text-foreground">
                      {convTitle.slice(0, 50)}{convTitle.length > 50 ? "..." : ""}
                    </p>
                    <p class="text-[11px] text-muted-foreground">
                      {conv.message_count} msgs &middot; {new Date(conv.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Messages container -->
    <div
      bind:this={messagesEl}
      class="relative flex-1 overflow-y-auto"
      onscroll={handleContainerScroll}
    >
      {#if !agent && !agentListStore.loading && agentListStore.agents.length > 0}
        <div class="flex flex-1 flex-col items-center justify-center px-6 py-16">
          <svg xmlns="http://www.w3.org/2000/svg" class="mb-4 h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <h3 class="mb-1 text-lg font-semibold text-foreground">Agent not found</h3>
          <p class="mb-4 text-sm text-muted-foreground">No agent named "{agentName}" exists.</p>
          <a
            href="/"
            class="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to Dashboard
          </a>
        </div>
      {:else if messages.length === 0}
        <EmptyChat
          {agentName}
          tools={agent?.tools ?? []}
          onSend={handleSend}
        />
      {:else}
        <div class="w-full max-w-5xl mx-auto space-y-6 px-4 py-6 sm:px-6">
          {#each messages as msg, i}
            <ChatMessage
              message={msg}
              streaming={streaming && i === messages.length - 1}
              agentName={agentName}
              index={i}
              onEdit={handleEditMessage}
              onRegenerate={msg.role === "assistant" ? handleRegenerateMessage : undefined}
              onDelete={handleDeleteMessage}
            />
          {/each}
        </div>
      {/if}

      <!-- Scroll to bottom floating button -->
      {#if showScrollBtn && messages.length > 0}
        <button
          type="button"
          class="fixed bottom-28 right-8 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-popover shadow-lg transition-all hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:right-12"
          onclick={() => autoScroll.scrollToBottom(true)}
          aria-label="Scroll to bottom"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      {/if}
    </div>

    <ChatInput
      onSend={handleSend}
      onStop={handleStop}
      {streaming}
      disabled={false}
    />
  </div>

  {#if improveOpen}
    <MetaAgentPanel
      {agentName}
      bind:open={improveOpen}
      bind:width={panelWidth}
      onClose={() => (improveOpen = false)}
    />
  {/if}

  <WorkspacePanel
    bind:this={workspacePanelRef}
    {agentName}
    open={workspaceOpen}
    onClose={() => (workspaceOpen = false)}
  />

  <ComputerPanel
    open={computerOpen}
    onClose={() => (computerOpen = false)}
    toolCalls={messages[messages.length - 1]?.toolCalls || []}
    {previewUrl}
    {activeFile}
    {terminalLines}
    files={workspaceFiles}
  />
</div>

<style>
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  :global(.animate-shimmer) {
    animation: shimmer 2s linear infinite;
  }
</style>
