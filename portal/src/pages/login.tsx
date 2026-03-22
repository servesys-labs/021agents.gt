import { useLogin, useRegister } from "@refinedev/core";
import { useEffect, useState } from "react";
import { Card, TextInput, Button, Text } from "@tremor/react";
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">AgentOS</h1>
          <Text className="text-gray-500">Agent Control Plane</Text>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {expiryMessage ? <Text className="text-amber-600">{expiryMessage}</Text> : null}
          {isRegister && (
            <div>
              <Text className="mb-1">Name</Text>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </div>
          )}
          <div>
            <Text className="mb-1">Email</Text>
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
          </div>
          <div>
            <Text className="mb-1">Password</Text>
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>
          <Button type="submit" className="w-full" loading={loginLoading || registerLoading}>
            {isRegister ? "Create Account" : "Sign In"}
          </Button>
        </form>

        <div className="text-center mt-4">
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="text-sm text-blue-600 hover:underline"
          >
            {isRegister ? "Already have an account? Sign in" : "Don't have an account? Register"}
          </button>
        </div>
      </Card>
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <Card className="w-full max-w-md">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold">AgentOS</h1>
          <Text className="text-gray-500">Sign in with Clerk</Text>
        </div>
        <SignedOut>
          <SignIn routing="hash" />
        </SignedOut>
        <SignedIn>
          <Text>{syncing ? "Completing sign in..." : "Signed in with Clerk."}</Text>
        </SignedIn>
        {expiryMessage ? <Text className="mt-2 text-amber-600">{expiryMessage}</Text> : null}
        {error ? <Text className="mt-2 text-red-600">{error}</Text> : null}
      </Card>
    </div>
  );
};
