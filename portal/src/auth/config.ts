export type AuthMode = "local" | "cf_access";

export const AUTH_MODE: AuthMode =
  import.meta.env.VITE_AUTH_PROVIDER === "cf_access" ? "cf_access" : "local";

export const CF_ACCESS_TEAM_DOMAIN = import.meta.env.VITE_CF_ACCESS_TEAM_DOMAIN ?? "";

export function isCfAccessMode(): boolean {
  return AUTH_MODE === "cf_access";
}
