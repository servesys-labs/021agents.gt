import { NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { Home, Bot, Settings, LogOut, Menu, X, Plus, Loader2, User, Store } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../lib/auth";
import { PRODUCT } from "../../lib/product";
import { api } from "../../lib/api";
import { agentPathSegment } from "../../lib/agent-path";
import { ensureArray } from "../../lib/ensure-array";

function topNavClass(active: boolean) {
  return `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    active
      ? "bg-primary-light text-primary border-l-2 border-primary"
      : "text-text-secondary hover:bg-surface-alt hover:text-text"
  }`;
}

interface ListedAgent {
  agent_id?: string;
  name: string;
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [agents, setAgents] = useState<ListedAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const { user, logout } = useAuth();
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

  useEffect(() => {
    loadAgents();
  }, [loadAgents, location.pathname, location.search]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const onAgentsNew = location.pathname === "/agents/new";
  const isPersonalNew = onAgentsNew && location.search.includes("kind=personal");
  const isBusinessNew = onAgentsNew && !isPersonalNew;

  const nav = (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-border shadow-[0_1px_2px_0_rgba(0,0,0,0.03)] shrink-0">
        <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center transition-transform hover:scale-105">
          <span className="text-white text-xs font-bold">A</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-text leading-tight truncate">{PRODUCT.name}</div>
          <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider truncate">{PRODUCT.edition}</div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <NavLink
          to="/"
          end
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) => topNavClass(isActive)}
        >
          <Home size={18} />
          Dashboard
        </NavLink>
        <Link
          to="/agents/new"
          onClick={() => setMobileOpen(false)}
          className={topNavClass(isBusinessNew)}
        >
          <Plus size={18} />
          {PRODUCT.newAgentCta}
        </Link>
        <Link
          to="/agents/new?kind=personal"
          onClick={() => setMobileOpen(false)}
          className={topNavClass(isPersonalNew)}
        >
          <User size={18} />
          Personal assistant
        </Link>

        <div className="pt-3 mt-3 border-t border-border">
          <div className="flex items-center justify-between px-3 py-1">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider">{PRODUCT.agentsSectionTitle}</p>
            {agentsLoading && <Loader2 size={12} className="animate-spin text-text-muted" />}
          </div>
          {!agentsLoading && agents.length === 0 && (
            <p className="px-3 py-2 text-xs text-text-muted leading-relaxed">No assistants yet. Create one from the button above.</p>
          )}
          {agents.map((agent) => (
            <NavLink
              key={agent.agent_id || agent.name}
              to={`/agents/${agentPathSegment(agent.agent_id || agent.name)}/activity`}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary-light text-primary border-l-2 border-primary"
                    : "text-text-secondary hover:bg-surface-alt hover:text-text"
                }`
              }
            >
              <Bot size={16} className="shrink-0 text-text-muted" />
              <span className="truncate">{agent.name}</span>
              <span className="ml-auto w-2 h-2 rounded-full bg-success shrink-0" title="Live" />
            </NavLink>
          ))}
        </div>

        <div className="pt-3 mt-3 border-t border-border">
          <NavLink
            to="/marketplace"
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) => topNavClass(isActive)}
          >
            <Store size={18} />
            Marketplace
          </NavLink>
          <NavLink
            to="/settings"
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary-light text-primary border-l-2 border-primary"
                  : "text-text-secondary hover:bg-surface-alt hover:text-text"
              }`
            }
          >
            <Settings size={18} />
            Settings
          </NavLink>
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

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-white rounded-lg border border-border shadow-sm"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" className="absolute inset-0 bg-black/30 cursor-default" aria-label="Close menu" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-white border-r border-border shadow-xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 p-1 rounded-lg hover:bg-surface-alt text-text-secondary"
              aria-label="Close"
            >
              <X size={18} />
            </button>
            {nav}
          </div>
        </div>
      )}

      <aside className="hidden md:block w-64 bg-white border-r border-border h-screen sticky top-0 shrink-0">
        {nav}
      </aside>
    </>
  );
}
