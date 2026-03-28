import { useNavigate, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, Play, GitBranch, FlaskConical, BookOpen, Phone, ShoppingBag, Share2, Lightbulb, Settings, BarChart3 } from "lucide-react";

const tabs = [
  { path: "activity", icon: BarChart3, label: "Activity" },
  { path: "play", icon: Play, label: "Test" },
  { path: "flow", icon: GitBranch, label: "Flow" },
  { path: "tests", icon: FlaskConical, label: "Evals" },
  { path: "knowledge", icon: BookOpen, label: "Knowledge" },
  { path: "voice", icon: Phone, label: "Voice" },
  { path: "integrations", icon: ShoppingBag, label: "Integrations" },
  { path: "channels", icon: Share2, label: "Channels" },
  { path: "insights", icon: Lightbulb, label: "Insights" },
  { path: "settings", icon: Settings, label: "Settings" },
];

interface AgentNavProps {
  agentName: string;
  children?: React.ReactNode; // page-specific action buttons
}

export function AgentNav({ agentName, children }: AgentNavProps) {
  const navigate = useNavigate();
  const { id } = useParams();
  const location = useLocation();
  const currentPath = location.pathname.split("/").pop() || "";

  return (
    <div className="mb-6">
      {/* Breadcrumb row */}
      <div className="flex items-center gap-3 mb-3">
        <button onClick={() => navigate("/")} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary">
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-1.5 text-sm">
          <button onClick={() => navigate("/")} className="text-text-muted hover:text-primary transition-colors">Dashboard</button>
          <span className="text-text-muted">/</span>
          <button onClick={() => navigate(`/agents/${id}/activity`)} className="text-text-muted hover:text-primary transition-colors">{agentName}</button>
          <span className="text-text-muted">/</span>
          <span className="font-medium text-text capitalize">{tabs.find((t) => t.path === currentPath)?.label || currentPath}</span>
        </div>
        {children && <div className="ml-auto flex gap-2">{children}</div>}
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => {
          const active = currentPath === tab.path;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(`/agents/${id}/${tab.path}`)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-all duration-200 ${
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-text-secondary hover:text-text hover:border-gray-300"
              }`}
            >
              <tab.icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
