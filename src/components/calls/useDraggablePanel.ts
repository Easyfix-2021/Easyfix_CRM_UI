/*
 * useDraggablePanel — draggable + collapsible behaviour for the fixed
 * bottom-right call panels (WebCallPanel / LiveCallPanel).
 *
 * Encapsulates:
 *   - Pointer-events drag from a header handle (no drag library), with the
 *     position clamped to stay fully inside the viewport (EDGE_GAP px gap).
 *   - Session-persisted position: the operator's chosen spot survives the
 *     panel unmounting between calls (the panels render null when idle, so
 *     component state would otherwise reset each call). Keyed per-panel so
 *     two panels never clobber each other's remembered spot.
 *   - A collapse toggle (full card ⇄ compact pill) that defaults back to
 *     expanded whenever a NEW call becomes active (`resetKey`).
 */

import * as React from 'react';

// Gap kept between the panel and the viewport edge while dragging / clamping.
const EDGE_GAP = 8;

// Fallback panel dimensions used before the element has measured itself.
const DEFAULT_W = 320;
const DEFAULT_H = 0;

type Pos = { x: number; y: number };

/*
 * Session-persisted drag positions, keyed per-panel. Module-level (NOT React
 * state) so the operator's chosen spot survives the panel unmounting between
 * calls. A missing entry means "use the default bottom-right anchor".
 */
const sessionPositions = new Map<string, Pos>();

// Clamp a candidate top-left so the panel stays fully inside the viewport.
function clampToViewport(x: number, y: number, w: number, h: number): Pos {
  const maxX = Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP);
  const maxY = Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP);
  return {
    x: Math.min(Math.max(EDGE_GAP, x), maxX),
    y: Math.min(Math.max(EDGE_GAP, y), maxY),
  };
}

export type DraggablePanel = {
  /** Attach to the panel root (the element that gets positioned + measured). */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Spread onto the panel root's `style` — pins it when drag-positioned. */
  style: React.CSSProperties;
  /** True once dragged (pin via style); false → keep the default CSS anchor. */
  positioned: boolean;
  /** Spread onto the header element to make it the drag handle. */
  headerHandlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
  /** Collapsed → compact pill; expanded is the default per new call. */
  collapsed: boolean;
  toggleCollapsed: () => void;
};

export function useDraggablePanel({
  sessionKey,
  resetKey,
}: {
  /** Per-panel key so panels don't clobber each other's remembered position. */
  sessionKey: string;
  /**
   * Identity of the current call. When it changes to a non-null value the
   * panel re-expands (a new call always opens expanded). Pass the call id.
   */
  resetKey: string | number | null;
}): DraggablePanel {
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Drag position (top-left, viewport px). null → default bottom-right anchor.
  const [pos, setPos] = React.useState<Pos | null>(() => sessionPositions.get(sessionKey) ?? null);
  // Collapsed → compact pill (status + timer + hangup); expanded is default.
  const [collapsed, setCollapsed] = React.useState(false);
  // Pointer offset between the grab point and the panel's top-left corner.
  const dragOffset = React.useRef<{ dx: number; dy: number } | null>(null);

  const commitPos = React.useCallback((next: Pos) => {
    sessionPositions.set(sessionKey, next); // persist for the session (survives remount between calls)
    setPos(next);
  }, [sessionKey]);

  // Default expanded whenever a NEW call becomes active. The panel may stay
  // mounted across calls (renders null when idle), so collapsed state would
  // otherwise persist from a previous call — reset it per call id.
  React.useEffect(() => {
    if (resetKey != null) setCollapsed(false);
  }, [resetKey]);

  // Keep the panel inside the viewport when the window resizes. Uses the
  // functional updater so it reads the latest position without re-subscribing.
  React.useEffect(() => {
    const onResize = () => {
      setPos((p) => {
        if (!p) return p;
        const el = containerRef.current;
        const next = clampToViewport(p.x, p.y, el?.offsetWidth ?? DEFAULT_W, el?.offsetHeight ?? DEFAULT_H);
        if (next.x === p.x && next.y === p.y) return p;
        sessionPositions.set(sessionKey, next);
        return next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sessionKey]);

  // Re-clamp after a collapse/expand toggle — expanding a panel dragged near
  // the bottom edge grows it downward, which could otherwise clip the body.
  React.useLayoutEffect(() => {
    setPos((p) => {
      if (!p) return p;
      const el = containerRef.current;
      if (!el) return p;
      const next = clampToViewport(p.x, p.y, el.offsetWidth, el.offsetHeight);
      if (next.x === p.x && next.y === p.y) return p;
      sessionPositions.set(sessionKey, next);
      return next;
    });
  }, [collapsed, sessionKey]);

  // ── Pointer-events drag from the header (no drag library) ──────────────
  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    // Never start a drag from an interactive control inside the header.
    if ((e.target as HTMLElement).closest('button')) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragOffset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    // Seed pos from the current on-screen rect so the first move doesn't jump
    // (needed while still on the default bottom-right CSS anchor).
    commitPos({ x: rect.left, y: rect.top });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [commitPos]);

  const onPointerMove = React.useCallback((e: React.PointerEvent) => {
    const off = dragOffset.current;
    if (!off) return;
    const el = containerRef.current;
    const next = clampToViewport(
      e.clientX - off.dx,
      e.clientY - off.dy,
      el?.offsetWidth ?? DEFAULT_W,
      el?.offsetHeight ?? DEFAULT_H,
    );
    commitPos(next);
  }, [commitPos]);

  const onPointerUp = React.useCallback((e: React.PointerEvent) => {
    if (!dragOffset.current) return;
    dragOffset.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const toggleCollapsed = React.useCallback(() => setCollapsed((c) => !c), []);

  const positioned = pos != null;
  // When positioned via drag, pin with left/top; otherwise keep the default
  // bottom-right anchor via the caller's Tailwind classes.
  const style: React.CSSProperties = positioned
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {};

  return {
    containerRef,
    style,
    positioned,
    headerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      style: { touchAction: 'none' },
    },
    collapsed,
    toggleCollapsed,
  };
}
