import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAuth } from "./lib/auth";
import { AppShell } from "./components/layout/AppShell";
import LoginPage from "./pages/LoginPage";
import OnboardingPage from "./pages/OnboardingPage";
import DashboardPage from "./pages/DashboardPage";
import AgentBuilderPage from "./pages/AgentBuilderPage";
import AgentPlaygroundPage from "./pages/AgentPlaygroundPage";
import AgentSettingsPage from "./pages/AgentSettingsPage";
import AgentActivityPage from "./pages/AgentActivityPage";
import AgentFlowPage from "./pages/AgentFlowPage";
import AgentTestsPage from "./pages/AgentTestsPage";
import AgentKnowledgePage from "./pages/AgentKnowledgePage";
import AgentVoicePage from "./pages/AgentVoicePage";
import AgentIntegrationsPage from "./pages/AgentIntegrationsPage";
import AgentChannelsPage from "./pages/AgentChannelsPage";
import AgentInsightsPage from "./pages/AgentInsightsPage";
import AgentManagerPage from "./pages/AgentManagerPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />

      {/* Auth required, no sidebar */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />

      {/* Auth required, with sidebar */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="agents/new" element={<AgentBuilderPage />} />
        <Route path="agents/:id/play" element={<AgentPlaygroundPage />} />
        <Route path="agents/:id/settings" element={<AgentSettingsPage />} />
        <Route path="agents/:id/activity" element={<AgentActivityPage />} />
        <Route path="agents/:id/flow" element={<AgentFlowPage />} />
        <Route path="agents/:id/tests" element={<AgentTestsPage />} />
        <Route path="agents/:id/knowledge" element={<AgentKnowledgePage />} />
        <Route path="agents/:id/voice" element={<AgentVoicePage />} />
        <Route path="agents/:id/integrations" element={<AgentIntegrationsPage />} />
        <Route path="agents/:id/channels" element={<AgentChannelsPage />} />
        <Route path="agents/:id/insights" element={<AgentInsightsPage />} />
        <Route path="agents/:id/manager" element={<AgentManagerPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
