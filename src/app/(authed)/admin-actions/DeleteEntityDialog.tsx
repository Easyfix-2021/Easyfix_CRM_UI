'use client';

/*
 * DeleteEntityDialog — OTP-gated hard-delete of an Easyfixer or internal
 * User. Two-step flow against /admin/entity-deletion/*:
 *
 *   Step 1 "Select Record"
 *     - Entity-type toggle (Easyfixer | User)
 *     - SearchSelect populated from useLookup (easyfixers | adminUsers)
 *     - Required free-text reason
 *     - On entity selection we POST /impact to learn whether the record is
 *       safe to delete. Eligible → green "safe" note; blocked → red panel
 *       listing the blockers and the request-OTP button is disabled.
 *     - "Request OTP" POSTs /request-otp. The BE rejects (409) ineligible
 *       entities — that ApiError surfaces via showToast and we stay on step 1.
 *
 *   Step 2 "Verify OTP"
 *     - 4-digit numeric input + "Confirm Delete" (destructive) → POST /confirm.
 *     - Success: toast + close + reset. Resend re-calls /request-otp.
 *
 * Conventions honoured: never native alert/confirm/prompt (showToast only);
 * no raw api.get in useEffect (impact + OTP are POSTs inside click/effect
 * handlers, which is allowed); Title Case throughout; shared DialogHeader.
 */

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { useLookup } from '@/lib/use-lookup';
import { usePostFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';

type EntityType = 'easyfixer' | 'user';

type Blocker = { table: string; column: string; label: string; count: number };

type Impact = {
  entityType: EntityType;
  id: number;
  label: string;
  currentStatus: string | number | null;
  eligible: boolean;
  blockedBy: Blocker[];
  ownDataCounts: Record<string, number>;
};

export function DeleteEntityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lookup = useLookup();

  const [step, setStep] = useState<1 | 2>(1);
  const [entityType, setEntityType] = useState<EntityType>('easyfixer');
  const [entityId, setEntityId] = useState('');
  const [reason, setReason] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  /*
   * Impact probe via usePostFetch (the POST analogue of useFetch) — re-fires
   * whenever entityType / entityId change, with Strict-Mode dedupe + stale-
   * response cancellation handled in the hook. Deferred until an entity is
   * picked AND the dialog is open. We keep the result on step 2 (for the
   * "Deleting: <label>" line), so it isn't gated on step === 1.
   */
  const impactEnabled = open && !!entityId;
  const { data: impact, loading: impactLoading } = usePostFetch<Impact>(
    impactEnabled ? '/admin/entity-deletion/impact' : null,
    { entityType, id: Number(entityId) },
    { enabled: impactEnabled },
  );

  function resetAll() {
    setStep(1);
    setEntityType('easyfixer');
    setEntityId('');
    setReason('');
    setOtp('');
    setBusy(false);
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  // Switching the entity type clears the picked record so the operator can't
  // request an OTP against a stale selection from the other list. The impact
  // probe re-keys automatically off entityType + entityId.
  function switchType(t: EntityType) {
    if (t === entityType) return;
    setEntityType(t);
    setEntityId('');
  }

  const options = entityType === 'easyfixer'
    ? lookup.easyfixers.map((e) => ({
        value: e.efr_id,
        label: `${formatEasyfixerName(e.efr_name)} · ${e.efr_no}${e.city_name ? ` · ${e.city_name}` : ''}`,
      }))
    : lookup.adminUsers.map((u) => ({
        value: u.user_id,
        label: `${u.user_name} · ${u.role_name ?? ''}`,
      }));

  const eligible = impact?.eligible === true;
  const canRequestOtp = !!entityId && reason.trim().length > 0 && eligible && !busy && !impactLoading;

  async function requestOtp() {
    if (!entityId) return;
    setBusy(true);
    try {
      const r = await api.post<{ delivered: boolean; expiresAt: string; label: string; message: string }>(
        '/admin/entity-deletion/request-otp',
        { entityType, id: Number(entityId) },
      );
      showToast({ variant: 'success', message: r.message || 'OTP Sent.' });
      setOtp('');
      setStep(2);
    } catch (e) {
      // Covers the 409-blocked case too — err.message explains.
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed To Send OTP' });
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (otp.trim().length < 4) {
      showToast({ variant: 'error', message: 'Enter The 4-Digit OTP' });
      return;
    }
    setBusy(true);
    try {
      await api.post<{ archiveId: number; label: string; entityType: EntityType; id: number; message: string }>(
        '/admin/entity-deletion/confirm',
        { entityType, id: Number(entityId), reason: reason.trim(), otp: otp.trim() },
      );
      showToast({ variant: 'success', message: 'Record deleted and archived.' });
      handleClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed To Delete' });
    } finally {
      setBusy(false);
    }
  }

  // Guard the Esc / X / overlay close paths. Treat a started selection or
  // typed reason as dirty; skip the prompt while a request is in flight.
  const guardedOpenChange = useFormDirtyGuard(handleClose, {
    isDirty: () => !!entityId || reason.trim().length > 0 || step === 2,
    when: () => !busy,
  });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            {step === 1 ? 'Delete Easyfixer / User' : 'Verify OTP'}
          </DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-3 p-4">
            {/* Entity-type toggle */}
            <div className="space-y-1">
              <Label>Record Type</Label>
              <div className="inline-flex rounded-md border border-input overflow-hidden">
                {(['easyfixer', 'user'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => switchType(t)}
                    className={
                      'px-3 py-1.5 text-sm font-medium transition-colors ' +
                      (entityType === t
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-foreground hover:bg-muted')
                    }
                  >
                    {t === 'easyfixer' ? 'Easyfixer' : 'User'}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label>{entityType === 'easyfixer' ? 'Easyfixer *' : 'User *'}</Label>
              <SearchSelect
                value={entityId}
                onChange={(v) => setEntityId(String(v))}
                options={options}
                placeholder={entityType === 'easyfixer' ? '— Select an easyfixer —' : '— Select a user —'}
              />
            </div>

            {/* Impact panel */}
            {impactLoading && (
              <div className="rounded border bg-muted/40 p-3 text-xs text-muted-foreground">
                Checking operational history…
              </div>
            )}
            {!impactLoading && impact && eligible && (
              <div className="rounded border border-success/30 bg-success-tint p-3 text-sm text-success-strong">
                No operational history — safe to delete.
              </div>
            )}
            {!impactLoading && impact && !eligible && (
              <div className="rounded border border-urgent/30 bg-urgent-tint p-3 text-sm text-urgent-strong space-y-1">
                <div className="font-medium">
                  Blocked: {impact.blockedBy.map((b) => `${b.count} ${b.label}`).join(', ')} — deactivate instead.
                </div>
                <div className="text-xs text-urgent-strong">
                  This record has linked operational data and cannot be hard-deleted.
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label>Reason For Deletion *</Label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why is this record being deleted?"
                className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none focus-visible:border-foreground/40"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button onClick={requestOtp} disabled={!canRequestOtp}>
                {busy ? 'Sending…' : 'Request OTP'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              An OTP was sent to your registered mobile.
            </p>
            {impact?.label && (
              <div className="rounded border bg-muted/40 p-2 text-xs">
                Deleting: <span className="font-medium text-foreground">{impact.label}</span>
              </div>
            )}
            <div className="space-y-1">
              <Label>Enter OTP *</Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4-Digit OTP"
                className="tracking-[0.4em] text-center"
              />
            </div>
            <div className="flex items-center justify-between gap-2 pt-2">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setStep(1); setOtp(''); }} disabled={busy}>
                  Back
                </Button>
                <Button variant="outline" onClick={requestOtp} disabled={busy}>
                  Request New OTP
                </Button>
              </div>
              <Button variant="destructive" onClick={confirmDelete} disabled={busy || otp.trim().length < 4}>
                {busy ? 'Deleting…' : 'Confirm Delete'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
