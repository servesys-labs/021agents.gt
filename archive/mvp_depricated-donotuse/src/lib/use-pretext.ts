import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { prepare, layout, type PreparedText } from "@chenglou/pretext";

// ── Font constants (must match CSS) ───────────────────────────
const MSG_FONT = "14px Inter, ui-sans-serif, system-ui, sans-serif";
const MSG_LINE_HEIGHT = 22; // leading-relaxed at 14px ≈ 22px
const BUBBLE_PADDING_X = 32; // px-4 = 16px * 2
const BUBBLE_PADDING_Y = 24; // py-3 = 12px * 2

// ── Types ─────────────────────────────────────────────────────

interface MeasuredMessage {
  id: string;
  prepared: PreparedText;
  text: string;
}

interface MessageHeight {
  id: string;
  height: number;
  lineCount: number;
}

/**
 * usePretext — pre-measures chat message text using @chenglou/pretext.
 *
 * prepare() runs once per unique message text (~0.04ms each).
 * layout() runs on every width change (~0.0002ms each) — safe to call
 * on every render, resize, or panel open/close.
 *
 * Returns a function that computes all message heights for a given
 * container width, plus a scroll-anchor helper.
 */
export function usePretext(messages: { id: string; content: string; role: string }[]) {
  // Cache prepared texts keyed by message id
  const cacheRef = useRef<Map<string, MeasuredMessage>>(new Map());

  // Prepare new messages (the expensive part — only runs for new messages)
  const measured = useMemo(() => {
    const cache = cacheRef.current;
    const result: MeasuredMessage[] = [];

    for (const msg of messages) {
      // Only measure text messages (user + assistant)
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      if (!msg.content) continue;

      let entry = cache.get(msg.id);
      if (!entry || entry.text !== msg.content) {
        try {
          entry = {
            id: msg.id,
            prepared: prepare(msg.content, MSG_FONT),
            text: msg.content,
          };
          cache.set(msg.id, entry);
        } catch {
          // If prepare fails (e.g. SSR), skip this message
          continue;
        }
      }
      result.push(entry);
    }

    // Prune stale entries
    const activeIds = new Set(messages.map((m) => m.id));
    for (const key of cache.keys()) {
      if (!activeIds.has(key)) cache.delete(key);
    }

    return result;
  }, [messages]);

  // Compute heights for a given container width (the cheap part)
  const computeHeights = useCallback(
    (containerWidth: number): MessageHeight[] => {
      if (containerWidth <= 0) return [];

      return measured.map((m) => {
        // Max bubble width is 85% of container minus padding
        const maxBubbleContent = containerWidth * 0.85 - BUBBLE_PADDING_X;
        const { height, lineCount } = layout(m.prepared, maxBubbleContent, MSG_LINE_HEIGHT);
        return {
          id: m.id,
          height: height + BUBBLE_PADDING_Y,
          lineCount,
        };
      });
    },
    [measured],
  );

  // Total height prediction for a given width
  const predictTotalHeight = useCallback(
    (containerWidth: number, gap = 16): number => {
      const heights = computeHeights(containerWidth);
      if (heights.length === 0) return 0;
      return heights.reduce((sum, h) => sum + h.height, 0) + (heights.length - 1) * gap;
    },
    [computeHeights],
  );

  return { measured, computeHeights, predictTotalHeight };
}

/**
 * useScrollAnchor — preserves scroll position when container width changes
 * (e.g. when meta panel opens/closes). Uses pretext to predict the new
 * scroll offset without waiting for DOM reflow.
 */
export function useScrollAnchor(
  scrollRef: React.RefObject<HTMLElement | null>,
  containerWidth: number,
  messageCount: number,
) {
  const prevWidthRef = useRef(containerWidth);
  const prevScrollRef = useRef({ top: 0, height: 0, clientHeight: 0 });

  // Capture scroll state before width change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    prevScrollRef.current = {
      top: el.scrollTop,
      height: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });

  // After width changes, restore relative scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const prevWidth = prevWidthRef.current;
    if (prevWidth === containerWidth) return;

    const prev = prevScrollRef.current;
    const wasAtBottom = prev.top + prev.clientHeight >= prev.height - 20;

    if (wasAtBottom) {
      // If user was at bottom, stay at bottom
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    } else if (prev.height > 0) {
      // Preserve proportional scroll position
      const ratio = prev.top / prev.height;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight * ratio;
      });
    }

    prevWidthRef.current = containerWidth;
  }, [containerWidth, scrollRef, messageCount]);
}
