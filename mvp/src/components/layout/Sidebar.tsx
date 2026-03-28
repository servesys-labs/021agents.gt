import { NavLink, useNavigate } from "react-router-dom";
import { Home, Bot, Settings, LogOut, Menu, X, Plus } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../../lib/auth";
import { MOCK_AGENTS } from "../../lib/mock-data";

const navItems = [
  { to: "/", icon: Home, label: "Dashboard" },
  { to: "/agents/new", icon: Plus, label: "New Agent" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const nav = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-border shadow-[0_1px_2px_0_rgba(0,0,0,0.03)] shrink-0">
        <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center transition-transform hover:scale-110">
          <span className="text-white text-xs font-bold">A</span>
        </div>
        <span className="font-semibold text-text">AgentOS</span>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.slice(0, 2).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary-light text-primary border-l-2 border-primary"
                  : "text-text-secondary hover:bg-surface-alt hover:text-text"
              }`
            }
          >
            <item.icon size={18} />
            {item.label}
          </NavLink>
        ))}

        {/* Agent list */}
        {MOCK_AGENTS.length > 0 && (
          <div className="pt-3 mt-3 border-t border-border">
            <p className="px-3 py-1 text-xs font-medium text-text-muted uppercase tracking-wider">Agents</p>
            {MOCK_AGENTS.map((agent) => (
              <NavLink
                key={agent.id}
                to={`/agents/${agent.id}/activity`}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-primary-light text-primary border-l-2 border-primary"
                      : "text-text-secondary hover:bg-surface-alt hover:text-text"
                  }`
                }
              >
                <Bot size={16} />
                <span className="truncate">{agent.name}</span>
                {agent.status === "active" && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-success shrink-0" />
                )}
              </NavLink>
            ))}
          </div>
        )}

        {/* Settings at bottom of nav */}
        <div className="pt-3 mt-3 border-t border-border">
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

      {/* User */}
      <div className="px-3 py-4 border-t border-border">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-8 h-8 rounded-full bg-primary-light flex items-center justify-center text-primary text-sm font-medium">
            {(user?.name?.[0] || user?.email?.[0] || "U").toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text truncate">{user?.name || "User"}</p>
            <p className="text-xs text-text-muted truncate">{user?.email}</p>
          </div>
          <button onClick={handleLogout} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary" title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-white rounded-lg border border-border shadow-sm"
      >
        <Menu size={20} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-64 bg-white border-r border-border">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 p-1 rounded-lg hover:bg-surface-alt text-text-secondary"
            >
              <X size={18} />
            </button>
            {nav}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:block w-64 bg-white border-r border-border h-screen sticky top-0 shrink-0">
        {nav}
      </aside>
    </>
  );
}
