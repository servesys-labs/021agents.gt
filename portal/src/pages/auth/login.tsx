import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isCfAccessMode } from "../../auth/config";

function CfAccessLoginPage() {
  useEffect(() => {
    // CF Access handles the login UI — redirect to root so CF Access can intercept
    window.location.href = "/";
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base">
      <div className="text-text-muted text-sm">Redirecting to sign-in...</div>
    </div>
  );
}

function LocalLoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Already authenticated — redirect
  if (isAuthenticated) {
    navigate("/", { replace: true });
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-[var(--space-6)]">
      <div className="card w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-[var(--space-8)]">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent-muted mb-[var(--space-4)]">
            <span className="text-accent font-bold text-[var(--text-xl)]">O</span>
          </div>
          <h1 className="text-[var(--text-xl)] font-bold text-text-primary">
            Sign in to AgentOS
          </h1>
          <p className="mt-[var(--space-2)] text-[var(--text-sm)] text-text-muted">
            Agent infrastructure platform
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-[var(--space-4)] p-[var(--space-3)] rounded-lg bg-status-error/10 border border-status-error/20 text-[var(--text-sm)] text-status-error">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-[var(--space-4)]">
          <div>
            <label
              htmlFor="login-email"
              className="block text-[var(--text-sm)] text-text-secondary mb-[var(--space-1)]"
            >
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoComplete="email"
              autoFocus
              minLength={1}
            />
          </div>
          <div>
            <label
              htmlFor="login-password"
              className="block text-[var(--text-sm)] text-text-secondary mb-[var(--space-1)]"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              autoComplete="current-password"
              minLength={8}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary w-full min-h-[var(--touch-target-min)]"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        {/* Signup link */}
        <p className="text-center mt-[var(--space-6)] text-[var(--text-sm)] text-text-muted">
          Don&apos;t have an account?{" "}
          <Link to="/signup" className="text-accent hover:text-accent-hover transition-colors">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

export function LoginPage() {
  return isCfAccessMode() ? <CfAccessLoginPage /> : <LocalLoginPage />;
}
