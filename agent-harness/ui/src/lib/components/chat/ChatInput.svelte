<script lang="ts">
  import { toast } from "svelte-sonner";

  interface Props {
    onSend: (text: string) => void;
    onStop: () => void;
    streaming: boolean;
    disabled: boolean;
  }

  let { onSend, onStop, streaming, disabled }: Props = $props();

  let input = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let showSlashMenu = $state(false);

  const slashCommands = [
    { name: "/help", description: "Show available commands" },
    { name: "/clear", description: "Clear conversation" },
    { name: "/model", description: "Switch model" },
    { name: "/tools", description: "List available tools" },
  ];

  let filteredCommands = $derived.by(() => {
    if (!showSlashMenu || !input.startsWith("/")) return [];
    const query = input.slice(1).toLowerCase();
    if (!query) return slashCommands;
    return slashCommands.filter((c) => c.name.slice(1).startsWith(query));
  });

  function handleInput() {
    showSlashMenu = input.startsWith("/") && !input.includes(" ");
    autoResize();
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    const maxHeight = 12 * 24; // ~12 rows
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, maxHeight) + "px";
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showSlashMenu && filteredCommands.length > 0) {
        selectCommand(filteredCommands[0].name);
        return;
      }
      send();
    }
    if (e.key === "Escape") {
      showSlashMenu = false;
    }
  }

  function send() {
    const text = input.trim();
    if (!text || streaming || disabled) return;
    onSend(text);
    input = "";
    showSlashMenu = false;
    if (textareaEl) textareaEl.style.height = "auto";
  }

  function selectCommand(name: string) {
    input = name + " ";
    showSlashMenu = false;
    textareaEl?.focus();
  }

  function handleAttach() {
    toast.info("File attachments coming soon");
  }

  let canSend = $derived(input.trim().length > 0 && !streaming && !disabled);
</script>

<div class="bg-background px-4 pb-4 pt-3 shadow-[0_-1px_3px_0_rgba(0,0,0,0.06)]">
  <div class="relative mx-auto max-w-4xl">
    {#if showSlashMenu && filteredCommands.length > 0}
      <div class="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
        {#each filteredCommands as cmd}
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
            onclick={() => selectCommand(cmd.name)}
          >
            <span class="font-mono font-medium text-foreground">{cmd.name}</span>
            <span class="text-xs text-muted-foreground">{cmd.description}</span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="flex items-end gap-2 rounded-xl border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <button
        type="button"
        class="mb-2.5 ml-2 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={handleAttach}
        aria-label="Attach file"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <textarea
        bind:this={textareaEl}
        bind:value={input}
        oninput={handleInput}
        onkeydown={handleKeydown}
        class="max-h-72 min-h-[2.5rem] flex-1 resize-none bg-transparent py-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
        rows={1}
        placeholder="Type a message... (/ for commands)"
        disabled={disabled}
      ></textarea>

      <div class="mb-2 mr-2 shrink-0">
        {#if streaming}
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
            onclick={onStop}
            aria-label="Stop generating"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        {:else}
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none"
            onclick={send}
            disabled={!canSend}
            aria-label="Send message"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </button>
        {/if}
      </div>
    </div>

    <p class="mt-1.5 text-center text-[10px] text-muted-foreground">
      <kbd class="rounded border border-border px-1 font-mono text-[10px]">Enter</kbd> to send,
      <kbd class="rounded border border-border px-1 font-mono text-[10px]">Shift+Enter</kbd> for newline
    </p>
  </div>
</div>
