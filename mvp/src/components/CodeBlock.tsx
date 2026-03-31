/**
 * CodeBlock — Syntax-highlighted code blocks with language label, copy button, and line numbers.
 *
 * Used as a custom ReactMarkdown component to replace the default <pre><code> rendering.
 * Uses Shiki for syntax highlighting with lazy loading (doesn't block initial render).
 *
 * Visual design inspired by Claude Code's terminal output: dark themed with
 * language badge, copy button on hover, and semantic colors.
 */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Check, Copy, ChevronDown, ChevronUp } from "lucide-react";

// ── Language display names ──────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  js: "JavaScript", jsx: "JSX", ts: "TypeScript", tsx: "TSX",
  py: "Python", python: "Python", rb: "Ruby", ruby: "Ruby",
  go: "Go", rust: "Rust", rs: "Rust", java: "Java",
  cpp: "C++", "c++": "C++", c: "C", cs: "C#", csharp: "C#",
  swift: "Swift", kotlin: "Kotlin", kt: "Kotlin",
  php: "PHP", sh: "Shell", bash: "Bash", zsh: "Shell",
  sql: "SQL", html: "HTML", css: "CSS", scss: "SCSS",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  xml: "XML", md: "Markdown", markdown: "Markdown",
  dockerfile: "Dockerfile", docker: "Dockerfile",
  graphql: "GraphQL", gql: "GraphQL",
  txt: "Text", text: "Text", plaintext: "Text",
};

// ── Language colors (subtle badge backgrounds) ──────────────────────

const LANG_COLORS: Record<string, string> = {
  javascript: "bg-yellow-500/15 text-yellow-300",
  typescript: "bg-blue-500/15 text-blue-300",
  python: "bg-green-500/15 text-green-300",
  rust: "bg-orange-500/15 text-orange-300",
  go: "bg-cyan-500/15 text-cyan-300",
  ruby: "bg-red-500/15 text-red-300",
  shell: "bg-gray-500/15 text-gray-300",
  bash: "bg-gray-500/15 text-gray-300",
  sql: "bg-purple-500/15 text-purple-300",
  json: "bg-amber-500/15 text-amber-300",
  html: "bg-orange-500/15 text-orange-300",
  css: "bg-blue-500/15 text-blue-300",
};

function getLangColor(lang: string): string {
  const l = lang.toLowerCase();
  return LANG_COLORS[l] || LANG_COLORS[LANG_NAMES[l]?.toLowerCase() || ""] || "bg-white/10 text-gray-400";
}

// ── Shiki highlighting (lazy loaded) ────────────────────────────────

let highlighterPromise: Promise<any> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(async ({ createHighlighter }) => {
      return createHighlighter({
        themes: ["github-dark"],
        langs: [
          "javascript", "typescript", "python", "bash", "json", "html", "css",
          "sql", "go", "rust", "java", "ruby", "yaml", "toml", "markdown",
          "tsx", "jsx", "c", "cpp", "csharp", "swift", "kotlin", "php",
          "graphql", "dockerfile", "xml",
        ],
      });
    });
  }
  return highlighterPromise;
}

// ── Collapse threshold ──────────────────────────────────────────────

const COLLAPSE_LINE_THRESHOLD = 30; // Collapse code blocks with 30+ lines

// ── Component ───────────────────────────────────────────────────────

interface CodeBlockProps {
  children: ReactNode;
  className?: string;
  inline?: boolean;
}

export function CodeBlock({ children, className, inline }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);

  // Extract language from className (e.g., "language-python")
  const langMatch = className?.match(/language-(\w+)/);
  const lang = langMatch?.[1] || "";
  const displayLang = LANG_NAMES[lang] || lang.toUpperCase() || "";
  const codeText = String(children).replace(/\n$/, "");
  const lineCount = codeText.split("\n").length;
  const shouldCollapse = lineCount > COLLAPSE_LINE_THRESHOLD;

  // Inline code — render as <code> tag
  if (inline) {
    return (
      <code className="bg-surface-alt text-primary px-1.5 py-0.5 rounded-md text-xs font-mono">
        {children}
      </code>
    );
  }

  // Syntax highlighting (async, non-blocking)
  useEffect(() => {
    if (!lang || lang === "text" || lang === "plaintext") return;
    let cancelled = false;
    getHighlighter().then(highlighter => {
      if (cancelled) return;
      try {
        const html = highlighter.codeToHtml(codeText, {
          lang: lang,
          theme: "github-dark",
        });
        // Strip the outer <pre><code> wrapper from shiki output
        const inner = html.replace(/^<pre[^>]*><code[^>]*>/, "").replace(/<\/code><\/pre>$/, "");
        setHighlighted(inner);
      } catch {
        // Language not loaded — fall back to plain text
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [codeText, lang]);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isCollapsed = shouldCollapse && !expanded;
  const displayCode = isCollapsed ? codeText.split("\n").slice(0, COLLAPSE_LINE_THRESHOLD).join("\n") : codeText;

  return (
    <div className="code-block-wrapper my-3 rounded-xl overflow-hidden border border-white/[0.06]">
      {/* Header bar — language label + copy button */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          {displayLang && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${getLangColor(lang)}`}>
              {displayLang}
            </span>
          )}
          {lineCount > 1 && (
            <span className="text-[10px] text-gray-500">{lineCount} lines</span>
          )}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
        >
          {copied ? <><Check size={10} className="text-green-400" /> Copied</> : <><Copy size={10} /> Copy</>}
        </button>
      </div>

      {/* Code content */}
      <pre
        ref={codeRef}
        className={`terminal-card px-4 py-3 overflow-x-auto text-[11px] leading-relaxed ${isCollapsed ? "max-h-[400px]" : ""}`}
      >
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: isCollapsed
            ? highlighted.split("\n").slice(0, COLLAPSE_LINE_THRESHOLD).join("\n")
            : highlighted
          }} />
        ) : (
          <code className="terminal-stdout">{displayCode}</code>
        )}
      </pre>

      {/* Collapse/expand for long code blocks */}
      {shouldCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1 py-1.5 bg-[#161b22] border-t border-white/[0.06] text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
        >
          {expanded ? <><ChevronUp size={10} /> Show less</> : <><ChevronDown size={10} /> Show all {lineCount} lines</>}
        </button>
      )}
    </div>
  );
}

/**
 * Markdown table wrapper with stripes and sticky header.
 */
export function MarkdownTable({ children, ...props }: any) {
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-xs border-collapse" {...props}>
        {children}
      </table>
    </div>
  );
}

export function MarkdownThead({ children, ...props }: any) {
  return <thead className="bg-surface-alt sticky top-0" {...props}>{children}</thead>;
}

export function MarkdownTr({ children, ...props }: any) {
  return <tr className="even:bg-surface-alt/50 hover:bg-primary/[0.03] transition-colors" {...props}>{children}</tr>;
}

export function MarkdownTh({ children, ...props }: any) {
  return <th className="px-3 py-2 text-left font-semibold text-text border-b border-border text-[11px]" {...props}>{children}</th>;
}

export function MarkdownTd({ children, ...props }: any) {
  return <td className="px-3 py-1.5 border-b border-border/30 text-text-secondary" {...props}>{children}</td>;
}
