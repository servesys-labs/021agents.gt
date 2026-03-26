/**
 * CLI Configuration management
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".agentos");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");

export interface Config {
  apiUrl: string;
  defaultModel: string;
  templatesDir?: string;
}

export interface AuthConfig {
  token?: string;
  refreshToken?: string;
  userId?: string;
  email?: string;
  expiresAt?: number;
}

const DEFAULT_CONFIG: Config = {
  apiUrl: process.env.AGENTOS_API_URL || "https://api.agentos.dev",
  defaultModel: "claude-sonnet-4-20250514",
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }
  try {
    const data = readFileSync(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function setConfig(config: Partial<Config>): void {
  ensureConfigDir();
  const current = getConfig();
  const updated = { ...current, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
}

export function getAuth(): AuthConfig | null {
  ensureConfigDir();
  if (!existsSync(AUTH_FILE)) {
    return null;
  }
  try {
    const data = readFileSync(AUTH_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function setAuth(auth: AuthConfig | null): void {
  ensureConfigDir();
  if (auth === null) {
    writeFileSync(AUTH_FILE, JSON.stringify({}), { mode: 0o600 });
  } else {
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  }
}

export function isAuthenticated(): boolean {
  const auth = getAuth();
  if (!auth?.token) return false;
  if (auth.expiresAt && auth.expiresAt < Date.now()) return false;
  return true;
}

export function requireAuth(): AuthConfig {
  const auth = getAuth();
  if (!auth?.token) {
    throw new Error("Not authenticated. Run 'agentos login' first.");
  }
  if (auth.expiresAt && auth.expiresAt < Date.now()) {
    throw new Error("Session expired. Run 'agentos login' to re-authenticate.");
  }
  return auth;
}
