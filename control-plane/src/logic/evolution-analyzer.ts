/**
 * Evolution Analyzer — port of Python agentos/evolution/analyzer.py
 *
 * Analyzes agent session data to discover failure patterns, cost anomalies,
 * tool performance issues, and generates ranked improvement proposals.
 *
 * This is the "observe → analyze → propose" half of the evolution loop.
 * The other half (review → apply → measure) lives in the evolve routes.
 */

// ── Types ─────────────────────────────────────────────────────

export interface SessionRecord {
  session_id: string;
  agent_name: string;
  status: string;        // success, error, timeout, budget
  stop_reason: string;
  cost_total_usd: number;
  wall_clock_seconds: number;
  step_count: number;
  action_count: number;
  created_at: number;
  // Enriched from turns
  tool_calls: ToolCallRecord[];
  errors: ErrorRecord[];
  // Enriched from conversation intelligence
  quality_score?: number;
  sentiment?: string;
  task_completed?: boolean;
}

export interface ToolCallRecord {
  tool_name: string;
  success: boolean;
  error?: string;
  latency_ms: number;
  turn_number: number;
}

export interface ErrorRecord {
  source: "llm" | "tool" | "governance" | "timeout" | "unknown";
  message: string;
  tool_name?: string;
  turn_number: number;
  recoverable: boolean;
}

export interface FailureCluster {
  pattern: string;         // e.g., "tool:web-search" or "llm:rate_limit"
  count: number;
  severity: number;        // frequency * impact_multiplier
  example_errors: string[];
  affected_sessions: string[];
}

export interface CostAnomaly {
  session_id: string;
  cost_usd: number;
  avg_cost_usd: number;
  deviation_factor: number;  // how many times above average
  likely_cause: string;
}

export interface ToolAnalysis {
  tool_name: string;
  call_count: number;
  failure_count: number;
  failure_rate: number;
  avg_latency_ms: number;
  total_cost_usd: number;
}

export interface AnalysisReport {
  agent_name: string;
  analyzed_at: number;
  session_count: number;
  time_window_days: number;

  // Core metrics
  success_rate: number;
  avg_cost_usd: number;
  avg_turns: number;
  avg_wall_clock_seconds: number;

  // Discovered patterns
  failure_clusters: FailureCluster[];
  cost_anomalies: CostAnomaly[];
  tool_analysis: ToolAnalysis[];
  unused_tools: string[];
  top_error_sources: Array<{ source: string; count: number }>;

  // Quality signals (from conversation intelligence)
  avg_quality_score: number;
  task_completion_rate: number;

  // Recommendations (human-readable)
  recommendations: string[];
}

export interface EvolutionProposal {
  id: string;
  title: string;
  rationale: string;
  category: "prompt" | "tools" | "governance" | "model" | "memory";
  priority: number;          // 0.0 - 1.0
  modification: Record<string, unknown>;  // config diff to apply
  evidence: {
    metric: string;
    current_value: number | string;
    suggested_value?: number | string;
    supporting_data: string[];
  };
}

// ── Analyzer ──────────────────────────────────────────────────

/**
 * Analyze session records and produce a report with failure patterns,
 * cost anomalies, and tool performance insights.
 */
