import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
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
  const tabsRowRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  // Responsive overflow: show as many tabs inline as fit.
  const [visibleTabPaths, setVisibleTabPaths] = useState<string[]>(
    // Default to "primary" visible; overflow in More until we measure.
    primaryTabs.map((t) => t.path),
  );

  const overflowTabs = useMemo(() => {
    const visibleSet = new Set(visibleTabPaths);
    // Overflow = all tabs that are not visible.
    return allTabs.filter((t) => !visibleSet.has(t.path));
  }, [visibleTabPaths]);

  const isMoreActive = overflowTabs.some((t) => t.path === currentPath);

  useLayoutEffect(() => {
    function recompute() {
      const row = tabsRowRef.current;
      if (!row) return;

      const rowWidth = row.clientWidth;
      if (!rowWidth) return;

      // Measure each tab button width (including padding/borders).
      const widths = allTabs.map((t) => ({
        tab: t,
        w: tabButtonRefs.current[t.path]?.getBoundingClientRect().width ?? 0,
      }));

      // If measurement failed (e.g. first paint), fall back to primary tabs.
      if (widths.some((x) => x.w <= 0)) {
        setVisibleTabPaths(primaryTabs.map((t) => t.path));
        return;
      }

      const moreW = moreButtonRef.current?.getBoundingClientRect().width ?? 80;
      const gap = 2; // roughly matches gap-0.5

      // Prefer to keep primary tabs visible; overflow from the end of moreTabs first,
      // then from the end of primaryTabs if still needed.
      const ordered = [...primaryTabs, ...moreTabs];
      const visible: string[] = [];
      let used = 0;

      // First pass: assume we might not need "More".
      for (const t of ordered) {
        const w = tabButtonRefs.current[t.path]?.getBoundingClientRect().width ?? 0;
        const next = used === 0 ? w : used + gap + w;
        if (next <= rowWidth) {
          visible.push(t.path);
          used = next;
        } else {
          break;
        }
      }

      // If everything fits, hide More.
      if (visible.length === ordered.length) {
        setVisibleTabPaths(ordered.map((t) => t.path));
        return;
      }

      // Second pass: reserve space for "More" button, then fit tabs.
      visible.length = 0;
      used = 0;
      const available = Math.max(0, rowWidth - (moreW + gap));

      for (const t of ordered) {
        const w = tabButtonRefs.current[t.path]?.getBoundingClientRect().width ?? 0;
        const next = used === 0 ? w : used + gap + w;
        if (next <= available) {
          visible.push(t.path);
          used = next;
        } else {
          break;
        }
      }

      // Ensure the active tab is visible if possible (swap it in).
      if (currentPath && ordered.some((t) => t.path === currentPath) && !visible.includes(currentPath)) {
        if (visible.length > 0) {
          visible[visible.length - 1] = currentPath;
        } else {
          visible.push(currentPath);
        }
      }

      setVisibleTabPaths([...new Set(visible)]);
    }

    const raf = requestAnimationFrame(recompute);
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => recompute())
      : null;

    if (ro && tabsRowRef.current) ro.observe(tabsRowRef.current);
    window.addEventListener("resize", recompute);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", recompute);
      ro?.disconnect();
    };
  }, [currentPath]);

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
      <div ref={tabsRowRef} className="flex items-center gap-0.5 border-b border-border">
        {allTabs.map((tab) => {
          const active = currentPath === tab.path;
          const isVisible = visibleTabPaths.includes(tab.path);
          return (
            <button
              key={tab.path}
              onClick={() => navigate(`/agents/${pathSeg}/${tab.path}`)}
              ref={(el) => { tabButtonRefs.current[tab.path] = el; }}
              style={{ display: isVisible ? undefined : "none" }}
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
        <div className="relative" ref={moreRef} style={{ display: overflowTabs.length > 0 ? undefined : "none" }}>
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            ref={moreButtonRef}
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
              {overflowTabs.map((tab) => {
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
