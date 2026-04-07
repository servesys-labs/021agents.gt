import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { getSessionTurns, listSessions, type SessionSummary, type SessionTurn } from "../services/sessions";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface SessionsScreenProps {
  token: string;
  mode: ThemeMode;
}

export function SessionsScreen({ token, mode }: SessionsScreenProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [error, setError] = useState("");
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const [loadingList, setLoadingList] = useState(false);

  const refresh = async () => {
    try {
      setLoadingList(true);
      setError("");
      const data = await listSessions(token);
      setSessions(data);
      if (data.length > 0) {
        setSelected((prev) => prev ?? data[0]);
      } else {
        setSelected(null);
        setTurns([]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [token]);

  useEffect(() => {
    if (!selected?.session_id) return;
    void (async () => {
      try {
        const data = await getSessionTurns(token, selected.session_id);
        setTurns(data);
      } catch {
        setTurns([]);
      }
    })();
  }, [token, selected]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Sessions</Text>
          <Text style={styles.subtitle}>{sessions.length} total</Text>
        </View>
        <Pressable style={styles.refreshBtn} onPress={() => void refresh()}>
          <Text style={styles.refreshText}>{loadingList ? "Refreshing..." : "Refresh"}</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={sessions}
        keyExtractor={(item) => item.session_id}
        horizontal
        contentContainerStyle={styles.sessionList}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => setSelected(item)}
            style={[
              styles.sessionPill,
              selected?.session_id === item.session_id && styles.sessionPillActive,
            ]}
          >
            <Text
              style={[
                styles.sessionPillText,
                selected?.session_id === item.session_id && styles.sessionPillTextActive,
              ]}
            >
              {item.agent_name || "agent"} • {item.session_id.slice(0, 8)}
            </Text>
          </Pressable>
        )}
      />

      <View style={styles.selectedCard}>
        <Text style={styles.selectedLabel}>Selected session</Text>
        {selected ? (
          <>
            <Text style={styles.selectedTitle}>
              {selected.agent_name || "agent"} - {selected.session_id.slice(0, 12)}
            </Text>
            <Text style={styles.selectedMeta}>
              Status: {selected.status || "-"} | Updated: {formatTime(selected.updated_at)}
            </Text>
          </>
        ) : (
          <Text style={styles.selectedMeta}>No sessions found.</Text>
        )}
      </View>

      <FlatList
        data={turns}
        keyExtractor={(item, idx) => `${item.turn_id ?? idx}`}
        contentContainerStyle={styles.turns}
        renderItem={({ item }) => (
          <View style={styles.turnCard}>
            <Text style={styles.turnRole}>
              {item.role || "turn"} {item.created_at ? `• ${formatTime(item.created_at)}` : ""}
            </Text>
            <Text style={styles.turnContent}>{item.content || "(empty)"}</Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyTurns}>
            {selected ? "No turns in this session yet." : "Select a session to view activity."}
          </Text>
        }
      />
    </View>
  );
}

function formatTime(value?: string): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, padding: 12, gap: 10 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    headerText: { gap: 2 },
    title: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
    subtitle: { color: colors.mutedForeground, fontSize: 12 },
    refreshBtn: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    refreshText: { color: colors.foreground, fontSize: 12, fontWeight: "500" },
    error: { color: colors.destructive, fontSize: 12 },
    sessionList: { gap: 8 },
    sessionPill: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.card,
    },
    sessionPillActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    sessionPillText: { color: colors.foreground, fontSize: 12 },
    sessionPillTextActive: { color: colors.primaryForeground },
    selectedCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.card,
      padding: 10,
      gap: 4,
    },
    selectedLabel: { color: colors.mutedForeground, fontSize: 11, textTransform: "uppercase" },
    selectedTitle: { color: colors.foreground, fontSize: 13, fontWeight: "600" },
    selectedMeta: { color: colors.mutedForeground, fontSize: 12 },
    turns: { gap: 8, paddingBottom: 24 },
    turnCard: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: 10,
      padding: 10,
      gap: 6,
    },
    turnRole: { color: colors.mutedForeground, fontSize: 11, textTransform: "uppercase" },
    turnContent: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    emptyTurns: { color: colors.mutedForeground, fontSize: 12, paddingVertical: 8 },
  });
}

