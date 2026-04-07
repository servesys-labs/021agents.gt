import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { env } from "../config/env";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface LoginScreenProps {
  mode: ThemeMode;
  loading: boolean;
  error?: string;
  onSubmit: (email: string, password: string) => void;
}

export function LoginScreen({ mode, loading, error, onSubmit }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>OpenShots</Text>
      <Text style={styles.subtitle}>Sign in with your AgentOS account</Text>
      <Text style={styles.env}>API: {env.apiBaseUrl}</Text>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="Email"
        placeholderTextColor={c.mutedForeground}
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="Password"
        placeholderTextColor={c.mutedForeground}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, !canSubmit && styles.buttonDisabled]}
        disabled={!canSubmit}
        onPress={() => onSubmit(email.trim(), password)}
      >
        <Text style={styles.buttonText}>{loading ? "Signing in..." : "Sign in"}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      backgroundColor: colors.background,
      gap: 12,
    },
    title: {
      color: colors.foreground,
      fontSize: 28,
      fontWeight: "700",
    },
    subtitle: {
      color: colors.mutedForeground,
      fontSize: 14,
    },
    env: {
      color: colors.mutedForeground,
      fontSize: 11,
      marginBottom: 8,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 12,
      color: colors.foreground,
      backgroundColor: colors.card,
    },
    error: {
      color: colors.destructive,
      fontSize: 12,
    },
    button: {
      marginTop: 4,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: "center",
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonText: {
      color: colors.primaryForeground,
      fontSize: 14,
      fontWeight: "600",
    },
  });
}

