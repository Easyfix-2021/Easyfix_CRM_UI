'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TOAST_HOST_ATTR } from '@/lib/portal-markers';

/*
 * App-wide toast system. Imperative API so non-React code paths
 * (form submit handlers, async callbacks, error boundaries) can
 * trigger feedback without prop-drilling a toast function down the
 * tree.
 *
 * Design choices:
 *
 * 1. Custom-event bus instead of React Context. Anywhere in the
 *    codebase that can `import { showToast } from '@/components/ui/toast'`
 *    can fire one — even from outside React (utility functions,
 *    error handlers, fetch interceptors). No provider plumbing.
 *
 * 2. Bottom-centre portal. Matches the existing CallButton toast
 *    convention so the operator's eye learns ONE location for
 *    "thing happened, here's how it went."
 *
 * 3. Three variants:
 *    - `loading`  — persists until explicitly dismissed or replaced.
 *                   Use for in-flight operations (>500ms).
 *    - `success`  — auto-dismisses after 4s.
 *    - `error`    — auto-dismisses after 6s (long enough to read, short
 *                   enough that stacked failures don't block the page).
 *                   Operator can still dismiss earlier via the close
 *                   button. Was sticky until 2026-05-25 — ops feedback
 *                   was that 403s/transient API errors piled up and
 *                   covered the action buttons.
 *
 * 4. `showToast()` returns the toast id so the caller can dismiss
 *    or replace it explicitly. Common pattern for loading → success
 *    transitions:
 *      const id = showToast({ variant: 'loading', message: 'Saving…' });
 *      // ... do work ...
 *      dismissToast(id);
 *      showToast({ variant: 'success', message: 'Saved.' });
 *
 * 5. Multiple toasts stack vertically (newest at the bottom). In
 *    practice the loading→success pattern dismisses the loading one
 *    before showing the success one, so you usually see only one at
 *    a time.
 */

export type ToastVariant = 'success' | 'error' | 'loading';

type Toast = {
  id: number;
  variant: ToastVariant;
  message: string;
};

let toastIdCounter = 0;
const TOAST_EVENT   = 'easyfix:toast:show';
const DISMISS_EVENT = 'easyfix:toast:dismiss';

/*
 * Maximum simultaneous toasts (2026-05-28). When a 4th toast is
 * queued, the oldest VISIBLE toast is evicted to keep the stack at
 * MAX_TOAST_STACK. Picked 3 because:
 *   - one operation in progress + one warning + one transient hint
 *     is the realistic upper bound for a single user gesture;
 *   - more than that and the bottom toast obscures call-to-action
 *     buttons on shorter viewports (1080p Chrome at 100% zoom).
 *
 * Loading toasts are NEVER evicted automatically — they represent
 * in-flight work and disappearing one mid-request would leave the
 * operator unsure whether the work is still happening. Eviction
 * scans for the oldest NON-loading entry first.
 */
const MAX_TOAST_STACK = 3;

/* Imperative show. Returns the assigned id so callers can dismiss
 * or replace this specific toast. */
export function showToast(opts: { variant: ToastVariant; message: string }): number {
  const id = ++toastIdCounter;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { id, ...opts } }));
  }
  return id;
}

/* Imperative dismiss. Pass the id returned by `showToast()`. */
export function dismissToast(id: number): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DISMISS_EVENT, { detail: { id } }));
  }
}

/* Mount once at the app root (see app/(authed)/layout.tsx). Listens for
 * the custom events and renders the toast stack into document.body. */
