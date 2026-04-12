/**
 * Auth barrel export.
 */
export { createToken, verifyToken } from "./jwt";

export { hashPassword, verifyPassword } from "./password";
export { generateApiKey, hashApiKey } from "./api-keys";
export type { CurrentUser, TokenClaims } from "./types";
export { hasScope, hasRole, ROLE_HIERARCHY, ALL_SCOPES } from "./types";
