/**
 * OneShots Embeddable Chat Widget
 *
 * Self-initializing IIFE that reads configuration from the hosting
 * <script> tag's data-* attributes and injects a Shadow DOM chat
 * widget into the page.
 */

import { getStyles } from "./styles";
import { createConversation, streamMessage, uploadAndRun } from "./api";
import { renderMarkdown } from "./markdown";

/* ------------------------------------------------------------------ */
/*  i18n string table                                                   */
/* ------------------------------------------------------------------ */

const STRINGS: Record<string, Record<string, string>> = {
  en: {
    placeholder: "Type a message...",
    send: "Send",
    typing: "Thinking...",
    error: "Something went wrong. Please try again.",
    rateLimit: "Too many messages. Please wait a moment.",
    powered: "Powered by OneShots",
    upload: "Attach file",
    newChat: "New conversation",
  },
  es: {
    placeholder: "Escribe un mensaje...",
    send: "Enviar",
    typing: "Pensando...",
    error: "Algo sali\u00f3 mal. Int\u00e9ntalo de nuevo.",
    rateLimit: "Demasiados mensajes. Espera un momento.",
    powered: "Impulsado por OneShots",
    upload: "Adjuntar archivo",
    newChat: "Nueva conversaci\u00f3n",
  },
  fr: {
    placeholder: "Tapez un message...",
    send: "Envoyer",
    typing: "R\u00e9flexion...",
    error: "Une erreur est survenue. R\u00e9essayez.",
    rateLimit: "Trop de messages. Patientez.",
    powered: "Propuls\u00e9 par OneShots",
    upload: "Joindre un fichier",
    newChat: "Nouvelle conversation",
  },
  de: {
    placeholder: "Nachricht eingeben...",
    send: "Senden",
    typing: "Denke nach...",
    error: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.",
    rateLimit: "Zu viele Nachrichten. Bitte warten Sie einen Moment.",
    powered: "Betrieben von OneShots",
    upload: "Datei anh\u00e4ngen",
    newChat: "Neues Gespr\u00e4ch",
  },
  ja: {
    placeholder: "\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u5165\u529b...",
    send: "\u9001\u4fe1",
    typing: "\u8003\u3048\u4e2d...",
    error: "\u554f\u984c\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002",
    rateLimit: "\u30e1\u30c3\u30bb\u30fc\u30b8\u304c\u591a\u3059\u304e\u307e\u3059\u3002\u5c11\u3005\u304a\u5f85\u3061\u304f\u3060\u3055\u3044\u3002",
    powered: "OneShots\u63d0\u4f9b",
    upload: "\u30d5\u30a1\u30a4\u30eb\u3092\u6dfb\u4ed8",
    newChat: "\u65b0\u3057\u3044\u4f1a\u8a71",
  },
  zh: {
    placeholder: "\u8f93\u5165\u6d88\u606f...",
    send: "\u53d1\u9001",
    typing: "\u601d\u8003\u4e2d...",
    error: "\u51fa\u4e86\u70b9\u95ee\u9898\u3002\u8bf7\u91cd\u8bd5\u3002",
    rateLimit: "\u6d88\u606f\u592a\u591a\u3002\u8bf7\u7a0d\u7b49\u3002",
    powered: "\u7531 OneShots \u63d0\u4f9b\u652f\u6301",
    upload: "\u9644\u52a0\u6587\u4ef6",
    newChat: "\u65b0\u5bf9\u8bdd",
  },
  pt: {
    placeholder: "Digite uma mensagem...",
    send: "Enviar",
    typing: "Pensando...",
    error: "Algo deu errado. Tente novamente.",
    rateLimit: "Muitas mensagens. Aguarde um momento.",
    powered: "Desenvolvido por OneShots",
    upload: "Anexar arquivo",
    newChat: "Nova conversa",
  },
  ar: {
    placeholder: "\u0627\u0643\u062a\u0628 \u0631\u0633\u0627\u0644\u0629...",
    send: "\u0625\u0631\u0633\u0627\u0644",
    typing: "\u062c\u0627\u0631\u064d \u0627\u0644\u062a\u0641\u0643\u064a\u0631...",
    error: "\u062d\u062f\u062b \u062e\u0637\u0623. \u064a\u0631\u062c\u0649 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649.",
    rateLimit: "\u0631\u0633\u0627\u0626\u0644 \u0643\u062b\u064a\u0631\u0629 \u062c\u062f\u064b\u0627. \u064a\u0631\u062c\u0649 \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631.",
    powered: "\u0645\u062f\u0639\u0648\u0645 \u0628\u0648\u0627\u0633\u0637\u0629 OneShots",
    upload: "\u0625\u0631\u0641\u0627\u0642 \u0645\u0644\u0641",
    newChat: "\u0645\u062d\u0627\u062f\u062b\u0629 \u062c\u062f\u064a\u062f\u0629",
  },
};

