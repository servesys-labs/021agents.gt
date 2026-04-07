import { useEffect, useMemo, useState } from "react";
import { SafeAreaView, StyleSheet, Text, Pressable, View } from "react-native";

import { ChatScreen } from "../screens/ChatScreen";
import { EvalScreen } from "../screens/EvalScreen";
import { LoginScreen } from "../screens/LoginScreen";
import { MetaAgentScreen } from "../screens/MetaAgentScreen";
import { ReleasesScreen } from "../screens/ReleasesScreen";
import { SessionsScreen } from "../screens/SessionsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { env } from "../config/env";
import { login, me, type AuthUser } from "../services/auth";
import { clearJwt, loadJwt, saveJwt } from "../storage/tokenStore";
import { getTheme, type ThemeMode } from "../theme";
import { hasScope } from "../lib/permissions";

type AppTab = "chat" | "sessions" | "meta" | "eval" | "releases" | "settings";
type TabSpec = { key: AppTab; label: string; requiredScope?: string };

export function AppShell() {
  const [mode] = useState<ThemeMode>("dark");
  const [tab, setTab] = useState<AppTab>("chat");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [authError, setAuthError] = useState("");
  const [activeAgent, setActiveAgent] = useState("");
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const tabSpecs: TabSpec[] = useMemo(
    () => [
      { key: "chat", label: "Chat" },
      { key: "sessions", label: "Sessions", requiredScope: "sessions:read" },
      { key: "meta", label: "Meta", requiredScope: "agents:write" },
      { key: "eval", label: "Eval", requiredScope: "eval:read" },
      { key: "releases", label: "Releases", requiredScope: "releases:read" },
      { key: "settings", label: "Settings" },
    ],
    [],
  );

  useEffect(() => {
    void (async () => {
      const stored = await loadJwt();
      if (!stored) return;
      setLoadingAuth(true);
      try {
        const currentUser = await me(stored);
        setToken(stored);
        setUser(currentUser);
      } catch {
        await clearJwt();
      } finally {
        setLoadingAuth(false);
      }
    })();
  }, []);

  const onLogin = async (email: string, password: string) => {
    setLoadingAuth(true);
    setAuthError("");
    try {
      const res = await login(email, password);
      await saveJwt(res.token);
      const currentUser = await me(res.token);
      setToken(res.token);
      setUser(currentUser);
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setLoadingAuth(false);
    }
  };

  const logout = async () => {
    await clearJwt();
    setToken(null);
    setUser(null);
    setTab("chat");
  };

  if (!token || !user) {
    return (
      <SafeAreaView style={styles.safe}>
        <LoginScreen
          mode={mode}
          loading={loadingAuth}
          error={authError}
          onSubmit={onLogin}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        {tab === "chat" ? (
          <ChatScreen
            baseUrl={env.apiBaseUrl}
            token={token}
            mode={mode}
            initialAgentName={activeAgent}
            onAgentChange={setActiveAgent}
          />
        ) : null}
        {tab === "sessions" ? <SessionsScreen token={token} mode={mode} /> : null}
        {tab === "meta" ? <MetaAgentScreen token={token} mode={mode} agentName={activeAgent} /> : null}
        {tab === "eval" ? <EvalScreen token={token} mode={mode} agentName={activeAgent} /> : null}
        {tab === "releases" ? <ReleasesScreen token={token} mode={mode} agentName={activeAgent} /> : null}
        {tab === "settings" ? (
          <SettingsScreen token={token} user={user} mode={mode} onLogout={logout} />
        ) : null}
      </View>

      <View style={styles.tabBar}>
        {tabSpecs
          .filter((t) => !t.requiredScope || hasScope(user, t.requiredScope))
          .map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    body: { flex: 1 },
    tabBar: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      flexDirection: "row",
      flexWrap: "wrap",
      backgroundColor: colors.card,
      paddingVertical: 6,
      paddingHorizontal: 8,
      gap: 6,
    },
    tabBtn: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 8,
      minWidth: 76,
      alignItems: "center",
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.background,
    },
    tabBtnActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primary,
    },
    tabText: {
      color: colors.foreground,
      fontSize: 12,
    },
    tabTextActive: {
      color: colors.primaryForeground,
      fontWeight: "600",
    },
  });
}

