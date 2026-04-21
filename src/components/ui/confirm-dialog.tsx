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
};

type ConfirmState = ConfirmOptions & {
  open: boolean;
  resolve?: (result: boolean) => void;
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
 * Provider — renders a single hidden dialog instance and wires the imperative
 * confirm() API. Only one confirmation is shown at a time; a second call
 * while one is open auto-rejects the prior promise so the UI stays coherent.
 */
export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmState>({ open: false });

  const confirm: ConfirmFn = React.useCallback((opts?: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState((prev) => {
        // Resolve any outstanding confirmation to false so callers that race
        // don't deadlock waiting on a promise whose dialog just got replaced.
        if (prev.open && prev.resolve) prev.resolve(false);
        return { ...opts, open: true, resolve };
      });
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {state.description && (
              <DialogDescription className="whitespace-pre-line pt-1">
                {state.description}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
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
