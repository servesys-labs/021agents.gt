import { Suspense, lazy, type ReactNode, useEffect, useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, Outlet, Navigate, useLocation } from "react-router-dom";

import { AuthProvider, RequireAuth } from "./lib/auth";
import { Sidebar } from "./components/layout/Sidebar";
import { ClerkSessionManager } from "./auth/ClerkSessionManager";
import { CLERK_PUBLISHABLE_KEY, isClerkMode } from "./auth/config";
import { ToastProvider } from "./components/common/ToastProvider";
import { CommandPalette } from "./components/common/CommandPalette";
import { MetaAgentProvider } from "./providers/MetaAgentProvider";
import { MetaAgentFAB } from "./components/common/MetaAgentFAB";

import { SkeletonDashboard } from "./components/common/Skeleton";
import { usePageTitle } from "./hooks/usePageTitle";
import "./index.css";

/* ── Page transition wrapper ────────────────────────────────────── */

function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [animKey, setAnimKey] = useState(location.pathname);

  useEffect(() => {
    setAnimKey(location.pathname);
  }, [location.pathname]);

  return (
    <div key={animKey} className="page-enter">
      {children}
    </div>
  );
}

/* ── Lazy page imports ──────────────────────────────────────────── */

// Auth
const LoginPage = lazy(() =>
  import("./pages/auth/login").then((m) => ({ default: m.LoginPage })),
);
const SignupPage = lazy(() =>
  import("./pages/auth/signup").then((m) => ({ default: m.SignupPage })),
);

// Dashboard (Screen 1)
const DashboardPage = lazy(() =>
  import("./pages/dashboard").then((m) => ({ default: m.DashboardPage })),
);

// Agent routes — Journey 1
const AgentListPage = lazy(() =>
  import("./pages/agents/list").then((m) => ({ default: m.AgentListPage })),
);
const CreateAgentPage = lazy(() =>
  import("./pages/agents/create").then((m) => ({ default: m.CreateAgentPage })),
);
const AgentDetailPage = lazy(() =>
  import("./pages/agents/detail").then((m) => ({ default: m.AgentDetailPage })),
);
const PlaygroundPage = lazy(() =>
  import("./pages/agents/playground").then((m) => ({ default: m.PlaygroundPage })),
);
const DeployPage = lazy(() =>
  import("./pages/agents/deploy").then((m) => ({ default: m.DeployPage })),
);
const SuccessPage = lazy(() =>
  import("./pages/agents/success").then((m) => ({ default: m.SuccessPage })),
);

// Journey 2: Troubleshooting workflow
const SessionTracePage = lazy(() =>
  import("./pages/agents/session-trace").then((m) => ({ default: m.SessionTracePage })),
);
const IssueDetailPage = lazy(() =>
  import("./pages/agents/issue-detail").then((m) => ({ default: m.IssueDetailPage })),
);
const VerifyPage = lazy(() =>
  import("./pages/agents/verify").then((m) => ({ default: m.VerifyPage })),
);

