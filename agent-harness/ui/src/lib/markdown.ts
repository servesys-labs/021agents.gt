import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeStringify from "rehype-stringify";
import type { Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * rehype plugin: enhance links with target="_blank" and rel="noopener noreferrer"
 */
function rehypeEnhanceLinks() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName === "a") {
        const hrefValue = node.properties?.href;
        const href = typeof hrefValue === "string" ? hrefValue : "";
        if (href.startsWith("http://") || href.startsWith("https://")) {
          node.properties = node.properties || {};
          node.properties.target = "_blank";
          node.properties.rel = "noopener noreferrer";
        }
      }
    });
  };
}

/**
 * rehype plugin: add data-language and unique id to code blocks
 * for downstream copy-button injection
 */
let blockCounter = 0;
function rehypeEnhanceCodeBlocks() {
  return (tree: Root) => {
    visit(tree, "element", (node, _index, parent) => {
      if (
        node.tagName === "code" &&
        parent &&
        "tagName" in parent &&
        parent.tagName === "pre"
      ) {
        const rawClassNames = (node.properties?.className as unknown[]) || [];
        const classNames = rawClassNames.filter((c): c is string => typeof c === "string");
        const langClass = classNames.find((c) => c.startsWith("language-") || c.startsWith("hljs-"));
        const lang = langClass?.replace(/^language-/, "").replace(/^hljs-/, "") || "";

        const id = `code-block-${++blockCounter}`;
        node.properties = node.properties || {};
        node.properties["data-block-id"] = id;
        if (lang) {
          node.properties["data-language"] = lang;
        }
      }
    });
  };
}

const processor = remark()
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeHighlight, { detect: true, ignoreMissing: true })
  .use(rehypeEnhanceLinks)
  .use(rehypeEnhanceCodeBlocks)
  .use(rehypeStringify, { allowDangerousHtml: false });

/**
 * Renders a markdown string to sanitized HTML with syntax highlighting.
 */
export async function renderMarkdown(text: string): Promise<string> {
  if (!text) return "";
  const result = await processor.process(text);
  return String(result);
}

/**
 * Detect if markdown text has an unclosed code fence (streaming scenario).
 * Returns the partial code block info if found.
 */
export function detectIncompleteCodeBlock(text: string): {
  incomplete: boolean;
  language: string;
  partialCode: string;
} | null {
  // Count triple backtick fences
  const fences = text.match(/```/g);
  if (!fences || fences.length % 2 === 0) return null;

  // Find the last unclosed fence
  const lastFenceIdx = text.lastIndexOf("```");
  const afterFence = text.slice(lastFenceIdx + 3);
  // Extract language from the line after the fence
  const firstNewline = afterFence.indexOf("\n");
  const language = firstNewline > 0 ? afterFence.slice(0, firstNewline).trim() : afterFence.trim();
  const partialCode = firstNewline > 0 ? afterFence.slice(firstNewline + 1) : "";

  return { incomplete: true, language, partialCode };
}

/**
 * Process markdown for streaming: handle incomplete code blocks gracefully.
 * Close any unclosed code fences before rendering.
 */
export async function renderStreamingMarkdown(text: string): Promise<string> {
  if (!text) return "";
  const incomplete = detectIncompleteCodeBlock(text);
  const processedText = incomplete ? text + "\n```" : text;
  return renderMarkdown(processedText);
}

/**
 * Wrap <pre><code> blocks with a container that has a header (language label + copy button).
 * This is applied post-render to the HTML string.
 */
export function wrapCodeBlocksWithHeader(html: string): string {
  return html.replace(
    /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (_match, attrs: string, code: string) => {
      // Extract language from data-language or class
      const dataLangMatch = attrs.match(/data-language="(\w+)"/);
      const classLangMatch = attrs.match(/class="[^"]*language-(\w+)/);
      const lang = dataLangMatch?.[1] ?? classLangMatch?.[1] ?? "";
      const blockIdMatch = attrs.match(/data-block-id="([^"]+)"/);
      const blockId = blockIdMatch?.[1] ?? `cb-${Math.random().toString(36).slice(2, 8)}`;

      const label = lang
        ? `<span class="text-[10px] uppercase tracking-wider text-muted-foreground">${lang}</span>`
        : `<span></span>`;

      return `<div class="code-block-wrapper group relative my-3 overflow-hidden rounded-lg border border-border" data-block-id="${blockId}">
        <div class="flex items-center justify-between bg-muted/50 px-3 py-1.5 sticky top-0 z-[1]">
          ${label}
          <button type="button" class="copy-code-btn rounded-md border border-border/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" data-block-id="${blockId}" aria-label="Copy code">Copy</button>
        </div>
        <pre class="overflow-x-auto bg-code-background p-4 text-sm leading-relaxed"><code${attrs}>${code}</code></pre>
      </div>`;
    }
  );
}
