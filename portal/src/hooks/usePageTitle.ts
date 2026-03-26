import { useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";

/**
 * Map of routes to page titles
 * These appear in browser tabs and are announced by screen readers
 */
const routeTitles: Record<string, string> = {
  "/": "Dashboard",
  "/agents": "Agents",
  "/agents/new": "Create Agent",
  "/intelligence": "Intelligence",
  "/issues": "Issues",
  "/workflows": "Workflows",
  "/compliance": "Compliance",
  "/guardrails": "Guardrails",
  "/connectors": "Connectors",
  "/pipelines": "Pipelines",
  "/codemode": "Codemode",
  "/sandbox": "Sandbox",
  "/skills": "Skills",
  "/jobs": "Jobs",
  "/settings": "Settings",
  "/sessions": "Sessions",
  "/security": "Security",
  "/autoresearch": "Autoresearch",
  "/audit": "Audit",
  "/voice": "Voice",
  "/memory": "Memory",
  "/rag": "RAG",
  "/releases": "Releases",
  "/schedules": "Schedules",
  "/webhooks": "Webhooks",
  "/billing": "Billing",
  "/api-keys": "API Keys",
  "/secrets": "Secrets",
};

function getPageTitle(pathname: string, params: Record<string, string | undefined>): string {
  // Check exact match first
  if (routeTitles[pathname]) {
    return routeTitles[pathname];
  }

  // Handle agent detail pages
  if (pathname.startsWith("/agents/")) {
    const agentName = params.name;
    if (pathname.includes("/playground")) {
      return agentName ? `${agentName} - Playground` : "Playground";
    }
    if (pathname.includes("/deploy")) {
      return agentName ? `${agentName} - Deploy` : "Deploy";
    }
    if (pathname.includes("/sessions/")) {
      return "Session Trace";
    }
    if (pathname.includes("/issues/")) {
      return "Issue Detail";
    }
    if (pathname.includes("/verify")) {
      return "Verify Fix";
    }
    if (pathname.includes("/success")) {
      return "Deploy Success";
    }
    return agentName ? `${agentName} - Agent` : "Agent Detail";
  }

  // Fallback: extract last segment and capitalize
  const segments = pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (lastSegment) {
    return lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);
  }

  return "AgentOS";
}

/**
 * Hook to update document title based on current route
 * Also updates aria-live region for screen readers
 */
export function usePageTitle() {
  const location = useLocation();
  const params = useParams();

  useEffect(() => {
    const pageTitle = getPageTitle(location.pathname, params);
    const fullTitle = `${pageTitle} | AgentOS`;
    
    // Update document title
    document.title = fullTitle;

    // Update meta description for SEO (optional enhancement)
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute("content", `${pageTitle} - AgentOS Portal`);
    }

    // Announce page change to screen readers (optional)
    const announcer = document.getElementById("page-title-announcer");
    if (announcer) {
      announcer.textContent = `Navigated to ${pageTitle}`;
    }
  }, [location.pathname, params]);
}
