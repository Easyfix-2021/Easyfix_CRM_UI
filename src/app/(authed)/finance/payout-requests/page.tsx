'use client';

/*
 * Payout Requests — finance-side processor for technician wallet withdrawals.
 *
 * Technicians submit withdrawals from the mobile app (POST /api/mobile/withdraw),
 * which records an intent row in tbl_easyfixer_withdrawal_request WITHOUT
 * debiting. This page is where finance settles them: PAY (debit the wallet +
 * mark paid) or REJECT (no debit). Money movement is transactional + idempotent
 * server-side (services/withdrawal.service.js::processWithdrawal).
 *
 * Backend wiring:
 *   GET  /admin/withdrawals?status=&q=&page=&limit=     → { items, total, page, limit }
 *   POST /admin/withdrawals/:id/process  { action: 'pay'|'reject', remarks? }
 *
 * RBAC: page gated by isPayoutRequestsView, Pay/Reject gated by
 * isPayoutRequestsProcess (seeded in 2026-07-09-seed-payout-requests-rbac.sql,
 * granted to Admin + Finance).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, CheckCircle2, XCircle, AlertTriangle, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch as useSharedFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';

type PayoutRow = {
  request_id: number;
  fk_easyfixer_id: number;
  amount: number | string;
  status: string;
  requested_on: string | null;
  processed_on: string | null;
  processed_by: number | null;
  remarks: string | null;
  efr_name: string | null;
  efr_no: string | null;
  current_balance: number | string | null;
};

type Resp = { items: PayoutRow[]; total: number; page: number; limit: number };

// Endpoint's Joi `limit.max()` — the TablePagination "All" cap must match it.
const LIMIT_CAP = 200;

const STATUS_META: Record<string, { label: string; tone: StatusChipTone }> = {
  requested:  { label: 'Requested',  tone: 'amber' },
  paid:       { label: 'Paid',       tone: 'emerald' },
  rejected:   { label: 'Rejected',   tone: 'red' },
};

// Statuses finance can still act on (mirror of the backend guard).
const OPEN_STATUSES = new Set(['requested']);

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '',          label: 'All' },
  { value: 'requested', label: 'Requested' },
  { value: 'paid',      label: 'Paid' },
  { value: 'rejected',  label: 'Rejected' },
];

function inr(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

export default function PayoutRequestsPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const canView = hasAction(me, 'isPayoutRequestsView');
  const canProcess = hasAction(me, 'isPayoutRequestsProcess');

  // Fail-closed: bounce operators without view permission back to the dashboard
  // once we KNOW their permissions (not while auth is still loading).
  useEffect(() => {
    if (!meLoading && !canView) router.replace('/dashboard');
  }, [meLoading, canView, router]);

  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(0);              // 0-indexed (TablePagination)
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const [busyId, setBusyId] = useState<number | null>(null);

  // A filter/search change resets to the first page so we never land on an
  // out-of-range page for the new result set.
  useEffect(() => { setPage(0); }, [status, debouncedSearch]);

  const limit = pageSizeToLimit(pageSize, LIMIT_CAP);
  const pageParam = pageSize === 'all' ? 1 : page + 1;   // backend is 1-based
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (debouncedSearch.trim()) qs.set('q', debouncedSearch.trim());
  qs.set('page', String(pageParam));
  qs.set('limit', String(limit));
  const key = canView ? `/admin/withdrawals?${qs.toString()}` : null;

  const { data, loading, error, refetch } = useSharedFetch<Resp>(key, { enabled: canView });
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  const confirm = useConfirm();
  // Remarks captured by the (uncontrolled) textarea inside the confirm dialog.
  // Uncontrolled because the confirm description JSX is snapshotted at call
  // time — a controlled input wouldn't re-render the provider on keystrokes.
  const remarksRef = useRef('');

  async function processRow(row: PayoutRow, action: 'pay' | 'reject') {
    remarksRef.current = '';
    const isPay = action === 'pay';
    const amt = inr(row.amount);
    const who = row.efr_name || 'the technician';

    const ok = await confirm({
      title: isPay ? 'Pay Withdrawal?' : 'Reject Withdrawal?',
      variant: isPay ? 'default' : 'destructive',
      confirmLabel: isPay ? 'Pay' : 'Reject',
      iconAccent: isPay ? 'emerald' : 'rose',
      icon: isPay ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />,
      description: (
        <div className="space-y-3">
          <p>
            {isPay ? (
              <>This will debit <b>&#8377;{amt}</b> from the wallet of <b>{who}</b> and mark the request <b>Paid</b>. This cannot be undone.</>
            ) : (
              <>This will mark the <b>&#8377;{amt}</b> withdrawal request from <b>{who}</b> as <b>Rejected</b>. No money is debited.</>
            )}
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Remarks (Optional)</label>
            <textarea
              defaultValue=""
              onChange={(e) => { remarksRef.current = e.target.value; }}
              rows={3}
              placeholder="Add a note (stored on the request)"
              className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      ),
    });
    if (!ok) return;

    setBusyId(row.request_id);
    const toastId = showToast({ variant: 'loading', message: isPay ? 'Processing Payment…' : 'Rejecting Request…' });
    try {
      await api.post(`/admin/withdrawals/${row.request_id}/process`, {
        action,
        remarks: remarksRef.current.trim() || undefined,
      });
      dismissToast(toastId);
      showToast({ variant: 'success', message: isPay ? 'Withdrawal Paid' : 'Withdrawal Rejected' });
      // Bust the cached list AND re-run the mounted hook (invalidateFetch only
      // evicts the cache; it doesn't refetch a live subscriber).
      invalidateFetch((k) => k.startsWith('/admin/withdrawals'));
      refetch();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Action Failed' });
    } finally {
      setBusyId(null);
    }
  }

  // Don't flash the table before the permission check resolves.
  if (meLoading || !canView) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Wallet className="size-6" /> Payout Requests
        </h1>
        <p className="text-sm text-muted-foreground">
          Technician wallet withdrawal requests. Pay to debit the wallet and settle, or reject.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Status:</span>
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value || 'all'}
                onClick={() => setStatus(s.value)}
                className={`rounded px-2 py-0.5 text-xs ${status === s.value ? 'bg-primary text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Technician / Mobile"
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      {loading && <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>}
      {error && (
        <Card><CardContent className="flex items-center gap-2 p-3 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No payout requests match the filter.
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Technician</th>
                  <th>Mobile</th>
                  <th className="!text-right">Amount &#8377;</th>
                  <th className="!text-right">Current Balance &#8377;</th>
                  <th>Requested On</th>
                  <th className="!text-center">Status</th>
                  <th className="!text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const meta = STATUS_META[r.status] ?? { label: r.status, tone: 'slate' as StatusChipTone };
                  const actionable = canProcess && OPEN_STATUSES.has(r.status);
                  const rowBusy = busyId === r.request_id;
                  return (
                    <tr key={r.request_id} className="hover:bg-slate-50">
                      <td>
                        {r.efr_name || '—'}
                        <br />
                        <span className="text-xs text-muted-foreground font-mono">#{r.fk_easyfixer_id}</span>
                      </td>
                      <td className="font-mono text-xs">{r.efr_no || '—'}</td>
                      <td className="!text-right font-mono">{inr(r.amount)}</td>
                      <td className="!text-right font-mono">{inr(r.current_balance)}</td>
                      <td className="text-xs">{r.requested_on ? formatDate(r.requested_on) : '—'}</td>
                      <td className="!text-center"><StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip></td>
                      <td className="!text-right whitespace-nowrap">
                        {actionable ? (
                          <div className="inline-flex items-center gap-1">
                            <IconButton
                              icon={CheckCircle2}
                              intent="success"
                              label="Pay Withdrawal"
                              busy={rowBusy}
                              onClick={() => processRow(r, 'pay')}
                            />
                            <IconButton
                              icon={XCircle}
                              intent="danger"
                              label="Reject Withdrawal"
                              disabled={rowBusy}
                              onClick={() => processRow(r, 'reject')}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t p-3">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
