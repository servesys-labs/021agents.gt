import { NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { Home, Bot, Settings, LogOut, Menu, X, Plus, Loader2, User, Store, Rss, PanelLeftClose, PanelLeftOpen, Sun, Moon } from "lucide-react";
import { useTheme } from "../../lib/theme-context";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../lib/auth";
import { useSidebar } from "../../lib/sidebar-context";
import { PRODUCT } from "../../lib/product";
import { api } from "../../lib/api";
import { agentPathSegment } from "../../lib/agent-path";
import { ensureArray } from "../../lib/ensure-array";

function topNavClass(active: boolean, collapsed: boolean) {
  const base = collapsed
    ? "flex items-center justify-center p-2 rounded-lg transition-colors"
    : "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors";
  return `${base} ${
    active
      ? `bg-primary-light text-primary ${collapsed ? "" : "border-l-2 border-primary"}`
      : "text-text-secondary hover:bg-surface-alt hover:text-text"
  }`;
}

interface ListedAgent {
  agent_id?: string;
  name: string;
}

function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="p-2 rounded-lg hover:bg-surface-alt transition-colors"
      title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
    >
      {resolved === "dark" ? <Sun size={16} className="text-text-muted" /> : <Moon size={16} className="text-text-muted" />}
    </button>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [agents, setAgents] = useState<ListedAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const { user, logout } = useAuth();
  const { collapsed, toggle } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation();

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const rows = await api.get<unknown>("/agents");
      setAgents(ensureArray<ListedAgent>(rows));
    } catch {
      setAgents([]);
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  // Fetch agents once on mount — not on every route change (was causing flicker)
  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const onAgentsNew = location.pathname === "/agents/new";
  const isPersonalNew = onAgentsNew && location.search.includes("kind=personal");
  const isBusinessNew = onAgentsNew && !isPersonalNew;

  // Full nav for expanded + mobile
  const navFull = (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-border shadow-[0_1px_2px_0_rgba(0,0,0,0.03)] shrink-0">
        <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center transition-transform hover:scale-105">
          <span className="text-white text-xs font-bold">A</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-text leading-tight truncate">{PRODUCT.name}</div>
          <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider truncate">{PRODUCT.edition}</div>
        </div>
        <button type="button" onClick={toggle} className="p-1 rounded-lg hover:bg-surface-alt text-text-muted transition-colors" title="Collapse sidebar">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <NavLink to="/dashboard" end onClick={() => setMobileOpen(false)} className={({ isActive }) => topNavClass(isActive, false)}>
          <Home size={18} /> Dashboard
        </NavLink>
        <Link to="/agents/new" onClick={() => setMobileOpen(false)} className={topNavClass(isBusinessNew, false)}>
          <Plus size={18} /> {PRODUCT.newAgentCta}
        </Link>
        <NavLink to="/my-assistant" onClick={() => setMobileOpen(false)} className={({ isActive }) => topNavClass(isActive, false)}>
          <User size={18} /> My Assistant
        </NavLink>

        <div className="pt-3 mt-3 border-t border-border">
          <div className="flex items-center justify-between px-3 py-1">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider">{PRODUCT.agentsSectionTitle}</p>
            {agentsLoading && <Loader2 size={12} className="animate-spin text-text-muted" />}
          </div>
          {!agentsLoading && agents.length === 0 && (
            <p className="px-3 py-2 text-xs text-text-muted leading-relaxed">No assistants yet. Create one from the button above.</p>
          )}
          {agents.filter(a => a.name.toLowerCase() !== "my-assistant").map((agent) => (
            <NavLink
              key={agent.agent_id || agent.name}
              to={`/agents/${agentPathSegment(agent.agent_id || agent.name)}/activity`}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive ? "bg-primary-light text-primary border-l-2 border-primary" : "text-text-secondary hover:bg-surface-alt hover:text-text"
                }`
              }
            >
              <Bot size={16} className="shrink-0 text-text-muted" />
              <span className="truncate">{agent.name}</span>
              {/* Phase UI5: Health status — green=healthy, amber=degraded, red=error, gray=draft */}
              <span className={`ml-auto w-2 h-2 rounded-full shrink-0 ${
                agent.is_active
                  ? (agent as any).error_rate_pct > 20 ? "bg-danger"
                    : (agent as any).error_rate_pct > 5 ? "bg-warning"
                    : "bg-success"
                  : "bg-text-muted/30"
              }`} title={agent.is_active ? `Live${(agent as any).error_rate_pct ? ` · ${Number((agent as any).error_rate_pct).toFixed(0)}% errors` : ""}` : "Draft"} />
            </NavLink>
          ))}
        </div>

        <div className="pt-3 mt-3 border-t border-border">
          <div className="flex items-center gap-1">
            <NavLink to="/settings" onClick={() => setMobileOpen(false)} className={({ isActive }) => `flex-1 ${topNavClass(isActive, false)}`}>
              <Settings size={18} /> Settings
            </NavLink>
            <ThemeToggle />
          </div>
          <div className="mt-2 pt-2 border-t border-border/50">
            <p className="px-3 py-1 text-[10px] font-medium text-text-muted uppercase tracking-wider">Explore</p>
            <NavLink to="/marketplace" onClick={() => setMobileOpen(false)} className={({ isActive }) => topNavClass(isActive, false)}>
              <Store size={18} /> Marketplace
            </NavLink>
            <NavLink to="/feed" onClick={() => setMobileOpen(false)} className={({ isActive }) => topNavClass(isActive, false)}>
              <Rss size={18} /> Feed
            </NavLink>
          </div>
        </div>
      </nav>

      <div className="px-3 py-4 border-t border-border">
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-alt/80 transition-colors">
          <div className="w-8 h-8 rounded-full bg-primary-light flex items-center justify-center text-primary text-sm font-medium shrink-0">
            {(user?.name?.[0] || user?.email?.[0] || "U").toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text truncate">{user?.name || "User"}</p>
            <p className="text-xs text-text-muted truncate" title={user?.email}>{user?.email}</p>
          </div>
          <button type="button" onClick={handleLogout} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary shrink-0" title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  // Collapsed nav — icons only with tooltips
  const navCollapsed = (
    <div className="flex flex-col h-full items-center">
      <div className="flex items-center justify-center h-16 border-b border-border shadow-[0_1px_2px_0_rgba(0,0,0,0.03)] shrink-0 w-full">
        <button type="button" onClick={toggle} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-muted transition-colors" title="Expand sidebar">
          <PanelLeftOpen size={18} />
        </button>
      </div>

      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto w-full">
        <NavLink to="/dashboard" end className={({ isActive }) => topNavClass(isActive, true)} title="Dashboard">
          <Home size={18} />
        </NavLink>
        <Link to="/agents/new" className={topNavClass(isBusinessNew, true)} title={PRODUCT.newAgentCta}>
          <Plus size={18} />
        </Link>
        <NavLink to="/my-assistant" className={({ isActive }) => topNavClass(isActive, true)} title="My Assistant">
          <User size={18} />
        </NavLink>

        <div className="pt-3 mt-3 border-t border-border space-y-1">
          {agentsLoading && (
            <div className="flex justify-center py-1">
              <Loader2 size={14} className="animate-spin text-text-muted" />
            </div>
          )}
          {agents.filter(a => a.name.toLowerCase() !== "my-assistant").map((agent) => (
            <NavLink
              key={agent.agent_id || agent.name}
              to={`/agents/${agentPathSegment(agent.agent_id || agent.name)}/activity`}
              className={({ isActive }) => topNavClass(isActive, true)}
              title={agent.name}
            >
              <Bot size={16} />
            </NavLink>
          ))}
        </div>

        <div className="pt-3 mt-3 border-t border-border space-y-1">
          <NavLink to="/settings" className={({ isActive }) => topNavClass(isActive, true)} title="Settings">
            <Settings size={18} />
          </NavLink>
          <NavLink to="/marketplace" className={({ isActive }) => topNavClass(isActive, true)} title="Marketplace">
            <Store size={18} />
          </NavLink>
          <NavLink to="/feed" className={({ isActive }) => topNavClass(isActive, true)} title="Feed">
            <Rss size={18} />
          </NavLink>
        </div>
      </nav>

      <div className="px-2 py-4 border-t border-border w-full flex justify-center">
        <button
          type="button"
          onClick={handleLogout}
          className="p-2 rounded-lg hover:bg-surface-alt text-text-secondary transition-colors"
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-surface rounded-lg border border-border shadow-sm"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" className="absolute inset-0 bg-black/30 cursor-default" aria-label="Close menu" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-surface border-r border-border shadow-xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 p-1 rounded-lg hover:bg-surface-alt text-text-secondary"
              aria-label="Close"
            >
              <X size={18} />
            </button>
            {navFull}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className={`hidden md:block bg-surface border-r border-border h-screen sticky top-0 shrink-0 transition-all duration-300 ease-out ${
        collapsed ? "w-14" : "w-64"
      }`}>
        {collapsed ? navCollapsed : navFull}
      </aside>
    </>
  );
}
