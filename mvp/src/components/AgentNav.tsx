import { useState, useRef, useEffect } from "react";
import { useNavigate, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, Play, FlaskConical, BookOpen, Phone, ShoppingBag, Share2, Lightbulb, Settings, BarChart3, Bot, MoreHorizontal } from "lucide-react";
import { agentPathSegment } from "../lib/agent-path";

const primaryTabs = [
  { path: "activity", icon: BarChart3, label: "Activity" },
  { path: "play", icon: Play, label: "Test" },
  { path: "tests", icon: FlaskConical, label: "Evals" },
  { path: "knowledge", icon: BookOpen, label: "Knowledge" },
  { path: "channels", icon: Share2, label: "Channels" },
  { path: "settings", icon: Settings, label: "Settings" },
];

const moreTabs = [
  { path: "voice", icon: Phone, label: "Voice" },
  { path: "integrations", icon: ShoppingBag, label: "Integrations" },
  { path: "insights", icon: Lightbulb, label: "Insights" },
  { path: "manager", icon: Bot, label: "Manager" },
];

const allTabs = [...primaryTabs, ...moreTabs];

interface AgentNavProps {
  agentName: string;
  children?: React.ReactNode;
}

export function AgentNav({ agentName, children }: AgentNavProps) {
  const navigate = useNavigate();
  const { id } = useParams();
  const location = useLocation();
  const currentPath = location.pathname.split("/").pop() || "";
  const pathSeg = id ? agentPathSegment(id) : agentPathSegment(agentName);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const isMoreActive = moreTabs.some((t) => t.path === currentPath);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    if (moreOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreOpen]);

  return (
    <div className="mb-5">
      {/* Breadcrumb row */}
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={() => navigate("/")} className="p-1 rounded-lg hover:bg-surface-alt text-text-secondary">
          <ArrowLeft size={16} />
        </button>
        <div className="flex items-center gap-1.5 text-sm">
          <button type="button" onClick={() => navigate("/")} className="text-text-muted hover:text-primary transition-colors">Dashboard</button>
          <span className="text-text-muted">/</span>
          <button type="button" onClick={() => navigate(`/agents/${pathSeg}/activity`)} className="text-text-muted hover:text-primary transition-colors">{agentName}</button>
          <span className="text-text-muted">/</span>
          <span className="font-medium text-text capitalize">{allTabs.find((t) => t.path === currentPath)?.label || currentPath}</span>
        </div>
        {children && <div className="ml-auto flex gap-2">{children}</div>}
      </div>

      {/* Tab nav — primary tabs + "More" dropdown */}
      <div className="flex items-center gap-0.5 border-b border-border">
        {primaryTabs.map((tab) => {
          const active = currentPath === tab.path;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(`/agents/${pathSeg}/${tab.path}`)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-all duration-200 ${
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-text-secondary hover:text-text hover:border-border"
              }`}
            >
              <tab.icon size={14} />
              {tab.label}
            </button>
          );
        })}

        {/* More dropdown */}
        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className={`flex items-center gap-1 px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-all duration-200 ${
              isMoreActive
                ? "border-primary text-primary"
                : "border-transparent text-text-secondary hover:text-text hover:border-border"
            }`}
          >
            <MoreHorizontal size={14} />
            More
          </button>
          {moreOpen && (
            <div className="absolute top-full left-0 mt-1 w-44 bg-surface border border-border rounded-lg shadow-lg py-1 z-20">
              {moreTabs.map((tab) => {
                const active = currentPath === tab.path;
                return (
                  <button
                    key={tab.path}
                    onClick={() => {
                      navigate(`/agents/${pathSeg}/${tab.path}`);
                      setMoreOpen(false);
                    }}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-left transition-colors ${
                      active ? "text-primary bg-primary-light" : "text-text-secondary hover:bg-surface-alt hover:text-text"
                    }`}
                  >
                    <tab.icon size={14} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
