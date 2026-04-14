export interface ToolDef {
  id: string;
  name: string;
  description: string;
  category: "web" | "code" | "memory" | "media";
  icon: string; // SVG path d attribute
}

// Sidebar categories — labels now match the canvas exactly so the
// drag-source ↔ drop-target relationship is visually obvious. Accents
// use the unified emerald capability tier.
export const TOOL_CATEGORIES = [
  { id: "web", label: "Web & Data", accent: "text-emerald-400" },
  { id: "code", label: "Code & Files", accent: "text-emerald-400" },
  { id: "memory", label: "Memory & Knowledge", accent: "text-emerald-400" },
  { id: "media", label: "Media", accent: "text-emerald-400" },
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number]["id"];

export const AVAILABLE_TOOLS: ToolDef[] = [
  {
    id: "web-search",
    name: "Web Search",
    description: "Search the web for current information",
    category: "web",
    icon: "M21 21l-5.2-5.2M17 10a7 7 0 11-14 0 7 7 0 0114 0z",
  },
  {
    id: "browse",
    name: "Browse",
    description: "Navigate and read web pages",
    category: "web",
    icon: "M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    id: "http-request",
    name: "HTTP Request",
    description: "Make arbitrary HTTP API calls",
    category: "web",
    icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1",
  },
  {
    id: "python-exec",
    name: "Python",
    description: "Execute Python code in a sandbox",
    category: "code",
    icon: "M17 8V5a2 2 0 00-2-2H9a2 2 0 00-2 2v3m10 0H7m10 0l1 12H6L7 8m3 4v4m4-4v4",
  },
  {
    id: "bash",
    name: "Bash",
    description: "Run shell commands securely",
    category: "code",
    icon: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  },
  {
    id: "read-file",
    name: "Read File",
    description: "Read files from the workspace",
    category: "code",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  {
    id: "write-file",
    name: "Write File",
    description: "Create or overwrite files",
    category: "code",
    icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  },
  {
    id: "edit-file",
    name: "Edit File",
    description: "Make targeted edits to files",
    category: "code",
    icon: "M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z",
  },
  {
    id: "memory-save",
    name: "Memory Save",
    description: "Persist information across sessions",
    category: "memory",
    icon: "M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4",
  },
  {
    id: "memory-recall",
    name: "Memory Recall",
    description: "Retrieve previously saved memories",
    category: "memory",
    icon: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4-4m0 0L8 12m4-4v12",
  },
  {
    id: "knowledge-search",
    name: "Knowledge Search",
    description: "Search uploaded knowledge base",
    category: "memory",
    icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
  },
  {
    id: "image-generate",
    name: "Image Generate",
    description: "Create images from text descriptions",
    category: "media",
    icon: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z",
  },
];

export function getToolById(id: string): ToolDef | undefined {
  return AVAILABLE_TOOLS.find((t) => t.id === id);
}

export function getToolsByCategory(category: ToolCategory): ToolDef[] {
  return AVAILABLE_TOOLS.filter((t) => t.category === category);
}

export function getToolIcon(id: string): string {
  return getToolById(id)?.icon ?? "";
}
