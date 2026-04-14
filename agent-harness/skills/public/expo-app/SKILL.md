---
name: expo-app
description: "Build production-quality React Native mobile apps with Expo SDK 54+. Covers project scaffolding, React Navigation, dual-theme systems, shared components, TypeScript patterns, and SDK migration (52→54). Use when building any Expo/React Native mobile app."
when_to_use: "When the user asks to build a mobile app, React Native app, Expo app, or any iOS/Android application."
category: development
version: 2.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - write-file
  - edit-file
  - execute-code
  - web-search
  - expose_preview
  - start_process
  - create_checkpoint
  - deploy_to_pages
  - github_create_repo
  - github_create_pr
---

# Expo React Native App Builder

Build production-quality mobile apps with Expo SDK 54 (React 19, React Native 0.81). These patterns come from building production apps and cover every gotcha that wastes hours.

## Phase 1: Project Initialization

### 1.1 Scaffold

```bash
cd /workspace
npx create-expo-app@latest my-app --template blank-typescript
cd my-app
```

**Entry point** — must be in `package.json`:
```json
{ "main": "node_modules/expo/AppEntry.js" }
```

> Do NOT use `"main": "expo-router/entry"` unless actually using file-based routing. Wrong entry = blank white screen, no error.

### 1.2 Path Aliases

