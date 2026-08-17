'use client';

/*
 * EasyfixerMobileDialog — operator-driven change of a technician's mobile
 * number, from the Manage Easyfixers row action menu.
 *
 * Backend contract:
 *   PATCH /admin/easyfixers/:id/mobile
 *     body { mobile: string (10 digits), reason: string }
 *     200 → { efr_id, mobile }
 *     409 → another technician already holds that number (message explains)
 *
 * Why this is not "just another edit field":
 *   The mobile IS the technician's login identity — the app signs in by
 *   number + OTP (see project memory "Tech login identity resolution").
 *   Changing it changes which number they sign in with, so the dialog says
 *   that in one plain sentence rather than burying it in a warning block.
 *
 * The current number arrives from the list already bullet-masked by the BE
 * response middleware — it is rendered verbatim and deliberately NOT
 * unmasked here (the CRM never holds the clear digits).
 *
 * Conventions honoured: shared Dialog / Input / Label / Button primitives,
 * showToast (never native alert/confirm), Title Case labels, and the close
 * paths routed through useFormDirtyGuard (an inline onOpenChange arrow is a
 * hard eslint error in this repo).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';
import { INDIAN_MOBILE_ERROR, isValidIndianMobile, normalizeMobileDigits } from '@/lib/format';
import { formatEasyfixerName } from '@/lib/utils';

/*
 * Minimal shape this dialog needs off a list row. `efr_no` is the masked
 * display value — see the file header.
 */
export type EasyfixerMobileTarget = {
  efr_id: number;
  efr_name: string;
  efr_no: string | null;
};

/* Matches DeleteEntityDialog's reason textarea — the shared Input primitive
 * is single-line, and there is no shared Textarea component in this repo. */
const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-sm '
  + 'transition-colors placeholder:text-muted-foreground focus:outline-none '
  + 'focus-visible:outline-none focus-visible:border-foreground/40';

export function EasyfixerMobileDialog({
  open,
  easyfixer,
  onClose,
  onUpdated,
}: {
  open: boolean;
  easyfixer: EasyfixerMobileTarget | null;
  onClose: () => void;
  /* Fired after a 200 so the page can refresh the list. */
  onUpdated: (efrId: number) => void;
}) {
  const [mobile, setMobile] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  /*
   * 409 is the one failure the operator can actually act on — it means a
   * DIFFERENT technician already holds the number they typed. Kept as inline
   * panel state (not just a toast) so the message stays on screen while they
   * correct the number.
   */
  const [conflict, setConflict] = useState<string | null>(null);

  // Reset every field on each open so a previous attempt never leaks in.
  useEffect(() => {
    if (!open) return;
    setMobile('');
    setReason('');
    setConflict(null);
    setSaving(false);
  }, [open, easyfixer?.efr_id]);

  // Timestamp of the last open — drives the phantom-close swallow below.
  const openedAtRef = useRef(0);
  useEffect(() => { if (open) openedAtRef.current = Date.now(); }, [open]);

  const handleClose = useCallback(() => {
    if (saving) return;
    onClose();
  }, [onClose, saving]);

  /*
   * Esc / X / overlay-click guard. Dirty once anything has been typed;
   * skipped outright while the PATCH is in flight so the dialog can't
   * unmount mid-request.
   */
  const guardedOpenChange = useFormDirtyGuard(handleClose, {
    isDirty: () => mobile.length > 0 || reason.trim().length > 0,
    when: () => !saving,
  });

  /*
   * Same Radix DropdownMenu → Dialog race the profile-update dialog documents
   * on this page: the pointer-up that closes the kebab menu is read by the
   * just-mounted Dialog as a click-outside, so it blinks open and dismisses.
   * Swallow any close fired within 400ms of opening; genuine Esc / X / Cancel
   * / outside-clicks always arrive later.
   */
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && Date.now() - openedAtRef.current < 400) return;
    guardedOpenChange(next);
  }, [guardedOpenChange]);

  const mobileValid = isValidIndianMobile(mobile, { required: true });
  const reasonFilled = reason.trim().length > 0;
  const canSubmit = !!easyfixer && mobileValid && reasonFilled && !saving;

  async function submit() {
    if (!easyfixer || !canSubmit) return;
    setSaving(true);
    setConflict(null);
    try {
      await api.patch<{ efr_id: number; mobile: string }>(
        `/admin/easyfixers/${easyfixer.efr_id}/mobile`,
        { mobile, reason: reason.trim() },
      );
      showToast({
        variant: 'success',
        message: `Mobile updated for ${formatEasyfixerName(easyfixer.efr_name)}. They now sign in with the new number.`,
      });
      onUpdated(easyfixer.efr_id);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Another technician holds this number — surface the BE's own message,
        // which names the clash, and keep the operator on the form.
        setConflict(e.message || 'Another technician already uses this mobile number.');
      } else if (e instanceof ApiError && e.status === 403) {
        showToast({ variant: 'error', message: "You don't have permission to change a technician's mobile." });
      } else {
        showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to update mobile' });
      }
    } finally {
      setSaving(false);
    }
  }

  // Fragment (not null) keeps the render shape stable across the closed
  // state — same reasoning as SendProfileUpdateLinkDialog on this page.
  if (!easyfixer) return <></>;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" />
            Update Mobile Number
          </DialogTitle>
          <DialogDescription>
            {formatEasyfixerName(easyfixer.efr_name)} · Easyfixer #{easyfixer.efr_id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 p-4 pt-2">
          <div className="space-y-1">
            <Label htmlFor="ef-current-mobile">Current Mobile</Label>
            {/* Already bullet-masked upstream by the response middleware —
                rendered as-is; the CRM never unmasks it. */}
            <Input
              id="ef-current-mobile"
              value={easyfixer.efr_no ?? '—'}
              disabled
              className="font-mono"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ef-new-mobile" required>New Mobile</Label>
            <Input
              id="ef-new-mobile"
              value={mobile}
              onChange={(e) => {
                setMobile(normalizeMobileDigits(e.target.value));
                setConflict(null);
              }}
              placeholder="10-Digit Mobile"
              className="font-mono"
              inputMode="numeric"
              autoComplete="off"
            />
            {mobile.length > 0 && !mobileValid && (
              <p className="text-xs text-destructive">{INDIAN_MOBILE_ERROR}</p>
            )}
          </div>

          {/*
            * The one consequence that matters, said once. This number is the
            * login identity for the technician app.
            */}
          <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            This number is the technician&apos;s login identity — after this change they sign in
            to the app with the new number.
          </div>

          {conflict && (
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {conflict}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="ef-mobile-reason" required>Reason</Label>
            <textarea
              id="ef-mobile-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this number being changed?"
              className={TEXTAREA_CLASS}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {saving ? 'Updating…' : 'Update Mobile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
