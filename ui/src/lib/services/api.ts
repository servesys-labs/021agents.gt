const TOKEN_KEY = "oneshots_token";

export class ApiClient {
  baseUrl: string;

  constructor(baseUrl = "https://api.oneshots.co/api/v1") {
    this.baseUrl = baseUrl;
  }

  get token(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(TOKEN_KEY);
  }

  set token(value: string | null) {
    if (typeof window === "undefined") return;
    if (value) {
      localStorage.setItem(TOKEN_KEY, value);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  private headers(): HeadersInit {
    const h: HeadersInit = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      this.token = null;
      if (typeof window !== "undefined") window.location.href = "/login";
      throw new Error("Unauthorized");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async signup(name: string, email: string, password: string, invite_code?: string): Promise<{ token: string; user: { email: string; org_id: string; user_id: string } }> {
    const data = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/signup",
      { name, email, password, ...(invite_code ? { referral_code: invite_code } : {}) }
    );
    this.token = data.token as string;
    return {
      token: data.token as string,
      user: {
        email: (data.email as string) || email,
        org_id: (data.org_id as string) || "",
        user_id: (data.user_id as string) || "",
      },
    };
  }

  async login(email: string, password: string): Promise<{ token: string; user: { email: string; org_id: string; user_id: string } }> {
    const data = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/login",
      { email, password }
    );
    this.token = data.token as string;
    // API returns flat { token, user_id, email, org_id } — normalize to nested shape
    return {
      token: data.token as string,
      user: {
        email: (data.email as string) || "",
        org_id: (data.org_id as string) || "",
        user_id: (data.user_id as string) || "",
      },
    };
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }

  del(path: string) {
    return this.request<void>("DELETE", path);
  }

  createAgentFromDescription(description: string, plan: string) {
    return this.post<{ agent: { name: string } }>("/agents/create-from-description", { description, plan });
  }

  getAgentDetail(name: string) {
    return this.get<Record<string, unknown>>(`/agents/${encodeURIComponent(name)}`);
  }

  updateAgent(name: string, config: Record<string, unknown>) {
    return this.put<{ agent: Record<string, unknown> }>(`/agents/${encodeURIComponent(name)}`, config);
  }

  deleteAgent(name: string) {
    return this.del(`/agents/${encodeURIComponent(name)}`);
  }
}

export const api = new ApiClient();
