/**
 * useAutopilot — poll for autopilot events and manage autopilot sessions.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./api";

export interface AutopilotMessage {
  content: string;
  tick: number;
  timestamp: number;
}

export interface AutopilotState {
  active: boolean;
  messages: AutopilotMessage[];
  tickCount: number;
  totalCost: number;
  loading: boolean;
}

export function useAutopilot(agentName: string) {
  const [state, setState] = useState<AutopilotState>({
    active: false,
    messages: [],
    tickCount: 0,
    totalCost: 0,
    loading: false,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.get<{ events: AutopilotMessage[] }>(
          `/autopilot/events?agent_name=${encodeURIComponent(agentName)}&channel=web`,
        );
        if (res.events?.length) {
          setState((prev) => ({
            ...prev,
            messages: res.events.slice(-20), // Keep last 20
            tickCount: Math.max(prev.tickCount, ...res.events.map((e) => e.tick)),
          }));
        }
      } catch {
        // Polling failure is non-fatal — retry on next interval
      }
    }, 10_000); // Poll every 10s
  }, [agentName]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: Array<Record<string, unknown>> }>("/autopilot/status");
      const session = res.sessions.find(
        (s) => s.agent_name === agentName && s.channel === "web" && s.status === "active",
      );
      if (session) {
        setState((prev) => ({
          ...prev,
          active: true,
          tickCount: (session.tick_count as number) || 0,
          totalCost: Number(session.total_cost_usd) || 0,
        }));
        startPolling();
      }
    } catch {
      // Status check failure — autopilot endpoints may not exist yet
    }
  }, [agentName, startPolling]);

  // Check status on mount and clean up on unmount
  useEffect(() => {
    if (agentName) checkStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [agentName, checkStatus]);

  const toggle = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }));
    try {
      if (state.active) {
        await api.post("/autopilot/stop", { agent_name: agentName, channel: "web" });
        stopPolling();
        setState((prev) => ({ ...prev, active: false, loading: false }));
      } else {
        await api.post("/autopilot/start", { agent_name: agentName, channel: "web" });
        startPolling();
        setState((prev) => ({ ...prev, active: true, loading: false }));
      }
    } catch {
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [agentName, state.active, startPolling, stopPolling]);

  return {
    ...state,
    toggle,
  };
}
