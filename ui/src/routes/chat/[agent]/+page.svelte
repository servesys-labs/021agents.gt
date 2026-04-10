<script lang="ts">
  import { page } from "$app/stores";
  import { agentStore } from "$lib/stores/agents.svelte";
  import { streamAgent, type ChatEvent } from "$lib/services/chat";
  import { conversationStore } from "$lib/stores/conversations.svelte";
  import { createAutoScrollController } from "$lib/utils/auto-scroll";
  import ChatHeader from "$lib/components/chat/ChatHeader.svelte";
  import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
  import ChatInput from "$lib/components/chat/ChatInput.svelte";
  import EmptyChat from "$lib/components/chat/EmptyChat.svelte";
  import MetaAgentPanel from "$lib/components/meta-agent/MetaAgentPanel.svelte";
  import { metaAgentStore } from "$lib/stores/meta-agent.svelte";

  interface ToolCall {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  interface Message {
    role: "user" | "assistant";
    content: string;
    toolCalls?: ToolCall[];
    thinking?: string;
    model?: string;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    latency_ms?: number;
  }

  let agentName = $derived($page.params.agent ?? "");
  let agent = $derived(agentStore.agents.find((a) => a.name === agentName) ?? null);

  let messages = $state<Message[]>([]);
  let streaming = $state(false);
  let abortFn = $state<(() => void) | null>(null);
  let messagesEl: HTMLDivElement | undefined = $state();
  let sessionId = $state<string | undefined>(undefined);
  let conversationId = $state<string | undefined>(undefined);
  let improveOpen = $state(false);

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
          converted.push({
            role: sm.role,
            content: sm.content,
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
    if (agentName) agentStore.setActive(agentName);
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
    // If replaceFromIndex is provided, truncate messages from that point
    if (replaceFromIndex !== undefined) {
      messages = messages.slice(0, replaceFromIndex);
    }

    messages = [...messages, { role: "user", content: text }];
    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [],
      thinking: "",
    };
    messages = [...messages, assistantMsg];
    streaming = true;

    // Tell auto-scroll to re-enable and scroll down
    autoScroll.onNewMessage();

    const { abort } = streamAgent(
      agentName,
      text,
      (event: ChatEvent) => {
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return;

        const d = event.data;

        switch (event.type) {
          case "turn_start": {
            const model = (d as { model?: string }).model;
            if (model) last.model = model;
            messages = [...messages];
            break;
          }
          case "token": {
            const text = (d as { content?: string; text?: string }).content ??
                         (d as { text?: string }).text ?? "";
            last.content += text;
            messages = [...messages];
            if (autoScroll.isEnabled()) {
              requestAnimationFrame(() => autoScroll.scrollToBottom(false));
            }
            break;
          }
          case "thinking": {
            const content = (d as { content?: string }).content ?? "";
            last.thinking = (last.thinking || "") + content;
            messages = [...messages];
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
            const inputStr = tc.args_preview ??
              (tc.input ? JSON.stringify(tc.input, null, 2) : "{}");
            last.toolCalls = [
              ...(last.toolCalls ?? []),
              { name: tc.name, input: inputStr, call_id: callId },
            ];
            messages = [...messages];
            if (autoScroll.isEnabled()) {
              requestAnimationFrame(() => autoScroll.scrollToBottom(false));
            }
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
            messages = [...messages];
            break;
          }
          case "done": {
            const done = d as {
              cost_usd?: number;
              session_id?: string;
              output?: string;
              input_tokens?: number;
              output_tokens?: number;
              latency_ms?: number;
              conversation_id?: string;
            };
            if (done.cost_usd !== undefined) last.cost_usd = done.cost_usd;
            if (done.session_id) sessionId = done.session_id;
            if (done.input_tokens) last.input_tokens = done.input_tokens;
            if (done.output_tokens) last.output_tokens = done.output_tokens;
            if (done.latency_ms) last.latency_ms = done.latency_ms;
            if (done.output && !last.content) last.content = done.output;
            // Capture conversation_id from server and update URL
            if (done.conversation_id) {
              conversationId = done.conversation_id;
              conversationStore.setActiveId(done.conversation_id);
              if (typeof window !== "undefined") {
                window.history.pushState({}, "", `/chat/${agentName}?c=${done.conversation_id}`);
              }
              // Refresh sidebar conversation list
              conversationStore.fetchConversations(agentName);
            }
            messages = [...messages];
            streaming = false;
            abortFn = null;
            break;
          }
          case "error": {
            const err = (d as { message?: string }).message ?? "Unknown error";
            last.content += `\n\n**Error:** ${err}`;
            messages = [...messages];
            streaming = false;
            abortFn = null;
            break;
          }
        }
      },
      sessionId,
      selectedPlan,
      // Send conversation history for session continuity — the DO uses this as fallback
      // when its SQLite is empty (e.g., after a code deploy resets the DO)
      messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
      conversationId,
    );

    abortFn = abort;
  }

  function handleStop() {
    abortFn?.();
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
      <div class="flex items-center justify-end px-4 py-1.5 sm:px-6">
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
      {#if !agent && !agentStore.loading && agentStore.agents.length > 0}
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
</div>
