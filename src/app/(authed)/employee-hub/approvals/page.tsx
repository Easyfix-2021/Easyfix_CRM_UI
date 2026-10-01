'use client';

/*
 * Employee Hub → Leave Approvals — Pending / History tabs for whoever a
 * request routes to (the snapshotted reporting-manager, or a Roster Admin
 * for everything). No action-key gate — the backend scopes the list to
 * "requests I may decide" (pending) / "requests I decided or approved"
 * (history), same as the leave-contract's approver semantics.
 *
 * `?request=<id>` (from an approval email or the SL popup's "Review
 * Request") highlights and scrolls to that row IF it's on the current
 * page of the current tab. It does not search across tabs/pages for it —
 * the common case is a freshly-created PENDING request landing on page 1
 * of Pending, which this covers; a request that has since moved to a later
 * page or been decided needs the operator to switch tabs/pages themselves.
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { CancelButton } from '@/components/ui/cancel-button';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { cn, formatDate } from '@/lib/utils';
import { formatYmdLabel } from '@/components/roster/roster-dates';
import {
  LEAVE_DURATION_LABEL, LEAVE_STATUS_LABEL, leaveKindLabel,
  type LeaveApprovalRow, type LeaveApprovalsResponse, type LeaveStatus,
} from '@/components/employee-hub/leave-types';

const STATUS_TONE: Record<LeaveStatus, StatusChipTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'urgent',
  WITHDRAWN: 'neutral',
  CANCELLED: 'neutral',
};

function dateRangeLabel(r: LeaveApprovalRow): string {
  return r.toDate !== r.fromDate ? `${formatYmdLabel(r.fromDate)} – ${formatYmdLabel(r.toDate)}` : formatYmdLabel(r.fromDate);
}

export default function LeaveApprovalsPage() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get('request');
  const confirm = useConfirm();

  const [tab, setTab] = React.useState<'pending' | 'history'>('pending');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [rejecting, setRejecting] = React.useState<LeaveApprovalRow | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);

  React.useEffect(() => { setPage(0); }, [tab]);

  const limit = pageSizeToLimit(pageSize);
  const key = `/admin/leave/approvals?status=${tab}&page=${page + 1}&limit=${limit}`;
  const { data, loading, error, refetch } = useFetch<LeaveApprovalsResponse>(key);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const rowRefs = React.useRef<Record<number, HTMLTableRowElement | null>>({});
  React.useEffect(() => {
    if (!highlightId) return;
    const el = rowRefs.current[Number(highlightId)];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, items]);

  function refresh() {
    invalidateFetch((k) => k.startsWith('/admin/leave/approvals'));
    refetch();
  }

  async function approve(r: LeaveApprovalRow) {
    const ok = await confirm({
      title: 'Approve This Request?',
      description: `Approve ${r.userName}'s ${leaveKindLabel(r.kind)} for ${dateRangeLabel(r)}?`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusyId(r.id);
    const toastId = showToast({ variant: 'loading', message: 'Approving…' });
    try {
      await api.post(`/admin/leave/requests/${r.id}/decide`, { decision: 'APPROVE' });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Request Approved' });
      refresh();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Approve Failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function cancelApproved(r: LeaveApprovalRow) {
    const ok = await confirm({
      title: 'Cancel This Leave?',
      description: `Cancel ${r.userName}'s approved ${leaveKindLabel(r.kind)} for ${dateRangeLabel(r)}? If it has already started, only the remaining days are called off.`,
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
      refresh();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Cancel Failed' });
    } finally {
      setBusyId(null);
    }
  }

  const colCount = tab === 'pending' ? 8 : 9;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldCheck className="size-6" /> Leave Approvals
        </h1>
        <p className="text-sm text-muted-foreground">Requests routed to you as reporting head or roster admin.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'pending' | 'history')}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>

      {error && <Card><CardContent className="p-3 text-sm text-urgent-strong">{error}</CardContent></Card>}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-left">Employee</th>
                  <th className="!text-left">Kind</th>
                  <th className="!text-left">Dates</th>
                  <th className="!text-left">Duration</th>
                  <th className="!text-center">Days</th>
                  <th className="!text-left">Reason</th>
                  <th className="!text-left">Requested At</th>
                  {tab === 'history' && <th className="!text-left">Status</th>}
                  <th className="!text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={colCount} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!loading && items.length === 0 && (
                  <tr><td colSpan={colCount} className="!text-center text-muted-foreground py-6">
                    {tab === 'pending' ? 'No Pending Requests.' : 'No Decided Requests Yet.'}
                  </td></tr>
                )}
                {!loading && items.map((r) => {
                  const busy = busyId === r.id;
                  const isHighlighted = highlightId != null && Number(highlightId) === r.id;
                  return (
                    <tr
                      key={r.id}
                      ref={(el) => { rowRefs.current[r.id] = el; }}
                      className={isHighlighted ? 'bg-info-tint' : undefined}
                    >
                      <td className="!text-left">
                        <div className="font-medium">{r.userName}</div>
                        {(r.empCode || r.roleName) && (
                          <div className="text-xs text-muted-foreground">{[r.empCode, r.roleName].filter(Boolean).join(' · ')}</div>
                        )}
                      </td>
                      <td className="!text-left">{leaveKindLabel(r.kind)}</td>
                      <td className="!text-left whitespace-nowrap">{dateRangeLabel(r)}</td>
                      <td className="!text-left">{LEAVE_DURATION_LABEL[r.duration]}</td>
                      <td className="!text-center tabular-nums">{r.days}</td>
                      <td className="!text-left text-xs max-w-[200px] truncate" title={r.reason ?? ''}>
                        {r.reason || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="!text-left text-xs whitespace-nowrap">{formatDate(r.createdAt)}</td>
                      {tab === 'history' && (
                        <td className="!text-left">
                          <StatusChip tone={STATUS_TONE[r.status]} size="sm">{LEAVE_STATUS_LABEL[r.status]}</StatusChip>
                          {r.endedEarly && <div className="mt-0.5 text-xs text-muted-foreground">Ended Early</div>}
                          {r.decisionNote && (
                            <div className="mt-0.5 text-xs text-muted-foreground truncate" title={r.decisionNote}>“{r.decisionNote}”</div>
                          )}
                        </td>
                      )}
                      <td className="!text-center whitespace-nowrap">
                        {tab === 'pending' && r.canDecide && (
                          <div className="inline-flex gap-1.5">
                            <Button size="sm" disabled={busy} onClick={() => void approve(r)}>Approve</Button>
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(r)}>Reject</Button>
                          </div>
                        )}
                        {tab === 'history' && r.canCancel && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancelApproved(r)}>Cancel</Button>
                        )}
                        {!(tab === 'pending' && r.canDecide) && !(tab === 'history' && r.canCancel) && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t px-3 py-2">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              loading={loading}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      {rejecting && (
        <RejectLeaveDialog request={rejecting} onClose={() => setRejecting(null)} onSaved={() => { setRejecting(null); refresh(); }} />
      )}
    </div>
  );
}

function RejectLeaveDialog({ request, onClose, onSaved }: {
  request: LeaveApprovalRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: note.trim() !== '', when: () => !submitting });
  const canSubmit = note.trim() !== '' && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Rejecting…' });
    try {
      await api.post(`/admin/leave/requests/${request.id}/decide`, { decision: 'REJECT', note: note.trim() });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Request Rejected' });
      onSaved();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reject Failed' });
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reject Request</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm">
            <div className="font-medium">{request.userName}</div>
            <div className="text-muted-foreground">{leaveKindLabel(request.kind)} · {dateRangeLabel(request)}</div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Note (Required)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Why This Request Cannot Be Approved"
              className={cn('min-h-[80px] w-full rounded border bg-background px-2 py-1 text-sm')}
            />
          </div>
        </div>
        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button variant="destructive" onClick={submit} disabled={!canSubmit}>{submitting ? 'Rejecting…' : 'Reject Request'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
