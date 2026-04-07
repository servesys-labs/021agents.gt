import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { ToolCallItem } from "../../chat";
import type { ThemeMode } from "../../theme";
import { getTheme } from "../../theme";

interface ToolCallCardProps {
  toolCall: ToolCallItem;
  mode: ThemeMode;
  defaultExpanded?: boolean;
}

export function ToolCallCard({
  toolCall,
  mode,
  defaultExpanded = false,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(defaultExpanded);
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const isPending = !toolCall.output && !toolCall.error;
  const hasError = Boolean(toolCall.error);

  return (
    <View style={styles.container}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.header}>
        <Text style={styles.caret}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.name}>{toolCall.name}</Text>
        <View style={styles.spacer} />
        {toolCall.latencyMs ? (
          <Text style={styles.meta}>{toolCall.latencyMs}ms</Text>
        ) : null}
        <Text
          style={[
            styles.status,
            isPending
              ? styles.pending
              : hasError
                ? styles.error
                : styles.success,
          ]}
        >
          {isPending ? "…" : hasError ? "✕" : "✓"}
        </Text>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          <Text style={styles.label}>INPUT</Text>
          <Text style={styles.code}>{toolCall.input || "(empty)"}</Text>
          {toolCall.error ? (
            <>
              <Text style={[styles.label, styles.error]}>ERROR</Text>
              <Text style={[styles.code, styles.error]}>{toolCall.error}</Text>
            </>
          ) : toolCall.output ? (
            <>
              <Text style={styles.label}>RESULT</Text>
              <Text style={styles.code}>
                {toolCall.output.length > 3000
                  ? `${toolCall.output.slice(0, 3000)}\n... (truncated)`
                  : toolCall.output}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 8,
    },
    caret: {
      color: colors.mutedForeground,
      width: 12,
    },
    name: {
      color: colors.foreground,
      fontFamily: "JetBrainsMono",
      fontSize: 12,
      fontWeight: "600",
    },
    spacer: {
      flex: 1,
    },
    meta: {
      color: colors.mutedForeground,
      fontSize: 11,
    },
    status: {
      fontSize: 12,
      fontWeight: "700",
    },
    pending: {
      color: colors.mutedForeground,
    },
    error: {
      color: colors.destructive,
    },
    success: {
      color: colors.success,
    },
    body: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 6,
      backgroundColor: colors.codeBackground,
    },
    label: {
      color: colors.mutedForeground,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    code: {
      color: colors.codeForeground,
      fontSize: 12,
      lineHeight: 18,
      fontFamily: "JetBrainsMono",
    },
  });
}

