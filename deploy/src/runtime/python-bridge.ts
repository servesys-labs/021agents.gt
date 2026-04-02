/**
 * Python tool bridge — lets Python code call AgentOS tools via a JSON file protocol.
 *
 * Architecture:
 *   1. Write agentos_bridge.py helper to the container
 *   2. Python code calls: result = agentos.call_tool("web-search", {"query": "..."})
 *   3. The bridge writes the request to /tmp/.tool_request.json and exits with code 42
 *   4. Parent detects exit code 42, reads the request, executes the tool
 *   5. Parent writes the result to /tmp/.tool_result.json
 *   6. Parent re-runs the Python script (which picks up from where it left off via checkpoint)
 *
 * This is a "pause-and-resume" model, not live RPC. It works because:
 *   - Container filesystem persists across exec() calls (same sandbox ID)
 *   - Exit code 42 is our "tool call pending" signal
 *   - Python state is checkpointed to a file between rounds
 *
 * Limitations:
 *   - Each tool call requires a re-exec of the script (added latency)
 *   - Max 10 tool calls per python-exec invocation
 *   - Script must be written to handle checkpointing (the bridge handles this)
 */

import type { RuntimeEnv } from "./types";
import { executeTools } from "./tools";

const BRIDGE_PYTHON = `
"""AgentOS tool bridge for Python scripts running in the sandbox."""
import json, sys, os, pickle

_TOOL_REQ = "/tmp/.tool_request.json"
_TOOL_RES = "/tmp/.tool_result.json"
_CHECKPOINT = "/tmp/.python_checkpoint.pkl"
_TOOL_EXIT_CODE = 42

class _AgentOS:
    """Call AgentOS tools from Python. Usage: result = agentos.call_tool("web-search", {"query": "..."})"""

    def call_tool(self, tool_name: str, args: dict = None) -> dict:
        """Call an AgentOS tool and get the result."""
        # Check if we already have a result from a previous round
        if os.path.exists(_TOOL_RES):
            with open(_TOOL_RES, "r") as f:
                result = json.load(f)
            os.remove(_TOOL_RES)
            return result

        # Write the request and exit with code 42 to signal the parent
        with open(_TOOL_REQ, "w") as f:
            json.dump({"tool": tool_name, "args": args or {}}, f)
        sys.exit(_TOOL_EXIT_CODE)

    def web_search(self, query: str) -> str:
        r = self.call_tool("web-search", {"query": query})
        return r.get("result", "")

    def browse(self, url: str) -> str:
        r = self.call_tool("browse", {"url": url})
        return r.get("result", "")

    def read_file(self, path: str) -> str:
        r = self.call_tool("read-file", {"path": path})
        return r.get("result", "")

    def write_file(self, path: str, content: str) -> str:
        r = self.call_tool("write-file", {"path": path, "content": content})
        return r.get("result", "")

    def memory_save(self, key: str, value: str, category: str = "general") -> str:
        r = self.call_tool("memory-save", {"key": key, "value": value, "category": category})
        return r.get("result", "")

    def memory_recall(self, query: str) -> str:
        r = self.call_tool("memory-recall", {"query": query})
        return r.get("result", "")

agentos = _AgentOS()
`;

const TOOL_REQ_PATH = "/tmp/.tool_request.json";
const TOOL_RES_PATH = "/tmp/.tool_result.json";
const BRIDGE_PATH = "/tmp/agentos_bridge.py";
const MAX_TOOL_ROUNDS = 10;

/**
 * Execute Python code with tool access via the pause-and-resume bridge.
 *
 * The Python code can `from agentos_bridge import agentos` and call tools like:
 *   result = agentos.web_search("Bitcoin price")
 *   agentos.memory_save("btc", result)
 */
export async function pythonWithTools(
  env: RuntimeEnv,
  code: string,
  sessionId: string,
  sandbox: { exec: (cmd: string, opts?: any) => Promise<any>; writeFile: (path: string, content: string) => Promise<void> },
  enabledTools?: string[],
): Promise<{ stdout: string; stderr: string; exit_code: number; tool_calls: number }> {
  // Write the bridge module
  await sandbox.writeFile(BRIDGE_PATH, BRIDGE_PYTHON);

  // Write the user's code (prepend the bridge import)
  const wrappedCode = `import sys; sys.path.insert(0, "/tmp")\nfrom agentos_bridge import agentos\n\n${code}`;
  const scriptPath = `/tmp/py_tooled_${Date.now()}.py`;
  await sandbox.writeFile(scriptPath, wrappedCode);

  let allStdout = "";
  let allStderr = "";
  let toolCalls = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Clean up any stale request/result files
    await sandbox.exec(`rm -f ${TOOL_REQ_PATH} ${TOOL_RES_PATH}`, { timeout: 5 }).catch(() => {});

    // Run the Python script
    const result = await sandbox.exec(`python3 ${scriptPath}`, { timeout: 60 });
    allStdout += result.stdout || "";
    allStderr += result.stderr || "";

    // If exit code is NOT 42, the script finished normally (or errored)
    if (result.exitCode !== 42) {
      // Clean up
      sandbox.exec(`rm -f ${scriptPath} ${BRIDGE_PATH} ${TOOL_REQ_PATH} ${TOOL_RES_PATH}`, { timeout: 5 }).catch(() => {});
      return { stdout: allStdout, stderr: allStderr, exit_code: result.exitCode ?? 0, tool_calls: toolCalls };
    }

    // Exit code 42 = tool call pending. Read the request.
    const reqResult = await sandbox.exec(`cat ${TOOL_REQ_PATH}`, { timeout: 5 });
    let toolReq: { tool: string; args: Record<string, any> };
    try {
      toolReq = JSON.parse(reqResult.stdout || "{}");
    } catch {
      allStderr += "\n[bridge] Invalid tool request JSON";
      break;
    }

    if (!toolReq.tool) {
      allStderr += "\n[bridge] Empty tool name in request";
      break;
    }

    // Execute the tool on the parent (with full bindings)
    toolCalls++;
    try {
      const results = await executeTools(env, [
        { id: `py-bridge-${round}`, name: toolReq.tool, arguments: JSON.stringify(toolReq.args) },
      ], sessionId, false, enabledTools);

      const toolResult = results[0];
      const resultJson = JSON.stringify({
        result: toolResult?.result || "",
        error: toolResult?.error || null,
      });

      // Write result back to the container
      await sandbox.writeFile(TOOL_RES_PATH, resultJson);
    } catch (err: any) {
      await sandbox.writeFile(TOOL_RES_PATH, JSON.stringify({
        result: "",
        error: err.message || "Tool execution failed",
      }));
    }
  }

  // Exhausted max rounds
  sandbox.exec(`rm -f ${scriptPath} ${BRIDGE_PATH} ${TOOL_REQ_PATH} ${TOOL_RES_PATH}`, { timeout: 5 }).catch(() => {});
  return { stdout: allStdout, stderr: allStderr + "\n[bridge] Max tool call rounds reached", exit_code: 1, tool_calls: toolCalls };
}