// Cross-agent pages
const IntelligencePage = lazy(() =>
  import("./pages/intelligence").then((m) => ({ default: m.IntelligencePage })),
);
const IssuesPage = lazy(() =>
  import("./pages/issues").then((m) => ({ default: m.IssuesPage })),
);
const CompliancePage = lazy(() =>
  import("./pages/compliance").then((m) => ({ default: m.CompliancePage })),
);
const SecurityPage = lazy(() =>
  import("./pages/security").then((m) => ({ default: m.SecurityPage })),
);
const GuardrailsPage = lazy(() =>
  import("./pages/guardrails").then((m) => ({ default: m.GuardrailsPage })),
);
const ConnectorHubPage = lazy(() =>
  import("./pages/connectors").then((m) => ({ default: m.ConnectorHubPage })),
);
const PipelinesPage = lazy(() =>
  import("./pages/pipelines").then((m) => ({ default: m.PipelinesPage })),
);
const CodemodePage = lazy(() =>
  import("./pages/codemode").then((m) => ({ default: m.CodemodePage })),
);
const SkillsPage = lazy(() =>
  import("./pages/skills").then((m) => ({ default: m.SkillsPage })),
);
const JobsPage = lazy(() =>
  import("./pages/jobs").then((m) => ({ default: m.JobsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/settings").then((m) => ({ default: m.SettingsPage })),
);
const WorkflowsPage = lazy(() =>
  import("./pages/workflows").then((m) => ({ default: m.WorkflowsPage })),
);
const SessionsPage = lazy(() =>
  import("./pages/sessions").then((m) => ({ default: m.SessionsPage })),
);
const AutoResearchPage = lazy(() =>
  import("./pages/autoresearch").then((m) => ({ default: m.AutoResearchPage })),
);
const AuditPage = lazy(() =>
  import("./pages/audit").then((m) => ({ default: m.AuditPage })),
);

// Tool Registry
const ToolRegistryPage = lazy(() =>
  import("./pages/tools/index").then((m) => ({ default: m.ToolRegistryPage })),
);
const CreateToolPage = lazy(() =>
  import("./pages/tools/create").then((m) => ({ default: m.CreateToolPage })),
);
const ToolDetailPage = lazy(() =>
  import("./pages/tools/detail").then((m) => ({ default: m.ToolDetailPage })),
);

// Billing
const PricingPage = lazy(() =>
  import("./pages/billing/pricing").then((m) => ({ default: m.PricingPage })),
);
const InvoicesPage = lazy(() =>
  import("./pages/billing/invoices").then((m) => ({ default: m.InvoicesPage })),
);

// A2A Protocol
const A2ADiscoveryPage = lazy(() =>
  import("./pages/a2a/index").then((m) => ({ default: m.A2ADiscoveryPage })),
);
const A2AComposePage = lazy(() =>
  import("./pages/a2a/compose").then((m) => ({ default: m.A2AComposePage })),
);

// Security detail pages
const SecurityFindingsPage = lazy(() =>
  import("./pages/security/findings").then((m) => ({ default: m.SecurityFindingsPage })),
);
const SecurityReportPage = lazy(() =>
  import("./pages/security/report").then((m) => ({ default: m.SecurityReportPage })),
);
const ScanDetailPage = lazy(() =>
  import("./pages/security/scan-detail").then((m) => ({ default: m.ScanDetailPage })),
);

/* ── Loading fallback ───────────────────────────────────────────── */

function LoadingFallback() {
  return (
    <div className="p-6 bg-surface-base min-h-screen">
      <SkeletonDashboard />
    </div>
  );
}

/* ── Authenticated layout (sidebar + outlet) ────────────────────── */

function AuthenticatedLayout() {
  return (
    <RequireAuth>
      <MetaAgentProvider>
        <Sidebar>
          <PageTransition>
            <Outlet />
          </PageTransition>
        </Sidebar>
        <MetaAgentFAB />
      </MetaAgentProvider>
    </RequireAuth>
  );
}

/* ── App ────────────────────────────────────────────────────────── */

function AppContent() {
  // Update page title on route change
  usePageTitle();

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setCommandPaletteOpen((prev) => !prev);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <AuthProvider>
      <ToastProvider>
        {isClerkMode() && CLERK_PUBLISHABLE_KEY ? <ClerkSessionManager /> : null}
        <CommandPalette
          isOpen={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
        />
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />

            {/* Authenticated routes */}
            <Route element={<AuthenticatedLayout />}>
              {/* Screen 1: Dashboard */}
              <Route index element={<DashboardPage />} />

              {/* Journey 1: Zero to Deployed Agent */}
              <Route path="/agents" element={<AgentListPage />} />
              <Route path="/agents/new" element={<CreateAgentPage />} />
              <Route path="/agents/:name" element={<AgentDetailPage />} />
              <Route path="/agents/:name/playground" element={<PlaygroundPage />} />
              <Route path="/agents/:name/deploy" element={<DeployPage />} />
              <Route path="/agents/:name/success" element={<SuccessPage />} />

              {/* Journey 2: Troubleshooting workflow */}
              <Route path="/agents/:name/sessions/:sessionId" element={<SessionTracePage />} />
              <Route path="/agents/:name/issues/:issueId" element={<IssueDetailPage />} />
              <Route path="/agents/:name/verify" element={<VerifyPage />} />

              {/* Cross-agent pages */}
              <Route path="/intelligence" element={<IntelligencePage />} />
              <Route path="/issues" element={<IssuesPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/compliance" element={<CompliancePage />} />
              <Route path="/guardrails" element={<GuardrailsPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/connectors" element={<ConnectorHubPage />} />
              <Route path="/pipelines" element={<PipelinesPage />} />
              <Route path="/codemode" element={<CodemodePage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/autoresearch" element={<AutoResearchPage />} />
              <Route path="/audit" element={<AuditPage />} />

              {/* Tool Registry */}
              <Route path="/tools" element={<ToolRegistryPage />} />
              <Route path="/tools/new" element={<CreateToolPage />} />
              <Route path="/tools/:toolName" element={<ToolDetailPage />} />

              {/* Billing */}
              <Route path="/billing/pricing" element={<PricingPage />} />
              <Route path="/billing/invoices" element={<InvoicesPage />} />

              {/* A2A Protocol */}
              <Route path="/a2a" element={<A2ADiscoveryPage />} />
              <Route path="/a2a/compose" element={<A2AComposePage />} />

              {/* Security detail pages */}
              <Route path="/security/findings" element={<SecurityFindingsPage />} />
              <Route path="/security/report" element={<SecurityReportPage />} />
              <Route path="/security/scans/:scanId" element={<ScanDetailPage />} />

              {/* Settings */}
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            {/* Catch-all: redirect to dashboard */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </AuthProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