function getStrings(locale: string): Record<string, string> {
  return STRINGS[locale] ?? STRINGS["en"];
}

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

interface WidgetConfig {
  agent: string;
  apiKey: string;
  baseUrl: string;
  theme: "light" | "dark";
  position: "bottom-right" | "bottom-left";
  title: string;
  placeholder: string;
  primaryColor: string;
  greeting: string | null;
  locale: string;
  logo: string | null;
  launcherIcon: string | null;
  width: number;
  height: number;
  hidePoweredBy: boolean;
  suggestedReplies: string[];
}

function readConfig(): WidgetConfig {
  const script =
    document.currentScript ??
    document.querySelector<HTMLScriptElement>("script[data-agent][data-api-key]");

  if (!script) {
    throw new Error("[OneShots Widget] Could not locate the widget <script> tag.");
  }

  const agent = script.getAttribute("data-agent");
  const apiKey = script.getAttribute("data-api-key");

  if (!agent || !apiKey) {
    throw new Error(
      "[OneShots Widget] data-agent and data-api-key are required attributes."
    );
  }

  // Derive base URL from script src origin if not explicitly provided.
  let baseUrl = script.getAttribute("data-base-url") ?? "";
  if (!baseUrl) {
    try {
      const srcUrl = new URL((script as HTMLScriptElement).src);
      baseUrl = srcUrl.origin;
    } catch {
      baseUrl = window.location.origin;
    }
  }
  // Strip trailing slash
  baseUrl = baseUrl.replace(/\/$/, "");

  const locale = script.getAttribute("data-locale") ?? "en";
  const strings = getStrings(locale);

  let suggestedReplies: string[] = [];
  const suggestedRaw = script.getAttribute("data-suggested-replies");
  if (suggestedRaw) {
    try {
      suggestedReplies = JSON.parse(suggestedRaw);
    } catch {
      console.warn("[OneShots Widget] Invalid data-suggested-replies JSON.");
    }
  }

  return {
    agent,
    apiKey,
    baseUrl,
    theme: (script.getAttribute("data-theme") as "light" | "dark") ?? "light",
    position:
      (script.getAttribute("data-position") as "bottom-right" | "bottom-left") ??
      "bottom-right",
    title: script.getAttribute("data-title") ?? "Chat",
    placeholder: script.getAttribute("data-placeholder") ?? strings.placeholder,
    primaryColor: script.getAttribute("data-primary-color") ?? "#6366f1",
    greeting: script.getAttribute("data-greeting") ?? null,
    locale,
    logo: script.getAttribute("data-logo") ?? null,
    launcherIcon: script.getAttribute("data-launcher-icon") ?? null,
    width: parseInt(script.getAttribute("data-width") ?? "380", 10),
    height: parseInt(script.getAttribute("data-height") ?? "600", 10),
    hidePoweredBy: script.getAttribute("data-hide-powered-by") === "true",
    suggestedReplies,
  };
}

/* ------------------------------------------------------------------ */
/*  SVG Icons                                                          */
/* ------------------------------------------------------------------ */

