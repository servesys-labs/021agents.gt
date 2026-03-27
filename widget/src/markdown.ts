/**
 * Lightweight markdown renderer -- zero dependencies.
 * Supports: bold, italic, inline code, fenced code blocks, links,
 * unordered lists, and line breaks.
 *
 * Returns an HTML string safe for innerHTML (we escape user-supplied text
 * first, then apply markdown transforms on the escaped output).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMarkdown(raw: string): string {
  const escaped = escapeHtml(raw);

  // --- fenced code blocks (``` ... ```) ---
  let html = escaped.replace(
    /```(?:\w*)\n([\s\S]*?)```/g,
    (_match, code: string) =>
      `<pre class="aos-code-block"><code>${code.trimEnd()}</code></pre>`
  );

  // --- inline code (`code`) ---
  html = html.replace(/`([^`\n]+)`/g, '<code class="aos-inline-code">$1</code>');

  // --- bold (**text** or __text__) ---
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // --- italic (*text* or _text_) -- careful not to match inside words with _ ---
  html = html.replace(/(?<!\w)\*([^\s*].*?[^\s*]|[^\s*])\*(?!\w)/g, "<em>$1</em>");
  html = html.replace(/(?<!\w)_([^\s_].*?[^\s_]|[^\s_])_(?!\w)/g, "<em>$1</em>");

  // --- links [text](url) ---
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // --- unordered lists ---
  // Gather consecutive lines starting with "- " or "* " into <ul> blocks.
  html = html.replace(
    /(^|\n)((?:[\t ]*[-*] .+(?:\n|$))+)/g,
    (_match, prefix: string, block: string) => {
      const items = block
        .trim()
        .split(/\n/)
        .map((line) => {
          const content = line.replace(/^[\t ]*[-*] /, "");
          return `<li>${content}</li>`;
        })
        .join("");
      return `${prefix}<ul>${items}</ul>`;
    }
  );

  // --- line breaks (double newline → paragraph break, single → <br>) ---
  html = html.replace(/\n{2,}/g, '<div class="aos-paragraph-break"></div>');
  html = html.replace(/\n/g, "<br>");

  return html;
}
