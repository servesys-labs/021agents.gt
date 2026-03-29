/**
 * All CSS for the OneShots chat widget.
 * Injected into Shadow DOM to isolate from host page styles.
 *
 * Uses CSS custom properties for theming -- the light/dark token sets
 * are toggled via the `[data-theme]` attribute on the widget root.
 */
export function getStyles(
  primaryColor: string,
  width: number = 380,
  height: number = 600
): string {
  return `
/* ------------------------------------------------------------------ */
/*  Design tokens                                                      */
/* ------------------------------------------------------------------ */

:host {
  /* --- Primitive scale --- */
  --aos-space-1: 4px;
  --aos-space-2: 8px;
  --aos-space-3: 12px;
  --aos-space-4: 16px;
  --aos-space-5: 24px;
  --aos-space-6: 32px;
  --aos-space-7: 40px;
  --aos-space-8: 48px;

  --aos-radius-sm: 8px;
  --aos-radius-md: 12px;
  --aos-radius-lg: 16px;
  --aos-radius-full: 9999px;

  --aos-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Oxygen, Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif;
  --aos-font-size-xs: 0.75rem;
  --aos-font-size-sm: 0.8125rem;
  --aos-font-size-base: 0.875rem;
  --aos-font-size-lg: 1rem;
  --aos-font-size-xl: 1.125rem;

  --aos-line-height-body: 1.5;
  --aos-line-height-heading: 1.25;

  --aos-font-weight-normal: 400;
  --aos-font-weight-medium: 500;
  --aos-font-weight-semibold: 600;

  --aos-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --aos-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.1);
  --aos-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.15);
  --aos-shadow-xl: 0 12px 40px rgba(0, 0, 0, 0.2);

  --aos-transition-fast: 150ms ease;
  --aos-transition-normal: 250ms ease;
  --aos-transition-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);

  /* --- Primary color --- */
  --aos-primary: ${primaryColor};
  --aos-primary-hover: color-mix(in srgb, ${primaryColor} 85%, #000);
  --aos-primary-text: #fff;

  /* --- Semantic tokens: light (default) --- */
  --aos-bg-primary: #ffffff;
  --aos-bg-secondary: #f9fafb;
  --aos-bg-tertiary: #f3f4f6;
  --aos-bg-input: #ffffff;
  --aos-bg-assistant: #f3f4f6;

  --aos-text-primary: #111827;
  --aos-text-secondary: #6b7280;
  --aos-text-tertiary: #9ca3af;
  --aos-text-inverse: #f9fafb;

  --aos-border-primary: #e5e7eb;
  --aos-border-secondary: #f3f4f6;

  --aos-focus-ring: 0 0 0 2px #fff, 0 0 0 4px ${primaryColor};

  /* Widget dimensions */
  --aos-widget-width: ${width}px;
  --aos-widget-height: ${height}px;
  --aos-fab-size: 56px;
  --aos-header-height: 56px;
}

/* --- Dark theme token overrides --- */
:host([data-theme="dark"]) {
  --aos-bg-primary: #111827;
  --aos-bg-secondary: #1f2937;
  --aos-bg-tertiary: #374151;
  --aos-bg-input: #1f2937;
  --aos-bg-assistant: #1f2937;

  --aos-text-primary: #f3f4f6;
  --aos-text-secondary: #d1d5db;
  --aos-text-tertiary: #9ca3af;
  --aos-text-inverse: #111827;

  --aos-border-primary: #374151;
  --aos-border-secondary: #1f2937;

  --aos-primary-text: #fff;
  --aos-focus-ring: 0 0 0 2px #111827, 0 0 0 4px ${primaryColor};

  --aos-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.3);
  --aos-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.4);
  --aos-shadow-xl: 0 12px 40px rgba(0, 0, 0, 0.5);
}

/* ------------------------------------------------------------------ */
/*  Reset & base                                                       */
/* ------------------------------------------------------------------ */

*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* ------------------------------------------------------------------ */
/*  Container                                                          */
/* ------------------------------------------------------------------ */

.aos-container {
  position: fixed;
  z-index: 2147483647;
  font-family: var(--aos-font-family);
  font-size: var(--aos-font-size-base);
  line-height: var(--aos-line-height-body);
  color: var(--aos-text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.aos-container[data-position="bottom-right"] {
  bottom: var(--aos-space-5);
  right: var(--aos-space-5);
}

.aos-container[data-position="bottom-left"] {
  bottom: var(--aos-space-5);
  left: var(--aos-space-5);
}

/* ------------------------------------------------------------------ */
/*  FAB (floating action button)                                       */
/* ------------------------------------------------------------------ */

.aos-fab {
  width: var(--aos-fab-size);
  height: var(--aos-fab-size);
  border-radius: var(--aos-radius-full);
  background: var(--aos-primary);
  color: var(--aos-primary-text);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--aos-shadow-lg);
  transition: transform var(--aos-transition-normal),
              box-shadow var(--aos-transition-normal),
              background var(--aos-transition-fast);
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.aos-fab:hover {
  transform: scale(1.05);
  box-shadow: var(--aos-shadow-xl);
  background: var(--aos-primary-hover);
}

.aos-fab:focus-visible {
  box-shadow: var(--aos-focus-ring);
}

.aos-fab:active {
  transform: scale(0.95);
}

.aos-fab svg {
  width: 24px;
  height: 24px;
  transition: transform var(--aos-transition-normal);
}

.aos-fab[aria-expanded="true"] svg {
  transform: rotate(90deg);
}

/* ------------------------------------------------------------------ */
/*  Chat window                                                        */
/* ------------------------------------------------------------------ */

.aos-window {
  position: absolute;
  bottom: calc(var(--aos-fab-size) + var(--aos-space-4));
  width: var(--aos-widget-width);
  height: var(--aos-widget-height);
  max-height: calc(100vh - 120px);
  background: var(--aos-bg-primary);
  border-radius: var(--aos-radius-lg);
  box-shadow: var(--aos-shadow-xl);
  border: 1px solid var(--aos-border-primary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Animation */
  opacity: 0;
  transform: translateY(16px) scale(0.96);
  pointer-events: none;
  transition: opacity var(--aos-transition-slow),
              transform var(--aos-transition-slow);
}

.aos-container[data-position="bottom-right"] .aos-window {
  right: 0;
}

.aos-container[data-position="bottom-left"] .aos-window {
  left: 0;
}

.aos-window[data-open="true"] {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

.aos-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--aos-space-3) var(--aos-space-4);
  min-height: var(--aos-header-height);
  background: var(--aos-primary);
  color: var(--aos-primary-text);
  flex-shrink: 0;
}

.aos-header-left {
  display: flex;
  align-items: center;
  gap: var(--aos-space-2);
  min-width: 0;
}

.aos-header-logo {
  width: 28px;
  height: 28px;
  border-radius: var(--aos-radius-sm);
  object-fit: contain;
  flex-shrink: 0;
}

.aos-header-title {
  font-size: var(--aos-font-size-lg);
  font-weight: var(--aos-font-weight-semibold);
  line-height: var(--aos-line-height-heading);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aos-header-actions {
  display: flex;
  align-items: center;
  gap: var(--aos-space-1);
  flex-shrink: 0;
}

.aos-close-btn,
.aos-new-chat-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--aos-primary-text);
  cursor: pointer;
  border-radius: var(--aos-radius-sm);
  transition: background var(--aos-transition-fast);
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.aos-close-btn:hover,
.aos-new-chat-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.aos-close-btn:focus-visible,
.aos-new-chat-btn:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8);
}

.aos-close-btn svg,
.aos-new-chat-btn svg {
  width: 20px;
  height: 20px;
}

/* ------------------------------------------------------------------ */
/*  Messages area                                                      */
/* ------------------------------------------------------------------ */

.aos-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--aos-space-4);
  background: var(--aos-bg-secondary);
  display: flex;
  flex-direction: column;
  gap: var(--aos-space-3);
  scroll-behavior: smooth;
}

/* Scrollbar styling */
.aos-messages::-webkit-scrollbar {
  width: 6px;
}
.aos-messages::-webkit-scrollbar-track {
  background: transparent;
}
.aos-messages::-webkit-scrollbar-thumb {
  background: var(--aos-border-primary);
  border-radius: var(--aos-radius-full);
}

/* ------------------------------------------------------------------ */
/*  Message bubbles                                                    */
/* ------------------------------------------------------------------ */

.aos-message {
  max-width: 85%;
  padding: var(--aos-space-3) var(--aos-space-4);
  border-radius: var(--aos-radius-md);
  font-size: var(--aos-font-size-base);
  line-height: var(--aos-line-height-body);
  word-wrap: break-word;
  overflow-wrap: break-word;
  animation: aos-fade-in var(--aos-transition-normal) ease;
}

@keyframes aos-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.aos-message--user {
  align-self: flex-end;
  background: var(--aos-primary);
  color: var(--aos-primary-text);
  border-bottom-right-radius: var(--aos-space-1);
}

.aos-message--assistant {
  align-self: flex-start;
  background: var(--aos-bg-assistant);
  color: var(--aos-text-primary);
  border-bottom-left-radius: var(--aos-space-1);
}

/* ------------------------------------------------------------------ */
/*  Markdown content inside assistant messages                         */
/* ------------------------------------------------------------------ */

.aos-message--assistant strong {
  font-weight: var(--aos-font-weight-semibold);
}

.aos-message--assistant em {
  font-style: italic;
}

.aos-message--assistant a {
  color: var(--aos-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.aos-message--assistant a:hover {
  opacity: 0.8;
}

.aos-message--assistant ul {
  padding-left: var(--aos-space-5);
  margin: var(--aos-space-2) 0;
}

.aos-message--assistant li {
  margin-bottom: var(--aos-space-1);
}

.aos-message--assistant .aos-inline-code {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
  font-size: var(--aos-font-size-sm);
  background: var(--aos-bg-tertiary);
  padding: 1px var(--aos-space-1);
  border-radius: 4px;
}

.aos-message--assistant .aos-code-block {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
  font-size: var(--aos-font-size-sm);
  background: var(--aos-bg-tertiary);
  padding: var(--aos-space-3);
  border-radius: var(--aos-radius-sm);
  overflow-x: auto;
  margin: var(--aos-space-2) 0;
  line-height: 1.6;
}

.aos-message--assistant .aos-code-block code {
  background: none;
  padding: 0;
}

.aos-message--assistant .aos-paragraph-break {
  height: var(--aos-space-3);
}

/* ------------------------------------------------------------------ */
/*  Typing indicator                                                   */
/* ------------------------------------------------------------------ */

.aos-typing {
  display: flex;
  gap: var(--aos-space-1);
  align-items: center;
  padding: var(--aos-space-3) var(--aos-space-4);
  align-self: flex-start;
  background: var(--aos-bg-assistant);
  border-radius: var(--aos-radius-md);
  border-bottom-left-radius: var(--aos-space-1);
  animation: aos-fade-in var(--aos-transition-normal) ease;
}

.aos-typing-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--aos-radius-full);
  background: var(--aos-text-tertiary);
  animation: aos-bounce 1.4s ease-in-out infinite;
}

.aos-typing-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.aos-typing-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes aos-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}

/* Streaming cursor */
.aos-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--aos-text-primary);
  margin-left: 1px;
  vertical-align: text-bottom;
  animation: aos-blink 0.8s step-end infinite;
}

@keyframes aos-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ------------------------------------------------------------------ */
/*  Input bar                                                          */
/* ------------------------------------------------------------------ */

.aos-input-bar {
  display: flex;
  align-items: flex-end;
  gap: var(--aos-space-2);
  padding: var(--aos-space-3) var(--aos-space-4);
  border-top: 1px solid var(--aos-border-primary);
  background: var(--aos-bg-primary);
  flex-shrink: 0;
}

.aos-input {
  flex: 1;
  min-height: 44px;
  max-height: 120px;
  padding: var(--aos-space-2) var(--aos-space-3);
  border: 1px solid var(--aos-border-primary);
  border-radius: var(--aos-radius-sm);
  background: var(--aos-bg-input);
  color: var(--aos-text-primary);
  font-family: var(--aos-font-family);
  font-size: var(--aos-font-size-base);
  line-height: var(--aos-line-height-body);
  resize: none;
  outline: none;
  transition: border-color var(--aos-transition-fast);
}

.aos-input::placeholder {
  color: var(--aos-text-tertiary);
}

.aos-input:focus {
  border-color: var(--aos-primary);
  box-shadow: 0 0 0 1px var(--aos-primary);
}

.aos-send-btn {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aos-primary);
  color: var(--aos-primary-text);
  border: none;
  border-radius: var(--aos-radius-sm);
  cursor: pointer;
  transition: background var(--aos-transition-fast),
              transform var(--aos-transition-fast);
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.aos-send-btn:hover:not(:disabled) {
  background: var(--aos-primary-hover);
}

.aos-send-btn:focus-visible {
  box-shadow: var(--aos-focus-ring);
}

.aos-send-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.aos-send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.aos-send-btn svg {
  width: 20px;
  height: 20px;
}

/* ------------------------------------------------------------------ */
/*  Attach button                                                      */
/* ------------------------------------------------------------------ */

.aos-attach-btn {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--aos-text-secondary);
  border: 1px solid var(--aos-border-primary);
  border-radius: var(--aos-radius-sm);
  cursor: pointer;
  transition: background var(--aos-transition-fast),
              color var(--aos-transition-fast),
              border-color var(--aos-transition-fast);
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.aos-attach-btn:hover {
  background: var(--aos-bg-tertiary);
  color: var(--aos-text-primary);
  border-color: var(--aos-text-tertiary);
}

.aos-attach-btn:focus-visible {
  box-shadow: var(--aos-focus-ring);
}

.aos-attach-btn svg {
  width: 20px;
  height: 20px;
}

/* ------------------------------------------------------------------ */
/*  File preview bar                                                   */
/* ------------------------------------------------------------------ */

.aos-file-preview-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aos-space-2);
  padding: var(--aos-space-2) var(--aos-space-4);
  background: var(--aos-bg-primary);
  border-top: 1px solid var(--aos-border-secondary);
  flex-shrink: 0;
}

.aos-file-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--aos-space-1);
  padding: var(--aos-space-1) var(--aos-space-2);
  background: var(--aos-bg-tertiary);
  border-radius: var(--aos-radius-sm);
  font-size: var(--aos-font-size-xs);
  color: var(--aos-text-primary);
  max-width: 200px;
  animation: aos-fade-in var(--aos-transition-fast) ease;
}

.aos-file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aos-file-chip-remove {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--aos-text-tertiary);
  cursor: pointer;
  border-radius: var(--aos-radius-full);
  padding: 0;
  flex-shrink: 0;
  transition: color var(--aos-transition-fast), background var(--aos-transition-fast);
}

.aos-file-chip-remove:hover {
  color: var(--aos-text-primary);
  background: var(--aos-border-primary);
}

.aos-file-chip-remove svg {
  width: 12px;
  height: 12px;
}

/* ------------------------------------------------------------------ */
/*  Suggested reply chips                                              */
/* ------------------------------------------------------------------ */

.aos-suggested-replies {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aos-space-2);
  padding: var(--aos-space-1) 0;
  animation: aos-fade-in var(--aos-transition-normal) ease;
}

.aos-reply-chip {
  display: inline-flex;
  align-items: center;
  padding: var(--aos-space-2) var(--aos-space-3);
  background: var(--aos-bg-primary);
  color: var(--aos-primary);
  border: 1px solid var(--aos-primary);
  border-radius: var(--aos-radius-full);
  font-family: var(--aos-font-family);
  font-size: var(--aos-font-size-sm);
  font-weight: var(--aos-font-weight-medium);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--aos-transition-fast),
              color var(--aos-transition-fast);
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.aos-reply-chip:hover {
  background: var(--aos-primary);
  color: var(--aos-primary-text);
}

.aos-reply-chip:focus-visible {
  box-shadow: var(--aos-focus-ring);
}

/* ------------------------------------------------------------------ */
/*  Custom FAB icon                                                    */
/* ------------------------------------------------------------------ */

.aos-fab-custom-icon {
  width: 28px;
  height: 28px;
  object-fit: contain;
  border-radius: var(--aos-radius-full);
}

/* ------------------------------------------------------------------ */
/*  Error message                                                      */
/* ------------------------------------------------------------------ */

.aos-error {
  align-self: center;
  background: #fef2f2;
  color: #991b1b;
  font-size: var(--aos-font-size-sm);
  padding: var(--aos-space-2) var(--aos-space-3);
  border-radius: var(--aos-radius-sm);
  max-width: 90%;
  text-align: center;
}

:host([data-theme="dark"]) .aos-error {
  background: #450a0a;
  color: #fca5a5;
}

/* ------------------------------------------------------------------ */
/*  Powered by footer                                                  */
/* ------------------------------------------------------------------ */

.aos-powered {
  text-align: center;
  padding: var(--aos-space-1) var(--aos-space-4) var(--aos-space-2);
  font-size: var(--aos-font-size-xs);
  color: var(--aos-text-tertiary);
  background: var(--aos-bg-primary);
  flex-shrink: 0;
}

.aos-powered a {
  color: var(--aos-text-secondary);
  text-decoration: none;
}

.aos-powered a:hover {
  text-decoration: underline;
}

/* ------------------------------------------------------------------ */
/*  Mobile responsive: full-screen on small viewports                  */
/* ------------------------------------------------------------------ */

@media (max-width: 480px) {
  .aos-container {
    bottom: 0 !important;
    right: 0 !important;
    left: 0 !important;
  }

  .aos-fab {
    position: fixed;
    bottom: var(--aos-space-4);
    right: var(--aos-space-4);
  }

  .aos-container[data-position="bottom-left"] .aos-fab {
    right: auto;
    left: var(--aos-space-4);
  }

  .aos-window {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    border: none;
  }
}

/* ------------------------------------------------------------------ */
/*  RTL support (Arabic and other RTL languages)                       */
/* ------------------------------------------------------------------ */

:host([dir="rtl"]) .aos-message--user {
  align-self: flex-start;
  border-bottom-right-radius: var(--aos-radius-md);
  border-bottom-left-radius: var(--aos-space-1);
}

:host([dir="rtl"]) .aos-message--assistant {
  align-self: flex-end;
  border-bottom-left-radius: var(--aos-radius-md);
  border-bottom-right-radius: var(--aos-space-1);
}

:host([dir="rtl"]) .aos-message--assistant ul {
  padding-left: 0;
  padding-right: var(--aos-space-5);
}

:host([dir="rtl"]) .aos-typing {
  align-self: flex-end;
  border-bottom-left-radius: var(--aos-radius-md);
  border-bottom-right-radius: var(--aos-space-1);
}

:host([dir="rtl"]) .aos-input-bar {
  direction: rtl;
}

:host([dir="rtl"]) .aos-input {
  text-align: right;
}

:host([dir="rtl"]) .aos-cursor {
  margin-left: 0;
  margin-right: 1px;
}

:host([dir="rtl"]) .aos-header {
  direction: rtl;
}

:host([dir="rtl"]) .aos-powered {
  direction: rtl;
}

/* ------------------------------------------------------------------ */
/*  Reduced motion                                                     */
/* ------------------------------------------------------------------ */

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
}
