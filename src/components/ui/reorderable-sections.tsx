'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { GripVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { reorder } from '@/lib/reorder';
import { cn } from '@/lib/utils';
import { StatusChip } from '@/components/ui/StatusChip';

/*
 * ReorderableSections + SectionFrame — collapsible, drag-to-reorder sections.
 *
 * Lifted from My Orders -> Unconfirmed (components/job/UnconfirmedSections.tsx),
 * where the interaction was built and debugged, so a second page gets the SAME
 * one instead of a lookalike. Interaction, markup and a11y attributes are that
 * file's; the reasoning behind each piece is written up there. Unconfirmed
 * still carries its own inline copy and should move onto this — its only
 * difference is the mx-3 / pt-3 inset, which becomes `className="px-3 pt-3"`.
 *
 * WHAT IS SHARED
 *   - Order: drag a header, or focus its grip and press ArrowUp / ArrowDown.
 *     The destination is the GAP under the pointer (above or below a card's
 *     midpoint), drawn as a live bar; the arithmetic is lib/reorder.ts, which
 *     is unit-tested (tests/section-reorder.test.js).
 *   - Collapse: a chevron toggle. Only EXPLICIT choices are stored; a section
 *     without one is on auto (the caller decides: Unconfirmed opens it when it
 *     has rows, and keeps it open while the count is unknown).
 *   - A FLIP slide on reorder, so it is visible WHICH section moved; skipped
 *     under prefers-reduced-motion.
 *   - Persistence in localStorage under the caller's two keys — order and
 *     collapse stored separately, so a change to one shape never resets the
 *     other. Every access is wrapped: localStorage THROWS in a private window
 *     and with site data blocked.
 *
 * WHAT IS NOT: each section's fetch, count and pagination. The caller renders
 * each section through the render prop and wraps its body in <SectionFrame/>.
 */

// How long a section takes to slide to its new place after a reorder.
const REORDER_MS = 220;

type Keyed = { key: string };
type Choices = Record<string, boolean>; // key -> collapsed; absent = auto

/** What <ReorderableSections> hands each section; pass it on to <SectionFrame>. */
export type SectionControls = {
  index: number;
  /** The operator's pinned choice, or undefined to let the count decide. */
  explicitCollapsed: boolean | undefined;
  onToggle: (nextCollapsed: boolean) => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: (after: boolean) => void;
  onGripKey: (e: KeyboardEvent) => void;
  registerNode: (el: HTMLElement | null) => void;
};

/*
 * A saved order is a snapshot of the sections that existed the day it was
 * saved: unknown keys are dropped and new sections appended, never trusted
 * wholesale — a section added later would otherwise never render.
 */
function reconcile<S extends Keyed>(stored: unknown, sections: readonly S[]): S[] {
  const known = new Map(sections.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const out: S[] = [];
  if (Array.isArray(stored)) {
    for (const k of stored) {
      const s = typeof k === 'string' ? known.get(k) : undefined;
      if (s && !seen.has(s.key)) { out.push(s); seen.add(s.key); }
    }
  }
  for (const s of sections) if (!seen.has(s.key)) out.push(s);
  return out;
}

function loadCollapsed(storageKey: string): Choices {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const v = raw ? JSON.parse(raw) : null;
    // Unconfirmed's v1 shape: a bare array of collapsed keys. Converted rather
    // than discarded — those were deliberate choices.
    if (Array.isArray(v)) {
      return Object.fromEntries(v.filter((k) => typeof k === 'string').map((k) => [k, true]));
    }
    if (v && typeof v === 'object') {
      const out: Choices = {};
      for (const [k, val] of Object.entries(v)) if (typeof val === 'boolean') out[k] = val;
      return out;
    }
    return {};
  } catch {
    // Private window, blocked site data, corrupt JSON — auto is a correct page.
    return {};
  }
}

function loadOrder<S extends Keyed>(storageKey: string, sections: readonly S[]): S[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return reconcile(raw ? JSON.parse(raw) : null, sections);
  } catch {
    return [...sections];
  }
}

