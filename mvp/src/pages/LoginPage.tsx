import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { PRODUCT } from "../lib/product";
import { Bot, CheckCircle, Loader2 } from "lucide-react";

export default function LoginPage() {
  const params = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<"login" | "signup" | "reset" | "new-password">(
    params.get("mode") === "signup" ? "signup" :
    params.get("reset_token") ? "new-password" :
    params.get("forgot") !== null ? "reset" : "login"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState(params.get("ref") || "");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, signup } = useAuth();
  const navigate = useNavigate();

  // Handle email verification on load
  useEffect(() => {
    const verifyToken = params.get("verify_token");
    if (verifyToken) {
      api.post("/auth/verify-email", { token: verifyToken })
        .then(() => setSuccess("Email verified! You can now sign in."))
        .catch(() => setError("Verification link expired or invalid."));
      window.history.replaceState({}, "", "/login");
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);

    try {
      if (mode === "login") {
        await login(email, password);
        // Skip onboarding — go straight to assistant
        navigate("/dashboard");
      } else if (mode === "signup") {
        await signup(email, password, name, inviteCode || undefined);
        navigate("/dashboard");
      } else if (mode === "reset") {
        await api.post("/auth/forgot-password", { email });
        setSuccess("If that email exists, a reset link has been sent. Check your inbox.");
      } else if (mode === "new-password") {
        if (password !== confirmPassword) {
          setError("Passwords don't match");
          setLoading(false);
          return;
        }
        const resetToken = params.get("reset_token") || "";
        await api.post("/auth/reset-password", { token: resetToken, password });
        setSuccess("Password reset! You can now sign in.");
        setMode("login");
        window.history.replaceState({}, "", "/login");
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2.5 mb-2">
            <div className="w-9 h-9 bg-primary rounded-xl flex items-center justify-center">
              <Bot size={18} className="text-white" />
            </div>
            <span className="text-xl font-semibold text-text">{PRODUCT.name}</span>
          </div>
          <p className="text-sm text-text-secondary mt-2 max-w-xs mx-auto leading-relaxed">
            {mode === "signup" ? "Create your account — $5 free credits included" :
             mode === "reset" ? "Reset your password" :
             mode === "new-password" ? "Set a new password" :
             PRODUCT.editionTagline}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-border p-6 shadow-lg overflow-hidden relative">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-primary to-blue-400" />

          {/* Tabs (only for login/signup) */}
          {(mode === "login" || mode === "signup") && (
            <div className="flex gap-1 bg-surface-alt rounded-lg p-1 mb-6">
              <button
                onClick={() => { setMode("login"); setError(""); setSuccess(""); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  mode === "login" ? "bg-white text-text shadow-sm" : "text-text-secondary"
                }`}
              >
                Sign in
              </button>
              <button
                onClick={() => { setMode("signup"); setError(""); setSuccess(""); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  mode === "signup" ? "bg-white text-text shadow-sm" : "text-text-secondary"
                }`}
              >
                Create account
              </button>
            </div>
          )}

          {/* Back to login link for reset modes */}
          {(mode === "reset" || mode === "new-password") && (
            <button
              onClick={() => { setMode("login"); setError(""); setSuccess(""); }}
              className="text-xs text-primary hover:underline mb-4 block"
            >
              Back to sign in
            </button>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <>
                <Input
                  label="Invite code"
                  placeholder="Enter your invite code"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  required
                />
                <Input
                  label="Name"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </>
            )}

            {mode !== "new-password" && (
              <Input
                label="Email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}

            {(mode === "login" || mode === "signup") && (
              <Input
                label="Password"
                type="password"
                placeholder={mode === "signup" ? "Min 8 characters" : "Your password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "signup" ? 8 : undefined}
              />
            )}

            {mode === "new-password" && (
              <>
                <Input
                  label="New password"
                  type="password"
                  placeholder="Min 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
                <Input
                  label="Confirm password"
                  type="password"
                  placeholder="Repeat password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </>
            )}

            {success && (
              <p className="text-sm text-green-700 bg-green-50 px-3 py-2 rounded-lg flex items-center gap-2">
                <CheckCircle size={14} /> {success}
              </p>
            )}
            {error && (
              <p className="text-sm text-danger bg-red-50 px-3 py-2 rounded-lg">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <><Loader2 size={14} className="animate-spin" /> Please wait...</> :
               mode === "login" ? "Sign in" :
               mode === "signup" ? "Create account" :
               mode === "reset" ? "Send reset link" :
               "Set new password"}
            </Button>

            {mode === "login" && (
              <button
                type="button"
                onClick={() => { setMode("reset"); setError(""); setSuccess(""); }}
                className="text-xs text-text-secondary hover:text-primary w-full text-center"
              >
                Forgot password?
              </button>
            )}
          </form>
        </div>

        <p className="text-center text-xs text-text-muted mt-6">
          By continuing, you agree to our Terms of Service.
        </p>
      </div>
    </div>
  );
}
