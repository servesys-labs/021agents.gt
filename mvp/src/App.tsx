import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAuth, useAuth } from "./lib/auth";
import { AppShell } from "./components/layout/AppShell";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
// OnboardingPage removed — signup goes straight to /my-assistant
import DashboardPage from "./pages/DashboardPage";
import AgentBuilderPage from "./pages/AgentBuilderPage";
import AgentPlaygroundPage from "./pages/AgentPlaygroundPage";
import AgentSettingsPage from "./pages/AgentSettingsPage";
import AgentActivityPage from "./pages/AgentActivityPage";
import AgentTestsPage from "./pages/AgentTestsPage";
import AgentKnowledgePage from "./pages/AgentKnowledgePage";
import AgentVoicePage from "./pages/AgentVoicePage";
import AgentIntegrationsPage from "./pages/AgentIntegrationsPage";
import AgentChannelsPage from "./pages/AgentChannelsPage";
import AgentInsightsPage from "./pages/AgentInsightsPage";
import AgentManagerPage from "./pages/AgentManagerPage";
import SettingsPage from "./pages/SettingsPage";
import MarketplacePage from "./pages/MarketplacePage";
import FeedPage from "./pages/FeedPage";
import AgentDetailPage from "./pages/AgentDetailPage";
import MyAssistantPage from "./pages/MyAssistantPage";

/** Redirect to dashboard if logged in, otherwise show landing */
function LandingOrDashboard() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (user) return <Navigate to="/dashboard" replace />;
  return <LandingPage />;
}

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<LandingOrDashboard />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/explore" element={<MarketplacePage />} />
      <Route path="/explore/:name" element={<AgentDetailPage />} />
      <Route path="/feed" element={<FeedPage />} />

      {/* Onboarding redirects to assistant (personal agent auto-created on signup) */}
      <Route path="/onboarding" element={<Navigate to="/my-assistant" replace />} />

      {/* Auth required, with sidebar */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="my-assistant" element={<MyAssistantPage />} />
        <Route path="agents/new" element={<AgentBuilderPage />} />
        <Route path="agents/:id/play" element={<AgentPlaygroundPage />} />
        <Route path="agents/:id/settings" element={<AgentSettingsPage />} />
        <Route path="agents/:id/activity" element={<AgentActivityPage />} />
        <Route path="agents/:id/tests" element={<AgentTestsPage />} />
        <Route path="agents/:id/knowledge" element={<AgentKnowledgePage />} />
        <Route path="agents/:id/voice" element={<AgentVoicePage />} />
        <Route path="agents/:id/integrations" element={<AgentIntegrationsPage />} />
        <Route path="agents/:id/channels" element={<AgentChannelsPage />} />
        <Route path="agents/:id/insights" element={<AgentInsightsPage />} />
        <Route path="agents/:id/manager" element={<AgentManagerPage />} />
        <Route path="marketplace" element={<MarketplacePage />} />
        <Route path="marketplace/:name" element={<AgentDetailPage />} />
        <Route path="feed" element={<FeedPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
