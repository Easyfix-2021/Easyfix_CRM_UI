'use client';

/*
 * Common app-wide confirmation dialog. Replaces native `window.confirm()` /
 * `alert()` so we don't get the jarring Chrome "localhost:5180 says..." popup.
 *
 * Two surfaces:
 *
 *   1. `<ConfirmDialog>` — fully-controlled component. Use for truly complex
 *      confirmations that want their own layout or side-effects.
 *
 *   2. `useConfirm()` hook (default export) — exposes `confirm(opts)` that
 *      returns a Promise<boolean>. Mirrors the native API so call sites can do
 *      `if (!(await confirm({...}))) return;` with minimal ceremony.
 *
 * A single <ConfirmDialogHost /> mounted near the app root backs the hook;
 * see app/(authed)/layout.tsx.
 */

import * as React from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from './dialog';
import { Button } from './button';

export type ConfirmOptions = {
  title?: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  /*
   * Optional lucide-icon ReactNode rendered next to the title inside the
   * header band. Gives the operator instant visual context (a phone icon
   * for a call confirm, a warn icon for a destructive action) instead of
   * forcing them to parse the title text. Caller supplies the element
   * with whatever sizing they want; the dialog wraps it in a circular
   * tinted plate for visual weight.
   */
  icon?: React.ReactNode;
  /* Optional accent for the icon plate. Defaults to sky (matches the
   * portal's sidebar accent line). Pass 'emerald' for positive-action
   * confirms (place call, send notification), 'rose' for destructive. */
  iconAccent?: 'sky' | 'emerald' | 'rose' | 'amber';
  /*
   * Retracts the prompt when the thing it is asking about stops being true.
   *
   * `description` is a ReactNode built ONCE at call time and stored as a
   * value — it is a snapshot, not a subscription, so anything interpolated
   * into it (a head-count, a status) freezes at the instant of the call while
   * the surface behind the dialog keeps polling. That is how the live-call
   * panel came to show "Call Ended · 0 on this call" underneath a dialog
   * insisting the call was "still running with 1", and pointing at an End Call
   * control the panel had already removed.
   *
   * A caller whose prompt has a premise passes a signal and aborts it when the
   * premise clears; the dialog closes and the promise resolves FALSE — the
   * safe answer, since a retracted question was never answered. An
   * AbortSignal rather than an exposed close() because it is scoped to the
   * caller by construction: there is no way to spell "cancel somebody else's
   * dialog".
   */
  signal?: AbortSignal;
};

type ConfirmState = ConfirmOptions & {
  open: boolean;
  resolve?: (result: boolean) => void;
  /* Identifies WHICH prompt is on screen, so a late abort from a prompt that
   * has already been superseded cannot close the one that replaced it. */
  id?: number;
};

const DEFAULTS: Required<Pick<ConfirmOptions, 'title' | 'confirmLabel' | 'cancelLabel' | 'variant'>> = {
  title: 'Are you sure?',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  variant: 'default',
};

