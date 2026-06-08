'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
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

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  // Reuse formatDate for the common case; if the source contains a time
  // component, append HH:mm so the operator can distinguish multiple
  // transactions on the same day.
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return formatDate(s);
  const date = formatDate(s);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
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
          {easyfixerMobile && (
            <div className="text-[12px] text-slate-300/85 mt-0.5">
              Mobile: {maskMobile(easyfixerMobile)}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-auto px-4 py-3">
          <table className="data-table w-full">
            <thead>
              <tr>
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
                  <td colSpan={11} className="text-center py-8 text-rose-600">
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
                <tr key={t.transaction_id}>
                  <td className="text-xs text-muted-foreground tabular-nums">{t.transaction_id}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(t.transaction_date)}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(t.appointment_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{fmtDateTime(t.completion_date_time)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(t.amount)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(t.balance)}</td>
                  <td className="text-xs">{t.customer_name ?? '—'}</td>
                  <td className="text-xs">{t.customer_address ?? '—'}</td>
                  <td className="text-xs">{t.location ?? '—'}</td>
                  <td className="text-xs">{t.transaction_by ?? '—'}</td>
                  <td className="text-xs">{t.description ?? '—'}</td>
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
