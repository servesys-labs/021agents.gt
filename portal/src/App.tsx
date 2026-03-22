import { Refine, Authenticated } from "@refinedev/core";
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

import "./index.css";

function App() {
  return (
    <BrowserRouter>
      <Refine
        routerProvider={routerProvider}
        dataProvider={agentosDataProvider}
        authProvider={authProvider}
        resources={[
          { name: "dashboard", list: "/" },
          { name: "agents", list: "/agents" },
          { name: "sessions", list: "/sessions" },
          { name: "billing", list: "/billing" },
          { name: "settings", list: "/settings" },
        ]}
        options={{ syncWithLocation: true }}
      >
        <Routes>
          {/* Auth required routes */}
          <Route
            element={
              <Authenticated fallback={<LoginPage />}>
                <Sidebar>
                  <Outlet />
                </Sidebar>
              </Authenticated>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<NavigateToResource resource="dashboard" />} />
        </Routes>
      </Refine>
    </BrowserRouter>
  );
}

export default App;
