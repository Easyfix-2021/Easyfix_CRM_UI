'use client';

/*
 * My Requests — the requester's own leave history on /employee-hub/attendance.
 * Withdraw (PENDING, canWithdraw) and Cancel (APPROVED, canCancel) both go
 * through useConfirm; the backend is the source of truth for which button a
 * row gets (canWithdraw / canCancel), this table just renders what it's told.
 */

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
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

export function MyRequestsTable({ requests, loading, onChanged }: {
  requests: LeaveRequestRow[];
  loading: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<number | null>(null);

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
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Kind</th>
                <th className="!text-left">Dates</th>
                <th className="!text-left">Duration</th>
                <th className="!text-center">Days</th>
                <th className="!text-left">Reason</th>
                <th className="!text-left">Status</th>
                <th className="!text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && requests.length === 0 && (
                <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">No Requests Yet.</td></tr>
              )}
              {!loading && requests.map((r) => {
                const busy = busyId === r.id;
                return (
                  <tr key={r.id}>
                    <td className="!text-left">{leaveKindLabel(r.kind)}</td>
                    <td className="!text-left whitespace-nowrap">{dateRangeLabel(r)}</td>
                    <td className="!text-left">{LEAVE_DURATION_LABEL[r.duration]}</td>
                    <td className="!text-center tabular-nums">{r.days}</td>
                    <td className="!text-left text-xs max-w-[220px] truncate" title={r.reason ?? ''}>
                      {r.reason || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-left">
                      <StatusChip tone={STATUS_TONE[r.status]} size="sm">{LEAVE_STATUS_LABEL[r.status]}</StatusChip>
                      {r.endedEarly && <div className="mt-0.5 text-xs text-muted-foreground">Ended Early</div>}
                      {r.decisionNote && (
                        <div className="mt-0.5 text-xs text-muted-foreground truncate" title={r.decisionNote}>“{r.decisionNote}”</div>
                      )}
                    </td>
                    <td className="!text-center whitespace-nowrap">
                      <div className="inline-flex gap-1.5">
                        {r.canWithdraw && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void withdraw(r)}>Withdraw</Button>
                        )}
                        {r.canCancel && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel(r)}>Cancel</Button>
                        )}
                        {!r.canWithdraw && !r.canCancel && <span className="text-xs text-muted-foreground">—</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
