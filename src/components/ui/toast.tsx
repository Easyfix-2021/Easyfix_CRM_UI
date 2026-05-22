'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

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
 *    - `error`    — sticky until manually dismissed (operator must
 *                   acknowledge failures).
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

  React.useEffect(() => {
    const onShow = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((prev) => {
        // Replace any toast with the same id (rare but possible if a
        // caller re-fires with the same id) and append the new entry.
        const filtered = prev.filter((p) => p.id !== t.id);
        return [...filtered, t];
      });
      if (t.variant === 'success') {
        // Auto-dismiss success after 4s. Loading + error stay until the
        // caller dismisses (or until error close button is clicked).
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((p) => p.id !== t.id));
        }, 4000);
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

  if (typeof document === 'undefined' || toasts.length === 0) return null;

  return createPortal(
    <div
      className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem
          key={t.id}
          toast={t}
          onDismiss={() => dismissToast(t.id)}
        />
      ))}
    </div>,
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
