'use client';

/*
 * CallCustomNumbersDialog — QA-mode confirmation with two number inputs.
 *
 * Used only when the backend's GET /admin/calls/config returns
 * { promptForNumbers: true } (which mirrors the env flag
 * KALEYRA_CALLING_CUSTOM_NUMBER=true). For dev + production the simpler
 * useConfirm dialog runs instead.
 *
 * Why this exists: in QA we need to dial test-network numbers (one phone
 * a QA can answer for the operator leg, another for the receiver leg)
 * regardless of the logged-in operator's profile or the customer record.
 * Putting that prompt in a dedicated dialog keeps the simple consumer
 * flow (one-click confirm) untouched everywhere else.
 *
 * Visual treatment mirrors the upgraded ConfirmDialog primitive:
 *   - Dark slate header band with phone icon in an emerald-tinted plate
 *   - White body with form inputs and proper spacing
 *   - Footer bar: Cancel left, primary CTA right (portal-wide convention)
 */

import * as React from 'react';
import { Phone } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = {
  open: boolean;
  /** Default for the Call From field — usually qaDefaults.from from /config
   *  (env var KALEYRA_CALL_FROM) or falling back to the logged-in user's
   *  mobile. Operator can edit. */
  defaultFrom?: string;
  /** Default for the Call To field — usually qaDefaults.to from /config
   *  (env var KALEYRA_CALL_TO). Empty if the env var isn't set, in which
   *  case the operator must type from scratch. */
  defaultTo?: string;
  /** Called when operator clicks Cancel / closes / hits Esc. */
  onCancel: () => void;
  /** Called when operator confirms with two valid numbers. */
  onConfirm: (callFrom: string, callTo: string) => void;
};

/* Indian-phone shape acceptable to the backend's Joi validator. */
const PHONE_RX = /^[0-9]{10,12}$/;

function sanitize(v: string): string {
  return String(v || '').replace(/\D/g, '').slice(0, 12);
}

export function CallCustomNumbersDialog({
  open, defaultFrom = '', defaultTo = '', onCancel, onConfirm,
}: Props) {
  // Inputs are seeded on every open so reopening the dialog resets cleanly.
  // Both pre-fills come from props — typically qaDefaults from /config. When
  // KALEYRA_CALL_TO isn't set in env, defaultTo is empty and the operator
  // types from scratch (the explicit ask: "if KALEYRA_CALL_FROM/CALL_TO is
  // set, prefill it in modal").
  const [callFrom, setCallFrom] = React.useState(defaultFrom);
  const [callTo, setCallTo]     = React.useState(defaultTo);
  const [touched, setTouched]   = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setCallFrom(defaultFrom);
      setCallTo(defaultTo);
      setTouched(false);
    }
  }, [open, defaultFrom, defaultTo]);

  const fromOk = PHONE_RX.test(callFrom);
  const toOk   = PHONE_RX.test(callTo);
  const sameNumber = callFrom && callTo && callFrom === callTo;
  const canSubmit = fromOk && toOk && !sameNumber;

  function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onConfirm(callFrom, callTo);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      {/* `!p-0 !gap-0` opt-out of DialogContent defaults — same pattern as
          the upgraded ConfirmDialog primitive (see confirm-dialog.tsx).
          Lets each section own its padding instead of stacking 24+16+24px. */}
      <DialogContent className="sm:max-w-md !p-0 !gap-0 overflow-hidden">
        <DialogHeader className="!mx-0 !mt-0 !mb-0 !py-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 ring-1 ring-emerald-400/40 text-emerald-200">
              <Phone className="h-4 w-4" />
            </span>
            <DialogTitle className="flex-1 leading-tight">Place Call</DialogTitle>
          </div>
        </DialogHeader>

        {/* asChild here for symmetry with the ConfirmDialog primitive
            (same HTML-validity reasoning — keeps aria-describedby wiring
            intact while allowing block-level children if ever added). */}
        <DialogDescription asChild>
          <div className="px-6 pt-5 text-[0.95rem] leading-relaxed text-foreground">
            Specify the Call From and Call To numbers for this call. Both legs will be
            dialled by Kaleyra and bridged.
          </div>
        </DialogDescription>

        <form onSubmit={submit} className="px-6 pt-4 pb-5 space-y-3">
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
              <p className="text-xs text-rose-600">Enter 10 to 12 digits (optionally 91-prefixed).</p>
            )}
          </div>

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
              <p className="text-xs text-rose-600">Enter 10 to 12 digits (optionally 91-prefixed).</p>
            )}
            {sameNumber && (
              <p className="text-xs text-amber-700">
                Call From and Call To must be different — Kaleyra cannot bridge a line to itself.
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
