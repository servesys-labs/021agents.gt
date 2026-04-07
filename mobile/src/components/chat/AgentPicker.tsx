import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ThemeMode } from "../../theme";
import { getTheme } from "../../theme";

interface AgentPickerProps {
  mode: ThemeMode;
  agents: string[];
  selectedAgent?: string;
  loading?: boolean;
  onSelectAgent: (agentName: string) => void;
  onRefresh?: () => void;
}

export function AgentPicker({
  mode,
  agents,
  selectedAgent,
  loading = false,
  onSelectAgent,
  onRefresh,
}: AgentPickerProps) {
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>Agents</Text>
        {onRefresh ? (
          <Pressable style={styles.refreshBtn} onPress={onRefresh}>
            <Text style={styles.refreshText}>{loading ? "Loading..." : "Refresh"}</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.list}>
        {agents.length === 0 ? (
          <Text style={styles.emptyText}>{loading ? "Loading agents..." : "No agents found"}</Text>
        ) : (
          agents.map((name) => {
            const selected = name === selectedAgent;
            return (
              <Pressable
                key={name}
                onPress={() => onSelectAgent(name)}
                style={[styles.pill, selected ? styles.pillSelected : null]}
              >
                <Text style={[styles.pillText, selected ? styles.pillTextSelected : null]}>{name}</Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    wrap: {
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 10,
      backgroundColor: colors.background,
      gap: 8,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: {
      color: colors.mutedForeground,
      fontSize: 12,
      fontWeight: "600",
    },
    refreshBtn: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    refreshText: {
      color: colors.foreground,
      fontSize: 12,
      fontWeight: "500",
    },
    list: {
      gap: 8,
      alignItems: "center",
      paddingRight: 8,
    },
    emptyText: {
      color: colors.mutedForeground,
      fontSize: 12,
    },
    pill: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: colors.card,
    },
    pillSelected: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    pillText: {
      color: colors.foreground,
      fontSize: 13,
      fontWeight: "500",
    },
    pillTextSelected: {
      color: colors.primaryForeground,
    },
  });
}

