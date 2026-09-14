'use client';

/*
 * Supply Gap request ACTIONS — legacy opencity / opencitytable action flows.
 *
 *   AddRemarkBox           "+ Add Remark"                 POST /:id/remarks
 *   CloseRequestDialog     "✔ Mark Complete" / "✖ Cancel" POST /:id/action (4 / 3)
 *   NewTechnicianDialog    "Add A New Supply"             POST /:id/action (1)
 *                          header "Invite Sent"           POST /invite
 *   ExistingSupplyDialog   "Allocate An Existing Supply"  POST /:id/action (2)
 *
 * Which buttons show in which status lives in SupplyGapRequestDialog; the
 * backend enforces the same matrix, so a stale screen gets a clear 409 rather
 * than a silent wrong transition.
 *
 * Nothing here renders a technician's phone number: the existing-supply lookup
 * returns one, but the checklist only needs the name and city, and the server
 * re-resolves the number itself on submit.
 */

import * as React from 'react';
import { CheckCircle2, Loader2, Search, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast, dismissToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const API_BASE = '/admin/quicksight/supply-gap';
const REMARKS_MAX = 500;
const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40 disabled:opacity-60';

type ActionResult = { id: number; status: number; whatsapp?: { sent: boolean; reason?: string | null } | null };

/* ── + Add Remark ──────────────────────────────────────────────────────── */

export function AddRemarkBox({ id, onAdded }: { id: number; onAdded: () => void }) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function add() {
    const comment = text.trim();
    if (!comment || busy) return;
    setBusy(true);
    try {
      await api.post(`${API_BASE}/${id}/remarks`, { comment });
      setText('');
      showToast({ variant: 'success', message: 'Remark added' });
      onAdded();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not add the remark' }) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label className="block">Add Remark</Label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={REMARKS_MAX}
        rows={2}
        placeholder="Enter your remark here…"
        className={TEXTAREA_CLASS}
      />
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={add} disabled={busy || !text.trim()}>
          {busy ? 'Adding…' : '+ Add Remark'}
        </Button>
      </div>
    </div>
  );
}

/* ── ✔ Mark Complete / ✖ Cancel ────────────────────────────────────────── */

export function CloseRequestDialog({
  id, kind, onClose, onDone,
}: { id: number; kind: 'complete' | 'cancel'; onClose: () => void; onDone: () => void }) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const guarded = useFormDirtyGuard(onClose, { when: () => Boolean(text.trim()) && !busy });
  const complete = kind === 'complete';

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await api.post<ActionResult>(`${API_BASE}/${id}/action`, { actionType: complete ? 4 : 3, remarks: text.trim() });
      showToast({ variant: 'success', message: complete ? `Request #${id} marked complete` : `Request #${id} cancelled` });
      onDone();
      onClose();
    } catch (e) {
      setError(formatApiError(e, { fallback: complete ? 'Could not complete the request' : 'Could not cancel the request' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={guarded}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{complete ? 'Complete Supply Request' : 'Cancel Supply Request'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {complete
              ? 'Add completion remarks. The request moves to Completed and can no longer be changed.'
              : 'Add the reason for cancelling. The request moves to Cancelled and can no longer be changed.'}
          </p>
          <div>
            <Label className="block mb-1" required>Remarks</Label>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={REMARKS_MAX}
              rows={3}
              placeholder={complete ? 'Enter completion remarks…' : 'Enter cancellation remarks…'}
              className={TEXTAREA_CLASS}
            />
          </div>
          {error && <ErrorLine>{error}</ErrorLine>}
          <div className="flex justify-end gap-2 border-t pt-3">
            <CancelButton onCancel={onClose} disabled={busy} label="Back" />
            <Button
              variant={complete ? 'default' : 'destructive'}
              onClick={submit}
              disabled={busy || !text.trim()}
            >
              {busy ? 'Saving…' : complete ? '✔ Mark Complete' : '✖ Cancel Request'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Add A New Supply / Invite Sent ───────────────────────────────────── */

/* Legacy status → what it means for the operator, and whether it blocks. */
const TX_STATUS_NOTE: Record<string, { tone: 'danger' | 'warning' | 'success'; text: string; blocks?: boolean }> = {
  Active: { tone: 'danger', text: 'This technician is already active in the system.', blocks: true },
  'In-active': { tone: 'warning', text: 'Technician exists but is currently inactive. You can reactivate.' },
  'Not Suitable': { tone: 'danger', text: 'Technician was marked as not suitable. Review before proceeding.' },
  'Not Eligible': { tone: 'danger', text: 'Technician is not eligible for allocation.' },
  'Self Registration In Progress': { tone: 'warning', text: 'Technician registration is in progress.' },
  'New Lead': { tone: 'success', text: 'New lead technician. You can proceed with registration.' },
  'Not logged into App': { tone: 'warning', text: 'Technician has not logged into the app yet.', blocks: true },
};
const NOTE_CLASS = {
  danger: 'bg-urgent-tint text-urgent-strong',
  warning: 'bg-warning-tint text-warning-strong',
  success: 'bg-success-tint text-success-strong',
};

export function NewTechnicianDialog({
  mode, id, onClose, onDone,
}: {
  /* 'supply' = row action on request `id`; 'invite' = header Invite Sent. */
  mode: 'supply' | 'invite';
  id?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [remarks, setRemarks] = React.useState('');
  const [status, setStatus] = React.useState<string | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const guarded = useFormDirtyGuard(onClose, { when: () => Boolean(name || mobile || remarks) && !busy });

  const mobileValid = /^[5-9]\d{9}$/.test(mobile);
  const nameValid = /^[A-Za-z ]{2,}$/.test(name.trim());
  const note = status ? TX_STATUS_NOTE[status] : undefined;
  // Remarks are required for a supply action (legacy form), optional for an invite.
  const canSubmit =
    nameValid && mobileValid && !note?.blocks && !statusLoading && (mode === 'invite' || Boolean(remarks.trim()));

  async function onMobile(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    setMobile(digits);
    setStatus(null);
    if (!/^[5-9]\d{9}$/.test(digits)) return;
    setStatusLoading(true);
    try {
      setStatus(await api.get<string>(`${API_BASE}/tx-status`, { mobileNo: digits }));
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true); setError(null);
    const t = showToast({ variant: 'loading', message: mode === 'invite' ? 'Saving invite…' : 'Adding new supply…' });
    try {
      if (mode === 'invite') {
        await api.post(`${API_BASE}/invite`, { name: name.trim(), mobile, remarks: remarks.trim() || null });
        dismissToast(t);
        showToast({ variant: 'success', message: `Invite recorded for ${name.trim()}` });
      } else {
        const r = await api.post<ActionResult>(`${API_BASE}/${id}/action`, {
          actionType: 1, newSupplyName: name.trim(), newSupplyNumber: mobile, remarks: remarks.trim(),
        });
        dismissToast(t);
        showToast(
          r.whatsapp?.sent
            ? { variant: 'success', message: `${name.trim()} added · onboarding WhatsApp sent` }
            : { variant: 'warning', message: `${name.trim()} added · onboarding WhatsApp NOT sent` },
        );
      }
      onDone();
      onClose();
    } catch (e) {
      dismissToast(t);
      setError(formatApiError(e, { fallback: 'Could not save' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={guarded}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'invite' ? 'Invite Technician' : 'Add New Technician'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="block mb-1" required>Technician Name</Label>
            <Input
              autoFocus
              value={name}
              maxLength={100}
              placeholder="Enter technician name"
              onChange={(e) => setName(e.target.value.replace(/[^A-Za-z ]/g, ''))}
            />
          </div>
          <div>
            <Label className="block mb-1" required>Contact No</Label>
            <div className="relative">
              <Input
                value={mobile}
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit mobile number"
                onChange={(e) => onMobile(e.target.value)}
              />
              {statusLoading && (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            {mobile.length === 10 && !mobileValid && (
              <p className="mt-1 text-xs text-urgent-strong">Must be 10 digits starting with 5–9.</p>
            )}
          </div>

          {status && (
            <div className={`rounded-md px-3 py-2 text-sm ${note ? NOTE_CLASS[note.tone] : 'bg-muted text-muted-foreground'}`}>
              <span className="font-semibold">Status: {status}</span>
              {note && <span className="block text-xs">{note.text}</span>}
            </div>
          )}

          <div>
            <Label className="block mb-1" required={mode === 'supply'}>Remarks</Label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              maxLength={REMARKS_MAX}
              rows={2}
              placeholder="Note before submitting…"
              className={TEXTAREA_CLASS}
            />
          </div>

          {mode === 'supply' && (
            <p className="text-xs text-muted-foreground">
              The technician gets an onboarding WhatsApp, and the request moves to In Progress.
            </p>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}

          <div className="flex justify-end gap-2 border-t pt-3">
            <CancelButton onCancel={onClose} disabled={busy} />
            <Button onClick={submit} disabled={!canSubmit || busy}>
              {busy ? 'Saving…' : mode === 'invite' ? 'Save Invite' : 'Add Technician'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Allocate An Existing Supply ──────────────────────────────────────── */

type TxDetails = {
  efrName: string | null;
  efrId: number;
  cityName: string | null;
  supplyStatus: string;
  txOrderCount: number;
  categoryMatch: boolean;
};

export function ExistingSupplyDialog({
  id, requestFor, referenceId, cityName, catgId, catgName, onClose, onDone,
}: {
  id: number;
  requestFor: number | null;
  referenceId: string | null;
  cityName: string | null;
  catgId: number | null;
  catgName: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [txId, setTxId] = React.useState('');
  const [tx, setTx] = React.useState<TxDetails | null>(null);
  const [looking, setLooking] = React.useState(false);
  const [lookupError, setLookupError] = React.useState<string | null>(null);
  const [remarks, setRemarks] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const guarded = useFormDirtyGuard(onClose, { when: () => Boolean(txId || remarks) && !busy });

  const isJob = requestFor === 1;

  async function lookup() {
    if (!/^\d+$/.test(txId) || !catgId) return;
    setLooking(true); setLookupError(null); setTx(null);
    try {
      setTx(await api.get<TxDetails>(`${API_BASE}/tx/${txId}`, { catgId }));
    } catch (e) {
      setLookupError(formatApiError(e, { fallback: 'No record found.' }));
    } finally {
      setLooking(false);
    }
  }

  // Legacy checklist, same rules the backend enforces on submit.
  const cityOk = Boolean(tx && (tx.cityName || '').trim().toLowerCase() === (cityName || '').trim().toLowerCase());
  const categoryOk = Boolean(tx?.categoryMatch);
  const statusOk = tx?.supplyStatus === 'Active';
  const ordersOk = Boolean(tx && (isJob || tx.txOrderCount <= 10));
  const allOk = Boolean(tx) && cityOk && categoryOk && statusOk && ordersOk;

  async function submit(scheduleNow: boolean) {
    if (!tx || !allOk || !remarks.trim() || busy) return;
    // Open Manage Jobs on this job BEFORE the await, or the browser treats the
    // new tab as an unrequested popup and blocks it.
    if (scheduleNow && isJob && referenceId) {
      window.open(`/jobs?q=${encodeURIComponent(referenceId)}`, '_blank', 'noopener');
    }
    setBusy(true); setError(null);
    try {
      await api.post<ActionResult>(`${API_BASE}/${id}/action`, {
        actionType: 2, oldSupplyId: tx.efrId, remarks: remarks.trim(),
      });
      showToast({ variant: 'success', message: `${tx.efrName ?? 'Technician'} allocated to request #${id}` });
      onDone();
      onClose();
    } catch (e) {
      setError(formatApiError(e, { fallback: 'Could not allocate this technician' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={guarded}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Allocate An Existing Supply</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="block mb-1" required>Technician ID</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={txId}
                  inputMode="numeric"
                  placeholder="Type the TX ID and press Enter"
                  className="pl-9"
                  onChange={(e) => { setTxId(e.target.value.replace(/\D/g, '')); setTx(null); setLookupError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } }}
                />
              </div>
              <Button variant="outline" onClick={lookup} disabled={looking || !txId || !catgId}>
                {looking ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
              </Button>
            </div>
            {!catgId && <p className="mt-1 text-xs text-urgent-strong">This request has no category, so technicians can’t be checked.</p>}
            {lookupError && <p className="mt-1 text-xs text-urgent-strong">{lookupError}</p>}
          </div>

          {tx && (
            <div className="rounded-lg border border-border">
              <div className="border-b border-border px-4 py-2.5">
                <p className="text-sm font-semibold">{tx.efrName ?? '-'}</p>
                <p className="text-xs text-muted-foreground">TX #{tx.efrId}{tx.cityName ? ` · ${tx.cityName}` : ''}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-4">
                <Check label="City" ok={cityOk} value={tx.cityName ?? '—'} hint={cityOk ? undefined : `Request: ${cityName ?? '—'}`} />
                <Check label="Category" ok={categoryOk} value={catgName ?? '—'} />
                <Check label="Status" ok={statusOk} value={tx.supplyStatus} />
                <Check
                  label="Orders ≤ 10"
                  ok={ordersOk}
                  value={String(tx.txOrderCount)}
                  hint={isJob ? 'Not checked for Job ID' : undefined}
                  neutral={isJob}
                />
              </div>
              <div className={`border-t border-border px-4 py-2 text-sm font-medium ${allOk ? 'bg-success-tint text-success-strong' : 'bg-urgent-tint text-urgent-strong'}`}>
                {allOk ? '✔ All checks passed — allocation allowed' : '✘ Allocation not allowed'}
              </div>
            </div>
          )}

          <div>
            <Label className="block mb-1" required>Remarks</Label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              maxLength={REMARKS_MAX}
              rows={2}
              placeholder="Note for this allocation…"
              className={TEXTAREA_CLASS}
            />
          </div>
          {error && <ErrorLine>{error}</ErrorLine>}

          <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
            <CancelButton onCancel={onClose} disabled={busy} />
            <Button variant="outline" onClick={() => submit(false)} disabled={!allOk || !remarks.trim() || busy}>
              Later
            </Button>
            {isJob && (
              <Button onClick={() => submit(true)} disabled={!allOk || !remarks.trim() || busy}>
                Schedule Now
              </Button>
            )}
          </div>
          {isJob && (
            <p className="text-right text-xs text-muted-foreground">
              Schedule Now also opens this job in Manage Jobs so you can assign the technician.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Check({
  label, ok, value, hint, neutral = false,
}: { label: string; ok: boolean; value: string; hint?: string; neutral?: boolean }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`flex items-center gap-1 text-sm font-medium ${neutral ? 'text-muted-foreground' : ok ? 'text-success-strong' : 'text-urgent-strong'}`}>
        {!neutral && <Icon className="size-4 shrink-0" />}
        <span className="truncate">{value}</span>
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
      <XCircle className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
