'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type JobCharge } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * AddChargeDialog — create OR edit a Travel / Incentive / Penalty charge
 * line item on a job (legacy CheckIn-detail right column).
 *
 * One dialog, three field-sets driven by `mode`:
 *   penalty   → reason + tx/client charge (+ client-approval switch)
 *   incentive → reason + tx/client charge + optional document name
 *   travel    → from/to city, distance, tx/client unit, tx/client charge,
 *               + optional document name
 *
 * Client-side guard (mirrors the BE rule): Client Charge >= Tx Charge,
 * shown as an inline error. `editing` swaps POST → PATCH and pre-fills.
 *
 * NOTE on documents: the BE POST/PATCH bodies carry `documentName?` (a
 * string), so the optional document here is a NAME/reference field, not a
 * file upload. Actual file attachments (Job Sheet / Purchase Order) go
 * through JobDocumentsCard's multipart endpoint.
 */

export type ChargeMode = 'penalty' | 'travel' | 'incentive';

const TITLE: Record<ChargeMode, string> = {
  penalty: 'Penalty',
  travel: 'Travel',
  incentive: 'Incentive',
};

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function AddChargeDialog({
  open,
  mode,
  jobId,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: ChargeMode;
  jobId: number;
  editing?: JobCharge | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Shared fields
  const [reason, setReason] = useState('');
  const [txCharge, setTxCharge] = useState('');
  const [clientCharge, setClientCharge] = useState('');
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [documentName, setDocumentName] = useState('');
  // Travel-only fields
  const [fromCity, setFromCity] = useState('');
  const [toCity, setToCity] = useState('');
  const [distance, setDistance] = useState('');
  const [txUnit, setTxUnit] = useState('');
  const [clientUnit, setClientUnit] = useState('');

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset / hydrate when the dialog opens or the target row changes.
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setReason(editing?.reason ?? '');
    setTxCharge(editing?.tx_charge != null ? String(editing.tx_charge) : '');
    setClientCharge(editing?.client_charge != null ? String(editing.client_charge) : '');
    setApprovalNeeded(Boolean(editing?.is_client_approval_needed));
    setDocumentName(editing?.document_name ?? '');
    setFromCity(editing?.from_city_name ?? '');
    setToCity(editing?.to_city_name ?? '');
    setDistance(editing?.total_distance != null ? String(editing.total_distance) : '');
    setTxUnit(editing?.tx_unit != null ? String(editing.tx_unit) : '');
    setClientUnit(editing?.cx_unit != null ? String(editing.cx_unit) : '');
  }, [open, editing]);

  const isTravel = mode === 'travel';
  const canHaveDocument = mode === 'travel' || mode === 'incentive';

  // Discard-changes guard for Esc / X / overlay-click close paths.
  const isDirty = () => {
    if (editing) {
      return reason !== (editing.reason ?? '')
        || txCharge !== (editing.tx_charge != null ? String(editing.tx_charge) : '')
        || clientCharge !== (editing.client_charge != null ? String(editing.client_charge) : '')
        || approvalNeeded !== Boolean(editing.is_client_approval_needed)
        || documentName !== (editing.document_name ?? '')
        || fromCity !== (editing.from_city_name ?? '')
        || toCity !== (editing.to_city_name ?? '')
        || distance !== (editing.total_distance != null ? String(editing.total_distance) : '')
        || txUnit !== (editing.tx_unit != null ? String(editing.tx_unit) : '')
        || clientUnit !== (editing.cx_unit != null ? String(editing.cx_unit) : '');
    }
    return Boolean(reason || txCharge || clientCharge || documentName || fromCity || toCity || distance || txUnit || clientUnit || approvalNeeded);
  };
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty, when: () => !saving });

  async function submit() {
    const tx = num(txCharge);
    const client = num(clientCharge);

    // Field validation.
    if (!isTravel && !reason.trim()) { setErr('Reason is required.'); return; }
    if (!Number.isFinite(tx) || tx < 0) { setErr('Enter a valid Tx Charge.'); return; }
    if (!Number.isFinite(client) || client < 0) { setErr('Enter a valid Client Charge.'); return; }
    // Guard mirrors the backend rule: the client must never be charged
    // less than the technician (tx) charge.
    if (client < tx) { setErr('Client Charge must be greater than or equal to Tx Charge.'); return; }

    let body: Record<string, unknown>;
    if (isTravel) {
      if (!fromCity.trim() || !toCity.trim()) { setErr('From and To city are required.'); return; }
      const dist = num(distance);
      const tu = num(txUnit);
      const cu = num(clientUnit);
      if (!Number.isFinite(dist) || dist < 0) { setErr('Enter a valid distance.'); return; }
      if (!Number.isFinite(tu) || tu < 0) { setErr('Enter a valid Tx Unit.'); return; }
      if (!Number.isFinite(cu) || cu < 0) { setErr('Enter a valid Client Unit.'); return; }
      body = {
        fromCityName: fromCity.trim(),
        toCityName: toCity.trim(),
        totalDistance: dist,
        txUnit: tu,
        clientUnit: cu,
        txCharge: tx,
        clientCharge: client,
        isClientApprovalNeeded: approvalNeeded,
        ...(documentName.trim() ? { documentName: documentName.trim() } : {}),
      };
    } else if (mode === 'incentive') {
      body = {
        reason: reason.trim(),
        txCharge: tx,
        clientCharge: client,
        isClientApprovalNeeded: approvalNeeded,
        ...(documentName.trim() ? { documentName: documentName.trim() } : {}),
      };
    } else {
      body = {
        txCharge: tx,
        clientCharge: client,
        reason: reason.trim(),
        isClientApprovalNeeded: approvalNeeded,
      };
    }

    setSaving(true);
    setErr(null);
    try {
      if (editing) {
        await api.updateJobCharge(jobId, editing.id, body as never);
      } else if (mode === 'penalty') {
        await api.addJobPenalty(jobId, body as never);
      } else if (mode === 'travel') {
        await api.addJobTravel(jobId, body as never);
      } else {
        await api.addJobIncentive(jobId, body as never);
      }
      showToast({ variant: 'success', message: `${TITLE[mode]} ${editing ? 'Updated' : 'Added'}` });
      onSaved();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed';
      setErr(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${TITLE[mode]}` : `Add ${TITLE[mode]}`}</DialogTitle>
          <DialogDescription>
            {isTravel
              ? 'Record a travel charge for this job.'
              : `Record ${mode === 'penalty' ? 'a penalty' : 'an incentive'} against this job.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {isTravel ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="mb-1 block text-sm font-medium">From City *</Label>
                  <Input value={fromCity} onChange={(e) => setFromCity(e.target.value)} placeholder="Origin city" />
                </div>
                <div>
                  <Label className="mb-1 block text-sm font-medium">To City *</Label>
                  <Input value={toCity} onChange={(e) => setToCity(e.target.value)} placeholder="Destination city" />
                </div>
              </div>
              <div>
                <Label className="mb-1 block text-sm font-medium">Total Distance (km) *</Label>
                <Input
                  value={distance}
                  onChange={(e) => setDistance(e.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  className="font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="mb-1 block text-sm font-medium">Tx Unit *</Label>
                  <Input
                    value={txUnit}
                    onChange={(e) => setTxUnit(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal"
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-sm font-medium">Client Unit *</Label>
                  <Input
                    value={clientUnit}
                    onChange={(e) => setClientUnit(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal"
                    className="font-mono"
                  />
                </div>
              </div>
            </>
          ) : (
            <div>
              <Label className="mb-1 block text-sm font-medium">Reason *</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Why is this ${mode} being applied?`} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="mb-1 block text-sm font-medium">Tx Charge (₹) *</Label>
              <Input
                value={txCharge}
                onChange={(e) => setTxCharge(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                className="font-mono"
              />
            </div>
            <div>
              <Label className="mb-1 block text-sm font-medium">Client Charge (₹) *</Label>
              <Input
                value={clientCharge}
                onChange={(e) => setClientCharge(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                className="font-mono"
              />
            </div>
          </div>

          {canHaveDocument && (
            <div>
              <Label className="mb-1 block text-sm font-medium">Document Name</Label>
              <Input value={documentName} onChange={(e) => setDocumentName(e.target.value)} placeholder="Optional reference / filename" />
            </div>
          )}

          <label className="flex items-center gap-2 pt-1">
            <Switch checked={approvalNeeded} onCheckedChange={setApprovalNeeded} />
            <span className="text-sm text-slate-700">Client Approval?</span>
          </label>

          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save Changes' : `Add ${TITLE[mode]}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
