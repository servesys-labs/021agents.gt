import { tokens, type ThemeMode } from "./tokens";

export { tokens };
export type { ThemeMode };

export function getTheme(mode: ThemeMode) {
  return tokens[mode];
}

export function getColor(mode: ThemeMode, key: keyof (typeof tokens)["light"]["colors"]) {
  return tokens[mode].colors[key];
}
