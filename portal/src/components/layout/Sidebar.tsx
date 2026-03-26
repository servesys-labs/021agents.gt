import { useGetIdentity, useLogout } from "@refinedev/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getTokenSecondsRemaining } from "../../auth/jwt";
import { getAuthToken } from "../../auth/tokens";
import {
  Layers,
  LayoutDashboard,
  Activity,
  BarChart3,
  Brain,
  ShieldCheck,
  Bug,
  Shield,
  Phone,
  FlaskConical,
  Settings,
  LogOut,
  CreditCard,
  ExternalLink,
  BookOpen,
  Users,
  Terminal,
} from "lucide-react";

/* ── Expandable sidebar with grouped navigation ─────────────────── */

type NavItem = {
  path: string;
  label: string;
  icon: ReactNode;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const iconSize = 18;
const iconStroke = 1.5;

const navGroups: NavGroup[] = [
  {
    label: "Core",
    items: [
      { path: "/overview", label: "Dashboard", icon: <LayoutDashboard size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/", label: "Canvas", icon: <Layers size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/observability", label: "Observability", icon: <Activity size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "Data",
    items: [
      { path: "/autoresearch", label: "Autoresearch", icon: <FlaskConical size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/intelligence", label: "Intelligence", icon: <Brain size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/metrics", label: "Metrics", icon: <BarChart3 size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "Operations",
    items: [
      { path: "/issues", label: "Issues", icon: <Bug size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/voice", label: "Voice", icon: <Phone size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/sandbox", label: "Sandbox", icon: <Terminal size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "Governance",
    items: [
      { path: "/compliance", label: "Compliance", icon: <ShieldCheck size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/security", label: "Security", icon: <Shield size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/settings", label: "Settings", icon: <Settings size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
];

export const Sidebar = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { mutate: logout } = useLogout();
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCanvasPage = pathname === "/" || pathname === "/canvas";

  const handleMouseEnter = useCallback(() => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setExpanded(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    collapseTimer.current = setTimeout(() => setExpanded(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, []);

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
    <div className="sidebar-layout flex h-screen bg-surface-base text-text-primary overflow-hidden">
      {/* Spacer - reserves space so content doesn't shift */}
      <div className="w-[52px] flex-shrink-0" />

      {/* Expandable sidebar - overlays content when expanded */}
      <aside
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="sidebar-rail glass-heavy"
        data-expanded={expanded}
      >
        {/* Logo */}
        <Link
          to="/"
          className="sidebar-logo"
        >
          <span className="text-accent font-bold text-sm flex-shrink-0">O</span>
          <span
            className="sidebar-label text-accent font-bold text-sm"
            data-expanded={expanded}
          >
            neShot
          </span>
        </Link>

        {/* Grouped navigation */}
        <nav className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden sidebar-nav-scroll" aria-label="Main navigation">
          {navGroups.map((group, groupIdx) => (
            <div key={group.label} className="flex flex-col">
              {/* Group divider (not before first group) */}
              {groupIdx > 0 && (
                <div className="sidebar-group-divider" />
              )}

              {/* Group label - visible when expanded */}
              <div
                className="sidebar-group-label"
                data-expanded={expanded}
              >
                {group.label}
              </div>

              {/* Group items */}
              <div className="flex flex-col items-stretch gap-0.5 px-2">
                {group.items.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-label={item.label}
                    aria-current={isActive(item.path) ? "page" : undefined}
                    className={`sidebar-nav-item group ${
                      isActive(item.path)
                        ? "bg-accent-muted text-accent"
                        : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
                    }`}
                  >
                    <span className="flex-shrink-0 flex items-center justify-center w-5 h-5">
                      {item.icon}
                    </span>
                    <span
                      className="sidebar-label text-[length:var(--text-sm)]"
                      data-expanded={expanded}
                    >
                      {item.label}
                    </span>
                    {/* Tooltip for collapsed state */}
                    {!expanded && (
                      <span className="sidebar-tooltip" role="tooltip">
                        {item.label}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User avatar / menu — pinned to bottom */}
        <div className="flex flex-col items-stretch gap-1 mt-auto px-2 pb-1">
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="sidebar-nav-item bg-accent/20 text-accent text-xs font-bold hover:bg-accent/30 transition-colors w-full"
              aria-label={`Account menu for ${identity?.email || "user"}`}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              <span className="flex-shrink-0 flex items-center justify-center w-5 h-5">
                {(identity?.name || identity?.email || "U").charAt(0).toUpperCase()}
              </span>
              <span
                className="sidebar-label text-[length:var(--text-sm)] truncate"
                data-expanded={expanded}
              >
                {identity?.name || identity?.email || "User"}
              </span>
              {!expanded && (
                <span className="sidebar-tooltip" role="tooltip">
                  Account
                </span>
              )}
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
          <div className={isCanvasPage ? "h-full" : "p-6 page-content"}>
            {children}
          </div>
        </main>

        {/* Mobile bottom tab bar (visible only on mobile via CSS) */}
        <nav className="bottom-tab-bar" aria-label="Mobile navigation">
          {navGroups.slice(0, 2).flatMap(g => g.items).slice(0, 5).map((item) => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              aria-current={isActive(item.path) ? "page" : undefined}
              className={`bottom-tab-item ${isActive(item.path) ? "bottom-tab-item-active" : ""}`}
            >
              {item.icon}
              <span className="bottom-tab-label">{item.label}</span>
            </Link>
          ))}
        </nav>

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
