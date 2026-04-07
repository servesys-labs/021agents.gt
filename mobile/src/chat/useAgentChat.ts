import { useCallback, useMemo, useRef, useState } from "react";

import { applyStreamEvent, addUserMessage, initialChatState, type ChatState } from "./reducer";
import { streamAgent } from "./streamAgent";
import { logError, logInfo } from "../telemetry/logger";

export interface UseAgentChatOptions {
  baseUrl: string;
  token: string;
  agentName: string;
  initialSessionId?: string;
  plan?: "free" | "basic" | "standard" | "premium";
}

export function useAgentChat(options: UseAgentChatOptions) {
  const [state, setState] = useState<ChatState>({
    ...initialChatState,
    sessionId: options.initialSessionId,
  });
  const abortRef = useRef<(() => void) | null>(null);

  const send = useCallback(
    (message: string) => {
      if (!message.trim()) return;
      if (abortRef.current) abortRef.current();

      setState((prev) => addUserMessage(prev, message));
      logInfo("chat.send", {
        agent: options.agentName,
        hasSession: Boolean(state.sessionId),
      });
      const handle = streamAgent({
        baseUrl: options.baseUrl,
        token: options.token,
        agentName: options.agentName,
        message,
        sessionId: state.sessionId,
        plan: options.plan,
        onEvent: (event) => {
          setState((prev) => {
            const next = applyStreamEvent(prev, event);
            const maybeSessionId = event.data.session_id;
            if (maybeSessionId) {
              next.sessionId = String(maybeSessionId);
            }
            if (event.type === "error") {
              logError("chat.stream_error", event.data.message ?? "unknown", {
                agent: options.agentName,
                sessionId: next.sessionId,
              });
            }
            return next;
          });
        },
      });
      abortRef.current = handle.abort;
    },
    [options, state.sessionId],
  );

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current();
    abortRef.current = null;
    setState((prev) => ({ ...prev, streaming: false }));
  }, []);

  const clear = useCallback(() => {
    setState({
      ...initialChatState,
      sessionId: state.sessionId,
    });
  }, [state.sessionId]);

  return useMemo(
    () => ({
      ...state,
      send,
      stop,
      clear,
    }),
    [state, send, stop, clear],
  );
}

