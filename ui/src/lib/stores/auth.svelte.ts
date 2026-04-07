import { api } from "$lib/services/api";

export interface User {
  email: string;
  org_id: string;
  user_id: string;
}

class AuthStore {
  token = $state<string | null>(null);
  user = $state<User | null>(null);
  loading = $state(true);

  isAuthenticated = $derived(!!this.token && !!this.user);

  async init() {
    this.loading = true;
    const stored = api.token;
    if (!stored) {
      this.loading = false;
      return;
    }

    this.token = stored;
    try {
      const me = await api.get<{ email: string; org_id: string; user_id: string }>("/auth/me");
      this.user = me;
    } catch {
      this.token = null;
      api.token = null;
      this.user = null;
    } finally {
      this.loading = false;
    }
  }

  async login(email: string, password: string) {
    const data = await api.login(email, password);
    this.token = data.token;
    this.user = data.user;
  }

  logout() {
    this.token = null;
    this.user = null;
    api.token = null;
    if (typeof window !== "undefined") window.location.href = "/login";
  }
}

export const authStore = new AuthStore();
