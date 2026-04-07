import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { ThemeMode } from "../../theme";
import { getTheme } from "../../theme";

interface ChatComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  mode: ThemeMode;
}

const slashCommands = [
  { name: "/help", description: "Show available commands" },
  { name: "/clear", description: "Clear conversation" },
  { name: "/model", description: "Switch model" },
  { name: "/tools", description: "List available tools" },
];

export function ChatComposer({
  onSend,
  onStop,
  streaming,
  disabled = false,
  mode,
}: ChatComposerProps) {
  const [input, setInput] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const filteredCommands = useMemo(() => {
    if (!showSlashMenu || !input.startsWith("/")) return [];
    const query = input.slice(1).toLowerCase();
    if (!query) return slashCommands;
    return slashCommands.filter((cmd) => cmd.name.slice(1).startsWith(query));
  }, [showSlashMenu, input]);

  const canSend = input.trim().length > 0 && !streaming && !disabled;

  const send = () => {
    if (!canSend) return;
    onSend(input.trim());
    setInput("");
    setShowSlashMenu(false);
  };

  const selectCommand = (name: string) => {
    setInput(`${name} `);
    setShowSlashMenu(false);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.wrap}>
        {showSlashMenu && filteredCommands.length > 0 ? (
          <View style={styles.menu}>
            {filteredCommands.map((cmd) => (
              <Pressable
                key={cmd.name}
                style={styles.menuItem}
                onPress={() => selectCommand(cmd.name)}
              >
                <Text style={styles.menuName}>{cmd.name}</Text>
                <Text style={styles.menuDesc}>{cmd.description}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={(text) => {
              setInput(text);
              setShowSlashMenu(text.startsWith("/") && !text.includes(" "));
            }}
            placeholder="Type a message... (/ for commands)"
            placeholderTextColor={c.mutedForeground}
            editable={!disabled}
            multiline
            style={styles.input}
            onSubmitEditing={() => {
              if (showSlashMenu && filteredCommands.length > 0) {
                selectCommand(filteredCommands[0].name);
                return;
              }
              send();
            }}
          />

          {streaming ? (
            <Pressable style={styles.stopBtn} onPress={onStop}>
              <Text style={styles.stopBtnText}>■</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
              onPress={send}
              disabled={!canSend}
            >
              <Text style={styles.sendBtnText}>↑</Text>
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    wrap: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 12,
      backgroundColor: colors.card,
      gap: 8,
    },
    menu: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      overflow: "hidden",
      backgroundColor: colors.popover,
    },
    menuItem: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 2,
    },
    menuName: {
      color: colors.foreground,
      fontFamily: "JetBrainsMono",
      fontSize: 13,
    },
    menuDesc: {
      color: colors.mutedForeground,
      fontSize: 12,
    },
    inputRow: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 12,
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      padding: 8,
      backgroundColor: colors.background,
    },
    input: {
      flex: 1,
      color: colors.foreground,
      fontSize: 14,
      maxHeight: 140,
      minHeight: 42,
      paddingHorizontal: 6,
      paddingVertical: 6,
      textAlignVertical: "top",
    },
    sendBtn: {
      width: 34,
      height: 34,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary,
    },
    sendBtnDisabled: {
      opacity: 0.4,
    },
    sendBtnText: {
      color: colors.primaryForeground,
      fontSize: 16,
      fontWeight: "700",
      marginTop: -2,
    },
    stopBtn: {
      width: 34,
      height: 34,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.destructive,
    },
    stopBtnText: {
      color: colors.destructiveForeground,
      fontSize: 14,
      fontWeight: "700",
    },
  });
}

