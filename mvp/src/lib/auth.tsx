import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "./api";

interface User {
  user_id: string;
  email: string;
  name: string;
  org_id: string;
  onboarding_complete?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string, referralCode?: string) => Promise<void>;
  logout: () => void;
  setUser: (u: User) => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  login: async () => {},
  signup: async () => {},
  logout: () => {},
  setUser: () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("agentos_token");
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get<User>("/auth/me")
      .then(setUser)
      .catch(() => localStorage.removeItem("agentos_token"))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user_id: string; email: string; org_id: string }>("/auth/login", {
      email,
      password,
    });
    localStorage.setItem("agentos_token", res.token);
    setUser({ user_id: res.user_id, email: res.email, name: "", org_id: res.org_id });
  }, []);

  const signup = useCallback(async (email: string, password: string, name: string, referralCode?: string) => {
    const res = await api.post<{ token: string; user_id: string; email: string; org_id: string }>("/auth/signup", {
      email,
      password,
      name,
      ...(referralCode ? { referral_code: referralCode } : {}),
    });
    localStorage.setItem("agentos_token", res.token);
    setUser({ user_id: res.user_id, email: res.email, name, org_id: res.org_id, onboarding_complete: false });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("agentos_token");
    setUser(null);
    api.post("/auth/logout").catch(() => {});
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
