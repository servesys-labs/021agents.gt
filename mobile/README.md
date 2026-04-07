# OpenShots Mobile

This folder hosts shared mobile modules for the React Native app.

## Native scaffold status

`mobile/` now includes React Native native runtime files:

- `android/`
- `ios/`
- `index.js`
- `metro.config.js`
- `babel.config.js`
- `app.json`
- `Gemfile`

Identity settings applied:

- App display name: `OpenShots`
- Android package/applicationId: `co.oneshots.mobile`
- iOS bundle identifier: `co.oneshots.mobile`
- iOS test bundle identifier: `co.oneshots.mobile.tests`
- iOS product name: `OpenShots` (target module name and scheme buildable app name)

Note:

- Native iOS project paths and scheme were renamed to `OpenShots` (`ios/OpenShots.xcodeproj`, `ios/OpenShots/`, `ios/OpenShotsTests/`, `OpenShots.xcscheme`).

Run locally:

```bash
cd mobile
npm install
npm run start
npm run ios
# or
npm run android
```

## Local prerequisites checklist

From runtime validation:

- Install CocoaPods (`pod`) for iOS and run `bundle install` / `pod install` in `mobile/ios`.
- Install Android tooling:
  - JDK 17-20
  - Android Studio + Android SDK 35
  - `ANDROID_HOME` configured
  - `adb` on `PATH`
- Start at least one simulator/emulator or attach a device before `npm run ios` / `npm run android`.

## Centralized design tokens

Use generated tokens from `design-tokens/tokens.json`:

- `mobile/src/theme/tokens.ts` (generated)
- `mobile/src/theme/index.ts` (helpers)

```ts
import { getTheme } from "./src/theme";

const theme = getTheme("dark");
const bg = theme.colors.background;
```

## Reused chat interaction model

These modules mirror the same runtime streaming/events and message model used in the Svelte `ui`:

- `mobile/src/chat/types.ts` — event and message contracts
- `mobile/src/chat/streamAgent.ts` — POST + SSE parser for `/api/v1/runtime-proxy/runnable/stream`
- `mobile/src/chat/reducer.ts` — state reducer for token/thinking/tool events
- `mobile/src/chat/useAgentChat.ts` — hook for send/stop/clear and stream wiring
- `mobile/src/components/chat/*` — tokenized chat UI primitives (`ChatComposer`, `ChatMessageItem`, `ToolCallCard`)
- `mobile/src/screens/ChatScreen.tsx` — ready-to-drop container screen (agent picker + streaming list + composer)

## Integration notes

- Use `useAgentChat(...)` in your screen container and feed `messages` into a `FlatList`.
- Pass `mode` (`light` or `dark`) into chat components so styles always resolve from centralized tokens.
- Keep event handling in `reducer.ts` as the single behavior source to ensure parity across all pages.
- `ChatScreen` expects `baseUrl` and `token` props; wire it from your auth/session layer in the RN app shell.

## Smoke test flow

Run this sequence before release:

1. Login with valid credentials (`/api/v1/auth/login`) and verify `/api/v1/auth/me` hydration.
2. Open Chat, select an agent, send a prompt, observe streamed tokens and tool calls.
3. Stop a running stream and verify UI exits streaming mode.
4. Open Sessions and inspect turns for a recent session.
5. Open Meta-agent and run one management prompt.
6. Open Eval, trigger a run, and load run details.
7. Open Releases, fetch channels, run promote/rollback actions in non-prod org.
8. Open Settings and verify diagnostics + org/billing snapshots.

## Permission-aware UI

Tabs are hidden when JWT scopes do not include the required capability:

- `sessions` -> `sessions:read`
- `meta` -> `agents:write`
- `eval` -> `eval:read`
- `releases` -> `releases:read`
