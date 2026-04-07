import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { ChatMessageItem as ChatMessage } from "../../chat";
import type { ThemeMode } from "../../theme";
import { getTheme } from "../../theme";
import { ToolCallCard } from "./ToolCallCard";

interface ChatMessageItemProps {
  message: ChatMessage;
  mode: ThemeMode;
  streaming?: boolean;
}

export function ChatMessageItem({
  message,
  mode,
  streaming = false,
}: ChatMessageItemProps) {
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const isUser = message.role === "user";

  return (
    <View style={[styles.row, isUser ? styles.right : styles.left]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {message.thinking ? (
          <View style={styles.thinkingBlock}>
            <Text style={styles.thinkingTitle}>Thinking{streaming ? "..." : ""}</Text>
            <Text style={styles.thinkingText}>{message.thinking}</Text>
          </View>
        ) : null}

        {!isUser && message.toolCalls && message.toolCalls.length > 0 ? (
          <View style={styles.toolCalls}>
            {message.toolCalls.map((tc) => (
              <ToolCallCard
                key={tc.callId}
                toolCall={tc}
                mode={mode}
                defaultExpanded={!tc.output && streaming}
              />
            ))}
          </View>
        ) : null}

        {message.content ? (
          <Text style={[styles.content, isUser ? styles.userContent : styles.assistantContent]}>
            {message.content}
          </Text>
        ) : null}

        {!isUser && streaming && !message.content && (!message.toolCalls || message.toolCalls.length === 0) ? (
          <Text style={styles.cursor}>▍</Text>
        ) : null}

        {!isUser && (message.model || message.costUsd) ? (
          <View style={styles.metaRow}>
            {message.model ? <Text style={styles.meta}>{message.model}</Text> : null}
            {message.costUsd !== undefined && message.costUsd > 0 ? (
              <Text style={styles.meta}>${message.costUsd.toFixed(4)}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    row: {
      width: "100%",
      marginBottom: 12,
      flexDirection: "row",
    },
    left: {
      justifyContent: "flex-start",
    },
    right: {
      justifyContent: "flex-end",
    },
    bubble: {
      maxWidth: "90%",
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 8,
    },
    userBubble: {
      backgroundColor: colors.primary,
      borderTopRightRadius: 6,
    },
    assistantBubble: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderTopLeftRadius: 6,
      maxWidth: "100%",
      width: "100%",
    },
    content: {
      fontSize: 14,
      lineHeight: 20,
    },
    userContent: {
      color: colors.primaryForeground,
    },
    assistantContent: {
      color: colors.foreground,
    },
    thinkingBlock: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.muted,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 6,
    },
    thinkingTitle: {
      color: colors.mutedForeground,
      fontSize: 11,
      fontWeight: "600",
    },
    thinkingText: {
      color: colors.mutedForeground,
      fontFamily: "JetBrainsMono",
      fontSize: 12,
      lineHeight: 18,
    },
    toolCalls: {
      gap: 8,
    },
    cursor: {
      color: colors.foreground,
      fontSize: 16,
      lineHeight: 16,
    },
    metaRow: {
      marginTop: 2,
      flexDirection: "row",
      gap: 8,
      alignItems: "center",
    },
    meta: {
      color: colors.mutedForeground,
      fontSize: 10,
    },
  });
}

