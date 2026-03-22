import { useGetIdentity, useLogout } from "@refinedev/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getTokenSecondsRemaining } from "../../auth/jwt";
import { getAuthToken } from "../../auth/tokens";

const navItems: Array<{ path: string; label: string }> = [
  { path: "/", label: "Dashboard" },
  { path: "/agents", label: "Agents" },
  { path: "/sessions", label: "Sessions" },
  { path: "/runtime", label: "Workflows & Jobs" },
  { path: "/agent-chat", label: "Agent Chat" },
  { path: "/eval", label: "Eval Runner" },
  { path: "/schedules", label: "Schedules" },
  { path: "/webhooks", label: "Webhooks" },
  { path: "/sandbox", label: "Sandbox Studio" },
  { path: "/integrations", label: "Integrations" },
  { path: "/evolution", label: "Evolve & Proposals" },
  { path: "/projects", label: "Projects & Envs" },
  { path: "/releases", label: "Releases & Canary" },
  { path: "/memory", label: "Memory Manager" },
  { path: "/rag", label: "RAG Ingest" },
  { path: "/reliability", label: "SLO + Compare" },
  { path: "/infrastructure", label: "Infra & Retention" },
  { path: "/governance", label: "Governance" },
  { path: "/billing", label: "Billing" },
  { path: "/api-explorer", label: "API Explorer" },
  { path: "/settings", label: "Settings" },
];

export const Sidebar = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { mutate: logout } = useLogout();
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const update = () => {
      const token = getAuthToken();
      setSecondsRemaining(token ? getTokenSecondsRemaining(token) : null);
    };
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex h-screen">
      <button
        className="md:hidden fixed top-3 left-3 z-40 rounded bg-gray-900 px-3 py-2 text-xs text-white"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        Menu
      </button>

      {mobileOpen ? (
        <button
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu overlay"
        />
      ) : null}

      <aside
        className={`fixed md:static z-40 h-full w-64 bg-gray-900 text-white flex flex-col transition-transform ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="p-6 border-b border-gray-700">
          <h1 className="text-xl font-bold">AgentOS</h1>
          <p className="text-xs text-gray-400 mt-1">Agent Control Plane</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                pathname === item.path
                  ? "bg-blue-600 text-white"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-700">
          {identity && (
            <p className="text-xs text-gray-400 mb-2 truncate">{identity.email}</p>
          )}
          {secondsRemaining !== null ? (
            <p className="text-xs text-gray-500 mb-2">
              Session {secondsRemaining <= 0 ? "expired" : `expires in ${Math.max(1, Math.floor(secondsRemaining / 60))}m`}
            </p>
          ) : null}
          <button
            onClick={() => logout()}
            className="w-full text-left text-sm text-gray-400 hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-8 pt-14 md:pt-8">
        {children}
      </main>
    </div>
  );
};
