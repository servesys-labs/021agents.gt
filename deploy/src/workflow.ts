/**
 * AgentRunWorkflow — The single execution engine for all agent runs.
 *
 * Replaces streamRun and edge_graph as the primary execution path.
 * Every agent run goes through here — crash-safe, retryable, no state corruption.
 *
 * Architecture:
 *   Client ←WS/SSE→ DO (connection + session state only)
 *                      ↓ env.AGENT_RUN_WORKFLOW.create()
 *                  Workflow (durable agent loop)
 *                      ↓ writes events to KV after each step
 *                     KV ← DO polls & pushes to client in real-time
 *
 * Graph equivalents:
 *   LangGraph node       = step.do("node-name", { retries, timeout }, fn)
 *   Conditional edge      = if/else between steps
 *   Parallel branches     = Promise.all([step.do("a"), step.do("b")])
 *   Human-in-the-loop    = step.waitForEvent("approval")
 *   Sub-graph/delegation  = child Workflow via env.AGENT_RUN_WORKFLOW.create()
 *   State persistence     = KV (progress) + DO SQLite (conversation)
 *   Checkpointing         = automatic per step (Workflow runtime)
 */

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
  NonRetryableError,
} from "cloudflare:workers";
import { sanitizeUnicode, sanitizeDeep } from "./runtime/sanitize";
import { validateUrl } from "./runtime/ssrf";
import { shouldCompact, compactMessages } from "./runtime/compact";
import { repairConversation } from "./runtime/conversation-repair";

// ── Types ────────────────────────────────────────────────────

export interface AgentRunParams {
  agent_name: string;
  input: string;
  org_id: string;
  project_id: string;
  channel: string;
  channel_user_id: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  progress_key: string;
  /** If set, this is a delegated sub-agent run */
  parent_session_id?: string;
  parent_depth?: number;
  /** Override the system prompt for this run (used by training eval) */
  system_prompt_override?: string;
  /** Media URLs attached to the user message (images, audio, documents) */
  media_urls?: string[];
  /** MIME types corresponding to each media_url entry */
  media_types?: string[];
  /** Cost ceiling override for A2A tasks — ensures agent can't spend more than caller authorized */
  budget_limit_usd_override?: number;
  /** Override the LLM plan for this run (basic/standard/premium) */
  plan_override?: string;
  /** Override the agent's tool list for this run — scopes a sub-agent to only these tools */
  tools_override?: string[];
}

export interface RunOutput {
  output: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  session_id: string;
  trace_id: string;
}

