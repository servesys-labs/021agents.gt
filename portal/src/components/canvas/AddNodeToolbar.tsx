import { useState, useRef, useEffect } from "react";
import { Plus, Bot, FileText, Database, Plug, Server, X, Import } from "lucide-react";

type NodeTypeOption = {
  type: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  description: string;
};

const nodeTypes: NodeTypeOption[] = [
  {
    type: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
    color: "text-accent",
    bgColor: "bg-[rgba(249,115,22,0.1)]",
    description: "AI agent with tools & model",
  },
  {
    type: "knowledge",
    label: "Knowledge",
    icon: <FileText size={14} />,
    color: "text-chart-purple",
    bgColor: "bg-[rgba(168,85,247,0.1)]",
    description: "Upload docs for RAG",
  },
  {
    type: "datasource",
    label: "Data Source",
    icon: <Database size={14} />,
    color: "text-chart-cyan",
    bgColor: "bg-[rgba(6,182,212,0.1)]",
    description: "Connect a database",
  },
  {
    type: "connector",
    label: "Connector",
    icon: <Plug size={14} />,
    color: "text-chart-green",
    bgColor: "bg-[rgba(34,197,94,0.1)]",
    description: "Slack, GitHub, etc.",
  },
  {
    type: "mcpServer",
    label: "MCP Server",
    icon: <Server size={14} />,
    color: "text-chart-blue",
    bgColor: "bg-[rgba(59,130,246,0.1)]",
    description: "External tool server",
  },
];

type Props = {
  onAdd: (type: string) => void;
  onImportAgent?: (agentData: Record<string, unknown>) => void;
};

export function AddNodeToolbar({ onAdd, onImportAgent }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={menuRef} className="absolute top-4 left-1/2 -translate-x-1/2 z-40">
      {/* Expanded palette */}
      {open && (
        <div className="mb-2 flex items-center gap-1.5 px-2 py-1.5 rounded-xl border border-border-default glass-dropdown animate-[fadeIn_0.15s_ease-out]">
          {nodeTypes.map((nt) => (
            <button
              key={nt.type}
              onClick={() => {
                onAdd(nt.type);
                setOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors group"
              title={nt.description}
            >
              <span className={`${nt.color} ${nt.bgColor} w-6 h-6 rounded-md flex items-center justify-center`}>
                {nt.icon}
              </span>
              <span className="text-[11px] font-medium whitespace-nowrap">{nt.label}</span>
            </button>
          ))}
          {onImportAgent && (
            <>
              <div className="w-px h-6 bg-border-default mx-1" />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors group"
                title="Import agent from JSON file"
              >
                <span className="text-accent bg-[rgba(249,115,22,0.1)] w-6 h-6 rounded-md flex items-center justify-center">
                  <Import size={14} />
                </span>
                <span className="text-[11px] font-medium whitespace-nowrap">Import Agent</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    try {
                      const data = JSON.parse(reader.result as string) as Record<string, unknown>;
                      onImportAgent(data);
                    } catch {
                      // invalid JSON — ignore
                    }
                  };
                  reader.readAsText(file);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <button
            onClick={() => setOpen(false)}
            className="ml-1 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Collapsed button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border-default glass-dropdown text-[12px] text-text-secondary hover:text-text-primary hover:border-border-strong transition-all"
        >
          <Plus size={14} className="text-accent" />
          <span className="font-medium">Add Node</span>
        </button>
      )}
    </div>
  );
}