export function analyzeSessionRecords(
  agentName: string,
  records: SessionRecord[],
  availableTools: string[],
  timeWindowDays: number = 7,
): AnalysisReport {
  if (records.length === 0) {
    return emptyReport(agentName, timeWindowDays);
  }

  const successCount = records.filter((r) => r.status === "success").length;
  const successRate = successCount / records.length;
  const avgCost = records.reduce((s, r) => s + r.cost_total_usd, 0) / records.length;
  const avgTurns = records.reduce((s, r) => s + r.step_count, 0) / records.length;
  const avgWallClock = records.reduce((s, r) => s + r.wall_clock_seconds, 0) / records.length;

  // Failure clustering
  const failureClusters = clusterFailures(records);

  // Cost anomaly detection
  const costAnomalies = detectCostAnomalies(records, avgCost);

  // Tool analysis
  const toolAnalysis = analyzeTools(records);
  const usedTools = new Set(toolAnalysis.map((t) => t.tool_name));
  const unusedTools = availableTools.filter((t) => !usedTools.has(t));

  // Error source ranking
  const errorSourceCounts = new Map<string, number>();
  for (const record of records) {
    for (const err of record.errors) {
      const key = err.tool_name ? `${err.source}:${err.tool_name}` : err.source;
      errorSourceCounts.set(key, (errorSourceCounts.get(key) || 0) + 1);
    }
  }
  const topErrorSources = [...errorSourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([source, count]) => ({ source, count }));

  // Quality signals
  const qualityScores = records.filter((r) => r.quality_score != null).map((r) => r.quality_score!);
  const avgQuality = qualityScores.length > 0
    ? qualityScores.reduce((s, q) => s + q, 0) / qualityScores.length
    : 0;
  const completedCount = records.filter((r) => r.task_completed).length;
  const taskCompletionRate = records.length > 0 ? completedCount / records.length : 0;

  // Generate recommendations
  const recommendations = generateRecommendations({
    successRate, avgCost, avgTurns, avgWallClock,
    failureClusters, costAnomalies, toolAnalysis,
    unusedTools, avgQuality, taskCompletionRate,
    sessionCount: records.length,
  });

  return {
    agent_name: agentName,
    analyzed_at: Date.now(),
    session_count: records.length,
    time_window_days: timeWindowDays,
    success_rate: round(successRate, 4),
    avg_cost_usd: round(avgCost, 6),
    avg_turns: round(avgTurns, 1),
    avg_wall_clock_seconds: round(avgWallClock, 1),
    failure_clusters: failureClusters,
    cost_anomalies: costAnomalies.slice(0, 10),
    tool_analysis: toolAnalysis,
    unused_tools: unusedTools,
    top_error_sources: topErrorSources,
    avg_quality_score: round(avgQuality, 2),
    task_completion_rate: round(taskCompletionRate, 4),
    recommendations,
  };
}

/**
 * Generate ranked proposals from an analysis report and current agent config.
 */
