import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { listReleaseChannels, promoteRelease, rollbackCanary } from "../services/releases";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface ReleasesScreenProps {
  token: string;
  mode: ThemeMode;
  agentName: string;
}

export function ReleasesScreen({ token, mode, agentName }: ReleasesScreenProps) {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const run = async (fn: () => Promise<Record<string, unknown>>) => {
    if (!agentName || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fn();
      setPayload(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmRollback = () => {
    Alert.alert(
      "Rollback canary?",
      "This will rollback active canary settings for the selected agent.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rollback",
          style: "destructive",
          onPress: () => {
            void run(() => rollbackCanary(token, agentName));
          },
        },
      ],
    );
  };

  const confirmPromote = () => {
    Alert.alert(
      "Promote draft to staging?",
      "This will promote the selected agent release from draft to staging.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Promote",
          onPress: () => {
            void run(() => promoteRelease(token, agentName, "draft", "staging"));
          },
        },
      ],
    );
  };

  const channels = Array.isArray(payload?.channels)
    ? (payload?.channels as Array<Record<string, unknown>>)
    : [];
  const actionSummary =
    typeof payload?.decision === "string"
      ? String(payload.decision)
      : typeof payload?.status === "string"
        ? String(payload.status)
        : payload
          ? "Action completed"
          : "No action yet.";

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Releases</Text>
      <Text style={styles.subtitle}>Agent: {agentName || "select in Chat"}</Text>
      <View style={styles.row}>
        <Pressable
          style={styles.button}
          onPress={() => run(() => listReleaseChannels(token, agentName))}
        >
          <Text style={styles.buttonText}>Channels</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          onPress={confirmPromote}
        >
          <Text style={styles.buttonText}>Promote draft to staging</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.dangerButton]}
          onPress={confirmRollback}
        >
          <Text style={styles.buttonText}>Rollback canary</Text>
        </Pressable>
      </View>
      {busy ? <Text style={styles.muted}>Working...</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.card} contentContainerStyle={styles.cardContent}>
        <Text style={styles.label}>Status</Text>
        <Text style={styles.status}>{actionSummary}</Text>

        <Text style={styles.label}>Channels</Text>
        {channels.length === 0 ? (
          <Text style={styles.muted}>No channel list in latest response.</Text>
        ) : (
          channels.map((ch, idx) => (
            <View key={`${ch.channel ?? idx}`} style={styles.channelCard}>
              <Text style={styles.channelName}>{String(ch.channel ?? `channel-${idx + 1}`)}</Text>
              <Text style={styles.channelMeta}>
                Version: {String(ch.version ?? "-")} | Updated: {String(ch.updated_at ?? "-")}
              </Text>
            </View>
          ))
        )}

        {payload ? (
          <>
            <Text style={styles.label}>Action details</Text>
            <Text style={styles.payload} numberOfLines={12}>
              {JSON.stringify(payload, null, 2)}
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, padding: 12, gap: 10 },
    title: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
    subtitle: { color: colors.mutedForeground, fontSize: 12 },
    row: { gap: 8 },
    button: {
      borderRadius: 10,
      backgroundColor: colors.primary,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    dangerButton: {
      backgroundColor: colors.destructive,
    },
    buttonText: { color: colors.primaryForeground, fontSize: 12, fontWeight: "600" },
    muted: { color: colors.mutedForeground, fontSize: 12 },
    error: { color: colors.destructive, fontSize: 12 },
    card: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.card,
      padding: 10,
      gap: 8,
    },
    cardContent: {
      gap: 8,
    },
    label: { color: colors.mutedForeground, fontSize: 11, textTransform: "uppercase" },
    status: {
      color: colors.foreground,
      fontSize: 13,
      fontWeight: "600",
    },
    channelCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.background,
      padding: 10,
      gap: 2,
    },
    channelName: {
      color: colors.foreground,
      fontSize: 13,
      fontWeight: "600",
      textTransform: "capitalize",
    },
    channelMeta: {
      color: colors.mutedForeground,
      fontSize: 12,
    },
    payload: {
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 18,
      fontFamily: "JetBrainsMono",
    },
  });
}

