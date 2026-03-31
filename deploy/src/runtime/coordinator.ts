/**
 * Coordinator Mode — multi-agent orchestration.
 *
 * Transforms an agent into an orchestrator that:
 * 1. Decomposes complex tasks into subtasks
 * 2. Spawns parallel worker agents for each subtask
 * 3. Monitors worker progress and handles failures
 * 4. Synthesizes results into a final output
 *
 * Inspired by Claude Code's COORDINATOR_MODE with worker spawning,
 * delegation, and failure recovery.
 */

/**
 * Build the coordinator system prompt addendum.
 * Injected when reasoning_strategy === "coordinator" or agent has coordinator role.
 */
export function buildCoordinatorPrompt(agentName: string, availableAgents: string[]): string {
  return `## Coordinator Mode
You are operating as a COORDINATOR. Your job is to orchestrate other agents to accomplish complex tasks.

### Available Workers
${availableAgents.map(a => `- ${a}`).join("\n")}

### Coordination Protocol
1. **Decompose**: Break the user's task into independent subtasks
2. **Delegate**: Use the \`run-agent\` tool to spawn workers for each subtask
   - Assign clear, specific instructions to each worker
   - Set appropriate budget limits (workers inherit your budget proportionally)
   - Prefer parallel execution for independent subtasks
3. **Monitor**: Check worker results as they complete
   - If a worker fails, decide: retry with different instructions, assign to different agent, or handle yourself
   - If a worker produces partial results, build on them
4. **Synthesize**: Combine all worker outputs into a coherent final answer

### Worker Prompt Guidelines
When writing prompts for workers:
- Be specific about what you need (not vague)
- Include relevant context they'll need
- Specify the output format you expect
- Set scope boundaries (what NOT to do)

### Failure Handling
- If a worker times out: retry once with simpler instructions
- If a worker produces bad output: try a different agent or do it yourself
- If 3+ workers fail: stop delegating and handle the remaining work directly
- Always report what succeeded and what failed in your final answer

### Anti-Patterns to Avoid
- Don't delegate trivial tasks (just do them yourself)
- Don't spawn more than 5 workers for a single task
- Don't delegate the same task to multiple workers hoping one succeeds
- Don't ignore worker failures — acknowledge them in your response`;
}

/**
 * Determine if a task should use coordinator mode based on complexity signals.
 */
export function shouldCoordinate(input: string, toolCount: number): boolean {
  // Complexity heuristics
  const hasMultipleParts = /\b(and|also|additionally|then|after that|next)\b/gi.test(input);
  const isLong = input.length > 500;
  const mentionsMultipleActions = (input.match(/\b(research|implement|test|review|deploy|fix|build|analyze|compare)\b/gi) || []).length >= 3;
  const explicitCoordinator = /\b(coordinate|orchestrate|delegate|parallel|multi-agent)\b/i.test(input);

  return explicitCoordinator || (hasMultipleParts && mentionsMultipleActions) || (isLong && toolCount > 10);
}
