/**
 * Auto-scroll controller for chat message containers.
 * Detects manual scroll-up to disable auto-scroll, re-enables on new sends.
 */

const BOTTOM_THRESHOLD = 48; // px from bottom to consider "at bottom"

export interface AutoScrollController {
  /** Call when a new message is sent to force re-enable auto-scroll */
  onNewMessage: () => void;
  /** Call from the container's scroll event */
  onScroll: () => void;
  /** Smoothly scroll to the bottom of the container */
  scrollToBottom: (smooth?: boolean) => void;
  /** Whether auto-scroll is currently enabled */
  isEnabled: () => boolean;
  /** Whether the container is currently at the bottom */
  isAtBottom: () => boolean;
  /** Attach the container element */
  setContainer: (el: HTMLElement | undefined) => void;
}

export function createAutoScrollController(): AutoScrollController {
  let container: HTMLElement | undefined;
  let enabled = true;
  let atBottom = true;

  function checkAtBottom(): boolean {
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
  }

  return {
    setContainer(el: HTMLElement | undefined) {
      container = el;
      if (el) {
        atBottom = checkAtBottom();
        enabled = atBottom;
      }
    },

    onNewMessage() {
      enabled = true;
      // Scroll on next frame so DOM has updated
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
          atBottom = true;
        }
      });
    },

    onScroll() {
      atBottom = checkAtBottom();
      if (!atBottom) {
        enabled = false;
      }
    },

    scrollToBottom(smooth = true) {
      if (!container) return;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: smooth ? "smooth" : "instant",
      });
      atBottom = true;
      enabled = true;
    },

    isEnabled() {
      return enabled;
    },

    isAtBottom() {
      return atBottom;
    },
  };
}
