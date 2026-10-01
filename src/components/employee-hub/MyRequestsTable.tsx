/*
 * My Requests — the requester's upcoming (pending + approved) leave on
 * /employee-hub/attendance. The 1/3-width column only carries Type · Days
 * (+ dates) · Status · View; the full record and the Withdraw (PENDING,
 * canWithdraw) / Cancel (APPROVED, canCancel) actions live in the View
 * modal, both behind useConfirm. The backend is the source of truth for
 * which action a row gets — the modal just renders what it's told.
 */

import { useState } from 'react';
import { Eye } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate } from '@/lib/utils';
import { formatYmdLabel } from '@/components/roster/roster-dates';
import { LEAVE_DURATION_LABEL, LEAVE_STATUS_LABEL, leaveKindLabel, type LeaveRequestRow, type LeaveStatus } from './leave-types';

const STATUS_TONE: Record<LeaveStatus, StatusChipTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'urgent',
  WITHDRAWN: 'neutral',
  CANCELLED: 'neutral',
};

function dateRangeLabel(r: LeaveRequestRow): string {
  return r.toDate !== r.fromDate ? `${formatYmdLabel(r.fromDate)} – ${formatYmdLabel(r.toDate)}` : formatYmdLabel(r.fromDate);
}

/** "13 Oct" — the year is implied by the month the page is showing. */
const shortYmd = (ymd: string) => formatYmdLabel(ymd).slice(0, 6);

/** "13 Oct – 15 Oct", "13 Oct · 1st Half". */
function shortDates(r: LeaveRequestRow): string {
  if (r.toDate !== r.fromDate) return `${shortYmd(r.fromDate)} – ${shortYmd(r.toDate)}`;
  if (r.duration === 'FIRST_HALF') return `${shortYmd(r.fromDate)} · 1st Half`;
  if (r.duration === 'SECOND_HALF') return `${shortYmd(r.fromDate)} · 2nd Half`;
  return shortYmd(r.fromDate);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="col-span-2 min-w-0 break-words">{children}</dd>
    </div>
  );
}

function RequestDetailDialog({ request, busy, onClose, onWithdraw, onCancel }: {
  request: LeaveRequestRow | null;
  busy: boolean;
  onClose: () => void;
  onWithdraw: (r: LeaveRequestRow) => void;
  onCancel: (r: LeaveRequestRow) => void;
}) {
  // Read-only modal — never dirty, so every close path closes straight away.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => false });
  const r = request;
  return (
    <Dialog open={!!r} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Leave Request</DialogTitle>
        </DialogHeader>
        {r && (
          <dl className="space-y-2">
            <Field label="Kind">{leaveKindLabel(r.kind)}</Field>
            <Field label="Dates">{dateRangeLabel(r)}</Field>
            <Field label="Duration">{LEAVE_DURATION_LABEL[r.duration]}</Field>
            <Field label="Days"><span className="tabular-nums">{r.days}</span></Field>
            <Field label="Reason">{r.reason || <span className="text-muted-foreground">—</span>}</Field>
            <Field label="Status">
              <StatusChip tone={STATUS_TONE[r.status]} size="sm">{LEAVE_STATUS_LABEL[r.status]}</StatusChip>
              {r.endedEarly && <span className="ml-2 text-xs text-muted-foreground">Ended Early</span>}
            </Field>
            <Field label="Requested At">{formatDate(r.createdAt)}</Field>
            {r.decidedByName && <Field label="Decided By">{r.decidedByName}</Field>}
            {r.decidedAt && <Field label="Decided At">{formatDate(r.decidedAt)}</Field>}
            {r.decisionNote && <Field label="Decision Note">{r.decisionNote}</Field>}
          </dl>
        )}
        <DialogFooter>
          {r?.canWithdraw && <Button variant="outline" disabled={busy} onClick={() => onWithdraw(r)}>Withdraw</Button>}
          {r?.canCancel && <Button variant="outline" disabled={busy} onClick={() => onCancel(r)}>Cancel Leave</Button>}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MyRequestsTable({ requests, loading, onChanged }: {
  requests: LeaveRequestRow[];
  loading: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [viewId, setViewId] = useState<number | null>(null);
  const viewed = requests.find((x) => x.id === viewId) ?? null;

  async function withdraw(r: LeaveRequestRow) {
    const ok = await confirm({
      title: 'Withdraw This Request?',
      description: `Withdraw your ${leaveKindLabel(r.kind)} request for ${dateRangeLabel(r)}?`,
      confirmLabel: 'Withdraw',
    });
    if (!ok) return;
    setBusyId(r.id);
    const toastId = showToast({ variant: 'loading', message: 'Withdrawing…' });
    try {
      await api.post(`/admin/leave/requests/${r.id}/withdraw`);
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Request Withdrawn' });
      setViewId(null);
      onChanged();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Withdraw Failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(r: LeaveRequestRow) {
    const ok = await confirm({
      title: 'Cancel This Leave?',
      description: `Cancel your approved ${leaveKindLabel(r.kind)} for ${dateRangeLabel(r)}? If it has already started, only the remaining days are called off.`,
      confirmLabel: 'Cancel Leave',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(r.id);
    const toastId = showToast({ variant: 'loading', message: 'Cancelling…' });
    try {
      await api.post(`/admin/leave/requests/${r.id}/cancel`, {});
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Leave Cancelled' });
      setViewId(null);
      onChanged();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Cancel Failed' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardContent className="p-0">
        <h2 className="border-b px-3 py-2 text-sm font-semibold text-muted-foreground">My Requests</h2>
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="!text-left">Type</th>
              <th className="!text-left">Days</th>
              <th className="!text-left">Status</th>
              <th className="!text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
            )}
            {!loading && requests.length === 0 && (
              <tr><td colSpan={4} className="!text-center text-muted-foreground py-6">No Upcoming Requests.</td></tr>
            )}
            {!loading && requests.map((r) => (
              <tr key={r.id}>
                <td className="!text-left">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium" title={leaveKindLabel(r.kind)}>{r.kind}</span>
                </td>
                <td className="!text-left">
                  <div className="font-medium tabular-nums">{r.days}</div>
                  <div className="whitespace-nowrap text-xs text-muted-foreground">{shortDates(r)}</div>
                </td>
                <td className="!text-left">
                  <StatusChip tone={STATUS_TONE[r.status]} size="sm">{LEAVE_STATUS_LABEL[r.status]}</StatusChip>
                </td>
                <td className="!text-center">
                  <IconButton icon={Eye} label="View Request" onClick={() => setViewId(r.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
      <RequestDetailDialog
        request={viewed}
        busy={viewed !== null && busyId === viewed.id}
        onClose={() => setViewId(null)}
        onWithdraw={(r) => void withdraw(r)}
        onCancel={(r) => void cancel(r)}
      />
    </Card>
  );
}
