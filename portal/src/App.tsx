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

const DashboardPage = lazy(() => import("./pages/dashboard").then((m) => ({ default: m.DashboardPage })));
const AgentsPage = lazy(() => import("./pages/agents").then((m) => ({ default: m.AgentsPage })));
const SessionsPage = lazy(() => import("./pages/sessions").then((m) => ({ default: m.SessionsPage })));
const BillingPage = lazy(() => import("./pages/billing").then((m) => ({ default: m.BillingPage })));
const SettingsPage = lazy(() => import("./pages/settings").then((m) => ({ default: m.SettingsPage })));
const LoginPage = lazy(() => import("./pages/login").then((m) => ({ default: m.LoginPage })));
const RuntimePage = lazy(() => import("./pages/runtime").then((m) => ({ default: m.RuntimePage })));
const SandboxPage = lazy(() => import("./pages/sandbox").then((m) => ({ default: m.SandboxPage })));
const IntegrationsPage = lazy(() => import("./pages/integrations").then((m) => ({ default: m.IntegrationsPage })));
const GovernancePage = lazy(() => import("./pages/governance").then((m) => ({ default: m.GovernancePage })));
const ApiExplorerPage = lazy(() => import("./pages/api-explorer").then((m) => ({ default: m.ApiExplorerPage })));
const AgentChatPage = lazy(() => import("./pages/agent-chat").then((m) => ({ default: m.AgentChatPage })));
const EvalPage = lazy(() => import("./pages/eval").then((m) => ({ default: m.EvalPage })));
const SchedulesPage = lazy(() => import("./pages/schedules").then((m) => ({ default: m.SchedulesPage })));
const WebhooksPage = lazy(() => import("./pages/webhooks").then((m) => ({ default: m.WebhooksPage })));
const EvolutionPage = lazy(() => import("./pages/evolution").then((m) => ({ default: m.EvolutionPage })));
const ProjectsPage = lazy(() => import("./pages/projects").then((m) => ({ default: m.ProjectsPage })));
const ReleasesPage = lazy(() => import("./pages/releases").then((m) => ({ default: m.ReleasesPage })));
const MemoryPage = lazy(() => import("./pages/memory").then((m) => ({ default: m.MemoryPage })));
const RagPage = lazy(() => import("./pages/rag").then((m) => ({ default: m.RagPage })));
const ReliabilityPage = lazy(() => import("./pages/reliability").then((m) => ({ default: m.ReliabilityPage })));
const InfrastructurePage = lazy(() => import("./pages/infrastructure").then((m) => ({ default: m.InfrastructurePage })));

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        {isClerkMode() && CLERK_PUBLISHABLE_KEY ? <ClerkSessionManager /> : null}
        <Refine
          routerProvider={routerProvider}
          dataProvider={{
            default: agentosDataProvider,
          }}
          authProvider={authProvider}
          resources={[
            { name: "dashboard", list: "/" },
            { name: "agents", list: "/agents" },
            { name: "sessions", list: "/sessions" },
            { name: "runtime", list: "/runtime" },
            { name: "agent-chat", list: "/agent-chat" },
            { name: "eval", list: "/eval" },
            { name: "schedules", list: "/schedules" },
            { name: "webhooks", list: "/webhooks" },
            { name: "sandbox", list: "/sandbox" },
            { name: "integrations", list: "/integrations" },
            { name: "evolution", list: "/evolution" },
            { name: "projects", list: "/projects" },
            { name: "releases", list: "/releases" },
            { name: "memory", list: "/memory" },
            { name: "rag", list: "/rag" },
            { name: "reliability", list: "/reliability" },
            { name: "infrastructure", list: "/infrastructure" },
            { name: "governance", list: "/governance" },
            { name: "billing", list: "/billing" },
            { name: "api-explorer", list: "/api-explorer" },
            { name: "settings", list: "/settings" },
            { name: "login", list: "/login" },
          ]}
          options={{ syncWithLocation: true }}
        >
          <Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-[#0d0d0d] text-gray-500 text-sm">Loading...</div>}>
            <Routes>
              <Route
                element={
                  <Authenticated key="private-routes" fallback={<NavigateToResource resource="login" />}>
                    <Sidebar>
                      <Outlet />
                    </Sidebar>
                  </Authenticated>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/runtime" element={<RuntimePage />} />
                <Route path="/agent-chat" element={<AgentChatPage />} />
                <Route path="/eval" element={<EvalPage />} />
                <Route path="/schedules" element={<SchedulesPage />} />
                <Route path="/webhooks" element={<WebhooksPage />} />
                <Route path="/sandbox" element={<SandboxPage />} />
                <Route path="/integrations" element={<IntegrationsPage />} />
                <Route path="/evolution" element={<EvolutionPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/releases" element={<ReleasesPage />} />
                <Route path="/memory" element={<MemoryPage />} />
                <Route path="/rag" element={<RagPage />} />
                <Route path="/reliability" element={<ReliabilityPage />} />
                <Route path="/infrastructure" element={<InfrastructurePage />} />
                <Route path="/governance" element={<GovernancePage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/api-explorer" element={<ApiExplorerPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>

              <Route
                path="/login"
                element={
                  <Authenticated key="public-routes" fallback={<LoginPage />}>
                    <NavigateToResource resource="dashboard" />
                  </Authenticated>
                }
              />
              <Route path="*" element={<NavigateToResource resource="dashboard" />} />
            </Routes>
          </Suspense>
        </Refine>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
