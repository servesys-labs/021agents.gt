/**
 * Memory digest trigger — pure decision logic for post-session memory agent invocation.
 *
 * Extracted from workflow.ts so it's testable without Cloudflare WorkflowEntrypoint.
 */

export interface MemoryDigestParams {
  agent_name: string;
  input: string;
  org_id: string;
  project_id: string;
  channel: string;
  channel_user_id: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  progress_key: string;
  parent_session_id: string;
  parent_depth: number;
}

function quoteWorkflowArg(value: string): string {
  const text = String(value || "");
  return JSON.stringify(text);
}

function buildMemoryAgentWorkflowParams(
  taskInput: string,
  progressPrefix: string,
  agentName: string,
  sessionId: string,
  orgId: string,
  parentDepth: number,
  hasWorkflowBinding: boolean,
): MemoryDigestParams | null {
  if (!hasWorkflowBinding) return null;
  if (agentName === "memory-agent") return null;
  return {
    agent_name: "memory-agent",
    input: taskInput,
    org_id: orgId,
    project_id: "",
    channel: "internal",
    channel_user_id: "",
    history: [] as Array<{ role: "user" | "assistant"; content: string }>,
    progress_key: `${progressPrefix}:${sessionId}`,
    parent_session_id: sessionId,
    parent_depth: parentDepth + 1,
  };
}

/** Build params for the post-session memory digest, or null if it should be skipped. */
export function buildMemoryDigestParams(
  agentName: string,
  sessionId: string,
  orgId: string,
  parentDepth: number,
  hasWorkflowBinding: boolean,
): MemoryDigestParams | null {
  return buildMemoryAgentWorkflowParams(
    `/memory-digest session_id=${sessionId} agent_name=${agentName}`,
    "memory-digest",
    agentName,
    sessionId,
    orgId,
    parentDepth,
    hasWorkflowBinding,
  );
}

/** Build params for passive signal-driven memory maintenance. */
export function buildPassiveMemoryWorkflowParams(
  workflowKind: "digest" | "consolidate",
  agentName: string,
  sessionId: string,
  orgId: string,
  parentDepth: number,
  hasWorkflowBinding: boolean,
  signalBriefing: string,
): MemoryDigestParams | null {
  const command = workflowKind === "consolidate" ? "/memory-consolidate" : "/memory-digest";
  const args = [
    `agent_name=${agentName}`,
    sessionId ? `session_id=${sessionId}` : "",
    `signal_briefing=${quoteWorkflowArg(signalBriefing)}`,
  ].filter(Boolean).join(" ");
  return buildMemoryAgentWorkflowParams(
    `${command} ${args}`.trim(),
    `memory-signal-${workflowKind}`,
    agentName,
    sessionId || `signal-${workflowKind}`,
    orgId,
    parentDepth,
    hasWorkflowBinding,
  );
}

/** Build params for periodic/cleanup consolidation pass after digest. */
export function buildMemoryConsolidateParams(
  agentName: string,
  sessionId: string,
  orgId: string,
  parentDepth: number,
  hasWorkflowBinding: boolean,
): MemoryDigestParams | null {
  return buildMemoryAgentWorkflowParams(
    `/memory-consolidate session_id=${sessionId} agent_name=${agentName}`,
    "memory-consolidate",
    agentName,
    sessionId,
    orgId,
    parentDepth,
    hasWorkflowBinding,
  );
}
