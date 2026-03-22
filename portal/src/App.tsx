import { Authenticated, Refine } from "@refinedev/core";
import routerProvider, { NavigateToResource } from "@refinedev/react-router";
import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";

import { authProvider } from "./providers/authProvider";
import { agentosDataProvider } from "./providers/dataProvider";
import { Sidebar } from "./components/layout/Sidebar";
import { DashboardPage } from "./pages/dashboard";
import { AgentsPage } from "./pages/agents";
import { SessionsPage } from "./pages/sessions";
import { BillingPage } from "./pages/billing";
import { SettingsPage } from "./pages/settings";
import { LoginPage } from "./pages/login";
import { RuntimePage } from "./pages/runtime";
import { SandboxPage } from "./pages/sandbox";
import { IntegrationsPage } from "./pages/integrations";
import { GovernancePage } from "./pages/governance";
import { ApiExplorerPage } from "./pages/api-explorer";
import { AgentChatPage } from "./pages/agent-chat";
import { EvalPage } from "./pages/eval";
import { SchedulesPage } from "./pages/schedules";
import { WebhooksPage } from "./pages/webhooks";
import { EvolutionPage } from "./pages/evolution";
import { ProjectsPage } from "./pages/projects";
import { ReleasesPage } from "./pages/releases";
import { MemoryPage } from "./pages/memory";
import { RagPage } from "./pages/rag";
import { ReliabilityPage } from "./pages/reliability";
import { InfrastructurePage } from "./pages/infrastructure";
import { ClerkSessionManager } from "./auth/ClerkSessionManager";
import { CLERK_PUBLISHABLE_KEY, isClerkMode } from "./auth/config";

import "./index.css";

function App() {
  return (
    <BrowserRouter>
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
        ]}
        options={{ syncWithLocation: true }}
      >
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
      </Refine>
    </BrowserRouter>
  );
}

export default App;
