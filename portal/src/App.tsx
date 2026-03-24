import { Authenticated, Refine } from "@refinedev/core";
import routerProvider, { NavigateToResource } from "@refinedev/react-router";
import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";

import { authProvider } from "./providers/authProvider";
import { agentosDataProvider } from "./providers/dataProvider";
import { Sidebar } from "./components/layout/Sidebar";
import { ClerkSessionManager } from "./auth/ClerkSessionManager";
import { CLERK_PUBLISHABLE_KEY, isClerkMode } from "./auth/config";
import { ToastProvider } from "./components/common/ToastProvider";

import "./index.css";

/* ── Lazy page imports ──────────────────────────────────────────── */

// Canvas is the primary workspace (default route)
const CanvasWorkspacePage = lazy(() =>
  import("./pages/canvas").then((m) => ({ default: m.CanvasWorkspacePage })),
);

// Sidebar secondary pages
const OverviewPage = lazy(() =>
  import("./pages/dashboard").then((m) => ({ default: m.DashboardPage })),
);
const ObservabilityPage = lazy(() =>
  import("./pages/sessions").then((m) => ({ default: m.SessionsPage })),
);
const MetricsPage = lazy(() =>
  import("./pages/evolution").then((m) => ({ default: m.EvolutionPage })),
);
const IntelligencePage = lazy(() =>
  import("./pages/intelligence").then((m) => ({ default: m.IntelligencePage })),
);
const CompliancePage = lazy(() =>
  import("./pages/compliance").then((m) => ({ default: m.CompliancePage })),
);
const IssuesPage = lazy(() =>
  import("./pages/issues").then((m) => ({ default: m.IssuesPage })),
);
const SecurityPage = lazy(() =>
  import("./pages/security").then((m) => ({ default: m.SecurityPage })),
);
const VoicePage = lazy(() =>
  import("./pages/voice").then((m) => ({ default: m.VoicePage })),
);
const SettingsPage = lazy(() =>
  import("./pages/settings").then((m) => ({ default: m.SettingsPage })),
);
const BillingPage = lazy(() =>
  import("./pages/billing").then((m) => ({ default: m.BillingPage })),
);
const AutoResearchPage = lazy(() =>
  import("./pages/autoresearch").then((m) => ({ default: m.AutoResearchPage })),
);

// Auth
const LoginPage = lazy(() =>
  import("./pages/login").then((m) => ({ default: m.LoginPage })),
);

/* ── App ────────────────────────────────────────────────────────── */

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        {isClerkMode() && CLERK_PUBLISHABLE_KEY ? <ClerkSessionManager /> : null}
        <Refine
          routerProvider={routerProvider}
          dataProvider={{ default: agentosDataProvider }}
          authProvider={authProvider}
          resources={[
            { name: "canvas", list: "/" },
            { name: "overview", list: "/overview" },
            { name: "observability", list: "/observability" },
            { name: "metrics", list: "/metrics" },
            { name: "intelligence", list: "/intelligence" },
            { name: "compliance", list: "/compliance" },
            { name: "issues", list: "/issues" },
            { name: "security", list: "/security" },
            { name: "voice", list: "/voice" },
            { name: "settings", list: "/settings" },
            { name: "autoresearch", list: "/autoresearch" },
            { name: "billing", list: "/billing" },
            { name: "login", list: "/login" },
          ]}
          options={{ syncWithLocation: true }}
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center min-h-screen bg-surface-base text-text-muted text-sm">
                Loading...
              </div>
            }
          >
            <Routes>
              {/* Authenticated routes */}
              <Route
                element={
                  <Authenticated
                    key="private-routes"
                    fallback={<NavigateToResource resource="login" />}
                  >
                    <Sidebar>
                      <Outlet />
                    </Sidebar>
                  </Authenticated>
                }
              >
                {/* Canvas is the default landing page */}
                <Route index element={<CanvasWorkspacePage />} />
                <Route path="/canvas" element={<CanvasWorkspacePage />} />

                {/* Secondary sidebar pages */}
                <Route path="/overview" element={<OverviewPage />} />
                <Route path="/observability" element={<ObservabilityPage />} />
                <Route path="/metrics" element={<MetricsPage />} />
                <Route path="/intelligence" element={<IntelligencePage />} />
                <Route path="/compliance" element={<CompliancePage />} />
                <Route path="/issues" element={<IssuesPage />} />
                <Route path="/security" element={<SecurityPage />} />
                <Route path="/voice" element={<VoicePage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/autoresearch" element={<AutoResearchPage />} />
                <Route path="/billing" element={<BillingPage />} />
              </Route>

              {/* Login */}
              <Route
                path="/login"
                element={
                  <Authenticated key="public-routes" fallback={<LoginPage />}>
                    <NavigateToResource resource="canvas" />
                  </Authenticated>
                }
              />

              {/* Catch-all → canvas */}
              <Route path="*" element={<NavigateToResource resource="canvas" />} />
            </Routes>
          </Suspense>
        </Refine>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