export function ReorderableSections<S extends Keyed>({
  sections,
  orderKey,
  collapsedKey,
  className,
  children,
}: {
  /** Every section, in default order. Keep the identity stable (module const or fetched meta). */
  sections: readonly S[] | undefined;
  /** localStorage key for the order — one per page, never shared. */
  orderKey: string;
  /** localStorage key for the explicit collapse choices — one per page. */
  collapsedKey: string;
  className?: string;
  children: (section: S, controls: SectionControls) => ReactNode;
}) {
  const [order, setOrder] = useState<S[]>([]);
  const [choices, setChoices] = useState<Choices>({});

  // Read on mount — localStorage exists only in the browser, and reading it
  // during render would differ between the server pass and the client one.
  useEffect(() => { setChoices(loadCollapsed(collapsedKey)); }, [collapsedKey]);

  useEffect(() => {
    if (sections?.length) {
      setOrder((prev) => (prev.length ? reconcile(prev.map((s) => s.key), sections) : loadOrder(orderKey, sections)));
    }
  }, [sections, orderKey]);

  /*
   * A click records an EXPLICIT choice and pins it, so a section the operator
   * shut does not spring open when a job lands in it, and one they opened does
   * not shut when it empties.
   */
  function toggle(key: string, nextCollapsed: boolean) {
    setChoices((prev) => {
      const next = { ...prev, [key]: nextCollapsed };
      try {
        window.localStorage.setItem(collapsedKey, JSON.stringify(next));
      } catch { /* applies for this visit; just will not survive a reload */ }
      return next;
    });
  }

  function persist(next: S[]) {
    setOrder(next);
    try {
      window.localStorage.setItem(orderKey, JSON.stringify(next.map((s) => s.key)));
    } catch {
      // Losing a display preference is not worth failing the interaction over.
    }
  }

  // ── Reordering: the destination is the gap under the pointer ─────────────
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Live DOM nodes, for measuring the slide.
  const nodes = useRef(new Map<string, HTMLElement>());
  const firstTops = useRef<Map<string, number> | null>(null);

  // FLIP: record every card's y BEFORE the state change, then (below) put each
  // card back where it was and release it, so the browser animates the move.
  function measureBefore() {
    const m = new Map<string, number>();
    for (const [k, el] of nodes.current) m.set(k, el.getBoundingClientRect().top);
    firstTops.current = m;
  }

  useLayoutEffect(() => {
    const first = firstTops.current;
    firstTops.current = null;
    if (!first) return;
    // Respect the OS setting: the reorder still happens, it just happens at once.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    // INVERT — every card back where it was, with no transition, before paint.
    const moved: HTMLElement[] = [];
    for (const [k, el] of nodes.current) {
      const was = first.get(k);
      if (was == null) continue;
      const delta = was - el.getBoundingClientRect().top;
      if (!delta) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      moved.push(el);
    }
    if (!moved.length) return;

    // PLAY — next frame, release them.
    const raf = requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = `transform ${REORDER_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        el.style.transform = '';
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [order]);

  // `to` is an insertion index in the CURRENT order — the gap the bar is drawn in.
  function move(fromKey: string, to: number) {
    const from = order.findIndex((s) => s.key === fromKey);
    const next = reorder(order, from, to);
    // reorder() returns a copy either way; only animate and store a real move.
    if (next.every((s, i) => s.key === order[i].key)) return;
    measureBefore();
    persist(next);
  }

  function endDrag() { setDragKey(null); setDropAt(null); }

  function onDrop() {
    if (dragKey && dropAt != null) move(dragKey, dropAt);
    endDrag();
  }

  // Keyboard reordering — the accessible path, and the precise one. Same move().
  function onGripKey(e: KeyboardEvent, idx: number, key: string) {
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    // One step down is "past the next card": idx + 2 before the source is removed.
    move(key, dir < 0 ? idx - 1 : idx + 2);
  }

  // The bar where the section would land. Suppressed when the drop would be a
  // no-op (either side of the dragged card), so it never promises a move.
  function indicator(at: number) {
    if (dragKey == null || dropAt !== at) return null;
    const from = order.findIndex((s) => s.key === dragKey);
    if (at === from || at === from + 1) return null;
    return <div className="mb-3 h-1 rounded-full bg-primary" aria-hidden />;
  }

  return (
    <div
      className={cn('flex flex-col', className)}
      onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
      onDrop={onDrop}
    >
      {order.map((s, idx) => (
        <div key={s.key}>
          {indicator(idx)}
          {children(s, {
            index: idx,
            explicitCollapsed: s.key in choices ? choices[s.key] : undefined,
            onToggle: (next) => toggle(s.key, next),
            dragging: dragKey === s.key,
            onDragStart: () => { setDragKey(s.key); setDropAt(idx); },
            onDragEnd: endDrag,
            onDragOverCard: (after) => { if (dragKey) setDropAt(idx + (after ? 1 : 0)); },
            onGripKey: (e) => onGripKey(e, idx, s.key),
            registerNode: (el) => {
              if (el) nodes.current.set(s.key, el); else nodes.current.delete(s.key);
            },
          })}
        </div>
      ))}
      {indicator(order.length)}
    </div>
  );
}

/*
 * One section's chrome: grip, collapse toggle, label, count chip, position.
 * The body (table, pagination) is `children`, and is not rendered at all while
 * collapsed.
 */
export function SectionFrame({
  label,
  subtitle,
  count,
  collapsed,
  controls,
  children,
}: {
  label: string;
  /** Optional muted line after the count chip. */
  subtitle?: string;
  /** null while unknown — an em dash, never a 0 that means "not loaded yet". */
  count: number | null;
  collapsed: boolean;
  controls: SectionControls;
  children: ReactNode;
}) {
  const { index, onToggle, dragging, onDragStart, onDragEnd, onDragOverCard, onGripKey, registerNode } = controls;
  return (
    <section
      ref={registerNode}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        // Which HALF the pointer is in decides before-or-after.
        onDragOverCard(e.clientY > r.top + r.height / 2);
      }}
      className={cn(
        'mb-3 rounded-lg border border-ink-100 overflow-hidden bg-surface transition-opacity',
        dragging && 'opacity-40',
      )}
    >
      <header
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex items-center gap-2 px-3 py-2 bg-surface-alt select-none"
      >
        {/* A real button so the grip can be tabbed to and moved with arrows. */}
        <button
          type="button"
          onKeyDown={onGripKey}
          aria-label={`Reorder ${label}: press the up or down arrow key to move this section`}
          title="Drag, or focus and use the arrow keys, to reorder"
          className="cursor-grab active:cursor-grabbing text-ink-300 hover:text-ink-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          <GripVertical className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => onToggle(!collapsed)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 flex-1 text-left"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4 text-ink-500" aria-hidden />
            : <ChevronDown className="w-4 h-4 text-ink-500" aria-hidden />}
          <span className="text-sm font-semibold text-ink-900">{label}</span>
          <StatusChip tone="info" size="sm">{count == null ? '—' : count.toLocaleString()}</StatusChip>
          {subtitle && <span className="text-xs text-ink-400">{subtitle}</span>}
        </button>
        <span className="text-xs text-ink-400">{index + 1}</span>
      </header>
      {collapsed ? null : children}
    </section>
  );
}
