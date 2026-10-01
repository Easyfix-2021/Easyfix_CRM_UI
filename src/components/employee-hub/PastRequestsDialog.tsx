'use client';

/*
 * Past Requests — opens from the My Requests card header. My Requests keeps
 * only the current month's and later Pending / Approved leave; this lists the
 * rest of the caller's OWN requests (older months, plus Rejected / Withdrawn /
 * Cancelled whenever), newest first, read-only. Fetched on demand from
 * GET /admin/leave/requests/past — a null key while closed fetches nothing.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusChip } from '@/components/ui/StatusChip';
import { TablePagination, type TablePageSize, pageSizeToLimit, PAGE_SIZE_OPTIONS } from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate } from '@/lib/utils';
import {
  LEAVE_DURATION_LABEL, LEAVE_STATUS_LABEL, LEAVE_STATUS_TONE, leaveDateRangeLabel, leaveKindLabel,
  type LeavePastResponse,
} from './leave-types';

// The endpoint's Joi max is 100 — never ask for more, and 'All' cannot tell the truth here.
const PAST_LIMIT_CAP = 100;
const PAST_PAGE_SIZES: typeof PAGE_SIZE_OPTIONS = [
  ...PAGE_SIZE_OPTIONS.filter((o) => o.value !== 'all'),
  { value: 100, label: '100' },
];
const COLS = 8;

export function PastRequestsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const limit = pageSizeToLimit(pageSize, PAST_LIMIT_CAP);

  // Each opening starts on page 1, not wherever it was left.
  useEffect(() => { if (open) setPage(0); }, [open]);
  const key = open ? `/admin/leave/requests/past?page=${page + 1}&limit=${limit}` : null;
  const { data, loading, error } = useFetch<LeavePastResponse>(key);
  const total = data?.total ?? 0;

  // Read-only list — never dirty, but every <Dialog> close path goes through the guard.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => false });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Past Requests</DialogTitle>
        </DialogHeader>

        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Kind</th>
                <th className="!text-left">Dates</th>
                <th className="!text-left">Duration</th>
                <th className="!text-left">Days</th>
                <th className="!text-left">Reason</th>
                <th className="!text-left">Status</th>
                <th className="!text-left">Decided By / Note</th>
                <th className="!text-left">Requested At</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={COLS} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {error && (
                <tr><td colSpan={COLS} className="!text-center text-urgent py-6">{error}</td></tr>
              )}
              {!loading && !error && (data?.items.length ?? 0) === 0 && (
                <tr><td colSpan={COLS} className="!text-center text-muted-foreground py-6">No Past Requests.</td></tr>
              )}
              {!loading && !error && data?.items.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="!text-left whitespace-nowrap">{leaveKindLabel(r.kind)}</td>
                  <td className="!text-left whitespace-nowrap">{leaveDateRangeLabel(r)}</td>
                  <td className="!text-left whitespace-nowrap">{LEAVE_DURATION_LABEL[r.duration]}</td>
                  <td className="!text-left tabular-nums">{r.days}</td>
                  <td className="!text-left min-w-40 max-w-64 whitespace-normal break-words">
                    {r.reason || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left whitespace-nowrap">
                    <StatusChip tone={LEAVE_STATUS_TONE[r.status]} size="sm">{LEAVE_STATUS_LABEL[r.status]}</StatusChip>
                    {r.endedEarly && <div className="mt-0.5 text-xs text-muted-foreground">Ended Early</div>}
                  </td>
                  <td className="!text-left min-w-36 max-w-56 whitespace-normal break-words">
                    {r.decidedByName || r.decisionNote ? (
                      <>
                        {r.decidedByName && <div>{r.decidedByName}</div>}
                        {r.decisionNote && <div className="text-xs text-muted-foreground">{r.decisionNote}</div>}
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left whitespace-nowrap">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t px-3 py-2 -mx-6 -mb-6">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            pageSizeOptions={PAST_PAGE_SIZES}
            loading={loading}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
