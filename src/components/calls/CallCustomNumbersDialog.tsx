'use client';

/*
 * CallCustomNumbersDialog — QA-mode confirmation with two number inputs.
 *
 * Shown when the chosen provider is in QA mode (its
 * `<PROVIDER>_CALLING_CUSTOM_NUMBER=true`). For dev + production the simpler
 * useConfirm dialog runs instead.
 *
 * Why this exists: in QA we dial test-network numbers (one phone a QA can
 * answer for the operator leg, another for the receiver leg) regardless of the
 * logged-in operator's profile or the customer record.
 *
 * Provider-aware (2026-06-19): when more than one provider is enabled the dialog
 * shows a provider radio FIRST, and the Call From / Call To fields pre-fill from
 * the SELECTED provider's defaults (KALEYRA_CALL_FROM/TO vs PLIVO_CALL_FROM/TO).
 * Switching the provider re-seeds the inputs. The chosen provider is returned to
 * the caller so the call is placed through it.
 */

import * as React from 'react';
import { Phone } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type ProviderDefaults = { from: string | null; to: string | null } | null;

type Props = {
  open: boolean;
  /** Providers the operator may pick from (those in QA mode). A radio renders
   *  only when length > 1; with one provider the call is single-provider. */
  providers: string[];
  /** Per-provider pre-fill numbers (env *_CALL_FROM / *_CALL_TO), keyed by
   *  provider name. Used to seed the inputs for the selected provider. */
  qaByProvider: Record<string, ProviderDefaults>;
  /** Provider selected on open. */
  initialProvider: string;
  /** Fallback for Call From when the selected provider has no *_CALL_FROM
   *  (e.g. the logged-in operator's own mobile). */
  fallbackFrom?: string;
  /** Web Call QA mode: there is no "Call From" leg (the browser is the caller),
   *  so hide the From field + provider radio and prompt ONLY for the number to
   *  dial (prefilled from PLIVO_CALL_TO). */
  toOnly?: boolean;
  /** Called when operator clicks Cancel / closes / hits Esc. */
  onCancel: () => void;
  /** Called when operator confirms with two valid numbers + the chosen provider. */
  onConfirm: (callFrom: string, callTo: string, provider: string) => void;
};

/* Indian-phone shape acceptable to the backend's Joi validator. */
const PHONE_RX = /^[0-9]{10,12}$/;

function sanitize(v: string): string {
  return String(v || '').replace(/\D/g, '').slice(0, 12);
}

function label(provider: string): string {
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'the provider';
}

export function CallCustomNumbersDialog({
  open, providers, qaByProvider, initialProvider, fallbackFrom = '', toOnly = false, onCancel, onConfirm,
}: Props) {
  const [provider, setProvider] = React.useState(initialProvider);
  const [callFrom, setCallFrom] = React.useState('');
  const [callTo, setCallTo]     = React.useState('');
  const [touched, setTouched]   = React.useState(false);

  // Seed the inputs from the SELECTED provider's defaults — on open, and again
  // whenever the operator switches provider (so the pre-fill always matches the
  // provider that will actually dial). Call From falls back to the operator's
  // own mobile when that provider has no *_CALL_FROM configured.
  const seedFor = React.useCallback((p: string) => {
    const d = qaByProvider[p] ?? null;
    setCallFrom(d?.from || fallbackFrom || '');
    setCallTo(d?.to || '');
    setTouched(false);
  }, [qaByProvider, fallbackFrom]);

  React.useEffect(() => {
    if (open) {
      setProvider(initialProvider);
      seedFor(initialProvider);
    }
  }, [open, initialProvider, seedFor]);

  function changeProvider(p: string) {
    setProvider(p);
    seedFor(p);
  }

  const fromOk = PHONE_RX.test(callFrom);
  const toOk   = PHONE_RX.test(callTo);
  const sameNumber = !toOnly && callFrom && callTo && callFrom === callTo;
  const canSubmit = toOnly ? toOk : (fromOk && toOk && !sameNumber);

  function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onConfirm(callFrom, callTo, provider);
  }

  const guardedOpenChange = useFormDirtyGuard(onCancel);
  const showProviderPicker = providers.length > 1;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/* overflow-y-auto (not overflow-hidden) so a long number list stays
          reachable; `auto` still clips to the rounded corners for the header
          band, while `overflow-hidden` would out-merge the base scroll. */}
      <DialogContent className="sm:max-w-md !p-0 !gap-0 overflow-x-hidden overflow-y-auto">
        <DialogHeader className="!mx-0 !mt-0 !mb-0 !py-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/20 ring-1 ring-success/40 text-success-tint">
              <Phone className="h-4 w-4" />
            </span>
            <DialogTitle className="flex-1 leading-tight">Place Call</DialogTitle>
          </div>
        </DialogHeader>

        <DialogDescription asChild>
          <div className="px-6 pt-5 !text-[0.95rem] leading-relaxed !text-foreground">
            {toOnly
              ? 'QA mode — enter the number to dial for this web call (prefilled from PLIVO_CALL_TO). The real customer is never called.'
              : `Specify the Call From and Call To numbers for this call. Both legs will be dialled by ${label(provider)} and bridged.`}
          </div>
        </DialogDescription>

        <form onSubmit={submit} className="px-6 pt-4 pb-5 space-y-3">
          {!toOnly && showProviderPicker && (
            <div className="space-y-1">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Calling Provider
              </Label>
              <div className="flex flex-wrap gap-4 pt-0.5">
                {providers.map((p) => (
                  <label key={p} className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground/90">
                    <input
                      type="radio"
                      name="ef-qa-call-provider"
                      value={p}
                      checked={provider === p}
                      onChange={() => changeProvider(p)}
                      className="h-4 w-4 accent-success"
                    />
                    Via {label(p)}
                  </label>
                ))}
              </div>
            </div>
          )}

          {!toOnly && (
            <div className="space-y-1">
              <Label htmlFor="call-from" className="text-xs uppercase tracking-wide text-muted-foreground">
                Call From
              </Label>
              <Input
                id="call-from"
                value={callFrom}
                onChange={(e) => setCallFrom(sanitize(e.target.value))}
                placeholder="10-12 digit Indian mobile"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                aria-invalid={touched && !fromOk}
              />
              {touched && callFrom && !fromOk && (
                <p className="text-xs text-urgent-strong">Enter 10 to 12 digits (optionally 91-prefixed).</p>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="call-to" className="text-xs uppercase tracking-wide text-muted-foreground">
              Call To
            </Label>
            <Input
              id="call-to"
              value={callTo}
              onChange={(e) => setCallTo(sanitize(e.target.value))}
              placeholder="10-12 digit Indian mobile"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={touched && !toOk}
            />
            {touched && callTo && !toOk && (
              <p className="text-xs text-urgent-strong">Enter 10 to 12 digits (optionally 91-prefixed).</p>
            )}
            {sameNumber && (
              <p className="text-xs text-warning-strong">
                Call From and Call To must be different — {label(provider)} cannot bridge a line to itself.
              </p>
            )}
          </div>
        </form>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t bg-muted/30">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => submit()}
            autoFocus
          >
            Call
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
