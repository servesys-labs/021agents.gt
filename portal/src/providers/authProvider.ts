import type { AuthProvider } from "@refinedev/core";

const API_URL = "/api/v1";

export const authProvider: AuthProvider = {
  login: async ({ email, password }) => {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      const data = await response.json();
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data));
      return { success: true, redirectTo: "/" };
    }

    return { success: false, error: { name: "Login Failed", message: "Invalid credentials" } };
  },

  register: async ({ email, password, name }) => {
    const response = await fetch(`${API_URL}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });

    if (response.ok) {
      const data = await response.json();
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data));
      return { success: true, redirectTo: "/" };
    }

    return { success: false, error: { name: "Register Failed", message: "Could not create account" } };
  },

  logout: async () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    return { success: true, redirectTo: "/login" };
  },

  check: async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      return { authenticated: false, redirectTo: "/login" };
    }
    return { authenticated: true };
  },

  getIdentity: async () => {
    const token = localStorage.getItem("token");
    if (!token) return null;

    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const user = await response.json();
        return { id: user.user_id, name: user.name || user.email, email: user.email };
      }
    } catch {}
    return null;
  },

  getPermissions: async () => {
    const user = localStorage.getItem("user");
    if (user) {
      return JSON.parse(user).role || "member";
    }
    return null;
  },

  onError: async (error) => {
    if (error.status === 401) {
      return { logout: true };
    }
    return { error };
  },
};
