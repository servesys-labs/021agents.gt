import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiPost, setStoredToken } from "../../lib/api";
import { isClerkMode } from "../../auth/config";

function ClerkSignupPage() {
  const [ClerkSignUp, setClerkSignUp] = useState<React.ComponentType<any> | null>(null);

  if (!ClerkSignUp) {
    import("@clerk/clerk-react").then((mod) => {
      setClerkSignUp(() => mod.SignUp);
    });
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base">
        <div className="text-text-muted text-sm">Loading authentication...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-[var(--space-6)]">
      <div className="flex flex-col items-center gap-[var(--space-6)]">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent-muted mb-[var(--space-4)]">
            <span className="text-accent font-bold text-[var(--text-xl)]">O</span>
          </div>
          <h1 className="text-[var(--text-xl)] font-bold text-text-primary">
            Create your account
          </h1>
          <p className="mt-[var(--space-2)] text-[var(--text-sm)] text-text-muted">
            Get started with AgentOS
          </p>
        </div>

        <ClerkSignUp
          appearance={{
            elements: {
              rootBox: "w-full max-w-md",
              card: "bg-surface-raised border border-border-default shadow-panel rounded-xl",
              headerTitle: "text-text-primary",
              headerSubtitle: "text-text-secondary",
              formFieldLabel: "text-text-secondary text-sm",
              formFieldInput:
                "bg-surface-overlay border-border-default text-text-primary rounded-lg",
              formButtonPrimary:
                "bg-accent hover:bg-accent-hover text-white rounded-lg min-h-[var(--touch-target-min)]",
              footerActionLink: "text-accent hover:text-accent-hover",
              socialButtonsBlockButton:
                "bg-surface-overlay border-border-default text-text-primary hover:bg-surface-hover rounded-lg",
              dividerLine: "bg-border-default",
              dividerText: "text-text-muted",
            },
          }}
          routing="path"
          path="/signup"
          signInUrl="/login"
          afterSignUpUrl="/"
        />
      </div>
    </div>
  );
}

function LocalSignupPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await apiPost<{ token: string; user_id: string; email: string }>(
        "/api/v1/auth/signup",
        { name, email, password },
      );
      setStoredToken(res.token);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-[var(--space-6)]">
      <div className="card w-full max-w-md">
        <div className="text-center mb-[var(--space-8)]">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent-muted mb-[var(--space-4)]">
            <span className="text-accent font-bold text-[var(--text-xl)]">O</span>
          </div>
          <h1 className="text-[var(--text-xl)] font-bold text-text-primary">
            Create your account
          </h1>
          <p className="mt-[var(--space-2)] text-[var(--text-sm)] text-text-muted">
            Get started with AgentOS
          </p>
        </div>

        {error && (
          <div className="mb-[var(--space-4)] p-[var(--space-3)] rounded-lg bg-status-error/10 border border-status-error/20 text-[var(--text-sm)] text-status-error">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-[var(--space-4)]">
          <div>
            <label htmlFor="signup-name" className="block text-[var(--text-sm)] text-text-secondary mb-[var(--space-1)]">
              Name
            </label>
            <input
              id="signup-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
              autoComplete="name"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="signup-email" className="block text-[var(--text-sm)] text-text-secondary mb-[var(--space-1)]">
              Email
            </label>
            <input
              id="signup-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label htmlFor="signup-password" className="block text-[var(--text-sm)] text-text-secondary mb-[var(--space-1)]">
              Password
            </label>
            <input
              id="signup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a password"
              required
              autoComplete="new-password"
              minLength={8}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary w-full min-h-[var(--touch-target-min)]"
          >
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p className="text-center mt-[var(--space-6)] text-[var(--text-sm)] text-text-muted">
          Already have an account?{" "}
          <Link to="/login" className="text-accent hover:text-accent-hover transition-colors">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export function SignupPage() {
  return isClerkMode() ? <ClerkSignupPage /> : <LocalSignupPage />;
}
