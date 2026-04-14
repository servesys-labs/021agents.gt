/**
 * Screen Template — Expo SDK 54 / React Native 0.81
 *
 * Usage: Copy this file, rename it to YourScreen.tsx, and customize.
 *
 * Conventions:
 * - SafeAreaView as root container
 * - Status bar spacer (height: 48) for consistent top spacing
 * - ScreenHeader with back button and centered title
 * - ScrollView for scrollable content with paddingHorizontal: 24
 * - All colors from useTheme() — never hardcode color values
 * - All fonts from FontFamily tokens — never use system fonts
 * - All spacing from Spacing/BorderRadius tokens
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { FontFamily, FontSize, Spacing, BorderRadius } from '@/lib/theme';
import ScreenHeader from '@/components/ScreenHeader';
import PrimaryButton from '@/components/PrimaryButton';
import { RootStackParamList } from '@/navigation/AppNavigator';

export default function TemplateScreen() {
  const { colors, isDark } = useTheme();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Status bar spacer — consistent 48px across all screens */}
      <View style={styles.statusBarSpacer} />

      {/* Screen header with back button */}
      <ScreenHeader
        title="Screen Title"
        onBack={() => navigation.goBack()}
        // Optional right element:
        // rightElement={<TouchableOpacity><Ionicons name="ellipsis-horizontal" size={22} color={colors.text} /></TouchableOpacity>}
      />

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Section Label */}
        <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
          SECTION TITLE
        </Text>

        {/* Card */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: colors.cardBg,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Card Title
          </Text>
          <Text
            style={[styles.cardDescription, { color: colors.textSecondary }]}
          >
            Card description text goes here.
          </Text>
        </View>

        {/* List Item */}
        <TouchableOpacity
          style={[styles.listItem, { borderBottomColor: colors.separator }]}
          activeOpacity={0.7}
        >
          <View style={styles.listItemLeft}>
            <View
              style={[
                styles.iconContainer,
                { backgroundColor: colors.surface2 },
              ]}
            >
              <Ionicons
                name="star-outline"
                size={20}
                color={colors.accentGreen}
              />
            </View>
            <Text style={[styles.listItemText, { color: colors.text }]}>
              List Item
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={18}
            color={colors.textSecondary}
          />
        </TouchableOpacity>

        {/* Bottom spacing for scroll content */}
        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* Fixed bottom CTA */}
      <View
        style={[styles.bottomCTA, { borderTopColor: colors.border }]}
      >
        <PrimaryButton
          title="Continue"
          onPress={() => {
            // navigation.navigate('NextScreen');
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  statusBarSpacer: {
    height: 48,
  },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.xxl, // 24
  },
  scrollContent: {
    paddingTop: Spacing.lg, // 16
  },
  sectionLabel: {
    fontFamily: FontFamily.bodySemiBold,
    fontSize: FontSize.xs, // 11
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: Spacing.md, // 12
  },
  card: {
    borderRadius: BorderRadius.lg, // 16
    borderWidth: 1,
    padding: Spacing.xl, // 20
    marginBottom: Spacing.lg, // 16
  },
  cardTitle: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.lg, // 17
    marginBottom: Spacing.xs, // 4
  },
  cardDescription: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.md, // 15
    lineHeight: 22,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg, // 16
    borderBottomWidth: 0.5,
  },
  listItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md, // 12
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.sm, // 8
    alignItems: 'center',
    justifyContent: 'center',
  },
  listItemText: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.lg, // 17
  },
  bottomSpacer: {
    height: 100,
  },
  bottomCTA: {
    paddingHorizontal: Spacing.xxl, // 24
    paddingVertical: Spacing.lg, // 16
    paddingBottom: Spacing.xxxl, // 32
    borderTopWidth: 0.5,
  },
});
