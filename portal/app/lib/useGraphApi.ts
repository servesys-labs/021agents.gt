/**
 * React Hooks for Graph API
 * 
 * Provides data fetching and mutations for graph operations.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { GraphSpec } from "./runtime-types";
import * as api from "./api";

// --- useGraphsList ---

export function useGraphsList(params?: {
  type?: "graph" | "prompt" | "tool_set";
  search?: string;
  limit?: number;
}) {
  const [data, setData] = useState<api.GraphListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const result = await api.listGraphs(params);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [params?.type, params?.search, params?.limit]);

  return { data, loading, error, refetch: () => window.location.reload() };
}

// --- useGraph ---

export function useGraph(id: string | null) {
  const [data, setData] = useState<api.GraphDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const result = await api.getGraph(id);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  const update = useCallback(async (updates: Parameters<typeof api.updateGraph>[1]) => {
    if (!id) return null;
    const result = await api.updateGraph(id, updates);
    // Refresh data
    const refreshed = await api.getGraph(id);
    setData(refreshed);
    return result;
  }, [id]);

  const remove = useCallback(async () => {
    if (!id) return null;
    return api.deleteGraph(id);
  }, [id]);

  return { data, loading, error, update, remove };
}

// --- useCreateGraph ---

export function useCreateGraph() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async (data: Parameters<typeof api.createGraph>[0]) => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.createGraph(data);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { create, loading, error };
}

// --- useValidateGraph ---

export function useValidateGraph() {
  const [result, setResult] = useState<api.GraphValidationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = useCallback(async (
    graph: GraphSpec,
    options?: Parameters<typeof api.validateGraph>[1]
  ) => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.validateGraph(graph, options);
      setResult(response);
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Validation failed";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { validate, result, loading, error };
}

// --- useExecuteGraph ---

export function useExecuteGraph() {
  const [result, setResult] = useState<api.GraphExecutionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const execute = useCallback(async (
    graph: GraphSpec,
    input: string,
    options?: Parameters<typeof api.executeGraph>[2]
  ) => {
    // Cancel any existing execution
    abortController.current?.abort();
    abortController.current = new AbortController();

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await api.executeGraph(graph, input, options);
      setResult(response);
      return response;
    } catch (err) {
      if ((err as Error).name === "AbortError") return null;
      const message = err instanceof Error ? err.message : "Execution failed";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const cancel = useCallback(() => {
    abortController.current?.abort();
  }, []);

  return { execute, cancel, result, loading, error };
}

// --- useStreamExecuteGraph ---

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export function useStreamExecuteGraph() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const execute = useCallback(async (
    graph: GraphSpec,
    input: string,
    options?: Parameters<typeof api.streamExecuteGraph>[3]
  ) => {
    // Cancel any existing stream
    abortController.current?.abort();
    abortController.current = new AbortController();

    setEvents([]);
    setIsStreaming(true);
    setError(null);

    try {
      await api.streamExecuteGraph(
        graph,
        input,
        (event) => {
          setEvents(prev => [...prev, event as StreamEvent]);
        },
        options
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Streaming failed");
    } finally {
      setIsStreaming(false);
    }
  }, []);

  const cancel = useCallback(() => {
    abortController.current?.abort();
    setIsStreaming(false);
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    setError(null);
  }, []);

  return { execute, cancel, clear, events, isStreaming, error };
}

// --- useSubgraphs ---

export function useSubgraphs(orgId?: string) {
  const [data, setData] = useState<api.SubgraphDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const result = await api.listSubgraphs(orgId);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [orgId]);

  return { data, loading, error };
}

// --- useGraphExport ---

export function useGraphExport() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportMermaid = useCallback(async (graph: GraphSpec) => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.exportGraphMermaid(graph);
      return result.mermaid;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const exportMarkdown = useCallback(async (graph: GraphSpec) => {
    const mermaid = await exportMermaid(graph);
    return "```mermaid\n" + mermaid + "\n```";
  }, [exportMermaid]);

  const exportSvg = useCallback(async (graph: GraphSpec) => {
    // SVG export would require server-side rendering
    throw new Error("SVG export not implemented - use Mermaid CLI or client-side rendering");
  }, []);

  return { exportMermaid, exportMarkdown, exportSvg, loading, error };
}
