import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import {
  Home,
  Bot,
  Brain,
  Bug,
  GitBranch,
  Shield,
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
  ChevronRight,
  Activity,
  Eye,
  Lock,
  Fingerprint,
} from "lucide-react";
import { QuotaWidget } from "../common/QuotaWidget";
import { PageShell } from "./PageShell";

/* ── Nav config ─────────────────────────────────────────────────── */

type NavItem = { path: string; label: string; icon: ReactNode };
type NavGroup = { id: string; label: string; icon: ReactNode; items: NavItem[] };

const iconSize = 18;
const iconStroke = 1.5;

const homeItem: NavItem = { path: "/", label: "Home", icon: <Home size={iconSize} strokeWidth={iconStroke} /> };

const navGroups: NavGroup[] = [
  {
    id: "build",
    label: "Build",
    icon: <Bot size={14} strokeWidth={iconStroke} />,
    items: [
      { path: "/agents", label: "Agents", icon: <Bot size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/tools", label: "Tools", icon: <Wrench size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/skills", label: "Skills", icon: <Sparkles size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/codemode", label: "Codemode", icon: <Code size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/sandbox", label: "Sandbox", icon: <Terminal size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/a2a", label: "A2A", icon: <Globe size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    id: "consume",
    label: "Consume",
    icon: <ExternalLink size={14} strokeWidth={iconStroke} />,
    items: [
      { path: "/developers", label: "Developer Portal", icon: <BookOpen size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/usage", label: "Usage & Users", icon: <Users size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    id: "operate",
    label: "Operate",
    icon: <Activity size={14} strokeWidth={iconStroke} />,
    items: [
      { path: "/sessions", label: "Sessions", icon: <Activity size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/workflows", label: "Workflows", icon: <GitBranch size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/pipelines", label: "Pipelines", icon: <Database size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/jobs", label: "Jobs", icon: <Timer size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/connectors", label: "Connectors", icon: <Plug size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    icon: <Eye size={14} strokeWidth={iconStroke} />,
    items: [
      { path: "/ops", label: "Ops Monitor", icon: <Activity size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/intelligence", label: "Intelligence", icon: <Brain size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/issues", label: "Issues", icon: <Bug size={iconSize} strokeWidth={iconStroke} /> },
      {
        path: "/observability/trace-integrity",
        label: "Trace integrity",
        icon: <Fingerprint size={iconSize} strokeWidth={iconStroke} />,
      },
    ],
  },
  {
    id: "govern",
    label: "Govern",
    icon: <Lock size={14} strokeWidth={iconStroke} />,
    items: [
      { path: "/security", label: "Security", icon: <ShieldAlert size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/security-events", label: "Security Events", icon: <Shield size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/compliance", label: "Compliance", icon: <ShieldCheck size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/guardrails", label: "Guardrails", icon: <ShieldAlert size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
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

  /* ── Collapsible group state ──────────────────────────────────── */
  // Auto-expand the group that contains the current route
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const group of navGroups) {
      if (group.items.some((item) => pathname.startsWith(item.path) && item.path !== "/")) {
        initial.add(group.id);
      }
    }
    // Default: expand "build" if nothing else matches
    if (initial.size === 0) initial.add("build");
    return initial;
  });

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const isCanvasPage = pathname === "/canvas";

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname === path || pathname.startsWith(path + "/");
  };

  // Check if any item in a group is active
  const isGroupActive = (group: NavGroup) =>
    group.items.some((item) => isActive(item.path));

  return (
    <div className="flex h-screen bg-surface-base text-text-primary overflow-hidden">
      {/* Skip to content link - visible on focus for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:outline-none"
      >
        Skip to main content
      </a>

      {/* Nav rail — 180px, grouped with labels, glass effect */}
      <aside className="flex flex-col w-[180px] flex-shrink-0 border-r border-border-subtle glass-heavy relative">
        {/* Logo */}
        <Link
          to="/"
          className="flex items-center gap-2 h-[52px] px-4 text-accent font-bold text-lg hover:bg-accent-muted transition-colors"
          aria-label="AgentOS Home"
        >
          <span className="text-base">O</span>
          <span className="text-sm font-semibold text-text-primary">AgentOS</span>
        </Link>

        {/* Top nav */}
        <nav className="flex flex-col gap-0.5 px-2 py-2 flex-1 overflow-y-auto" aria-label="Main navigation">
          {/* Home link */}
          <Link
            to={homeItem.path}
            aria-label={homeItem.label}
            aria-current={isActive(homeItem.path) ? "page" : undefined}
            className={`flex items-center gap-2.5 px-2.5 h-9 rounded-lg transition-colors text-xs font-medium ${
              isActive(homeItem.path)
                ? "bg-accent-muted text-accent"
                : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
            }`}
          >
            {homeItem.icon}
            {homeItem.label}
          </Link>

          {/* Grouped nav sections */}
          {navGroups.map((group) => {
            const expanded = expandedGroups.has(group.id);
            const groupActive = isGroupActive(group);

            return (
              <div key={group.id} className="mt-2">
                {/* Group header — clickable to expand/collapse */}
                <button
                  onClick={() => toggleGroup(group.id)}
                  className={`flex items-center justify-between w-full px-2.5 h-7 rounded-md transition-colors text-[10px] font-semibold uppercase tracking-wider ${
                    groupActive
                      ? "text-accent"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                  aria-expanded={expanded}
                  aria-label={`${group.label} section`}
                >
                  <span className="flex items-center gap-1.5">
                    {group.icon}
                    {group.label}
                  </span>
                  <ChevronRight
                    size={10}
                    className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                  />
                </button>

                {/* Group items — animated expand/collapse via grid-template-rows */}
                <div
                  className="grid mt-0.5"
                  style={{
                    gridTemplateRows: expanded ? "1fr" : "0fr",
                    opacity: expanded ? 1 : 0,
                    transition: `grid-template-rows var(--duration-normal) var(--ease-out), opacity var(--duration-fast) var(--ease-default)`,
                  }}
                >
                  <div className="flex flex-col gap-0.5 overflow-hidden">
                    {group.items.map((item) => (
                      <Link
                        key={item.path}
                        to={item.path}
                        aria-label={item.label}
                        aria-current={isActive(item.path) ? "page" : undefined}
                        className={`flex items-center gap-2.5 pl-5 pr-2.5 h-9 rounded-lg transition-colors text-xs font-medium ${
                          isActive(item.path)
                            ? "bg-accent-muted text-accent"
                            : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
                        }`}
                      >
                        {item.icon}
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        {/* Bottom nav + user */}
        <div className="flex flex-col gap-1 px-2 pb-2">
          {bottomNav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              className={`flex items-center gap-2.5 px-2.5 h-9 rounded-lg transition-colors text-xs font-medium ${
                isActive(item.path)
                  ? "bg-accent-muted text-accent"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}

          {/* Quota usage indicator */}
          <QuotaWidget />

          {/* User avatar / menu */}
          <div className="relative mt-1">
            <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2.5 w-full px-2.5 h-10 rounded-lg bg-accent/10 hover:bg-accent/15 transition-colors"
                aria-label={`Account menu for ${user?.email || "user"}`}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                <div className="w-7 h-7 rounded-md bg-accent/20 flex items-center justify-center text-accent text-xs font-bold flex-shrink-0">
                  {(user?.name || user?.email || "U").charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 text-left">
                  <p className="text-[11px] font-medium text-text-primary truncate">
                    {user?.name || "User"}
                  </p>
                </div>
              </button>

            {/* User popover */}
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-50" onClick={() => setUserMenuOpen(false)} aria-hidden="true" />
                <div
                  className="absolute bottom-0 left-full ml-2 z-50 w-56 rounded-xl overflow-hidden glass-dropdown"
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
        {isCanvasPage ? (
          <div className="h-full">{children}</div>
        ) : (
          <PageShell>{children}</PageShell>
        )}
      </main>
    </div>
  );
};
