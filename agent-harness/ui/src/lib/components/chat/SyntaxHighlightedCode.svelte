<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    code: string;
    language?: string;
    maxHeight?: string;
    showLineNumbers?: boolean;
    class?: string;
  }

  let {
    code,
    language = "",
    maxHeight = "20rem",
    showLineNumbers = false,
    class: className = "",
  }: Props = $props();

  let highlightedHtml = $state("");
  let hljsLoaded = $state(false);

  // Dynamic import of highlight.js to keep bundle small
  $effect(() => {
    const currentCode = code;
    const currentLang = language;

    if (!currentCode) {
      highlightedHtml = "";
      return;
    }

    loadAndHighlight(currentCode, currentLang);
  });

  async function loadAndHighlight(src: string, lang: string) {
    try {
      const hljs = (await import("highlight.js/lib/core")).default;

      // Register common languages on demand
      if (!hljsLoaded) {
        const langs: Record<string, () => Promise<{ default: unknown }>> = {
          javascript: () => import("highlight.js/lib/languages/javascript"),
          typescript: () => import("highlight.js/lib/languages/typescript"),
          python: () => import("highlight.js/lib/languages/python"),
          json: () => import("highlight.js/lib/languages/json"),
          bash: () => import("highlight.js/lib/languages/bash"),
          shell: () => import("highlight.js/lib/languages/shell"),
          xml: () => import("highlight.js/lib/languages/xml"),
          css: () => import("highlight.js/lib/languages/css"),
          sql: () => import("highlight.js/lib/languages/sql"),
          yaml: () => import("highlight.js/lib/languages/yaml"),
          markdown: () => import("highlight.js/lib/languages/markdown"),
          go: () => import("highlight.js/lib/languages/go"),
          rust: () => import("highlight.js/lib/languages/rust"),
          java: () => import("highlight.js/lib/languages/java"),
          cpp: () => import("highlight.js/lib/languages/cpp"),
          c: () => import("highlight.js/lib/languages/c"),
          diff: () => import("highlight.js/lib/languages/diff"),
          plaintext: () => import("highlight.js/lib/languages/plaintext"),
        };

        for (const [name, loader] of Object.entries(langs)) {
          try {
            const mod = await loader();
            hljs.registerLanguage(name, mod.default as any);
          } catch {
            // Language not available, skip
          }
        }
        // Aliases
        if (hljs.getLanguage("javascript")) {
          hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
        }
        if (hljs.getLanguage("typescript")) {
          hljs.registerAliases(["ts", "tsx", "svelte", "vue"], { languageName: "typescript" });
        }
        if (hljs.getLanguage("bash")) {
          hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
        }
        if (hljs.getLanguage("xml")) {
          hljs.registerAliases(["html", "svg"], { languageName: "xml" });
        }
        hljsLoaded = true;
      }

      const hljs2 = (await import("highlight.js/lib/core")).default;
      const normalizedLang = lang?.toLowerCase().trim() || "";

      let result: string;
      if (normalizedLang && hljs2.getLanguage(normalizedLang)) {
        result = hljs2.highlight(src, { language: normalizedLang }).value;
      } else if (normalizedLang) {
        // Try auto-detect
        result = hljs2.highlightAuto(src).value;
      } else {
        result = hljs2.highlightAuto(src).value;
      }
      highlightedHtml = result;
    } catch {
      // Fallback: escape HTML
      highlightedHtml = src
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
  }

  let lines = $derived(code.split("\n"));
</script>

<div
  class={cn(
    "overflow-auto rounded-lg border border-border bg-code-background font-mono text-xs",
    className
  )}
  style="max-height: {maxHeight};"
>
  {#if showLineNumbers}
    <div class="flex">
      <div class="select-none border-r border-border px-2 py-3 text-right text-muted-foreground/50" aria-hidden="true">
        {#each lines as _, i}
          <div class="leading-relaxed">{i + 1}</div>
        {/each}
      </div>
      <pre class="flex-1 overflow-x-auto p-3"><code class="hljs leading-relaxed text-code-foreground">{@html highlightedHtml}</code></pre>
    </div>
  {:else}
    <pre class="overflow-x-auto p-3"><code class="hljs leading-relaxed text-code-foreground">{@html highlightedHtml}</code></pre>
  {/if}
</div>

<style>
  pre {
    margin: 0;
    background: transparent;
  }
  :global(.hljs) {
    background: transparent;
  }
</style>
