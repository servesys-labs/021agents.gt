export type AuthMode = "local" | "clerk";

export const AUTH_MODE: AuthMode =
  import.meta.env.VITE_AUTH_PROVIDER === "clerk" ? "clerk" : "local";

export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";

export function isClerkMode(): boolean {
  return AUTH_MODE === "clerk";
}