export function generateProposals(
  report: AnalysisReport,
  agentConfig: Record<string, unknown>,
): EvolutionProposal[] {
  const proposals: EvolutionProposal[] = [];

  // 1. Remove unused tools (reduce context noise)
  if (report.unused_tools.length >= 3) {
    proposals.push({
      id: `proposal-${Date.now()}-unused-tools`,
      title: `Remove ${report.unused_tools.length} unused tools`,
      rationale:
        `Agent has ${report.unused_tools.length} tools configured that were never called in ${report.session_count} sessions. ` +
        `Removing them saves ~${report.unused_tools.length * 100} tokens per LLM call.`,
      category: "tools",
      priority: 0.6,
      modification: {
        tools: {
          remove: report.unused_tools,
        },
      },
      evidence: {
        metric: "unused_tool_count",
        current_value: report.unused_tools.length,
        suggested_value: 0,
        supporting_data: report.unused_tools.slice(0, 10),
      },
    });
  }

  // 2. Add failure guidance for high-failure tools
  const highFailureTools = report.tool_analysis.filter(
    (t) => t.failure_rate > 0.3 && t.call_count >= 5,
  );
  for (const tool of highFailureTools.slice(0, 3)) {
    const cluster = report.failure_clusters.find((c) => c.pattern.includes(tool.tool_name));
    proposals.push({
      id: `proposal-${Date.now()}-tool-guidance-${tool.tool_name}`,
      title: `Add failure guidance for ${tool.tool_name}`,
      rationale:
        `${tool.tool_name} has a ${(tool.failure_rate * 100).toFixed(0)}% failure rate across ${tool.call_count} calls. ` +
        `Adding guidance to the system prompt can help the agent use it more effectively.`,
      category: "prompt",
      priority: 0.7 + tool.failure_rate * 0.2,
      modification: {
        system_prompt: {
          append: `\n\nWhen using ${tool.tool_name}, be careful to: verify inputs are valid, handle errors gracefully, and try alternative approaches if it fails.`,
        },
      },
      evidence: {
        metric: "tool_failure_rate",
        current_value: `${(tool.failure_rate * 100).toFixed(1)}%`,
        suggested_value: "<30%",
        supporting_data: cluster?.example_errors.slice(0, 3) || [],
      },
    });
  }

  // 3. Increase budget if exhaustion is common
  const budgetExhausted = report.failure_clusters.find(
    (c) => c.pattern === "governance:budget",
  );
  if (budgetExhausted && budgetExhausted.count >= 3) {
    const currentBudget = Number(agentConfig.budget_limit_usd || (agentConfig.governance as Record<string, unknown>)?.budget_limit_usd || 10);
    proposals.push({
      id: `proposal-${Date.now()}-increase-budget`,
      title: "Increase session budget limit",
      rationale:
        `${budgetExhausted.count} sessions exhausted the budget limit in the analysis window. ` +
        `Current limit: $${currentBudget.toFixed(2)}. Average cost: $${report.avg_cost_usd.toFixed(4)}.`,
      category: "governance",
      priority: 0.8,
      modification: {
        budget_limit_usd: round(currentBudget * 1.5, 2),
      },
      evidence: {
        metric: "budget_exhaustion_count",
        current_value: budgetExhausted.count,
        suggested_value: 0,
        supporting_data: budgetExhausted.affected_sessions.slice(0, 5),
      },
    });
  }

  // 4. Reduce max_turns for high-turn runaway agents
  if (report.avg_turns > 15) {
    const currentMaxTurns = Number(agentConfig.max_turns || 50);
    proposals.push({
      id: `proposal-${Date.now()}-reduce-turns`,
      title: "Reduce max_turns to prevent runaway sessions",
      rationale:
        `Average turn count is ${report.avg_turns.toFixed(1)}, suggesting agents are running too long. ` +
        `Reducing max_turns encourages more focused execution.`,
      category: "governance",
      priority: 0.5,
      modification: {
        max_turns: Math.min(currentMaxTurns, Math.ceil(report.avg_turns * 1.5)),
      },
      evidence: {
        metric: "avg_turns",
        current_value: report.avg_turns.toFixed(1),
        suggested_value: Math.ceil(report.avg_turns * 1.5),
        supporting_data: [],
      },
    });
  }

  // 5. Review system prompt if success rate is low
  if (report.success_rate < 0.5 && report.session_count >= 10) {
    proposals.push({
      id: `proposal-${Date.now()}-review-prompt`,
      title: "Review system prompt — low success rate",
      rationale:
        `Only ${(report.success_rate * 100).toFixed(0)}% of sessions succeed. The system prompt may need ` +
        `clearer instructions, better examples, or more specific constraints.`,
      category: "prompt",
      priority: 0.9,
      modification: {
        system_prompt: { review: true },
      },
      evidence: {
        metric: "success_rate",
        current_value: `${(report.success_rate * 100).toFixed(1)}%`,
        suggested_value: ">70%",
        supporting_data: report.recommendations.slice(0, 3),
      },
    });
  }

  // 6. Try cheaper model if success rate is high
  if (report.success_rate > 0.85 && report.avg_cost_usd > 0.05) {
    proposals.push({
      id: `proposal-${Date.now()}-cheaper-model`,
      title: "Consider a cheaper model — high success rate",
      rationale:
        `Success rate is ${(report.success_rate * 100).toFixed(0)}% with average cost $${report.avg_cost_usd.toFixed(4)}. ` +
        `A less expensive model may maintain quality at lower cost.`,
      category: "model",
      priority: 0.4,
      modification: {
        model: { evaluate_alternatives: true },
      },
      evidence: {
        metric: "success_rate_vs_cost",
        current_value: `${(report.success_rate * 100).toFixed(0)}% @ $${report.avg_cost_usd.toFixed(4)}/session`,
        supporting_data: [],
      },
    });
  }

  // 7. Quality-based proposals
  if (report.avg_quality_score > 0 && report.avg_quality_score < 0.6) {
    proposals.push({
      id: `proposal-${Date.now()}-improve-quality`,
      title: "Improve response quality — below threshold",
      rationale:
        `Average quality score is ${report.avg_quality_score.toFixed(2)} (threshold: 0.6). ` +
        `Consider adding examples, clearer instructions, or RAG context to improve responses.`,
      category: "prompt",
      priority: 0.75,
      modification: {
        system_prompt: { improve_quality: true },
      },
      evidence: {
        metric: "avg_quality_score",
        current_value: report.avg_quality_score.toFixed(2),
        suggested_value: ">0.7",
        supporting_data: [],
      },
    });
  }

  // 8. Enable code mode for multi-tool agents
  const toolCount = (agentConfig.tools as string[] || []).length;
  if (toolCount > 15 && !agentConfig.use_code_mode) {
    proposals.push({
      id: `proposal-${Date.now()}-enable-codemode`,
      title: "Enable code mode for token savings",
      rationale:
        `Agent has ${toolCount} tools consuming ~${toolCount * 100} tokens per LLM call. ` +
        `Code mode collapses all tools into a single tool, saving ~85% of tool tokens.`,
      category: "tools",
      priority: 0.5,
      modification: {
        use_code_mode: true,
      },
      evidence: {
        metric: "tool_token_overhead",
        current_value: `~${toolCount * 100} tokens/call`,
        suggested_value: "~1,000 tokens/call",
        supporting_data: [],
      },
    });
  }

  // Sort by priority descending, surface top 10
  return proposals
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10);
}

