/**
 * Theme Tokens Template — Expo SDK 54 / React Native 0.81
 *
 * Usage: Copy this file to src/lib/theme.ts and customize colors for your brand.
 *
 * Design Philosophy:
 * - Dark mode: Pure black (#000000) with neon accent colors (Apple Fitness inspired)
 * - Light mode: System gray (#F2F2F7) with muted accent variants
 * - Both modes share the same token names for seamless switching
 *
 * Typography: Space Grotesk (display/headings) + DM Sans (body/UI)
 * Install: npm install @expo-google-fonts/space-grotesk @expo-google-fonts/dm-sans
 *
 * IMPORTANT: ThemeColors MUST be a union type for React 19 compatibility.
 * Using only `typeof Colors.dark` will cause TypeScript errors when
 * accessing Colors[mode] where mode can be 'light'.
 */

export const Colors = {
  dark: {
    // Backgrounds
    bg: '#000000',           // Pure black — main background
    surface: '#1C1C1E',     // Elevated surface (cards, inputs)
    surface2: '#2C2C2E',    // Secondary surface (avatars, chips)
    surface3: '#3A3A3C',    // Tertiary surface (pressed states)

    // Text
    text: '#FFFFFF',         // Primary text
    textSecondary: '#8E8E93', // Secondary/muted text

    // Borders & Separators
    border: '#38383A',
    separator: '#38383A',

    // Accent Colors — neon palette
    accentGreen: '#30D158',  // Primary action (CTAs, active states)
    accentCyan: '#64D2FF',   // Secondary accent (links, info)
    accentPink: '#FF375F',   // Destructive/alert
    accentOrange: '#FF9F0A', // Warning/pending
    accentPurple: '#BF5AF2', // Special/premium

    // Gradients
    gradientStart: '#30D158',
    gradientEnd: '#64D2FF',

    // Semantic
    cardBg: '#1C1C1E',
    tabBarBg: '#000000',
    inputBg: '#1C1C1E',
  },

  light: {
    // Backgrounds
    bg: '#F2F2F7',           // System gray — main background
    surface: '#FFFFFF',      // White surface
    surface2: '#E5E5EA',     // Secondary surface
    surface3: '#D1D1D6',     // Tertiary surface

    // Text
    text: '#000000',         // Primary text
    textSecondary: '#6C6C70', // Secondary/muted text

    // Borders & Separators
    border: '#C6C6C8',
    separator: '#C6C6C8',

    // Accent Colors — muted variants for light backgrounds
    accentGreen: '#248A3D',
    accentCyan: '#0071A4',
    accentPink: '#D70015',
    accentOrange: '#C93400',
    accentPurple: '#8944AB',

    // Gradients
    gradientStart: '#248A3D',
    gradientEnd: '#0071A4',

    // Semantic
    cardBg: '#FFFFFF',
    tabBarBg: '#F2F2F7',
    inputBg: '#FFFFFF',
  },
} as const;

// CRITICAL: Must be union type for React 19 / TypeScript 5.x compatibility
export type ThemeColors = typeof Colors.dark | typeof Colors.light;
export type ThemeMode = 'dark' | 'light';

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const BorderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  full: 9999,
} as const;

export const FontSize = {
  xs: 11,    // Labels, captions
  sm: 13,    // Secondary text
  md: 15,    // Body text
  lg: 17,    // Titles, buttons
  xl: 20,    // Section headers
  xxl: 24,   // Screen titles
  xxxl: 34,  // Hero text
  display: 48, // Splash/onboarding
} as const;

export const FontFamily = {
  // Display — Space Grotesk (headings, titles, numbers)
  display: 'SpaceGrotesk_700Bold',
  displayMedium: 'SpaceGrotesk_500Medium',

  // Body — DM Sans (paragraphs, buttons, labels)
  body: 'DMSans_400Regular',
  bodyMedium: 'DMSans_500Medium',
  bodySemiBold: 'DMSans_700Bold',  // Note: DMSans_600SemiBold was removed
  bodyBold: 'DMSans_700Bold',
} as const;