const ICON_CHAT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

const ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const ICON_SEND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

const ICON_ATTACH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

const ICON_NEW_CHAT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;

const ICON_REMOVE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

/* ------------------------------------------------------------------ */
/*  Widget class                                                       */
/* ------------------------------------------------------------------ */

class AgentOSWidget {
  private config: WidgetConfig;
  private strings: Record<string, string>;
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private conversationId: string | null = null;
  private isOpen = false;
  private isStreaming = false;
  private pendingFiles: File[] = [];

  // DOM refs
  private fab!: HTMLButtonElement;
  private window!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private attachBtn!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private filePreviewBar!: HTMLElement;

  constructor(config: WidgetConfig) {
    this.config = config;
    this.strings = getStrings(config.locale);

    // Create host element
    this.host = document.createElement("div");
    this.host.id = "oneshots-widget";
    this.host.setAttribute("data-theme", config.theme);

    // Set RTL direction for Arabic
    if (config.locale === "ar") {
      this.host.setAttribute("dir", "rtl");
    }

    // Attach shadow DOM
    this.shadow = this.host.attachShadow({ mode: "open" });

    this.render();
    this.bindEvents();

    document.body.appendChild(this.host);

    // Show greeting if configured
    if (config.greeting) {
      this.addMessage("assistant", config.greeting);
      // Show initial suggested replies after greeting
      if (config.suggestedReplies.length > 0) {
        this.showSuggestedReplies(config.suggestedReplies);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  private render(): void {
    // Inject styles
    const styleEl = document.createElement("style");
    styleEl.textContent = getStyles(
      this.config.primaryColor,
      this.config.width,
      this.config.height
    );
    this.shadow.appendChild(styleEl);

    // Container
    const container = document.createElement("div");
    container.className = "aos-container";
    container.setAttribute("data-position", this.config.position);
    if (this.config.locale === "ar") {
      container.setAttribute("dir", "rtl");
    }

    // Chat window
    this.window = document.createElement("div");
    this.window.className = "aos-window";
    this.window.setAttribute("data-open", "false");
    this.window.setAttribute("role", "dialog");
    this.window.setAttribute("aria-label", this.config.title);

    // Header
    const header = document.createElement("div");
    header.className = "aos-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "aos-header-left";

    // Logo (optional)
    if (this.config.logo) {
      const logo = document.createElement("img");
      logo.className = "aos-header-logo";
      logo.src = this.config.logo;
      logo.alt = this.config.title;
      headerLeft.appendChild(logo);
    }

    const title = document.createElement("span");
    title.className = "aos-header-title";
    title.textContent = this.config.title;
    headerLeft.appendChild(title);

    const headerActions = document.createElement("div");
    headerActions.className = "aos-header-actions";

    // New conversation button
    const newChatBtn = document.createElement("button");
    newChatBtn.className = "aos-new-chat-btn";
    newChatBtn.innerHTML = ICON_NEW_CHAT;
    newChatBtn.setAttribute("aria-label", this.strings.newChat);
    newChatBtn.title = this.strings.newChat;
    newChatBtn.type = "button";

    const closeBtn = document.createElement("button");
    closeBtn.className = "aos-close-btn";
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.type = "button";

    headerActions.appendChild(newChatBtn);
    headerActions.appendChild(closeBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerActions);

    // Messages
    this.messagesEl = document.createElement("div");
    this.messagesEl.className = "aos-messages";
    this.messagesEl.setAttribute("role", "log");
    this.messagesEl.setAttribute("aria-live", "polite");

    // File preview bar (hidden by default)
    this.filePreviewBar = document.createElement("div");
    this.filePreviewBar.className = "aos-file-preview-bar";
    this.filePreviewBar.style.display = "none";

    // Input bar
    const inputBar = document.createElement("div");
    inputBar.className = "aos-input-bar";

    // Hidden file input
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    this.fileInput.accept = "image/*,.pdf,.txt,.csv,.json,.md,.doc,.docx";
    this.fileInput.style.display = "none";

    // Attach button
    this.attachBtn = document.createElement("button");
    this.attachBtn.className = "aos-attach-btn";
    this.attachBtn.innerHTML = ICON_ATTACH;
    this.attachBtn.setAttribute("aria-label", this.strings.upload);
    this.attachBtn.title = this.strings.upload;
    this.attachBtn.type = "button";

    this.inputEl = document.createElement("textarea");
    this.inputEl.className = "aos-input";
    this.inputEl.placeholder = this.config.placeholder;
    this.inputEl.setAttribute("aria-label", "Message input");
    this.inputEl.rows = 1;

    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "aos-send-btn";
    this.sendBtn.innerHTML = ICON_SEND;
    this.sendBtn.setAttribute("aria-label", this.strings.send);
    this.sendBtn.type = "button";

    inputBar.appendChild(this.fileInput);
    inputBar.appendChild(this.attachBtn);
    inputBar.appendChild(this.inputEl);
    inputBar.appendChild(this.sendBtn);

    // Powered-by footer
    const powered = document.createElement("div");
    powered.className = "aos-powered";
    if (this.config.hidePoweredBy) {
      powered.style.display = "none";
    }
    const poweredLabel = this.strings.powered;
    powered.innerHTML = `${poweredLabel.replace(
      "OneShots",
      '<a href="https://oneshots.co" target="_blank" rel="noopener noreferrer">OneShots</a>'
    )}`;

    // Assemble window
    this.window.appendChild(header);
    this.window.appendChild(this.messagesEl);
    this.window.appendChild(this.filePreviewBar);
    this.window.appendChild(inputBar);
    this.window.appendChild(powered);

    // FAB
    this.fab = document.createElement("button");
    this.fab.className = "aos-fab";
    if (this.config.launcherIcon) {
      this.fab.innerHTML = `<img src="${this.config.launcherIcon}" alt="Chat" class="aos-fab-custom-icon" />`;
    } else {
      this.fab.innerHTML = ICON_CHAT;
    }
    this.fab.setAttribute("aria-label", "Open chat");
    this.fab.setAttribute("aria-expanded", "false");
    this.fab.type = "button";

    container.appendChild(this.window);
    container.appendChild(this.fab);

    this.shadow.appendChild(container);
  }

  /* ---------------------------------------------------------------- */
  /*  Event binding                                                    */
  /* ---------------------------------------------------------------- */

  private bindEvents(): void {
    // Toggle open/close
    this.fab.addEventListener("click", () => this.toggle());

    const closeBtn = this.shadow.querySelector<HTMLButtonElement>(".aos-close-btn")!;
    closeBtn.addEventListener("click", () => this.close());

    // New conversation
    const newChatBtn = this.shadow.querySelector<HTMLButtonElement>(".aos-new-chat-btn")!;
    newChatBtn.addEventListener("click", () => this.resetConversation());

    // Send message
    this.sendBtn.addEventListener("click", () => this.handleSend());

    // File attach
    this.attachBtn.addEventListener("click", () => this.fileInput.click());
    this.fileInput.addEventListener("change", () => this.handleFileSelect());

    // Enter to send (shift+enter for newline)
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Auto-resize textarea
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + "px";
    });

    // Close on Escape
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.isOpen) {
        this.close();
        this.fab.focus();
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Open / close                                                     */
  /* ---------------------------------------------------------------- */

  private toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    this.isOpen = true;
    this.window.setAttribute("data-open", "true");
    this.fab.setAttribute("aria-expanded", "true");
    this.fab.setAttribute("aria-label", "Close chat");
    // Focus the input after animation
    setTimeout(() => this.inputEl.focus(), 300);
    window.dispatchEvent(new CustomEvent("oneshots:open"));
  }

  private close(): void {
    this.isOpen = false;
    this.window.setAttribute("data-open", "false");
    this.fab.setAttribute("aria-expanded", "false");
    this.fab.setAttribute("aria-label", "Open chat");
    window.dispatchEvent(new CustomEvent("oneshots:close"));
  }

  /* ---------------------------------------------------------------- */
  /*  Messages                                                         */
  /* ---------------------------------------------------------------- */

  private addMessage(
    role: "user" | "assistant",
    content: string
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = `aos-message aos-message--${role}`;
    el.setAttribute("role", "article");

    if (role === "assistant") {
      el.innerHTML = renderMarkdown(content);
    } else {
      el.textContent = content;
    }

    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private addTypingIndicator(): HTMLElement {
    const el = document.createElement("div");
    el.className = "aos-typing";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", "Agent is typing");
    el.innerHTML = `
      <span class="aos-typing-dot"></span>
      <span class="aos-typing-dot"></span>
      <span class="aos-typing-dot"></span>
    `;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private addStreamingMessage(): HTMLElement {
    const el = document.createElement("div");
    el.className = "aos-message aos-message--assistant";
    el.setAttribute("role", "article");
    el.innerHTML = '<span class="aos-cursor"></span>';
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private addErrorMessage(text: string): void {
    const el = document.createElement("div");
    el.className = "aos-error";
    el.setAttribute("role", "alert");
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  /* ---------------------------------------------------------------- */
  /*  File upload                                                       */
  /* ---------------------------------------------------------------- */

  private handleFileSelect(): void {
    const files = this.fileInput.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      this.pendingFiles.push(files[i]);
    }

    this.renderFilePreview();
    // Reset input so same file can be selected again
    this.fileInput.value = "";
  }

  private renderFilePreview(): void {
    if (this.pendingFiles.length === 0) {
      this.filePreviewBar.style.display = "none";
      this.filePreviewBar.innerHTML = "";
      return;
    }

    this.filePreviewBar.style.display = "flex";
    this.filePreviewBar.innerHTML = "";

    for (let i = 0; i < this.pendingFiles.length; i++) {
      const file = this.pendingFiles[i];
      const chip = document.createElement("div");
      chip.className = "aos-file-chip";

      const sizeStr = file.size < 1024
        ? `${file.size} B`
        : file.size < 1048576
          ? `${(file.size / 1024).toFixed(1)} KB`
          : `${(file.size / 1048576).toFixed(1)} MB`;

      const nameSpan = document.createElement("span");
      nameSpan.className = "aos-file-chip-name";
      nameSpan.textContent = `${file.name} (${sizeStr})`;

      const removeBtn = document.createElement("button");
      removeBtn.className = "aos-file-chip-remove";
      removeBtn.innerHTML = ICON_REMOVE;
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", `Remove ${file.name}`);

      const index = i;
      removeBtn.addEventListener("click", () => {
        this.pendingFiles.splice(index, 1);
        this.renderFilePreview();
      });

      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      this.filePreviewBar.appendChild(chip);
    }
  }

  private clearPendingFiles(): void {
    this.pendingFiles = [];
    this.renderFilePreview();
  }

  /* ---------------------------------------------------------------- */
  /*  Suggested replies                                                */
  /* ---------------------------------------------------------------- */

  private showSuggestedReplies(replies: string[]): void {
    // Remove any existing suggested replies
    const existing = this.messagesEl.querySelector(".aos-suggested-replies");
    if (existing) existing.remove();

    if (replies.length === 0) return;

    const container = document.createElement("div");
    container.className = "aos-suggested-replies";

    for (const text of replies) {
      const chip = document.createElement("button");
      chip.className = "aos-reply-chip";
      chip.textContent = text;
      chip.type = "button";
      chip.addEventListener("click", () => {
        container.remove();
        this.inputEl.value = text;
        this.handleSend();
      });
      container.appendChild(chip);
    }

    this.messagesEl.appendChild(container);
    this.scrollToBottom();
  }

  /* ---------------------------------------------------------------- */
  /*  Reset / new conversation                                         */
  /* ---------------------------------------------------------------- */

  private resetConversation(): void {
    this.conversationId = null;
    this.messagesEl.innerHTML = "";
    this.clearPendingFiles();
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";

    // Re-add greeting if configured
    if (this.config.greeting) {
      this.addMessage("assistant", this.config.greeting);
      if (this.config.suggestedReplies.length > 0) {
        this.showSuggestedReplies(this.config.suggestedReplies);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Event dispatch helper                                            */
  /* ---------------------------------------------------------------- */

  private dispatchWidgetEvent(name: string, detail?: Record<string, unknown>): void {
    window.dispatchEvent(
      new CustomEvent(`oneshots:${name}`, detail ? { detail } : undefined)
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Send / stream                                                    */
  /* ---------------------------------------------------------------- */

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isStreaming) return;

    // Remove any existing suggested reply chips
    const existingReplies = this.messagesEl.querySelector(".aos-suggested-replies");
    if (existingReplies) existingReplies.remove();

    // Capture files before clearing
    const filesToSend = [...this.pendingFiles];

    // Add user message
    this.addMessage("user", text);
    this.dispatchWidgetEvent("message", { role: "user", content: text });

    // Clear input and files
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.clearPendingFiles();

    // Disable input during streaming
    this.isStreaming = true;
    this.sendBtn.disabled = true;
    this.inputEl.disabled = true;

    try {
      // Create conversation on first message
      if (!this.conversationId) {
        const conv = await createConversation(
          this.config.baseUrl,
          this.config.apiKey,
          this.config.agent
        );
        this.conversationId = conv.conversation_id;
      }

      // Show typing indicator
      const typingEl = this.addTypingIndicator();

      // Start streaming -- use upload endpoint if files present
      let stream: AsyncGenerator<string, void, unknown>;
      if (filesToSend.length > 0) {
        stream = await uploadAndRun(
          this.config.baseUrl,
          this.config.apiKey,
          this.config.agent,
          text,
          filesToSend,
          this.conversationId
        );
      } else {
        stream = streamMessage(
          this.config.baseUrl,
          this.config.apiKey,
          this.config.agent,
          text,
          this.conversationId
        );
      }

      let accumulated = "";
      let streamingEl: HTMLElement | null = null;

      for await (const token of stream) {
        // Replace typing indicator with streaming message on first token
        if (!streamingEl) {
          typingEl.remove();
          streamingEl = this.addStreamingMessage();
        }

        accumulated += token;
        // Render markdown and append cursor
        streamingEl.innerHTML =
          renderMarkdown(accumulated) + '<span class="aos-cursor"></span>';
        this.scrollToBottom();
      }

      // Finalize: remove cursor, render final markdown
      if (streamingEl) {
        streamingEl.innerHTML = renderMarkdown(accumulated);
      } else {
        // No tokens received -- remove typing indicator
        typingEl.remove();
        if (!accumulated) {
          this.addErrorMessage(this.strings.error);
        }
      }

      // Dispatch assistant message event
      if (accumulated) {
        this.dispatchWidgetEvent("message", { role: "assistant", content: accumulated });

        // Show suggested replies after assistant response
        if (this.config.suggestedReplies.length > 0) {
          this.showSuggestedReplies(this.config.suggestedReplies);
        }
      }
    } catch (err) {
      // Remove any typing indicators
      const typing = this.messagesEl.querySelector(".aos-typing");
      if (typing) typing.remove();

      const message =
        err instanceof Error ? err.message : this.strings.error;
      this.addErrorMessage(message);
      this.dispatchWidgetEvent("error", { error: message });
      console.error("[OneShots Widget]", err);
    } finally {
      this.isStreaming = false;
      this.sendBtn.disabled = false;
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Auto-initialize                                                    */
/* ------------------------------------------------------------------ */

function init(): void {
  try {
    const config = readConfig();
    new AgentOSWidget(config);
  } catch (err) {
    console.error("[OneShots Widget]", err);
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
