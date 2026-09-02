'use client';

/*
 * Drill-down modal for one technician's category-wise performance (native
 * rebuild of the legacy Angular app-tx-summary popup). Opened from the
 * "Name & Id" link in the main Technician Performance table.
 *
 * Fetches GET /admin/quicksight/technician-performance/:txId/by-category?flag=…
 * via the mandatory useFetch hook (keyed on txId+flag — never raw
 * useEffect+api.get). The response carries 3 periods, each with a categories[]
 * list. A month/period navigator (< >) steps through the periods, guarding
 * array access so the modal renders before the request resolves and never
 * crashes on a period with no categories (fixes the legacy no-length-guard
 * fragility).
 *
 * Modal header uses the shared DialogHeader band (bg-sidebar /
 * text-sidebar-foreground gradient applied globally per the modal-header
 * convention). Title Case labels throughout.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFetch } from '@/lib/hooks';

type Flag = 'monthly' | 'weekly';

type CategoryRow = {
  categoryId: number;
  categoryName: string;
  tktCount: number;
  tktCompleted: number;
  tktSdaCount: number;
  tktTatCount: number;
  txOpenOrderOnApp: number;
  sdaPercentage: number | null;
  tatPercentage: number | null;
};

type PeriodBlock = {
  detailsFor: string;
  startDate: string;
  endDate: string;
  categories: CategoryRow[];
};

type CategoryWisePayload = {
  technicianId: number;
  performanceData: PeriodBlock[];
};

/* '-' when null, else 'N%'; green when >=85 else red (legacy colour rule). */
function pctCell(v: number | null) {
  if (v == null) return <span className="text-muted-foreground">-</span>;
  const ok = v >= 85;
  return (
    <span className={ok ? 'text-success font-medium' : 'text-urgent font-medium'}>
      {v}%
    </span>
  );
}

export function TechnicianCategoryModal({
  txId,
  txName,
  flag,
  open,
  onOpenChange,
}: {
  txId: number | null;
  txName: string;
  flag: Flag;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  // Reset the period navigator whenever the modal opens for a new tech.
  const [periodIdx, setPeriodIdx] = useState(0);
  useEffect(() => {
    if (open) setPeriodIdx(0);
  }, [open, txId]);

  // Only fetch while the modal is open AND we have a real tech id (the
  // synthetic "No Technician" row has txId=null and is not clickable).
  const fetchKey =
    open && txId != null
      ? `/admin/quicksight/technician-performance/${txId}/by-category?flag=${flag}`
      : null;
  const { data, loading, error } = useFetch<CategoryWisePayload>(fetchKey);

  const periods = useMemo(() => data?.performanceData ?? [], [data]);
  // Guard the navigator index against an empty / shorter-than-expected list.
  const safeIdx = periods.length ? Math.min(periodIdx, periods.length - 1) : 0;
  const current = periods[safeIdx];
  const categories = current?.categories ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        * SINGLE SCROLLER — pinned header and navigator.
        *
        * DialogContent scrolls the whole panel by default (max-h-[85vh]
        * overflow-y-auto), and the table band below used to carry its own
        * max-h-[60vh] overflow-auto. That is two nested scrollers: a technician
        * with many categories filled the inner band, the panel then scrolled a
        * second time, and the period navigator scrolled out of reach while the
        * operator was still reading the table it drives. Opting out the way the
        * shared component documents — flex column, non-scrolling children
        * shrink-0, one flex-1 middle absorbing the overflow — leaves exactly
        * one scrollbar.
        *
        * min-h-0 is load-bearing: a flex child defaults to min-height:auto and
        * refuses to shrink below its content, so without it the table band
        * would grow the panel instead of scrolling and the pinning would
        * silently do nothing.
        */}
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Category Performance — {txName}
            {txId != null ? ` (${txId})` : ''}
          </DialogTitle>
        </DialogHeader>

        {/* Period navigator. */}
        <div className="shrink-0 flex items-center justify-center gap-4 py-1">
          <button
            type="button"
            aria-label="Previous Period"
            disabled={loading || safeIdx <= 0}
            onClick={() => setPeriodIdx((i) => Math.max(0, i - 1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-40 text-center text-sm font-medium">
            {current ? current.detailsFor : '—'}
          </span>
          <button
            type="button"
            aria-label="Next Period"
            disabled={loading || safeIdx >= periods.length - 1}
            onClick={() => setPeriodIdx((i) => Math.min(periods.length - 1, i + 1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-urgent">{error}</div>
          ) : categories.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No data available
            </div>
          ) : (
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-left">Category Name</th>
                  <th className="!text-right">Ticket Allocated</th>
                  <th className="!text-right">SDA%</th>
                  <th className="!text-right">TAT%</th>
                  <th className="!text-right">Open Order In App</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.categoryId}>
                    <td className="!text-left">{c.categoryName || '—'}</td>
                    <td className="!text-right">{c.tktCount}</td>
                    <td className="!text-right">{pctCell(c.sdaPercentage)}</td>
                    <td className="!text-right">{pctCell(c.tatPercentage)}</td>
                    <td className="!text-right">{c.txOpenOrderOnApp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
