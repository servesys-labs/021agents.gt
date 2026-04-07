import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, SafeAreaView, StyleSheet, Text, View } from "react-native";

import { useAgentChat } from "../chat";
import { AgentPicker, ChatComposer, ChatMessageItem } from "../components/chat";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface AgentSummary {
  name: string;
}

interface ChatScreenProps {
  baseUrl: string;
  token: string;
  mode?: ThemeMode;
  initialAgentName?: string;
  onAgentChange?: (agentName: string) => void;
}

export function ChatScreen({
  baseUrl,
  token,
  mode = "dark",
  initialAgentName,
  onAgentChange,
}: ChatScreenProps) {
  const [agents, setAgents] = useState<string[]>(initialAgentName ? [initialAgentName] : []);
  const [selectedAgent, setSelectedAgent] = useState<string>(initialAgentName ?? "");
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentLoadError, setAgentLoadError] = useState<string>("");

  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const chat = useAgentChat({
    baseUrl,
    token,
    agentName: selectedAgent || "__unset__",
  });

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true);
    setAgentLoadError("");
    try {
      const res = await fetch(`${baseUrl}/api/v1/agents`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as AgentSummary[];
      const names = data
        .map((a) => String(a?.name ?? "").trim())
        .filter(Boolean);
      setAgents(names);
      if (!selectedAgent && names.length > 0) {
        setSelectedAgent(names[0]);
        onAgentChange?.(names[0]);
      }
    } catch (err) {
      setAgentLoadError(`Failed to load agents: ${(err as Error).message}`);
    } finally {
      setLoadingAgents(false);
    }
  }, [baseUrl, token, selectedAgent]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const send = (text: string) => {
    if (!selectedAgent) return;
    chat.send(text);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Chat</Text>
          <Text style={styles.subtitle}>
            {selectedAgent ? `Agent: ${selectedAgent}` : "Select an agent to begin"}
          </Text>
        </View>

        <AgentPicker
          mode={mode}
          agents={agents}
          selectedAgent={selectedAgent}
          loading={loadingAgents}
          onSelectAgent={(name) => {
            setSelectedAgent(name);
            onAgentChange?.(name);
          }}
          onRefresh={loadAgents}
        />

        {agentLoadError ? <Text style={styles.error}>{agentLoadError}</Text> : null}
        {!selectedAgent ? (
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>Select an agent to begin</Text>
            <Text style={styles.emptySubtitle}>
              OpenShots chat streams from `/api/v1/runtime-proxy/runnable/stream`.
            </Text>
          </View>
        ) : (
          <FlatList
            data={chat.messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messagesContent}
            style={styles.messagesList}
            renderItem={({ item }) => (
              <ChatMessageItem
                message={item}
                mode={mode}
                streaming={chat.streaming && item === chat.messages[chat.messages.length - 1]}
              />
            )}
          />
        )}

        {chat.error ? <Text style={styles.error}>{chat.error}</Text> : null}

        <ChatComposer
          mode={mode}
          onSend={send}
          onStop={chat.stop}
          streaming={chat.streaming}
          disabled={!selectedAgent}
        />
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.background,
    },
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 4,
      gap: 2,
    },
    title: {
      color: colors.foreground,
      fontSize: 18,
      fontWeight: "600",
    },
    subtitle: {
      color: colors.mutedForeground,
      fontSize: 12,
    },
    messagesList: {
      flex: 1,
    },
    messagesContent: {
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 12,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      gap: 8,
    },
    emptyTitle: {
      color: colors.foreground,
      fontSize: 16,
      fontWeight: "600",
    },
    emptySubtitle: {
      color: colors.mutedForeground,
      fontSize: 13,
      textAlign: "center",
      lineHeight: 18,
    },
    error: {
      color: colors.destructiveForeground,
      fontSize: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginHorizontal: 12,
      marginBottom: 8,
      borderRadius: 8,
      backgroundColor: colors.destructive,
    },
  });
}

