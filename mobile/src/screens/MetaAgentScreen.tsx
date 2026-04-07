import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { runMetaChat, type MetaChatMessage } from "../services/metaAgent";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface MetaAgentScreenProps {
  token: string;
  mode: ThemeMode;
  agentName: string;
}

export function MetaAgentScreen({ token, mode, agentName }: MetaAgentScreenProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<MetaChatMessage[]>([]);
  const [lastCostUsd, setLastCostUsd] = useState<number | null>(null);
  const [lastTurns, setLastTurns] = useState<number | null>(null);
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const send = async () => {
    if (!input.trim() || loading || !agentName) return;
    const nextMessages: MetaChatMessage[] = [...messages, { role: "user", content: input.trim() }];
    setMessages(nextMessages);
    setLoading(true);
    setError("");
    setInput("");
    try {
      const res = await runMetaChat(token, agentName, nextMessages);
      setLastCostUsd(res.cost_usd ?? null);
      setLastTurns(res.turns ?? null);
      setMessages([
        ...nextMessages,
        { role: "assistant", content: res.response },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const clearThread = () => {
    if (loading) return;
    setMessages([]);
    setInput("");
    setError("");
    setLastCostUsd(null);
    setLastTurns(null);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Meta-agent</Text>
          <Text style={styles.subtitle}>Managing: {agentName || "select agent in Chat tab"}</Text>
        </View>
        <Pressable style={styles.clearBtn} onPress={clearThread}>
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>Messages: {messages.length}</Text>
        <Text style={styles.metaText}>
          Last cost: {lastCostUsd !== null ? `$${lastCostUsd.toFixed(4)}` : "-"}
        </Text>
        <Text style={styles.metaText}>Turns: {lastTurns ?? "-"}</Text>
      </View>

      <FlatList
        data={messages}
        keyExtractor={(_, idx) => `meta-msg-${idx}`}
        contentContainerStyle={styles.thread}
        renderItem={({ item }) => (
          <View
            style={[
              styles.messageCard,
              item.role === "user" ? styles.userCard : styles.assistantCard,
            ]}
          >
            <Text style={[styles.messageRole, item.role === "user" ? styles.userText : null]}>
              {item.role}
            </Text>
            <Text style={[styles.messageBody, item.role === "user" ? styles.userText : null]}>
              {item.content}
            </Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.emptyThread}>No conversation yet.</Text>}
      />

      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        multiline
        placeholder="Ask meta-agent to optimize prompts, tools, eval..."
        placeholderTextColor={c.mutedForeground}
      />
      <Pressable style={styles.button} onPress={send} disabled={!agentName || loading}>
        <Text style={styles.buttonText}>{loading ? "Running..." : "Send"}</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, padding: 12, gap: 10 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    title: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
    subtitle: { color: colors.mutedForeground, fontSize: 12 },
    clearBtn: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    clearText: { color: colors.foreground, fontSize: 12, fontWeight: "500" },
    metaRow: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.card,
      padding: 10,
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 6,
    },
    metaText: { color: colors.mutedForeground, fontSize: 11 },
    thread: { gap: 8, paddingBottom: 4 },
    emptyThread: { color: colors.mutedForeground, fontSize: 12, paddingVertical: 8 },
    messageCard: {
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
      gap: 4,
    },
    userCard: {
      borderColor: colors.primary,
      backgroundColor: colors.primary,
    },
    assistantCard: {
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    messageRole: {
      color: colors.mutedForeground,
      fontSize: 11,
      textTransform: "uppercase",
    },
    messageBody: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    userText: { color: colors.primaryForeground },
    input: {
      minHeight: 110,
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 10,
      backgroundColor: colors.card,
      color: colors.foreground,
      padding: 10,
      textAlignVertical: "top",
    },
    button: {
      alignSelf: "flex-start",
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: 10,
      backgroundColor: colors.primary,
    },
    buttonText: { color: colors.primaryForeground, fontWeight: "600" },
    error: { color: colors.destructive, fontSize: 12 },
  });
}

