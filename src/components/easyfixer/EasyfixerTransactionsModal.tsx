'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate, formatEasyfixerName } from '@/lib/utils';

/*
 * EasyfixerTransactionsModal — paginated transaction history for a single
 * easyfixer. BE contract (sibling agent is shipping this):
 *
 *   GET /admin/easyfixers/:id/transactions?limit=&offset=
 *     → { items: Transaction[]; total; limit; offset }
 *
 * We use the project's standard useFetch + TablePagination pair so this
 * matches every other list page in the CRM. The header band uses the
 * auto-styled dark-slate `DialogHeader`, so no extra theming is needed.
 */
type Transaction = {
  transaction_id: number;
  transaction_date: string | null;
  appointment_date_time: string | null;
  completion_date_time: string | null;
  amount: number | string | null;
  balance: number | string | null;
  customer_name: string | null;
  customer_address: string | null;
  location: string | null;
  transaction_by: string | null;
  description: string | null;
};

type Resp = { items: Transaction[]; total: number; limit: number; offset: number };

function maskMobile(no: string | null | undefined): string {
  if (!no) return '';
  const digits = no.replace(/\D/g, '');
  if (digits.length < 4) return no;
  return digits.slice(0, 2) + 'XXXXX' + digits.slice(-3);
}

function fmtMoney(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN')}`;
}

/*
 * formatDate ALREADY renders hour and minute, in Asia/Kolkata. This used to
 * append its own HH:mm on top, which printed the time twice —
 * "26 Aug 2026, 11:58 am 11:58" — and the appended half was wrong anywhere
 * outside IST, because it came from `new Date(s).getHours()`, i.e. the
 * BROWSER's clock, on a value that is a zone-less IST wall clock. That is the
 * exact trap formatDate's own comment exists to warn about.
 */
function fmtDateTime(s: string | null | undefined): string {
  return s ? formatDate(s) : '—';
}

export function EasyfixerTransactionsModal({
  open,
  onClose,
  easyfixerId,
  easyfixerName,
  easyfixerMobile,
}: {
  open: boolean;
  onClose: () => void;
  easyfixerId: number | null;
  easyfixerName: string | null;
  easyfixerMobile?: string | null;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

  // Read-only modal — no form input; guard short-circuits straight to
  // onClose. Keeps the project's no-restricted-syntax ESLint rule happy.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  // BE Joi cap on this endpoint is unknown to us — default the helper to 1000
  // which matches the project-wide TablePagination convention.
  const limit = pageSizeToLimit(pageSize, 1000);

  const listKey = useMemo(() => {
    if (!open || !easyfixerId) return null;
    const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    return `/admin/easyfixers/${easyfixerId}/transactions?${p.toString()}`;
  }, [open, easyfixerId, page, pageSize, limit]);

  const { data, loading, error } = useFetch<Resp>(listKey);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const headerTitle =
    easyfixerName
      ? `Transaction List — ${formatEasyfixerName(easyfixerName)}`
      : 'Transaction List';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-6xl w-[min(96vw,1200px)] h-[80vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{headerTitle}</DialogTitle>
          {/*
            * DialogDescription, not a bare <div>: Radix warns when DialogContent
            * has no description, and the sub-line was already carrying exactly
            * that role. Rendered unconditionally so the dialog is still
            * described when the easyfixer has no mobile on file.
            */}
          <DialogDescription className="mt-0.5">
            {easyfixerMobile
              ? `Mobile: ${maskMobile(easyfixerMobile)}`
              : 'Completed job transactions for this easyfixer.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-4 py-3">
          {/*
            * `table-fixed` + an explicit colgroup, because the browser's auto
            * layout was sizing columns by CONTENT and starving the two that
            * actually need room: Customer Address wrapped to five lines inside
            * ~90px while the date columns sat wide on a single short value.
            *
            * Each width holds its HEADER on one line — that is what stops
            * "Trans. Id" and "Customer Address" breaking mid-phrase — and the
            * three free-text columns wrap inside theirs. The total exceeds the
            * modal, so the body scrolls sideways; min-w is what keeps the
            * columns at their intended size instead of being squeezed back.
            */}
          <table className="data-table w-full table-fixed min-w-[1480px]">
            <colgroup>
              <col className="w-[92px]" />{/* Trans. Id */}
              <col className="w-[152px]" />{/* Trans. Date */}
              <col className="w-[152px]" />{/* Appointment Date Time */}
              <col className="w-[168px]" />{/* Date Time For Completion */}
              <col className="w-[104px]" />{/* Amount */}
              <col className="w-[112px]" />{/* Balance */}
              <col className="w-[160px]" />{/* Customer Name */}
              <col className="w-[240px]" />{/* Customer Address */}
              <col className="w-[120px]" />{/* Location */}
              <col className="w-[132px]" />{/* Trans. By */}
              <col className="w-[248px]" />{/* Description */}
            </colgroup>
            <thead>
              <tr className="[&>th]:whitespace-nowrap [&>th]:align-bottom">
                <th>Trans. Id</th>
                <th>Trans. Date</th>
                <th>Appointment Date Time</th>
                <th>Date Time For Completion</th>
                <th className="text-right">Amount (₹)</th>
                <th className="text-right">Balance (₹)</th>
                <th>Customer Name</th>
                <th>Customer Address</th>
                <th>Location</th>
                <th>Trans. By</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-urgent-strong">
                    {error}
                  </td>
                </tr>
              )}
              {!loading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-muted-foreground">
                    No Transactions Yet.
                  </td>
                </tr>
              )}
              {!loading && !error && items.map((t) => (
                <tr key={t.transaction_id} className="align-top">
                  <td className="text-xs text-muted-foreground tabular-nums">{t.transaction_id}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(t.transaction_date)}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(t.appointment_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(t.completion_date_time)}</td>
                  <td className="text-right text-xs tabular-nums">{fmtMoney(t.amount)}</td>
                  <td className="text-right text-xs tabular-nums">{fmtMoney(t.balance)}</td>
                  <td className="text-xs break-words">{t.customer_name || '—'}</td>
                  <td className="text-xs break-words">{t.customer_address || '—'}</td>
                  <td className="text-xs break-words">{t.location || '—'}</td>
                  <td className="text-xs break-words">{t.transaction_by || '—'}</td>
                  {/* Ledger notes are free text and arrive with trailing CRLF —
                      whitespace-pre-line keeps intended line breaks without
                      preserving the stray ones as blank space. */}
                  <td className="text-xs break-words whitespace-pre-line">{(t.description || '—').trim()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-2 border-t bg-background">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
