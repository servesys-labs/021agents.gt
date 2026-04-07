import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { env } from "../config/env";
import { getCreditsSummary, getOrgSettings } from "../services/settings";
import type { AuthUser } from "../services/auth";
import type { ThemeMode } from "../theme";
import { getTheme } from "../theme";

interface SettingsScreenProps {
  token: string;
  user: AuthUser;
  mode: ThemeMode;
  onLogout: () => void;
}

type SettingsCrumb = "account" | "diagnostics" | "org" | "billing";

export function SettingsScreen({ token, user, mode, onLogout }: SettingsScreenProps) {
  const [orgSettings, setOrgSettings] = useState<Record<string, unknown> | null>(null);
  const [credits, setCredits] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [activeCrumb, setActiveCrumb] = useState<SettingsCrumb>("account");
  const theme = getTheme(mode);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const orgRows = useMemo(() => pickPrimitiveRows(orgSettings), [orgSettings]);
  const creditRows = useMemo(() => pickPrimitiveRows(credits), [credits]);
  const crumbs: Array<{ key: SettingsCrumb; label: string }> = useMemo(
    () => [
      { key: "account", label: "Account" },
      { key: "diagnostics", label: "Diagnostics" },
      { key: "org", label: "Org" },
      { key: "billing", label: "Billing" },
    ],
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        setError("");
        const [os, cr] = await Promise.all([
          getOrgSettings(token),
          getCreditsSummary(token).catch(() => null),
        ]);
        setOrgSettings(os);
        setCredits(cr);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [token]);

  const refresh = async () => {
    try {
      setError("");
      const [os, cr] = await Promise.all([
        getOrgSettings(token),
        getCreditsSummary(token).catch(() => null),
      ]);
      setOrgSettings(os);
      setCredits(cr);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>Account, diagnostics, org settings, and billing snapshot</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.crumbRow}>
        {crumbs.map((crumb) => (
          <Pressable
            key={crumb.key}
            onPress={() => setActiveCrumb(crumb.key)}
            style={[
              styles.crumb,
              activeCrumb === crumb.key ? styles.crumbActive : null,
            ]}
          >
            <Text
              style={[
                styles.crumbText,
                activeCrumb === crumb.key ? styles.crumbTextActive : null,
              ]}
            >
              {crumb.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {activeCrumb === "account" ? (
        <View style={styles.card}>
          <Text style={styles.label}>Account</Text>
          <Text style={styles.value}>{user.email}</Text>
          <Text style={styles.muted}>Org: {user.org_id}</Text>
        </View>
      ) : null}

      {activeCrumb === "diagnostics" ? (
        <View style={styles.card}>
          <Text style={styles.label}>Diagnostics</Text>
          <Text style={styles.value}>API: {env.apiBaseUrl}</Text>
          <Text style={styles.value}>Auth: JWT</Text>
          <Text style={styles.value}>Theme: {mode}</Text>
          <Pressable style={styles.refreshBtn} onPress={() => void refresh()}>
            <Text style={styles.refreshText}>Refresh settings</Text>
          </Pressable>
        </View>
      ) : null}

      {activeCrumb === "org" ? (
        <View style={styles.card}>
          <Text style={styles.label}>Org Settings</Text>
          {orgRows.length === 0 ? (
            <Text style={styles.muted}>Loading...</Text>
          ) : (
            orgRows.map((row) => (
              <View key={row.key} style={styles.row}>
                <Text style={styles.rowKey}>{row.key}</Text>
                <Text style={styles.rowValue}>{row.value}</Text>
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeCrumb === "billing" ? (
        <View style={styles.card}>
          <Text style={styles.label}>Billing Snapshot</Text>
          {creditRows.length === 0 ? (
            <Text style={styles.muted}>Unavailable</Text>
          ) : (
            creditRows.map((row) => (
              <View key={row.key} style={styles.row}>
                <Text style={styles.rowKey}>{row.key}</Text>
                <Text style={styles.rowValue}>{row.value}</Text>
              </View>
            ))
          )}
        </View>
      ) : null}

      <Pressable style={styles.logout} onPress={onLogout}>
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </ScrollView>
  );
}

function pickPrimitiveRows(value: Record<string, unknown> | null): Array<{ key: string; value: string }> {
  if (!value) return [];
  return Object.entries(value)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 12)
    .map(([k, v]) => ({ key: k, value: String(v) }));
}

function makeStyles(colors: ReturnType<typeof getTheme>["colors"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { padding: 12, gap: 10, paddingBottom: 24 },
    title: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
    subtitle: { color: colors.mutedForeground, fontSize: 12 },
    error: { color: colors.destructive, fontSize: 12 },
    crumbRow: {
      flexDirection: "row",
      gap: 8,
      flexWrap: "wrap",
    },
    crumb: {
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: colors.card,
    },
    crumbActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primary,
    },
    crumbText: {
      color: colors.foreground,
      fontSize: 12,
      fontWeight: "500",
    },
    crumbTextActive: {
      color: colors.primaryForeground,
      fontWeight: "600",
    },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.card,
      padding: 10,
      gap: 4,
    },
    label: { color: colors.mutedForeground, fontSize: 11, textTransform: "uppercase" },
    value: { color: colors.foreground, fontSize: 13 },
    muted: { color: colors.mutedForeground, fontSize: 12 },
    refreshBtn: {
      marginTop: 6,
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      alignSelf: "flex-start",
    },
    refreshText: {
      color: colors.foreground,
      fontSize: 12,
      fontWeight: "500",
    },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
      marginTop: 4,
    },
    rowKey: {
      color: colors.mutedForeground,
      fontSize: 12,
      flex: 1,
    },
    rowValue: {
      color: colors.foreground,
      fontSize: 12,
      flex: 1,
      textAlign: "right",
    },
    logout: {
      marginTop: 4,
      borderRadius: 10,
      backgroundColor: colors.destructive,
      paddingVertical: 10,
      alignItems: "center",
    },
    logoutText: { color: colors.destructiveForeground, fontWeight: "600" },
  });
}