**tsconfig.json:**
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": { "strict": true, "baseUrl": ".", "paths": { "@/*": ["src/*"] } }
}
```

In SDK 54, `babel-preset-expo` handles `@/` resolution automatically. No `babel-plugin-module-resolver` needed.

### 1.3 Directory Structure

```
my-app/
├── App.tsx                  # Font loading, providers, root
├── app.json                 # Expo config
├── src/
│   ├── components/          # Shared: Avatar, PrimaryButton, ScreenHeader
│   ├── contexts/            # ThemeContext, AuthContext
│   ├── lib/                 # theme.ts (tokens), mockData.ts
│   ├── navigation/          # AppNavigator.tsx (Stack + Tab)
│   └── screens/             # One file per screen
```

## Phase 2: Dependencies

Install all at once — these are the tested SDK 54 compatible versions:

```bash
npx expo install expo-font expo-splash-screen expo-status-bar expo-linear-gradient expo-haptics react-native-gesture-handler react-native-reanimated react-native-safe-area-context react-native-screens react-native-svg @expo/vector-icons

npm install @react-navigation/native @react-navigation/native-stack @react-navigation/bottom-tabs
```

> Always use `npx expo install` for Expo-managed packages (`~` ranges). Use `npm install` for community packages.

See `references/sdk54_dependency_matrix.md` for the full version matrix.

### app.json

```json
{
  "expo": {
    "name": "MyApp",
    "slug": "my-app",
    "version": "1.0.0",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "splash": { "backgroundColor": "#000000", "resizeMode": "contain" },
    "ios": { "supportsTablet": false, "bundleIdentifier": "com.company.myapp" },
    "android": { "adaptiveIcon": { "backgroundColor": "#000000" }, "package": "com.company.myapp" },
    "plugins": ["expo-font"],
    "scheme": "myapp"
  }
}
```

> **SDK 54 breaking:** `expo-haptics` no longer ships a config plugin. Remove from `plugins` array or build fails.

## Phase 3: Theme System

Use the template at `templates/theme_tokens.ts` as starting point. Customize colors for the user's brand.

### Design Tokens (`src/lib/theme.ts`)

Single source of truth: `Colors` (dark/light), `Spacing`, `BorderRadius`, `FontSize`, `FontFamily`.

> **React 19 type fix:** `ThemeColors` MUST be union type: `typeof Colors.dark | typeof Colors.light`. Using only one branch causes TS errors with `Colors[mode]`.

> **Font fix:** `DMSans_600SemiBold` was removed. Use `DMSans_700Bold` as replacement.

### ThemeContext

Provides `mode`, `colors`, `toggleTheme()`, `setTheme()`, `isDark`. Wrap entire app in `<ThemeProvider>`.

**Provider ordering:** `ThemeProvider` wraps `NavigationContainer` (nav theme depends on theme context).

Map tokens to React Navigation theme: `primary`, `background`, `card`, `text`, `border`, `notification`.

## Phase 4: Navigation

### Type-Safe Navigation

Define `RootStackParamList` with every screen. Add backward-compatibility aliases:

```typescript
export type RootStackParamList = {
  Splash: undefined;
  MainTabs: undefined;
  SendGift: undefined;
  SignIn: undefined;    // alias → LoginScreen
};
```

### Stack + Bottom Tab Pattern

Nest `BottomTabNavigator` inside `StackNavigator`. Feature screens push on top of tabs. For prominent center action, use `tabBarButton` with custom floating button.

## Phase 5: Shared Components

### PrimaryButton

Accept multiple prop names: `title`, `label`, `text`. Resolve as `title ?? label ?? textProp`. Supports `variant` (primary/secondary/outline), `loading`, `disabled`, `icon`.

### ScreenHeader

Height 52px, padding 20px horizontal, back icon `arrow-back` size 22, left/right slots 40px.

### Avatar

Initials-based (no external URLs). Support `gradient` prop for accent backgrounds.

Use the template at `templates/screen_template.tsx` for consistent screen structure.

## Phase 6: UI Consistency Standards

| Element | Value | Notes |
|---------|-------|-------|
| Status bar spacer | `height: 48` | Below SafeAreaView |
| Screen header | `height: 52` | `paddingHorizontal: 20` |
| Content padding | `paddingHorizontal: 24` | Standard body |
| CTA button height | `height: 52` | `borderRadius: 16` |
| Card border radius | `borderRadius: 16` | Standard cards |
| Bottom tab height | `height: 85` | `paddingBottom: 28` for home indicator |
| Section labels | `uppercase`, `letterSpacing: 2` | Category headers |

## Phase 7: SDK Migration (52 → 54)

| Change | SDK 52 | SDK 54 | Impact |
|--------|--------|--------|--------|
| React | 18.3.1 | 19.1.0 | Type defs changed |
| React Native | 0.76.6 | 0.81.5 | New Arch default |
| Entry point | `expo-router/entry` | `AppEntry.js` | White screen if wrong |
| `expo-haptics` plugin | Required | Removed | Build fail if present |
| `DMSans_600SemiBold` | Available | Removed | Import error |

### React 19 TypeScript Fixes

1. **Implicit `children` removed** — must declare `children: ReactNode`
2. **Event handler types changed** — `TextInput.onFocus` `.clear()` needs cast
3. **Image source strictness** — string URIs → `{ uri: string }`
4. **Callback params** — must add explicit types
5. **Navigation casting** — dynamic targets need `as any`
6. **Ionicons typing** — use `keyof typeof Ionicons.glyphMap`

### Migration Checklist

1. Update `package.json` main to `node_modules/expo/AppEntry.js`
2. `npx expo install --fix`
3. Update `@types/react` to `~19.1.10`
4. Remove `expo-haptics` from plugins
5. Replace `DMSans_600SemiBold` → `DMSans_700Bold`
6. Fix `ThemeColors` union type
7. Add explicit types to callbacks
8. Wrap string image URIs in `{ uri: ... }`
9. `npx tsc --noEmit` and fix all errors
10. Test on iOS and Android simulators

## Phase 8: Build & Preview

```bash
npx expo start          # Dev server
npx expo start --ios    # iOS simulator
npx expo start --android # Android emulator
npx tsc --noEmit        # Type check
npx expo start --clear  # Clear cache
```

After starting the dev server, use `expose_preview` to share the Expo DevTools URL with the user.

## Phase 9: Deploy

For web builds (Expo Web):
```bash
npx expo export --platform web
# Then deploy with deploy_to_pages
```

For native builds:
```bash
npx eas build --platform ios --profile preview
npx eas build --platform android --profile preview
```

## Resources

- `references/sdk54_dependency_matrix.md` — Full version matrix
- `templates/screen_template.tsx` — Standard screen component
- `templates/theme_tokens.ts` — Theme tokens with dark/light modes
