import { useLogin, useRegister } from "@refinedev/core";
import { useEffect, useState } from "react";
import { SignedIn, SignedOut, SignIn, useAuth, useClerk, useUser } from "@clerk/clerk-react";
import { useNavigate } from "react-router-dom";

import { isClerkMode } from "../auth/config";
import { AUTH_EXPIRED_FLAG, CLERK_LOGOUT_FLAG, setAuthSession } from "../auth/tokens";

export const LoginPage = () => {
  return isClerkMode() ? <ClerkLoginPage /> : <LocalLoginPage />;
};

const LocalLoginPage = () => {
  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [expiryMessage] = useState(() => {
    if (sessionStorage.getItem(AUTH_EXPIRED_FLAG) === "1") {
      sessionStorage.removeItem(AUTH_EXPIRED_FLAG);
      return "Your session expired. Please sign in again.";
    }
    return "";
  });

  const loginLoading = "isPending" in loginMutation ? loginMutation.isPending : false;
  const registerLoading = "isPending" in registerMutation ? registerMutation.isPending : false;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRegister) {
      registerMutation.mutate({ email, password, name });
    } else {
      loginMutation.mutate({ email, password });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d0d0d]">
      <div className="card w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-white">oneshots<span className="text-[#ff8c00]">.co</span></h1>
          <span className="text-gray-500 text-sm">Agent Infrastructure Platform</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {expiryMessage ? <span className="text-amber-600">{expiryMessage}</span> : null}
          {isRegister && (
            <div>
              <span className="mb-1">Name</span>
              <input className="input-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </div>
          )}
          <div>
            <span className="mb-1">Email</span>
            <input className="input-field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
          </div>
          <div>
            <span className="mb-1">Password</span>
            <input className="input-field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={loginLoading || registerLoading}>
            {loginLoading || registerLoading ? "Loading..." : isRegister ? "Create Account" : "Sign In"}
          </button>
        </form>

        <div className="text-center mt-4">
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="text-sm text-[#ff8c00] hover:text-[#ffa940] hover:underline"
          >
            {isRegister ? "Already have an account? Sign in" : "Don't have an account? Register"}
          </button>
        </div>
      </div>
    </div>
  );
};

const ClerkLoginPage = () => {
  const navigate = useNavigate();
  const clerk = useClerk();
  const { getToken } = useAuth();
  const { user } = useUser();
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [expiryMessage] = useState(() => {
    if (sessionStorage.getItem(AUTH_EXPIRED_FLAG) === "1") {
      sessionStorage.removeItem(AUTH_EXPIRED_FLAG);
      return "Your session expired. Please sign in again.";
    }
    return "";
  });

  useEffect(() => {
    const run = async () => {
      if (sessionStorage.getItem(CLERK_LOGOUT_FLAG) === "1") {
        sessionStorage.removeItem(CLERK_LOGOUT_FLAG);
        await clerk.signOut();
      }
    };
    void run();
  }, [clerk]);

  useEffect(() => {
    const exchange = async () => {
      const clerkToken = await getToken();
      if (!clerkToken) {
        return;
      }
      setSyncing(true);
      setError("");
      try {
        const response = await fetch("/api/v1/auth/clerk/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clerk_token: clerkToken }),
        });
        if (!response.ok) {
          const payload = (await response.json()) as { detail?: string };
          throw new Error(payload.detail ?? "Failed to exchange Clerk token");
        }
        const data = (await response.json()) as { token: string; email: string; user_id: string; org_id: string; provider: string };
        setAuthSession(data.token, {
          email: data.email,
          user_id: data.user_id,
          org_id: data.org_id,
          provider: data.provider,
          name: user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? data.email,
          role: "owner",
        });
        navigate("/");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to complete sign in");
      } finally {
        setSyncing(false);
      }
    };
    void exchange();
  }, [getToken, navigate, user]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d0d0d] p-6">
      <div className="card w-full max-w-md">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-white">oneshots<span className="text-[#ff8c00]">.co</span></h1>
          <span className="text-gray-500 text-sm">Sign in with Clerk</span>
        </div>
        <SignedOut>
          <SignIn routing="hash" />
        </SignedOut>
        <SignedIn>
          <span className="text-gray-400">{syncing ? "Completing sign in..." : "Signed in with Clerk."}</span>
        </SignedIn>
        {expiryMessage ? <span className="mt-2 text-amber-600">{expiryMessage}</span> : null}
        {error ? <span className="mt-2 text-red-600">{error}</span> : null}
      </div>
    </div>
  );
};
