import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isClerkMode } from "../../auth/config";
import {
  Home,
  Bot,
  Brain,
  Bug,
  GitBranch,
  ShieldCheck,
  ShieldAlert,
  Plug,
  Database,
  Sparkles,
  Timer,
  Settings,
  LogOut,
  CreditCard,
  ExternalLink,
  BookOpen,
  Users,
  Code,
  Terminal,
  Wrench,
  Globe,
} from "lucide-react";
import { QuotaWidget } from "../common/QuotaWidget";

/* ── Clerk UserButton (lazy-loaded) ────────────────────────────── */

const isClerk = isClerkMode();

function ClerkUserButton() {
  const [Btn, setBtn] = useState<React.ComponentType<any> | null>(null);
  useEffect(() => {
    if (!isClerk) return;
    import("@clerk/clerk-react").then((mod) => {
      setBtn(() => mod.UserButton);
    });
  }, []);
  if (!Btn) return null;
  return (
    <Btn
      appearance={{
        elements: {
          avatarBox: "w-8 h-8 rounded-lg",
          userButtonPopoverCard: "bg-surface-raised border border-border-default shadow-panel",
        },
      }}
      afterSignOutUrl="/login"
    />
  );
}

/* ── Nav config ─────────────────────────────────────────────────── */

type NavItem = { path: string; label: string; icon: ReactNode };

const iconSize = 18;
const iconStroke = 1.5;

const topNav: NavItem[] = [
  { path: "/", label: "Home", icon: <Home size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/agents", label: "Agents", icon: <Bot size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/intelligence", label: "Intelligence", icon: <Brain size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/issues", label: "Issues", icon: <Bug size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/workflows", label: "Workflows", icon: <GitBranch size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/compliance", label: "Compliance", icon: <ShieldCheck size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/guardrails", label: "Guardrails", icon: <ShieldAlert size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/connectors", label: "Connectors", icon: <Plug size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/pipelines", label: "Pipelines", icon: <Database size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/tools", label: "Tools", icon: <Wrench size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/codemode", label: "Codemode", icon: <Code size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/sandbox", label: "Sandbox", icon: <Terminal size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/skills", label: "Skills", icon: <Sparkles size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/jobs", label: "Jobs", icon: <Timer size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/a2a", label: "A2A", icon: <Globe size={iconSize} strokeWidth={iconStroke} /> },
];

const bottomNav: NavItem[] = [
  { path: "/billing/pricing", label: "Billing", icon: <CreditCard size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/settings", label: "Settings", icon: <Settings size={iconSize} strokeWidth={iconStroke} /> },
];

/* ── Sidebar ────────────────────────────────────────────────────── */

export const Sidebar = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const isCanvasPage = pathname === "/" || pathname === "/canvas";

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/" || pathname === "/canvas";
    return pathname.startsWith(path);
  };

  return (
    <div className="flex h-screen bg-surface-base text-text-primary overflow-hidden">
      {/* Skip to content link - visible on focus for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:outline-none"
      >
        Skip to main content
      </a>

      {/* Icon rail — 52px, icon-only, tooltips on hover */}
      <aside className="flex flex-col w-[52px] flex-shrink-0 bg-surface-raised border-r border-border-subtle">
        {/* Logo */}
        <Link
          to="/"
          className="flex items-center justify-center h-[52px] text-accent font-bold text-lg hover:bg-accent-muted transition-colors"
          aria-label="AgentOS Home"
        >
          O
        </Link>

        {/* Top nav */}
        <nav className="flex flex-col items-center gap-0.5 px-1.5 py-2 flex-1 overflow-y-auto" aria-label="Main navigation">
          {topNav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              aria-current={isActive(item.path) ? "page" : undefined}
              title={item.label}
              className={`relative flex items-center justify-center w-11 h-11 rounded-lg transition-colors group ${
                isActive(item.path)
                  ? "bg-accent-muted text-accent"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
              }`}
            >
              {item.icon}
              {/* Tooltip */}
              <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-surface-overlay text-text-primary text-[11px] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 shadow-dropdown border border-border-default">
                {item.label}
              </span>
            </Link>
          ))}
        </nav>

        {/* Bottom nav + user */}
        <div className="flex flex-col items-center gap-1 px-1.5 pb-2">
          {bottomNav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              title={item.label}
              className={`relative flex items-center justify-center w-11 h-11 rounded-lg transition-colors group ${
                isActive(item.path)
                  ? "bg-accent-muted text-accent"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
              }`}
            >
              {item.icon}
              <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-surface-overlay text-text-primary text-[11px] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 shadow-dropdown border border-border-default">
                {item.label}
              </span>
            </Link>
          ))}

          {/* Quota usage indicator */}
          <QuotaWidget />

          {/* User avatar / menu */}
          <div className="relative mt-1">
            {isClerk ? (
              <ClerkUserButton />
            ) : (
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center justify-center w-11 h-11 rounded-lg bg-accent/20 text-accent text-xs font-bold hover:bg-accent/30 transition-colors"
                aria-label={`Account menu for ${user?.email || "user"}`}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                {(user?.name || user?.email || "U").charAt(0).toUpperCase()}
              </button>
            )}

            {/* User popover (local auth only) */}
            {!isClerk && userMenuOpen && (
              <>
                <div className="fixed inset-0 z-50" onClick={() => setUserMenuOpen(false)} aria-hidden="true" />
                <div
                  className="absolute bottom-0 left-full ml-2 z-50 w-56 rounded-xl shadow-2xl overflow-hidden bg-surface-raised border border-border-default"
                  role="menu"
                  aria-label="User menu"
                >
                  <div className="p-3 border-b border-border-default">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center text-accent text-sm font-bold">
                        {(user?.name || "U").charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-text-primary truncate">
                          {user?.name || "User"}
                        </p>
                        <p className="text-[10px] text-text-muted truncate">
                          {user?.email || ""}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="py-1">
                    <Link to="/settings" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors">
                      <Users size={12} /> Team Settings
                    </Link>
                    <Link to="/settings?tab=billing" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors">
                      <CreditCard size={12} /> Billing & Usage
                    </Link>
                    <a href="https://github.com/eprasad7/one-shot" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors">
                      <ExternalLink size={12} /> GitHub
                    </a>
                    <a href="https://oneshots.co/docs" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors">
                      <BookOpen size={12} /> Documentation
                    </a>
                  </div>
                  <div className="border-t border-border-default py-1">
                    <button
                      onClick={() => { setUserMenuOpen(false); logout(); }}
                      className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-status-error hover:bg-surface-overlay transition-colors w-full text-left"
                    >
                      <LogOut size={12} /> Log out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main id="main-content" className={`flex-1 ${isCanvasPage ? "overflow-hidden" : "overflow-auto"}`}>
        <div className={isCanvasPage ? "h-full" : "p-6"}>
          {children}
        </div>
      </main>
    </div>
  );
};
