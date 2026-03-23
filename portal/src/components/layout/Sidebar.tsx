import { useGetIdentity, useLogout } from "@refinedev/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getTokenSecondsRemaining } from "../../auth/jwt";
import { getAuthToken } from "../../auth/tokens";
import {
  Layers,
  LayoutDashboard,
  Activity,
  BarChart3,
  Settings,
  LogOut,
  CreditCard,
  ExternalLink,
  BookOpen,
  Users,
} from "lucide-react";

/* ── Railway-style icon-only sidebar ────────────────────────────── */

type NavItem = {
  path: string;
  label: string;
  icon: ReactNode;
};

const iconSize = 18;
const iconStroke = 1.5;

const topNav: NavItem[] = [
  { path: "/", label: "Canvas", icon: <Layers size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/overview", label: "Overview", icon: <LayoutDashboard size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/observability", label: "Observability", icon: <Activity size={iconSize} strokeWidth={iconStroke} /> },
  { path: "/metrics", label: "Metrics", icon: <BarChart3 size={iconSize} strokeWidth={iconStroke} /> },
];

const bottomNav: NavItem[] = [
  { path: "/settings", label: "Settings", icon: <Settings size={iconSize} strokeWidth={iconStroke} /> },
];

export const Sidebar = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { mutate: logout } = useLogout();
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const isCanvasPage = pathname === "/" || pathname === "/canvas";

  useEffect(() => {
    const update = () => {
      const token = getAuthToken();
      setSecondsRemaining(token ? getTokenSecondsRemaining(token) : null);
    };
    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, []);

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/" || pathname === "/canvas";
    return pathname.startsWith(path);
  };

  return (
    <div className="flex h-screen bg-surface-base text-text-primary overflow-hidden">
      {/* Icon rail — always 52px, icon-only */}
      <aside className="flex flex-col items-center w-[52px] border-r py-3 flex-shrink-0 z-40 glass-heavy relative">
        {/* Logo */}
        <Link
          to="/"
          className="mb-5 flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10 hover:bg-accent/20 transition-colors"
        >
          <span className="text-accent font-bold text-sm">O</span>
        </Link>

        {/* Top nav icons */}
        <nav className="flex flex-col items-center gap-1 flex-1" aria-label="Main navigation">
          {topNav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              aria-current={isActive(item.path) ? "page" : undefined}
              className={`flex items-center justify-center min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-lg transition-all ${
                isActive(item.path)
                  ? "bg-accent-muted text-accent"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
              }`}
            >
              {item.icon}
            </Link>
          ))}
        </nav>

        {/* Bottom nav icons */}
        <div className="flex flex-col items-center gap-1 mt-auto">
          {bottomNav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              aria-current={isActive(item.path) ? "page" : undefined}
              className={`flex items-center justify-center min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-lg transition-all ${
                isActive(item.path)
                  ? "bg-accent-muted text-accent"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
              }`}
            >
              {item.icon}
            </Link>
          ))}

          {/* User avatar / menu */}
          <div className="relative mt-1">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center justify-center min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-lg bg-accent/20 text-accent text-xs font-bold hover:bg-accent/30 transition-colors"
              aria-label={`Account menu for ${identity?.email || "user"}`}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              {(identity?.name || identity?.email || "U").charAt(0).toUpperCase()}
            </button>

            {/* User popover */}
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-50" onClick={() => setUserMenuOpen(false)} aria-hidden="true" />
                <div className="absolute bottom-0 left-full ml-2 z-50 w-56 rounded-xl shadow-2xl overflow-hidden glass-dropdown border border-border-default" role="menu" aria-label="User menu">
                  {/* User info */}
                  <div className="p-3 border-b border-border-default">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center text-accent text-sm font-bold">
                        {(identity?.name || "U").charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-text-primary truncate">
                          {identity?.name || "User"}
                        </p>
                        <p className="text-[10px] text-text-muted truncate">
                          {identity?.email || "user@oneshots.co"}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Menu items */}
                  <div className="py-1">
                    <Link
                      to="/settings"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors"
                    >
                      <Users size={12} /> Team Settings
                    </Link>
                    <Link
                      to="/billing"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors"
                    >
                      <CreditCard size={12} /> Billing & Usage
                    </Link>
                    <a
                      href="https://github.com/eprasad7/one-shot"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors"
                    >
                      <ExternalLink size={12} /> GitHub
                    </a>
                    <a
                      href="https://oneshots.co/docs"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-2 min-h-[var(--touch-target-min)] text-xs text-text-secondary hover:bg-surface-overlay transition-colors"
                    >
                      <BookOpen size={12} /> Documentation
                    </a>
                  </div>

                  {/* Logout */}
                  <div className="border-t border-border-default py-1">
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        logout();
                      }}
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

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className={`flex-1 ${isCanvasPage ? "overflow-hidden" : "overflow-auto"}`}>
          <div className={isCanvasPage ? "h-full" : "p-6"}>
            {children}
          </div>
        </main>

        {/* Status bar */}
        <div className="status-bar">
          <div className="flex items-center gap-2 font-mono">
            <span>&gt;</span>
            <span className="uppercase text-[10px]">
              {identity?.email || "user@oneshots.co"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-status-live" />
            <span>ALL SYSTEMS OPERATIONAL</span>
            {secondsRemaining !== null && secondsRemaining > 0 && (
              <span className="ml-3 text-text-muted">
                Session: {Math.max(1, Math.floor(secondsRemaining / 60))}m
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
