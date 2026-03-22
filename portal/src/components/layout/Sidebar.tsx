import { useLogout, useGetIdentity } from "@refinedev/core";
import { Link, useLocation } from "react-router-dom";

const navItems = [
  { path: "/", label: "Dashboard", icon: "📊" },
  { path: "/agents", label: "Agents", icon: "🤖" },
  { path: "/sessions", label: "Sessions", icon: "📋" },
  { path: "/eval", label: "Eval", icon: "✅" },
  { path: "/billing", label: "Billing", icon: "💰" },
  { path: "/settings", label: "Settings", icon: "⚙️" },
];

export const Sidebar = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();
  const { mutate: logout } = useLogout();
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="p-6 border-b border-gray-700">
          <h1 className="text-xl font-bold">AgentOS</h1>
          <p className="text-xs text-gray-400 mt-1">Agent Control Plane</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                pathname === item.path
                  ? "bg-blue-600 text-white"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-700">
          {identity && (
            <p className="text-xs text-gray-400 mb-2 truncate">{identity.email}</p>
          )}
          <button
            onClick={() => logout()}
            className="w-full text-left text-sm text-gray-400 hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-8">
        {children}
      </main>
    </div>
  );
};