export function ToastHost() {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  /*
   * `hiddenCount` (2026-05-28) — number of toasts that were dropped by
   * the MAX_TOAST_STACK eviction since the visible queue was last
   * empty. Surfaces as a small "+N earlier hidden" pill above the
   * stack so a burst of errors doesn't silently swallow the older
   * ones.
   *
   * Reset semantics: when `toasts.length` drops to 0 (every visible
   * toast has dismissed naturally or been clicked away), we consider
   * the burst "over" and clear the counter. The pill therefore tracks
   * eviction count PER-BURST, not the lifetime of the app — matching
   * the operator's expectation that "the loud period just ended, the
   * board is clear again."
   */
  const [hiddenCount, setHiddenCount] = React.useState(0);
  // Sync ref of hiddenCount so the timer-driven dismiss callbacks (which
  // close over their original render snapshot) can read the current
  // count without needing to be re-bound on every state change.
  const hiddenCountRef = React.useRef(hiddenCount);
  React.useEffect(() => { hiddenCountRef.current = hiddenCount; }, [hiddenCount]);

  React.useEffect(() => {
    const onShow = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((prev) => {
        // Replace any toast with the same id (rare but possible if a
        // caller re-fires with the same id) and append the new entry.
        const filtered = prev.filter((p) => p.id !== t.id);
        const next = [...filtered, t];
        // Stack cap (2026-05-28). When over MAX_TOAST_STACK, evict the
        // oldest non-loading entry first; only fall back to evicting a
        // loading toast if literally every visible toast is a loader
        // (extremely rare — would mean N concurrent in-flight calls).
        let evicted = 0;
        while (next.length > MAX_TOAST_STACK) {
          const evictIdx = next.findIndex((p) => p.variant !== 'loading');
          // -1 → no non-loading entries; remove oldest entry regardless
          // to keep the cap honest. Otherwise drop the oldest non-loader.
          next.splice(evictIdx === -1 ? 0 : evictIdx, 1);
          evicted += 1;
        }
        if (evicted > 0) {
          // Increment hidden-count by what we actually evicted in this
          // pass. Done inside the setter to keep render-state and ref
          // in lockstep — calling setHiddenCount here would batch but
          // a state-setter inside a state-setter is React's standard
          // way of staying within one transaction.
          setHiddenCount((h) => h + evicted);
        }
        return next;
      });
      // Note: setting timers below doesn't need to touch hiddenCount.
      // The natural-dismiss path empties `toasts` eventually, and the
      // reset-on-empty effect below clears the counter at that point.
      if (t.variant === 'success') {
        // Auto-dismiss success after 4s. Loading still stays until the
        // caller dismisses; error stacks were too aggressive at "sticky"
        // (see header comment) so they auto-dismiss after 6s now.
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((p) => p.id !== t.id));
        }, 4000);
      } else if (t.variant === 'error') {
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((p) => p.id !== t.id));
        }, 6000);
      }
    };
    const onDismiss = (e: Event) => {
      const { id } = (e as CustomEvent<{ id: number }>).detail;
      setToasts((prev) => prev.filter((p) => p.id !== id));
    };
    window.addEventListener(TOAST_EVENT,   onShow);
    window.addEventListener(DISMISS_EVENT, onDismiss);
    return () => {
      window.removeEventListener(TOAST_EVENT,   onShow);
      window.removeEventListener(DISMISS_EVENT, onDismiss);
    };
  }, []);

  // Reset hiddenCount whenever the visible queue empties — the burst is
  // considered over and the next eviction starts a fresh counter.
  React.useEffect(() => {
    if (toasts.length === 0 && hiddenCountRef.current !== 0) {
      setHiddenCount(0);
    }
  }, [toasts.length]);

  /*
   * One-shot pulse on hiddenCount increment (2026-05-28). Drives a
   * brief scale-up of the indicator pill so a fresh eviction is
   * visible even when the operator was looking at a toast rather
   * than the pill. The transition uses `transition-transform` so the
   * scale-down animates back smoothly — no jump. Rapid bursts
   * cancel the previous timer (via the cleanup) so the pill stays
   * elevated until the burst ends, then settles.
   *
   * 350ms is short enough to feel like a "tick", long enough that
   * the eye registers it. Matches the dashboard count-card pulse
   * cadence elsewhere in the app.
   */
  const [pulse, setPulse] = React.useState(false);
  React.useEffect(() => {
    if (hiddenCount === 0) { setPulse(false); return; }
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 350);
    return () => clearTimeout(t);
  }, [hiddenCount]);

  if (typeof document === 'undefined' || (toasts.length === 0 && hiddenCount === 0)) return null;

  // Interaction-blocking overlay activates whenever a `loading` toast is
  // present. Sits z-[9998] — below the toast itself (z-[9999]) so the
  // toast remains visible and clickable, but above every modal / page
  // surface so background clicks are absorbed during in-flight work.
  // `cursor: wait` gives a second visual signal that the page is busy.
  // Transparent (no backdrop tint) so the dialog underneath stays
  // readable — the toast carries the explicit "we're processing"
  // message.
  const isBlocking = toasts.some((t) => t.variant === 'loading');

  return createPortal(
    <>
      {isBlocking && (
        <div
          className="fixed inset-0 z-[9998] cursor-wait"
          // aria-hidden because the toast itself carries the operative
          // message; screen readers shouldn't announce an empty overlay.
          aria-hidden="true"
          // Capture every kind of pointer event so even keyboard-driven
          // activations of focused elements are stopped while busy.
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onKeyDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        />
      )}
      <div
        /*
         * Toast-host marker (2026-05-28) — read by Dialog's
         * outside-click guards so a click on the toast surface
         * doesn't dismiss the open modal. Attribute name + selector
         * live in `@/lib/portal-markers` so the producer (here) and
         * the consumer (Dialog) cannot drift on a rename.
         */
        {...TOAST_HOST_ATTR}
        className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none"
        aria-live="polite"
      >
        {/*
         * Overflow indicator (2026-05-28). Surfaces above the stack
         * when MAX_TOAST_STACK has evicted older toasts. Compact
         * (single-line, no icon, smaller text) so it never competes
         * with the actual toasts for the operator's attention — its
         * job is to admit "more happened than is visible", not to
         * deliver content. `pointer-events-none` keeps the badge
         * non-interactive; clicking through hits whatever sits under
         * the portal as usual.
         */}
        {hiddenCount > 0 && (
          <div
            /*
             * Pulse animation is gated by Tailwind's `motion-safe:`
             * variant — it only applies the scale-up/scale-down when
             * `prefers-reduced-motion: no-preference` is set on the
             * user's OS. Operators with the reduced-motion preference
             * see only the count update (which is the actual signal);
             * the bump-and-settle is purely a visual flourish.
             * `motion-reduce:scale-100` forces the static state for
             * extra safety on browsers that interpret motion-safe
             * differently.
             */
            className={`pointer-events-none rounded-full bg-slate-800/85 text-white text-[11px] font-medium px-2.5 py-0.5 shadow-md motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out motion-reduce:scale-100 ${pulse ? 'motion-safe:scale-110' : 'scale-100'}`}
            role="status"
            aria-label={`${hiddenCount} earlier toast${hiddenCount === 1 ? '' : 's'} hidden by stack cap`}
            title="Older toasts were hidden to keep the stack readable. Stack resets when current toasts clear."
          >
            +{hiddenCount} earlier hidden
          </div>
        )}
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDismiss={() => dismissToast(t.id)}
          />
        ))}
      </div>
    </>,
    document.body,
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto max-w-md min-w-[280px] shadow-xl rounded-lg px-4 py-3',
        'flex items-start gap-2 text-sm border',
        toast.variant === 'success' && 'bg-emerald-600 border-emerald-700 text-white',
        toast.variant === 'error'   && 'bg-rose-50 border-rose-300 text-rose-800',
        toast.variant === 'loading' && 'bg-slate-900 border-slate-700 text-white',
      )}
    >
      {toast.variant === 'success' && <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0 text-white" />}
      {toast.variant === 'error'   && <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0 text-rose-600" />}
      {toast.variant === 'loading' && <Loader2 className="h-5 w-5 mt-0.5 shrink-0 text-white animate-spin" />}
      <span className="flex-1 break-words font-medium">{toast.message}</span>
      {/* Loading variant intentionally has no dismiss button — caller
          dismisses it programmatically when the work completes. */}
      {toast.variant !== 'loading' && (
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            'rounded p-0.5 shrink-0',
            toast.variant === 'success' ? 'hover:bg-emerald-700/40 text-white' : 'hover:bg-rose-100 text-rose-700',
          )}
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