// ── Internal helpers ──────────────────────────────────────────

function clusterFailures(records: SessionRecord[]): FailureCluster[] {
  const clusters = new Map<string, {
    count: number;
    errors: string[];
    sessions: string[];
  }>();

  for (const record of records) {
    if (record.status === "success") continue;

    for (const err of record.errors) {
      const pattern = err.tool_name
        ? `${err.source}:${err.tool_name}`
        : err.source;

      const cluster = clusters.get(pattern) || { count: 0, errors: [], sessions: [] };
      cluster.count++;
      if (cluster.errors.length < 5) {
        cluster.errors.push(err.message.slice(0, 200));
      }
      if (!cluster.sessions.includes(record.session_id)) {
        cluster.sessions.push(record.session_id);
      }
      clusters.set(pattern, cluster);
    }

    // If no structured errors, cluster by status/stop_reason
    if (record.errors.length === 0) {
      const pattern = `status:${record.stop_reason || record.status}`;
      const cluster = clusters.get(pattern) || { count: 0, errors: [], sessions: [] };
      cluster.count++;
      cluster.sessions.push(record.session_id);
      clusters.set(pattern, cluster);
    }
  }

  // Impact multipliers by source
  const impact: Record<string, number> = {
    llm: 1.5,
    tool: 1.0,
    governance: 0.8,
    timeout: 1.2,
    status: 0.5,
  };

  return [...clusters.entries()]
    .map(([pattern, data]) => {
      const source = pattern.split(":")[0];
      return {
        pattern,
        count: data.count,
        severity: round(data.count * (impact[source] || 1.0), 2),
        example_errors: data.errors,
        affected_sessions: data.sessions.slice(0, 10),
      };
    })
    .sort((a, b) => b.severity - a.severity);
}

function detectCostAnomalies(
  records: SessionRecord[],
  avgCost: number,
): CostAnomaly[] {
  if (avgCost <= 0) return [];
  const threshold = avgCost * 3; // 3x average = anomaly

  return records
    .filter((r) => r.cost_total_usd > threshold)
    .map((r) => {
      const deviation = r.cost_total_usd / avgCost;
      let cause = "unknown";
      if (r.step_count > 30) cause = "high turn count";
      else if (r.stop_reason === "budget") cause = "budget exhaustion";
      else if (r.errors.some((e) => e.source === "llm")) cause = "LLM retries";
      else if (r.action_count > 20) cause = "excessive tool calls";
      return {
        session_id: r.session_id,
        cost_usd: round(r.cost_total_usd, 6),
        avg_cost_usd: round(avgCost, 6),
        deviation_factor: round(deviation, 1),
        likely_cause: cause,
      };
    })
    .sort((a, b) => b.deviation_factor - a.deviation_factor);
}

