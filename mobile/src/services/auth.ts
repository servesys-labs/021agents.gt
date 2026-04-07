import { apiRequest } from "./api";

export interface AuthUser {
  user_id: string;
  email: string;
  name: string;
  org_id: string;
  role?: string;
  scopes?: string[];
}

export interface LoginResponse {
  token: string;
  user_id: string;
  email: string;
  org_id: string;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function me(token: string): Promise<AuthUser> {
  return apiRequest<AuthUser>("/api/v1/auth/me", { method: "GET" }, token);
}