type ConfirmFn = (opts?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/*
 * Accent palettes for the optional icon plate. Tailwind classes are
 * spelled out so the JIT compiler picks them up at build time —
 * dynamic class composition with template strings doesn't survive
 * the purge pass. Each tone uses a translucent backplate over the
 * dark header band so the icon glow reads against the ink gradient.
 */
function accentPlateClass(accent?: 'sky' | 'emerald' | 'rose' | 'amber'): string {
  switch (accent) {
    case 'emerald': return 'bg-success/20 ring-1 ring-success/40 text-success-tint dark:text-success-strong';
    case 'rose':    return 'bg-destructive/20 ring-1 ring-urgent/40 text-urgent-tint dark:text-urgent-strong';
    case 'amber':   return 'bg-warning/20 ring-1 ring-warning/40 text-warning-tint dark:text-warning-strong';
    case 'sky':
    default:        return 'bg-info/20 ring-1 ring-info/40 text-info-tint dark:text-info-strong';
  }
}

/*
 * Provider — renders a single hidden dialog instance and wires the imperative
 * confirm() API. Only one confirmation is shown at a time; a second call
 * while one is open auto-rejects the prior promise so the UI stays coherent.
 */
export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmState>({ open: false });

  const idRef = React.useRef(0);

  const confirm: ConfirmFn = React.useCallback((opts?: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const signal = opts?.signal;
      // Already stale before it opened — never show it at all.
      if (signal?.aborted) { resolve(false); return; }

      const id = ++idRef.current;
      setState((prev) => {
        // Resolve any outstanding confirmation to false so callers that race
        // don't deadlock waiting on a promise whose dialog just got replaced.
        if (prev.open && prev.resolve) prev.resolve(false);
        return { ...opts, open: true, resolve, id };
      });

      signal?.addEventListener('abort', () => {
        setState((prev) => {
          // Ours only. A prompt that has since been replaced must not have its
          // abort tear down the replacement.
          if (prev.id !== id) return prev;
          if (prev.resolve) prev.resolve(false);
          return { ...prev, open: false, resolve: undefined };
        });
      }, { once: true });
    });
  }, []);

  function settle(result: boolean) {
    setState((prev) => {
      if (prev.resolve) prev.resolve(result);
      return { ...prev, open: false, resolve: undefined };
    });
  }

  const title        = state.title        ?? DEFAULTS.title;
  const confirmLabel = state.confirmLabel ?? DEFAULTS.confirmLabel;
  const cancelLabel  = state.cancelLabel  ?? DEFAULTS.cancelLabel;
  const variant      = state.variant      ?? DEFAULTS.variant;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state.open} onOpenChange={(o) => { if (!o) settle(false); }}>
        {/* `!p-0 !gap-0` opts out of DialogContent's default 24px padding +
            16px grid gap so we have explicit control of every section's
            spacing. Without this opt-out, every child accumulates 24px of
            outer padding AND 16px of inter-section gap, which is what made
            the original confirm dialog look airy and empty. */}
        {/* overflow-y-auto (not overflow-hidden) so a long confirmation body
            stays reachable. `auto` still clips to the rounded corners, so the
            edge-to-edge header band keeps its clip — while a plain
            `overflow-hidden` here would out-merge DialogContent's base
            `overflow-y-auto` (tailwind-merge treats it as the same conflict
            group) and silently re-clip the content at 85vh. */}
        <DialogContent noPadding className="sm:max-w-md !gap-0 overflow-x-hidden overflow-y-auto">
          {/* HEADER — dark slate band, edge-to-edge.
              `!mx-0 !mt-0` cancels the negative margins DialogHeader uses
              to extend itself past DialogContent's default p-6 (we set
              p-0 above, so the negative margins would have pushed the
              header outside the dialog body). `!mb-0` removes the 20px
              bottom margin DialogHeader adds — the body's own pt-5 owns
              that spacing now. `!py-4` keeps the header band compact. */}
          <DialogHeader className="!py-4">
            {/*
             * `pr-10` (2026-06-05): the top-right close X is positioned
             * `absolute right-3 top-3 h-7 w-7` by DialogContent. Without
             * trailing padding the wrapped title text runs UNDER the
             * close button — visible on long titles like
             * `Deactivate "Level 1 Charging Stations - 120V AC /Up to
             * 3.3 kW"?`. 40px of right padding clears the 28px button
             * plus a 12px breathing buffer.
             */}
            <div className="flex items-center gap-3 pr-10">
              {state.icon && (
                <span
                  className={
                    'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ' +
                    accentPlateClass(state.iconAccent)
                  }
                >
                  {state.icon}
                </span>
              )}
              <DialogTitle className="flex-1 leading-tight">{title}</DialogTitle>
            </div>
          </DialogHeader>
          {/* BODY — description sits here with proper reading width and
              clean type colour. `pt-5 pb-6 px-6` is the intentional
              spacing; same horizontal inset as the header so the title
              and description align flush vertically. `text-[0.95rem]
              leading-relaxed` gives operators a comfortable read at a
              glance. `whitespace-pre-line` preserves \n in caller text.
              `asChild` merges DialogDescription's aria-describedby onto
              the <div> instead of rendering Radix's default <p>. Without
              it, a caller passing JSX with block-level children (e.g. a
              <div> verification chip) triggers an HTML invalid-nesting
              hydration error. */}
          {state.description && (
            <DialogDescription asChild>
              {/* Tailwind `!` modifiers force-override the shared
                  DialogDescription wrapper's defaults (text-[12px] +
                  text-ink-300/85) which are tuned for the dark
                  header band, not the white body. Without `!`, Radix
                  Slot concatenates classNames without tailwind-merge
                  and the wrapper's styles win via CSS source order,
                  leaving body text barely visible. */}
              <div className="px-6 pt-5 pb-6 !text-[0.95rem] leading-relaxed !text-foreground">
                {state.description}
              </div>
            </DialogDescription>
          )}
          {/* FOOTER — subtle top border + faintly-tinted background so the
              action zone reads as a distinct surface. The order is
              Cancel-on-left / primary-on-right per the portal-wide
              modal-footer convention. */}
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t bg-muted/30">
            <Button type="button" variant="outline" onClick={() => settle(false)}>
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant={variant === 'destructive' ? 'destructive' : 'default'}
              onClick={() => settle(true)}
              autoFocus
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/*
 * Hook consumed by call sites. Returns the async `confirm(opts)` function.
 * Throws if used outside the provider — fails fast instead of silently
 * no-opping (which would let a destructive action through).
 */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmDialogProvider>');
  return ctx;
}
