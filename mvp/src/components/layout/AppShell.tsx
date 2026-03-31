import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/** Pages that need edge-to-edge layout (no padding) */
const FULL_BLEED_ROUTES = ["/my-assistant", /\/agents\/[^/]+\/play$/];

export function AppShell() {
  const { pathname } = useLocation();
  const isFullBleed = FULL_BLEED_ROUTES.some((p) =>
    typeof p === "string" ? pathname === p : p.test(pathname),
  );

  return (
    <div className="flex min-h-screen bg-surface-alt">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <div className={`flex-1 ${isFullBleed ? "" : "px-6 md:px-10 py-6"}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