function analyzeTools(records: SessionRecord[]): ToolAnalysis[] {
  const tools = new Map<string, {
    calls: number;
    failures: number;
    totalLatency: number;
    totalCost: number;
  }>();

  for (const record of records) {
    for (const tc of record.tool_calls) {
      const t = tools.get(tc.tool_name) || { calls: 0, failures: 0, totalLatency: 0, totalCost: 0 };
      t.calls++;
      if (!tc.success) t.failures++;
      t.totalLatency += tc.latency_ms;
      tools.set(tc.tool_name, t);
    }
  }

  return [...tools.entries()]
    .map(([name, data]) => ({
      tool_name: name,
      call_count: data.calls,
      failure_count: data.failures,
      failure_rate: data.calls > 0 ? round(data.failures / data.calls, 4) : 0,
      avg_latency_ms: data.calls > 0 ? round(data.totalLatency / data.calls, 0) : 0,
      total_cost_usd: round(data.totalCost, 6),
    }))
    .sort((a, b) => b.call_count - a.call_count);
}

interface RecommendationContext {
  successRate: number;
  avgCost: number;
  avgTurns: number;
  avgWallClock: number;
  failureClusters: FailureCluster[];
  costAnomalies: CostAnomaly[];
  toolAnalysis: ToolAnalysis[];
  unusedTools: string[];
  avgQuality: number;
  taskCompletionRate: number;
  sessionCount: number;
}

function generateRecommendations(ctx: RecommendationContext): string[] {
  const recs: string[] = [];

  if (ctx.successRate < 0.5) {
    recs.push(`Critical: Only ${(ctx.successRate * 100).toFixed(0)}% success rate. Review system prompt and tool configuration.`);
  } else if (ctx.successRate < 0.7) {
    recs.push(`Success rate is ${(ctx.successRate * 100).toFixed(0)}% — investigate top failure patterns.`);
  }

  if (ctx.failureClusters.length > 0) {
    const top = ctx.failureClusters[0];
    recs.push(`Top failure pattern: "${top.pattern}" (${top.count} occurrences, severity ${top.severity}).`);
  }

  if (ctx.costAnomalies.length > 0) {
    recs.push(`${ctx.costAnomalies.length} cost anomalies detected (sessions costing >3x average).`);
  }

  const highFailTools = ctx.toolAnalysis.filter((t) => t.failure_rate > 0.3 && t.call_count >= 5);
  if (highFailTools.length > 0) {
    const names = highFailTools.map((t) => `${t.tool_name} (${(t.failure_rate * 100).toFixed(0)}%)`).join(", ");
    recs.push(`High-failure tools: ${names}. Consider adding usage guidance or removing.`);
  }

  if (ctx.unusedTools.length >= 3) {
    recs.push(`${ctx.unusedTools.length} tools are configured but never used. Remove to reduce context noise.`);
  }

  if (ctx.avgTurns > 15) {
    recs.push(`Average ${ctx.avgTurns.toFixed(0)} turns per session — consider reducing max_turns or improving task decomposition.`);
  }

  if (ctx.avgQuality > 0 && ctx.avgQuality < 0.6) {
    recs.push(`Average quality score ${ctx.avgQuality.toFixed(2)} is below threshold. Review response patterns.`);
  }

  if (ctx.taskCompletionRate > 0 && ctx.taskCompletionRate < 0.5) {
    recs.push(`Only ${(ctx.taskCompletionRate * 100).toFixed(0)}% of tasks marked as completed.`);
  }

  if (recs.length === 0) {
    recs.push(`Agent is performing well: ${(ctx.successRate * 100).toFixed(0)}% success rate, $${ctx.avgCost.toFixed(4)} avg cost.`);
  }

  return recs;
}

function emptyReport(agentName: string, timeWindowDays: number): AnalysisReport {
  return {
    agent_name: agentName,
    analyzed_at: Date.now(),
    session_count: 0,
    time_window_days: timeWindowDays,
    success_rate: 0,
    avg_cost_usd: 0,
    avg_turns: 0,
    avg_wall_clock_seconds: 0,
    failure_clusters: [],
    cost_anomalies: [],
    tool_analysis: [],
    unused_tools: [],
    top_error_sources: [],
    avg_quality_score: 0,
    task_completion_rate: 0,
    recommendations: ["No sessions found in the analysis window."],
  };
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
