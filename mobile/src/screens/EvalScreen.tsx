import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { getEvalRunDetail, listEvalRuns, startEvalRun, type EvalRunSummary } from "../services/eval";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface EvalScreenProps {
  token: string;
  mode: ThemeMode;
  agentName: string;
}

export function EvalScreen({ token, mode, agentName }: EvalScreenProps) {
  const [runs, setRuns] = useState<EvalRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const refresh = async () => {
    try {
      setError("");
      const data = await listEvalRuns(token, agentName || undefined);
      setRuns(data);
      if (data.length > 0 && selectedRunId === null) setSelectedRunId(data[0].run_id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, [token, agentName]);

  useEffect(() => {
    if (!selectedRunId) return;
    void (async () => {
      try {
        const data = await getEvalRunDetail(token, selectedRunId);
        setDetail(data);
      } catch {
        setDetail(null);
      }
    })();
  }, [token, selectedRunId]);

  const runEval = async () => {
    if (!agentName || running) return;
    setRunning(true);
    setError("");
    try {
      await startEvalRun(token, agentName, [
        { name: "basic", input: "Say hello", expected: "hello", grader: "contains" },
      ]);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const selected = runs.find((r) => r.run_id === selectedRunId) ?? null;
  const trials = Array.isArray(detail?.trials) ? (detail?.trials as Array<Record<string, unknown>>) : [];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Evaluation</Text>
          <Text style={styles.subtitle}>Agent: {agentName || "select in Chat tab"}</Text>
        </View>
        <Pressable style={styles.button} onPress={runEval}>
          <Text style={styles.buttonText}>{running ? "Running..." : "Run eval"}</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={runs}
        horizontal
        keyExtractor={(item) => String(item.run_id)}
        contentContainerStyle={styles.runList}
        renderItem={({ item }) => (
          <Pressable
            style={[
              styles.runPill,
              selectedRunId === item.run_id && styles.runPillActive,
            ]}
            onPress={() => setSelectedRunId(item.run_id)}
          >
            <Text
              style={[
                styles.runPillText,
                selectedRunId === item.run_id && styles.runPillTextActive,
              ]}
            >
              #{item.run_id} {item.pass_rate !== undefined ? `${Math.round(item.pass_rate * 100)}%` : ""}
            </Text>
          </Pressable>
        )}
      />

      <ScrollView style={styles.detailCard} contentContainerStyle={styles.detailContent}>
        <Text style={styles.detailTitle}>Run summary</Text>
        {!selected ? (
          <Text style={styles.emptyText}>Select an eval run to inspect details.</Text>
        ) : (
          <>
            <View style={styles.metricsRow}>
              <Metric label="Pass rate" value={selected.pass_rate !== undefined ? `${Math.round(selected.pass_rate * 100)}%` : "-"} mode={mode} />
              <Metric label="Trials" value={String(selected.total_trials ?? "-")} mode={mode} />
              <Metric label="Tasks" value={String(selected.total_tasks ?? "-")} mode={mode} />
            </View>
            <View style={styles.metricsRow}>
              <Metric label="Latency" value={selected.avg_latency_ms !== undefined ? `${Math.round(selected.avg_latency_ms)}ms` : "-"} mode={mode} />
              <Metric label="Cost" value={selected.total_cost_usd !== undefined ? `$${Number(selected.total_cost_usd).toFixed(4)}` : "-"} mode={mode} />
              <Metric label="Run id" value={`#${selected.run_id}`} mode={mode} />
            </View>

            <Text style={styles.sectionTitle}>Trials</Text>
            {trials.length === 0 ? (
              <Text style={styles.emptyText}>No trial details available.</Text>
            ) : (
              trials.slice(0, 10).map((trial, idx) => (
                <View key={`${trial.trial_number ?? idx}`} style={styles.trialCard}>
                  <Text style={styles.trialTitle}>
                    Trial {String(trial.trial_number ?? idx + 1)}
                  </Text>
                  <Text style={styles.trialLine}>
                    Score: {trial.score !== undefined ? String(trial.score) : "-"} | Latency: {trial.latency_ms !== undefined ? `${trial.latency_ms}ms` : "-"}
                  </Text>
                  <Text style={styles.trialLine} numberOfLines={2}>
                    Input: {String(trial.input ?? "-")}
                  </Text>
                  {"output" in trial ? (
                    <Text style={styles.trialLine} numberOfLines={2}>
                      Output: {String(trial.output ?? "-")}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Metric({ label, value, mode }: { label: string; value: string; mode: ThemeMode }) {
  const colors = getTheme(mode).colors;
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ fontSize: 11, color: colors.mutedForeground }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.foreground }}>{value}</Text>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, padding: 12, gap: 10 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    headerText: { gap: 2 },
    title: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
    subtitle: { color: colors.mutedForeground, fontSize: 12 },
    button: {
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.primary,
    },
    buttonText: { color: colors.primaryForeground, fontWeight: "600", fontSize: 12 },
    error: { color: colors.destructive, fontSize: 12 },
    runList: { gap: 8 },
    runPill: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.input,
      backgroundColor: colors.card,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    runPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    runPillText: { color: colors.foreground, fontSize: 12 },
    runPillTextActive: { color: colors.primaryForeground },
    detailCard: {
      flex: 1,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      padding: 10,
      gap: 8,
    },
    detailContent: {
      gap: 10,
    },
    detailTitle: { color: colors.mutedForeground, fontSize: 11, textTransform: "uppercase" },
    emptyText: {
      color: colors.mutedForeground,
      fontSize: 12,
    },
    metricsRow: {
      flexDirection: "row",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 10,
      backgroundColor: colors.background,
    },
    sectionTitle: {
      color: colors.mutedForeground,
      fontSize: 11,
      textTransform: "uppercase",
      marginTop: 2,
    },
    trialCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.background,
      padding: 10,
      gap: 4,
    },
    trialTitle: {
      color: colors.foreground,
      fontSize: 12,
      fontWeight: "600",
    },
    trialLine: {
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 17,
    },
  });
}

