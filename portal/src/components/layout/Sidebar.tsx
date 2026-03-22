import { useGetIdentity, useLogout } from "@refinedev/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getTokenSecondsRemaining } from "../../auth/jwt";
import { getAuthToken } from "../../auth/tokens";
import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  Play,
  FlaskConical,
  Clock,
  Webhook,
  Box,
  Plug,
  GitBranch,
  FolderKanban,
  Rocket,
  Brain,
  Database,
  ShieldCheck,
  Activity,
  Server,
  Key,
  Users,
  BarChart3,
  Gauge,
  CreditCard,
  Compass,
  Settings,
  ExternalLink,
  BookOpen,
  Search,
  PanelLeftClose,
  PanelLeft,
  ChevronDown,
  CircleDot,
} from "lucide-react";

type NavItem = {
  path: string;
  label: string;
  icon: ReactNode;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const iconSize = 16;
const iconStroke = 1.5;

const navGroups: NavGroup[] = [
  {
    label: "",
    items: [
      { path: "/", label: "Dashboard", icon: <LayoutDashboard size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/agents", label: "Agents", icon: <Bot size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/sessions", label: "Sessions", icon: <Play size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/sandbox", label: "Sandbox Studio", icon: <Box size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "WORKFLOWS",
    items: [
      { path: "/runtime", label: "Workflows & Jobs", icon: <Activity size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/agent-chat", label: "Agent Chat", icon: <MessageSquare size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/eval", label: "Eval Runner", icon: <FlaskConical size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/schedules", label: "Schedules", icon: <Clock size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "INTEGRATION",
    items: [
      { path: "/webhooks", label: "Webhooks", icon: <Webhook size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/integrations", label: "Connectors", icon: <Plug size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/api-explorer", label: "API Explorer", icon: <Compass size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { path: "/evolution", label: "Evolve & Proposals", icon: <GitBranch size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/memory", label: "Memory Manager", icon: <Brain size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/rag", label: "RAG Ingest", icon: <Database size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      { path: "/projects", label: "Projects & Envs", icon: <FolderKanban size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/releases", label: "Releases & Canary", icon: <Rocket size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/reliability", label: "SLO & Compare", icon: <Gauge size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/infrastructure", label: "Infrastructure", icon: <Server size={iconSize} strokeWidth={iconStroke} /> },
      { path: "/governance", label: "Governance", icon: <ShieldCheck size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "BILLING",
    items: [
      { path: "/billing", label: "Billing & Usage", icon: <CreditCard size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
  {
    label: "SETTINGS",
    items: [
      { path: "/settings", label: "Settings", icon: <Settings size={iconSize} strokeWidth={iconStroke} /> },
    ],
  },
];

export const Sidebar = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { mutate: logout } = useLogout();
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const update = () => {
      const token = getAuthToken();
      setSecondsRemaining(token ? getTokenSecondsRemaining(token) : null);
    };
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

  return (
    <div className="flex h-screen bg-surface-base">
      {/* Mobile menu button */}
      <button
        className="md:hidden fixed top-3 left-3 z-50 rounded-md bg-surface-raised px-3 py-2 text-xs text-text-primary border border-border-default"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        <PanelLeft size={16} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <button
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu overlay"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:static z-40 h-full flex flex-col bg-surface-raised border-r border-border-default transition-all duration-200 ${
          collapsed ? "w-16" : "w-60"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        {/* Logo + Team */}
        <div className="p-4 border-b border-border-default">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
                <CircleDot size={16} className="text-white" strokeWidth={2.5} />
              </div>
              {!collapsed && (
                <span className="text-sm font-semibold text-text-primary tracking-tight">oneshots</span>
              )}
            </div>
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="hidden md:flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            >
              {collapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
            </button>
          </div>

          {/* Team selector */}
          {!collapsed && (
            <button className="mt-3 w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-base border border-border-default text-xs text-text-secondary hover:border-border-strong transition-colors">
              <div className="w-5 h-5 rounded bg-surface-overlay flex items-center justify-center text-[10px] font-bold text-text-primary">
                {identity?.name?.[0]?.toUpperCase() || "T"}
              </div>
              <span className="truncate flex-1 text-left">
                {identity?.name || "Team"}
              </span>
              <ChevronDown size={12} className="text-text-muted" />
            </button>
          )}

          {/* Search */}
          {!collapsed && (
            <button className="mt-2 w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-text-muted hover:bg-surface-overlay transition-colors">
              <Search size={13} />
              <span>Go to</span>
              <kbd className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-muted">
                ⌘K
              </kbd>
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {navGroups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? "mt-4" : ""}>
              {group.label && !collapsed && (
                <div className="px-2.5 mb-1.5 text-[10px] font-semibold tracking-widest text-text-muted uppercase">
                  {group.label}
                </div>
              )}
              {group.label && collapsed && gi > 0 && (
                <div className="mx-2 mb-2 border-t border-border-default" />
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileOpen(false)}
                    title={collapsed ? item.label : undefined}
                    className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition-colors ${
                      isActive(item.path)
                        ? "bg-accent-muted text-accent"
                        : "text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
                    } ${collapsed ? "justify-center px-0" : ""}`}
                  >
                    <span className={`flex-shrink-0 ${isActive(item.path) ? "text-accent" : ""}`}>
                      {item.icon}
                    </span>
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* External links */}
        {!collapsed && (
          <div className="px-2 py-2 space-y-0.5">
            <a
              href="https://github.com/eprasad7/one-shot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors"
            >
              <ExternalLink size={14} strokeWidth={1.5} />
              <span>GitHub</span>
              <ExternalLink size={10} className="ml-auto text-text-muted" />
            </a>
            <a
              href="https://oneshots.co/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors"
            >
              <BookOpen size={14} strokeWidth={1.5} />
              <span>Documentation</span>
              <ExternalLink size={10} className="ml-auto text-text-muted" />
            </a>
          </div>
        )}

        {/* Footer */}
        {!collapsed && (
          <div className="border-t border-border-default">
            <div className="flex items-center gap-3 px-4 py-2">
              <button className="text-[11px] text-text-muted hover:text-text-secondary transition-colors">
                Feedback
              </button>
              <button className="text-[11px] text-text-muted hover:text-text-secondary transition-colors">
                Support
              </button>
              <button
                onClick={() => logout()}
                className="text-[11px] text-text-muted hover:text-status-error transition-colors ml-auto"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto">
          <div className="p-6 pt-14 md:pt-6">
            {children}
          </div>
        </main>

        {/* Status bar */}
        <div className="status-bar">
          <div className="flex items-center gap-2 font-mono">
            <span>&gt;</span>
            <span className="uppercase">{identity?.email || "user@oneshots.co"}</span>
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
