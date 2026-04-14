# Expo SDK 54 Dependency Matrix

## Core Framework Versions

| Package | SDK 52 Version | SDK 54 Version | Migration Notes |
|---------|---------------|---------------|-----------------|
| `expo` | `~52.0.0` | `^54.0.0` | Major upgrade, run `npx expo install --fix` |
| `react` | `18.3.1` | `19.1.0` | React 19 — significant type changes |
| `react-native` | `0.76.6` | `0.81.5` | New Architecture enabled by default |
| `@types/react` | `~18.3.12` | `~19.1.10` | Must match React version |
| `typescript` | `^5.3.0` | `^5.3.0` | No change required |
| `babel-preset-expo` | (bundled) | `~54.0.10` | Now an explicit dependency |
| `@babel/core` | `^7.25.2` | `^7.25.2` | No change required |

## Navigation

| Package | SDK 52 Version | SDK 54 Version | Migration Notes |
|---------|---------------|---------------|-----------------|
| `@react-navigation/native` | `^7.0.0` | `^7.0.0` | Compatible across both |
| `@react-navigation/native-stack` | `^7.2.0` | `^7.2.0` | Compatible across both |
| `@react-navigation/bottom-tabs` | `^7.2.0` | `^7.2.0` | Compatible across both |
| `react-native-screens` | `~4.4.0` | `~4.16.0` | Use `npx expo install` |
| `react-native-safe-area-context` | `4.12.0` | `~5.6.0` | Major version bump |
| `react-native-gesture-handler` | `~2.20.0` | `~2.28.0` | Use `npx expo install` |

## Animation & Graphics

| Package | SDK 52 Version | SDK 54 Version | Migration Notes |
|---------|---------------|---------------|-----------------|
| `react-native-reanimated` | `~3.16.0` | `~4.1.1` | Major version bump, plugin API changes |
| `react-native-svg` | `15.8.0` | `15.12.1` | Minor update |
| `expo-linear-gradient` | `~14.0.0` | `~15.0.8` | Use `npx expo install` |

## Expo Modules

| Package | SDK 52 Version | SDK 54 Version | Migration Notes |
|---------|---------------|---------------|-----------------|
| `expo-font` | `~13.0.0` | `~14.0.11` | Use `npx expo install` |
| `expo-splash-screen` | `~0.29.0` | `~31.0.13` | Massive version jump (0.x → 31.x) |
| `expo-status-bar` | `~2.0.0` | `~3.0.9` | Use `npx expo install` |
| `expo-haptics` | `~14.0.0` | `~15.0.8` | **Config plugin removed** — remove from app.json plugins |
| `@expo/vector-icons` | `^14.0.0` | `^15.0.3` | Minor API changes |

## Fonts

| Package | SDK 52 Version | SDK 54 Version | Migration Notes |
|---------|---------------|---------------|-----------------|
| `@expo-google-fonts/space-grotesk` | `^0.2.3` | `^0.2.3` | No change |
| `@expo-google-fonts/dm-sans` | `^0.2.3` | `^0.2.3` | **`DMSans_600SemiBold` removed** — use `DMSans_700Bold` |

## Breaking Changes Requiring Code Fixes

### 1. Entry Point Change
```json
// SDK 52
{ "main": "expo-router/entry" }

// SDK 54
{ "main": "node_modules/expo/AppEntry.js" }
```

### 2. expo-haptics Plugin Removal
```json
// SDK 52 app.json
{ "plugins": ["expo-font", "expo-haptics"] }

// SDK 54 app.json
{ "plugins": ["expo-font"] }
```

### 3. Font Weight Removal
```typescript
// SDK 52
import { DMSans_600SemiBold } from '@expo-google-fonts/dm-sans';

// SDK 54
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans';
// Use DMSans_700Bold wherever DMSans_600SemiBold was used
```

### 4. ThemeColors Type Fix
```typescript
// SDK 52 (worked because only dark was used)
export type ThemeColors = typeof Colors.dark;

// SDK 54 (required for proper type inference)
export type ThemeColors = typeof Colors.dark | typeof Colors.light;
```

### 5. React 19 Type Changes (see SKILL.md Phase 7.2 for full list)
- Implicit `children` prop removed from `React.FC`
- `TextInput.onFocus` event handler types changed
- `Image` source prop requires `{ uri: string }` for URLs
- Callback parameters require explicit types
- `Ionicons` glyph names need `keyof typeof Ionicons.glyphMap`

## Upgrade Command Sequence

```bash
# 1. Update Expo CLI
npm install -g expo-cli@latest

# 2. Upgrade SDK
npx expo install expo@^54.0.0

# 3. Auto-fix compatible versions
npx expo install --fix

# 4. Update React types
npm install --save-dev @types/react@~19.1.10

# 5. Add explicit babel preset
npm install babel-preset-expo@~54.0.10

# 6. Fix app.json (remove expo-haptics from plugins)
# 7. Fix code (see Migration Checklist in SKILL.md)

# 8. Verify
npx tsc --noEmit
npx expo start --clear
```