interface LLMResult {
  content: string;
  tool_calls: Array<{ id: string; name: string; arguments: string }>;
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

// ── Workflow ─────────────────────────────────────────────────

export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunParams> {
  async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<RunOutput> {
    const p = event.payload;
    const sessionId = event.instanceId.slice(0, 16);
    const traceId = crypto.randomUUID().slice(0, 16);

    // ═══════════════════════════════════════════════════════════
    // STEP 1: BOOTSTRAP — load config, skills, reasoning strategy
    // ═══════════════════════════════════════════════════════════

    const bootstrap = await step.do("bootstrap", {
      retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
      timeout: "30 seconds",
    }, async () => {
      const { loadAgentConfig } = await import("./runtime/db");
      const config = await loadAgentConfig(this.env.HYPERDRIVE, p.agent_name, {
        provider: this.env.DEFAULT_PROVIDER || "openrouter",
        model: this.env.DEFAULT_MODEL || "openai/gpt-5.4-mini",
        plan: "standard",
      });

      // Apply plan override if provided (mid-session model switching)
      if (p.plan_override && ["basic", "standard", "premium"].includes(p.plan_override)) {
        config.plan = p.plan_override;
      }

      // Apply tools override — scopes sub-agent to only specified tools
      if (p.tools_override && p.tools_override.length > 0) {
        config.tools = p.tools_override;
      }

      // Reasoning strategy
      const { selectReasoningStrategy, autoSelectStrategy } = await import("./runtime/reasoning-strategies");
      const { getToolDefinitions } = await import("./runtime/tools");
      const toolDefs = getToolDefinitions(config.tools, config.blocked_tools);
      const reasoningPrompt = selectReasoningStrategy(
        config.reasoning_strategy as string | undefined, p.input, 1,
      ) || autoSelectStrategy(p.input, toolDefs.length);

      return {
        config: {
          system_prompt: config.system_prompt,
          model: config.model,
          provider: String(config.provider || "openrouter"),
          plan: config.plan,
          tools: config.tools,
          blocked_tools: config.blocked_tools || [],
          max_turns: config.max_turns || 50,
          budget_limit_usd: p.budget_limit_usd_override
            ? Math.min(p.budget_limit_usd_override, config.budget_limit_usd || 10)
            : (config.budget_limit_usd || 10),
          parallel_tool_calls: config.parallel_tool_calls !== false,
          reasoning_strategy: config.reasoning_strategy,
          routing: config.routing,
        },
        reasoning_prompt: reasoningPrompt,
        tool_count: toolDefs.length,
      };
    });

    const config = bootstrap.config;

    await this.emit(p.progress_key, {
      type: "session_start", session_id: sessionId, trace_id: traceId,
      agent_name: p.agent_name,
    });

    if (bootstrap.reasoning_prompt) {
      await this.emit(p.progress_key, {
        type: "reasoning", strategy: config.reasoning_strategy || "auto",
      });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 1b: HYDRATE WORKSPACE — restore files from R2 into sandbox
    // ═══════════════════════════════════════════════════════════
    // On cold start, the sandbox container has an empty /workspace.
    // Files from previous sessions exist in R2 but need to be loaded back.
    // This must happen BEFORE tools run, or read-file/edit-file will find nothing.

    if (this.env.STORAGE && this.env.SANDBOX) {
      await step.do("hydrate-workspace", {
        retries: { limit: 2, delay: "3 seconds", backoff: "linear" },
        timeout: "60 seconds",
      }, async () => {
        const { getSandbox } = await import("@cloudflare/sandbox");
        const { hydrateWorkspace } = await import("./runtime/workspace");
        const sandbox = getSandbox(this.env.SANDBOX, `session-${sessionId}`, {
          sleepAfter: "10m",
          enableInternet: false,
        } as any);
        const { restored, skipped } = await hydrateWorkspace(
          this.env.STORAGE, sandbox, p.org_id || "default", p.agent_name, p.channel_user_id || "",
        );
        return { restored, skipped };
      });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 2: BUILD MESSAGES
    // ═══════════════════════════════════════════════════════════

    let messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }> = [];

    // ── Phase 0 Security: Sanitize all inputs ──
    // Defends against ASCII smuggling, hidden prompt injection, Unicode tag attacks
    const safeInput = sanitizeUnicode(p.input);
    const safeHistory = (p.history || []).map(msg => ({
      role: msg.role,
      content: sanitizeUnicode(msg.content),
    }));

    // ── Phase 0 Security: Validate system prompt override ──
    // Size check runs AFTER sanitization so zero-width padding can't bypass the limit
    const MAX_SYSTEM_PROMPT_OVERRIDE_CHARS = 50_000;
    let effectiveSystemPrompt = config.system_prompt;
    if (p.system_prompt_override) {
      const sanitizedOverride = sanitizeUnicode(p.system_prompt_override);
      if (sanitizedOverride.length > MAX_SYSTEM_PROMPT_OVERRIDE_CHARS) {
        throw new NonRetryableError(
          `system_prompt_override exceeds ${MAX_SYSTEM_PROMPT_OVERRIDE_CHARS} char limit (got ${sanitizedOverride.length} after sanitization)`
        );
      }
      effectiveSystemPrompt = sanitizedOverride;
    }

    if (effectiveSystemPrompt) {
      messages.push({ role: "system", content: effectiveSystemPrompt });
    }
    if (bootstrap.reasoning_prompt) {
      messages.push({ role: "system", content: bootstrap.reasoning_prompt });
    }
    for (const msg of safeHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // ── Phase 0 Security: Validate media URLs for SSRF ──
    if (p.media_urls?.length) {
      for (const url of p.media_urls) {
        const check = validateUrl(url);
        if (!check.valid) {
          throw new NonRetryableError(`Blocked media URL: ${check.reason}`);
        }
      }
    }

    // Build user message — multimodal if media URLs are present (images, etc.)
    if (p.media_urls?.length) {
      const contentParts: Array<{ type: string; text?: string; image_url?: { url: string }; source?: { type: string; media_type: string; url: string } }> = [];
      if (safeInput) contentParts.push({ type: "text", text: safeInput });
      for (let i = 0; i < p.media_urls.length; i++) {
        const url = p.media_urls[i];
        const mimeType = p.media_types?.[i] || "";
        if (mimeType.startsWith("image") || /\.(jpg|jpeg|png|gif|webp)$/i.test(url)) {
          contentParts.push({ type: "image_url", image_url: { url } });
        } else {
          // Non-image media: include as text reference (audio/video transcription handled by tools)
          contentParts.push({ type: "text", text: `[Attached media: ${url}]` });
        }
      }
      messages.push({ role: "user", content: contentParts as any });
    } else {
      messages.push({ role: "user", content: safeInput });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3: AGENTIC TURN LOOP
    // ═══════════════════════════════════════════════════════════

    let totalCost = 0;
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalOutput = "";
    const startTime = Date.now();
    const turnRecords: Array<{
      turn: number; model: string; content: string;
      input_tokens: number; output_tokens: number; cost_usd: number;
      latency_ms: number; tool_calls: string[]; tool_results: Array<{ name: string; latency_ms: number; error?: string }>;
      errors: string[];
    }> = [];

    // ── Phase 1.4: Loop detection state ──
    // Track recent tool calls to detect stuck loops (same tool + same args + same error 3x)
    const recentToolSignatures: string[] = []; // ring buffer of last 5 signatures
    const LOOP_DETECTION_WINDOW = 5;
    const LOOP_THRESHOLD = 3;

    for (let turn = 1; turn <= config.max_turns; turn++) {
     try { // Phase 1.4: wrap turn body in try-catch for resilient error handling

      // ── Budget check (no step needed — pure logic) ──
      if (totalCost >= config.budget_limit_usd) {
        await this.emit(p.progress_key, { type: "error", message: "Budget exhausted", code: "BUDGET_EXHAUSTED" });
        break;
      }

      // ── Phase 9.1: Conversation repair — fix orphaned tool calls before LLM sees them ──
      {
        const { messages: repaired, repairs } = repairConversation(messages);
        if (repairs.orphanedUses + repairs.orphanedResults + repairs.duplicateIds + repairs.emptyResults > 0) {
          messages = repaired;
          console.log(`[conversation-repair] Fixed: ${repairs.orphanedUses} orphaned uses, ${repairs.orphanedResults} orphaned results, ${repairs.duplicateIds} duplicate IDs, ${repairs.emptyResults} empty results`);
        }
      }

      // ── Phase 2.4: Context compression — auto-compact when approaching token limit ──
      if (shouldCompact(messages)) {
        const compacted = await compactMessages(
          this.env as any,
          messages,
          6, // keep last 6 messages
        );
        const dropped = messages.length - compacted.length;
        messages = compacted;
        await this.emit(p.progress_key, {
          type: "system",
          content: `Context compressed: ${dropped} messages summarized to stay within token limits.`,
        });
      }

      // ── LLM call — retryable, checkpointed ──
      await this.emit(p.progress_key, { type: "turn_start", turn, model: config.model });

      const llm = await step.do(`llm-${turn}`, {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const { callLLM } = await import("./runtime/llm");
        const { getToolDefinitions } = await import("./runtime/tools");
        const { resolvePlanRouting } = await import("./runtime/db");
        const routerMod = await import("./runtime/router");

        const planRouting = resolvePlanRouting(config.plan, config.routing as any);
        const route = await routerMod.selectModel(p.input, planRouting as any, config.model, config.provider, {
          AI: this.env.AI,
          CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID || "",
          AI_GATEWAY_ID: this.env.AI_GATEWAY_ID || "",
          AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN || "",
          CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN || "",
        } as any);

        const { selectToolsForQuery } = await import("./runtime/tools");
        const allToolDefs = getToolDefinitions(config.tools, config.blocked_tools);

        // Progressive tool discovery: only send relevant tools per turn
        // Build context from last 3 messages + current input
        const recentContext = messages.slice(-3).map(m => m.content || "").join(" ");
        const toolDefs = selectToolsForQuery(allToolDefs, p.input, recentContext);

        const response = await callLLM(
          { AI: this.env.AI, CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID: this.env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN, CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN } as any,
          messages.map(m => ({ role: m.role as any, content: m.content || "", tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
          toolDefs,
          { model: route.model, provider: route.provider, max_tokens: route.max_tokens },
        );

        return {
          content: response.content || "",
          tool_calls: response.tool_calls || [],
          model: response.model || route.model,
          cost_usd: response.cost_usd || 0,
          input_tokens: response.usage?.input_tokens || 0,
          output_tokens: response.usage?.output_tokens || 0,
        } as LLMResult;
      });

      totalCost += llm.cost_usd;
      totalInputTokens += llm.input_tokens;
      totalOutputTokens += llm.output_tokens;

      // ── Thinking trace (only when LLM is reasoning before tool calls) ──
      if (llm.content && llm.tool_calls.length > 0) {
        await this.emit(p.progress_key, { type: "thinking", content: llm.content, turn });
      }

      // ── No tools → final answer (stream as tokens for the frontend) ──
      if (llm.tool_calls.length === 0) {
        finalOutput = llm.content;
        // Emit content as token chunks so frontend shows streaming
        const words = llm.content.split(/(\s+)/);
        let chunk = "";
        for (let i = 0; i < words.length; i++) {
          chunk += words[i];
          if (chunk.length > 40 || i === words.length - 1) {
            await this.emit(p.progress_key, { type: "token", content: chunk });
            chunk = "";
          }
        }
        await this.emit(p.progress_key, {
          type: "turn_end", turn, model: llm.model, cost_usd: llm.cost_usd,
          tokens: llm.input_tokens + llm.output_tokens, done: true,
        });
        // Record final answer turn
        turnRecords.push({
          turn, model: llm.model, content: llm.content,
          input_tokens: llm.input_tokens, output_tokens: llm.output_tokens,
          cost_usd: llm.cost_usd, latency_ms: 0,
          tool_calls: [], tool_results: [], errors: [],
        });
        break;
      }

      // ── PARALLEL TOOL EXECUTION ──
      // Emit individual tool_call events (not plural) so frontend shows each tool card
      for (const tc of llm.tool_calls) {
        // Include args preview so UI can show what was searched/executed
        let argsPreview = "";
        try {
          const parsed = JSON.parse(tc.arguments || "{}");
          argsPreview = parsed.query || parsed.code?.slice(0, 120) || parsed.url || parsed.path || parsed.input?.slice(0, 120) || "";
        } catch {}
        await this.emit(p.progress_key, {
          type: "tool_call", name: tc.name, tool_call_id: tc.id, turn,
          args_preview: argsPreview,
        });
      }

      // Handle discover-tools calls locally (no need for external execution)
      const discoverCalls = llm.tool_calls.filter(tc => tc.name === "discover-tools");
      if (discoverCalls.length > 0) {
        const { discoverTools, getToolDefinitions: gtd } = await import("./runtime/tools");
        const allTools = gtd(config.tools, config.blocked_tools);
        for (const dc of discoverCalls) {
          const query = JSON.parse(dc.arguments || "{}").query || "";
          const discovered = discoverTools(allTools, query);
          const resultText = discovered.tools.length > 0
            ? `Found ${discovered.tools.length} tools: ${discovered.tools.join(", ")}. These tools are now available for your next action.`
            : "No matching tools found. Try a different description.";
          messages.push({ role: "assistant", content: llm.content || "", tool_calls: [dc] });
          messages.push({ role: "tool", tool_call_id: dc.id, name: dc.name, content: resultText });
          await this.emit(p.progress_key, {
            type: "tool_result", name: "discover-tools", tool_call_id: dc.id,
            result: resultText, latency_ms: 0, cost_usd: 0,
          });
        }
        // If discover-tools was the only call, continue to next turn
        if (llm.tool_calls.every(tc => tc.name === "discover-tools")) {
          totalToolCalls += discoverCalls.length;
          continue;
        }
      }

      // Filter out discover-tools from actual execution
      const executableCalls = llm.tool_calls.filter(tc => tc.name !== "discover-tools");

      // ── Phase 1.2: Pre-execution budget check ──
      // Estimate total tool cost before executing. Prevents overspend when
      // budget is nearly exhausted but an expensive tool batch is queued.
      {
        const { estimateToolCost } = await import("./runtime/tools");
        const estimatedBatchCost = executableCalls.reduce(
          (sum, tc) => sum + estimateToolCost(tc.name), 0
        );
        if (totalCost + estimatedBatchCost > config.budget_limit_usd) {
          await this.emit(p.progress_key, {
            type: "warning",
            message: `Budget guard: estimated tool cost $${estimatedBatchCost.toFixed(4)} would exceed remaining budget $${(config.budget_limit_usd - totalCost).toFixed(4)}. Skipping tool execution.`,
          });
          // Inject a synthetic tool result so the LLM knows tools were skipped
          for (const tc of executableCalls) {
            messages.push({ role: "assistant", content: llm.content || "", tool_calls: [tc] });
            messages.push({
              role: "tool", tool_call_id: tc.id, name: tc.name,
              content: "[Tool execution skipped — budget limit would be exceeded]",
            });
          }
          finalOutput = llm.content || "Budget limit reached. Tool execution was skipped.";
          break;
        }
      }

      const toolResultEntries = await Promise.all(
        executableCalls.map((tc, i) =>
          step.do(`tool-${turn}-${i}-${tc.name}`, {
            retries: { limit: 2, delay: "3 seconds", backoff: "linear" },
            timeout: "5 minutes",
          }, async () => {
            const { executeTools } = await import("./runtime/tools");
            const results = await executeTools(
              {
                AI: this.env.AI, HYPERDRIVE: this.env.HYPERDRIVE,
                VECTORIZE: this.env.VECTORIZE, STORAGE: this.env.STORAGE,
                SANDBOX: this.env.SANDBOX, LOADER: this.env.LOADER,
                BROWSER: this.env.BROWSER, BRAVE_SEARCH_KEY: this.env.BRAVE_SEARCH_KEY,
                CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
                CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
                AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
                AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
                // Workflow + KV bindings for sub-agent delegation
                AGENT_RUN_WORKFLOW: this.env.AGENT_RUN_WORKFLOW,
                AGENT_PROGRESS_KV: this.env.AGENT_PROGRESS_KV,
                // Auth + API bindings for marketplace/feed/memory/mcp tools
                SERVICE_TOKEN: (this.env as any).SERVICE_TOKEN,
                CONTROL_PLANE_URL: (this.env as any).CONTROL_PLANE_URL,
                OPENROUTER_API_KEY: (this.env as any).OPENROUTER_API_KEY,
                // Agent config for plan-aware tool routing (vision model, etc.)
                __agentConfig: config,
                // User ID for per-user workspace scoping in R2
                __channelUserId: p.channel_user_id || "",
              } as any,
              [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
              sessionId,
              false, // single tool per step
              config.tools,
            );
            const r = results[0];
            return {
              tool_call_id: tc.id,
              name: tc.name,
              result: typeof r?.result === "string" ? r.result : JSON.stringify(r?.result || ""),
              error: r?.error || undefined,
              latency_ms: r?.latency_ms || 0,
              cost_usd: r?.cost_usd || 0,
            };
          })
        )
      );

      totalToolCalls += executableCalls.length + discoverCalls.length;

      // Accumulate tool costs (was missing — caused silent zero billing for tools)
      for (const tr of toolResultEntries) {
        totalCost += tr.cost_usd || 0;
      }

      // ── Phase 2.1: Tool result size management ──
      // Per-tool cap: 30K chars. Per-turn aggregate cap: 200K chars.
      const MAX_RESULT_CHARS = 30_000;
      const MAX_TURN_RESULT_CHARS = 200_000;
      let turnResultChars = 0;
      for (const tr of toolResultEntries) {
        if (tr.result && tr.result.length > MAX_RESULT_CHARS) {
          tr.result = tr.result.slice(0, MAX_RESULT_CHARS) + `\n[truncated — ${tr.result.length} chars total]`;
        }
        turnResultChars += (tr.result || "").length;
        if (turnResultChars > MAX_TURN_RESULT_CHARS) {
          const remaining = MAX_TURN_RESULT_CHARS - (turnResultChars - (tr.result || "").length);
          if (remaining > 0) {
            tr.result = (tr.result || "").slice(0, remaining) + "\n[truncated — aggregate turn result limit reached]";
          } else {
            tr.result = "[result omitted — aggregate turn result limit reached]";
          }
        }
      }

      // Emit tool results + file_change events for write-file/edit-file
      for (let i = 0; i < toolResultEntries.length; i++) {
        const tr = toolResultEntries[i];
        await this.emit(p.progress_key, {
          type: "tool_result", name: tr.name, tool_call_id: tr.tool_call_id,
          result: (tr.result || "").slice(0, 3000),
          error: tr.error, latency_ms: tr.latency_ms,
          cost_usd: tr.cost_usd || 0,
        });

        // Emit file_change events for file-writing tools so UI can show code diffs
        if (!tr.error && (tr.name === "write-file" || tr.name === "edit-file")) {
          try {
            const tc = executableCalls[i];
            const tcArgs = JSON.parse(tc?.arguments || "{}");
            const filePath = tcArgs.path || "";
            const ext = filePath.split(".").pop()?.toLowerCase() || "";
            const lang = { ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", py: "python", json: "json", html: "html", css: "css", md: "markdown", sql: "sql", sh: "bash", yaml: "yaml", yml: "yaml" }[ext] || ext;

            if (tr.name === "write-file") {
              const content = tcArgs.content || "";
              await this.emit(p.progress_key, {
                type: "file_change",
                change_type: "create",
                path: filePath,
                language: lang,
                content: content.slice(0, 10000), // Cap at 10KB for streaming
                size: content.length,
                tool_call_id: tr.tool_call_id,
              });
            } else if (tr.name === "edit-file") {
              await this.emit(p.progress_key, {
                type: "file_change",
                change_type: "edit",
                path: filePath,
                language: lang,
                old_text: (tcArgs.old_text || tcArgs.old_string || "").slice(0, 5000),
                new_text: (tcArgs.new_text || tcArgs.new_string || "").slice(0, 5000),
                tool_call_id: tr.tool_call_id,
              });
            }
          } catch { /* non-critical — don't fail tool processing for file events */ }
        }
      }

      // ── Build messages for next turn ──
      // Use executableCalls (not llm.tool_calls) to avoid double-adding discover-tools
      // which was already pushed to messages in the discover-tools handler above.
      messages.push({
        role: "assistant", content: llm.content || "",
        tool_calls: executableCalls,
      });
      for (const tr of toolResultEntries) {
        messages.push({
          role: "tool", tool_call_id: tr.tool_call_id,
          name: tr.name,
          content: tr.error ? `Error: ${tr.error}` : tr.result,
        });
      }

      await this.emit(p.progress_key, {
        type: "turn_end", turn, model: llm.model, cost_usd: llm.cost_usd,
        tokens: llm.input_tokens + llm.output_tokens, done: false,
        tool_calls: executableCalls.length,
      });

      // Accumulate turn record for telemetry
      turnRecords.push({
        turn,
        model: llm.model,
        content: llm.content,
        input_tokens: llm.input_tokens,
        output_tokens: llm.output_tokens,
        cost_usd: llm.cost_usd + toolResultEntries.reduce((s, t) => s + (t.cost_usd || 0), 0),
        latency_ms: 0,
        tool_calls: executableCalls.map(tc => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch {}
          return { name: tc.name, arguments: args };
        }),
        tool_results: toolResultEntries.map(tr => ({
          name: tr.name,
          result: (tr.result || "").slice(0, 2000),
          latency_ms: tr.latency_ms || 0,
          cost_usd: tr.cost_usd || 0,
          error: tr.error,
        })),
        errors: toolResultEntries.filter(tr => tr.error).map(tr => `${tr.name}: ${tr.error}`),
      });

      // ── Phase 1.4: Loop detection ──
      // Track tool call signatures (name + args hash + error presence).
      // If the same signature appears 3+ times in the last 5 calls, break.
      for (const tr of toolResultEntries) {
        const sig = `${tr.name}:${tr.error ? "ERR" : "OK"}`;
        recentToolSignatures.push(sig);
        if (recentToolSignatures.length > LOOP_DETECTION_WINDOW) {
          recentToolSignatures.shift();
        }
      }

      // Check for repeated failure pattern
      if (recentToolSignatures.length >= LOOP_THRESHOLD) {
        const lastSig = recentToolSignatures[recentToolSignatures.length - 1];
        const repeatCount = recentToolSignatures.filter(s => s === lastSig).length;
        if (repeatCount >= LOOP_THRESHOLD && lastSig.endsWith(":ERR")) {
          const loopTool = lastSig.split(":")[0];
          await this.emit(p.progress_key, {
            type: "warning",
            message: `Loop detected: ${loopTool} failed ${repeatCount} times in last ${LOOP_DETECTION_WINDOW} calls. Stopping to prevent budget waste.`,
          });
          finalOutput = `I encountered a repeated failure with the ${loopTool} tool and stopped to avoid wasting resources. Please check the tool configuration or try a different approach.`;
          break;
        }
      }

      // Keep messages under 1 MiB (Workflow step return limit)
      if (JSON.stringify(messages).length > 800_000) {
        // Trim old messages, keep system + last 10
        const system = messages.filter(m => m.role === "system");
        const recent = messages.filter(m => m.role !== "system").slice(-10);
        await this.emit(p.progress_key, {
          type: "warning",
          message: `Context exceeded 800KB — oldest ${messages.length - system.length - 10} messages compressed. Consider starting a new session for complex tasks.`,
        });
        messages = [...system, ...recent];
      }

     } catch (turnErr: any) {
       // Phase 1.4: Catch unexpected errors within a turn
       const errMsg = turnErr?.message || String(turnErr);
       console.error(`[workflow] Turn ${turn} error: ${errMsg}`);
       await this.emit(p.progress_key, {
         type: "error", message: `Turn ${turn} failed: ${errMsg.slice(0, 200)}`,
         code: turnErr?.name === "NonRetryableError" ? "NON_RETRYABLE" : "TURN_ERROR",
       });
       // NonRetryableErrors should stop the loop; transient errors can be retried by Workflow
       if (turnErr instanceof NonRetryableError) {
         finalOutput = `Error: ${errMsg.slice(0, 500)}`;
         break;
       }
       // For other errors, let the Workflow retry mechanism handle it
       throw turnErr;
     }
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: FINALIZE
    // ═══════════════════════════════════════════════════════════

    // If loop ended without final answer, do one more LLM call without tools
    if (!finalOutput && totalToolCalls > 0) {
      const recovery = await step.do("recovery-llm", {
        retries: { limit: 2, delay: "3 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const { callLLM } = await import("./runtime/llm");
        const response = await callLLM(
          { AI: this.env.AI, CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID: this.env.AI_GATEWAY_ID, AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN, CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN } as any,
          messages.map(m => ({ role: m.role as any, content: m.content || "", tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
          [], // no tools — force text response
          { model: config.model, provider: config.provider },
        );
        return { content: response.content || "", cost_usd: response.cost_usd || 0 };
      });
      finalOutput = recovery.content;
      totalCost += recovery.cost_usd;
    }

    const result: RunOutput = {
      output: finalOutput,
      turns: totalToolCalls > 0 ? Math.ceil(totalToolCalls) : 1,
      tool_calls: totalToolCalls,
      cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      session_id: sessionId,
      trace_id: traceId,
    };

    // Emit final done event
    await step.do("finalize", async () => {
      await this.emit(p.progress_key, { type: "done", ...result });
    });

    // ═══════════════════════════════════════════════════════════
    // STEP 5: WRITE TELEMETRY — persist everything for meta-agent
    // ═══════════════════════════════════════════════════════════
    // The old streamRun path wrote turns via writeTurn() but was never
    // ported to Workflows. This step writes the session + all accumulated
    // turn data to the telemetry queue for async DB persistence.

    await step.do("write-telemetry", {
      retries: { limit: 2, delay: "2 seconds", backoff: "linear" },
      timeout: "30 seconds",
    }, async () => {
      const queue = (this.env as any).TELEMETRY_QUEUE;
      if (!queue) return;

      // Write session record
      await queue.send({
        type: "session",
        payload: {
          session_id: sessionId,
          org_id: p.org_id || "",
          project_id: p.project_id || "",
          agent_name: p.agent_name,
          model: config.model || "workflow",
          status: result.output ? "success" : "error",
          input_text: p.input.slice(0, 2000),
          output_text: (result.output || "").slice(0, 2000),
          step_count: result.turns,
          action_count: result.tool_calls,
          wall_clock_seconds: Math.round((Date.now() - startTime) / 1000),
          cost_total_usd: result.cost_usd,
          trace_id: traceId,
          channel: p.channel || "workflow",
        },
      });

      // Write individual turn records from accumulated data
      for (const turnData of turnRecords) {
        await queue.send({
          type: "turn",
          payload: {
            session_id: sessionId,
            turn_number: turnData.turn,
            model_used: turnData.model,
            input_tokens: turnData.input_tokens,
            output_tokens: turnData.output_tokens,
            latency_ms: turnData.latency_ms,
            llm_content: (turnData.content || "").slice(0, 5000),
            cost_total_usd: turnData.cost_usd,
            tool_calls_json: JSON.stringify(turnData.tool_calls || []),
            tool_results_json: JSON.stringify(turnData.tool_results || []),
            errors_json: JSON.stringify(turnData.errors || []),
          },
        });
      }
    });

    return result;
  }

  // ── Progress emission to KV ────────────────────────────────

  private async emit(key: string, event: Record<string, unknown>) {
    if (!this.env.AGENT_PROGRESS_KV) return;
    try {
      const raw = await this.env.AGENT_PROGRESS_KV.get(key);
      const events: any[] = raw ? JSON.parse(raw) : [];
      events.push({ ...event, ts: Date.now() });
      // Keep last 200 events, expire after 1 hour
      await this.env.AGENT_PROGRESS_KV.put(key, JSON.stringify(events.slice(-200)), { expirationTtl: 3600 });
    } catch {}
  }
}
