'use client';

/*
 * Audit Advance — multi-step approval workflow for advance payments to
 * easyfixers backed by `tbl_efr_advance_payment`.
 *
 * State machine (adv_status) — legacy's ladder, shared with the still-live
 * Struts CRM writing the same table:
 *   1 = Initiated           (PM raised it, awaiting Ops)
 *   2 = Pending To Finance  (Ops approved, awaiting Finance)
 *   3 = Rejected by Ops     (terminal)
 *   4 = Advance Done        (Finance paid, terminal)
 *   5 = Rejected by Finance (terminal)
 *
 * Backend wiring:
 *   GET    /admin/advances?status=&efrId=
 *   POST   /admin/advances/:id/ops-approve
 *   POST   /admin/advances/:id/fin-approve
 *   POST   /admin/advances/:id/reject
 */

import { useEffect, useState } from 'react';
import { Coins, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { showToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFetch as useSharedFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { DownloadButton } from '@/components/ui/download-button';
import { downloadXlsx } from '@/lib/download-xlsx';

type Advance = {
  advance_id: number;
  client_id: number | null;
  job_id: number | null;
  efr_id: number;
  adv_status: number;
  job_total_amt: number | null;
  advance_amt: number | null;
  initiated_on: string | null;
  initiated_by: number | null;
  pm_remarks: string | null;
  ops_action_on: string | null;
  ops_remarks: string | null;
  fin_action_on: string | null;
  fin_remarks: string | null;
  transaction_id: string | null;
  efr_name: string | null;
  efr_no: string | null;
  client_name: string | null;
  /* Legacy Audit Advance columns this screen shipped without. Finance judges
     an advance against what the technician already holds, and Ops filters by
     city — neither was on the page. */
  city_name: string | null;
  current_balance: number | string | null;
  job_status: number | null;
};

/* Legacy's job-status filter: three buckets, not raw statuses
   (AdvanceDaoImpl.java:358). */
const JOB_STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All jobs' },
  { value: '1', label: 'Open' },
  { value: '2', label: 'Completed' },
  { value: '3', label: 'Cancelled / Enquiry' },
];

/*
 * adv_status labels — LEGACY's ladder, not an invented one. The legacy Struts
 * CRM is still live on the same tbl_efr_advance_payment, and its wording is
 * what Ops and Finance already read on that screen
 * (EasyFix_CRM AdvanceDaoImpl.java:429).
 *
 * This map used to be 0 Pending / 1 Ops Approved / 2 Finance Approved /
 * 3 Rejected, which mislabelled every legacy row: an untouched request (1)
 * displayed as "Ops Approved" and one still awaiting Finance (2) displayed as
 * "Finance Approved". Keep these in step with ADV_STATUS in
 * Easyfix_Backend/routes/admin/advances.js.
 */
const STATUS_LABEL: Record<number, string> = {
  1: 'Initiated',
  2: 'Pending To Finance',
  3: 'Rejected by Ops',
  4: 'Advance Done',
  5: 'Rejected by Finance',
};

/* Only these two states are actionable; 3, 4 and 5 are terminal. */
const STATUS_AWAITING_OPS = 1;
const STATUS_AWAITING_FINANCE = 2;

/*
 * Adapter over the mandatory shared `@/lib/hooks` useFetch (per memory
 * `feedback_crm_ui_fetch_hooks`). The shared hook returns the raw
 * payload; this page consumes a list endpoint, so we normalise to
 * array semantics + `reload` naming to keep the call-site terse.
 */
function useFetch<T>(url: string | null): {
  data: T[]; total: number; loading: boolean; error: string | null; reload: () => void;
} {
  const { data, loading, error, refetch } = useSharedFetch<T[] | { items?: T[]; total?: number }>(url);
  const arr: T[] = Array.isArray(data) ? data : ((data as { items?: T[] } | null)?.items ?? []);
  // Older payloads are a bare array with no count; fall back to what arrived so
  // the pager reads "1–n of n" rather than "of 0".
  const total = Array.isArray(data)
    ? data.length
    : ((data as { total?: number } | null)?.total ?? arr.length);
  return { data: arr, total, loading, error, reload: refetch };
}

export default function AdvancesPage() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [jobStatusFilter, setJobStatusFilter] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [downloading, setDownloading] = useState(false);
  const [page, setPage] = useState(0);

  /* Both halves of a range or neither — the BE only applies it when it has
     both ends, so sending one would silently do nothing. */
  const query = new URLSearchParams();
  if (statusFilter) query.set('status', statusFilter);
  if (jobStatusFilter) query.set('jobStatus', jobStatusFilter);
  if (dateFrom && dateTo) { query.set('dateFrom', dateFrom); query.set('dateTo', dateTo); }
  const qs = query.toString();

  // Legacy's page size (advancedApproved.vm:299).
  const PAGE_SIZE = 20;
  const pageQuery = new URLSearchParams(qs);
  pageQuery.set('limit', String(PAGE_SIZE));
  pageQuery.set('offset', String(page * PAGE_SIZE));

  const url = `/admin/advances?${pageQuery.toString()}`;
  const { data, total, loading, error, reload } = useFetch<Advance>(url);

  // Any filter change invalidates the current page number.
  useEffect(() => { setPage(0); }, [statusFilter, jobStatusFilter, dateFrom, dateTo]);

  async function download() {
    setDownloading(true);
    try {
      await downloadXlsx({
        url: `/admin/advances/export${qs ? `?${qs}` : ''}`,
        filename: `advance-list-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  }

  // Reject flow now uses a dedicated dialog instead of window.prompt.
  // Approve flows remain inline POST calls — no input needed.
  const [rejecting, setRejecting] = useState<Advance | null>(null);
  async function act(a: Advance, action: 'ops-approve' | 'fin-approve' | 'reject') {
    if (action === 'reject') {
      setRejecting(a);
      return;
    }
    try {
      if (action === 'ops-approve') {
        await api.post(`/admin/advances/${a.advance_id}/ops-approve`, {});
        showToast({ variant: 'success', message: 'Advance Approved By Ops' });
      } else {
        await api.post(`/admin/advances/${a.advance_id}/fin-approve`, {});
        showToast({ variant: 'success', message: 'Advance Approved By Finance' });
      }
      reload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Action failed' });
    }
  }
  async function submitReject(remarks: string) {
    if (!rejecting) return;
    try {
      await api.post(`/admin/advances/${rejecting.advance_id}/reject`, { remarks });
      showToast({ variant: 'success', message: 'Advance Rejected' });
      setRejecting(null);
      reload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reject failed' });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Coins className="size-6" /> Audit Advance
        </h1>
        <p className="text-sm text-muted-foreground">
          Multi-step approval workflow for advance payments to easyfixers — PM initiates, Ops approves, Finance approves.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Status:</span>
        {['', '1', '2', '3', '4', '5'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-0.5 rounded text-xs ${statusFilter === s ? 'bg-primary text-white' : 'bg-ink-100 text-ink-700'}`}
          >
            {s === '' ? 'All' : STATUS_LABEL[Number(s)]}
          </button>
        ))}
      </div>

      {/* Legacy's remaining filters. City / NDM / PM are supported by the API
          but need their own lookup pickers — not wired here yet. */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Job status</Label>
          <select
            value={jobStatusFilter}
            onChange={(e) => setJobStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm shadow-sm focus:outline-none"
          >
            {JOB_STATUS_FILTERS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">From</Label>
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-40" />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">To</Label>
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-40" />
        </div>
        {(dateFrom || dateTo) && (
          <Button
            variant="outline"
            onClick={() => { setDateFrom(''); setDateTo(''); }}
            className="h-9"
          >
            Clear dates
          </Button>
        )}
        <div className="ml-auto">
          {/* Legacy's "Download Advance" — exports the filtered set. */}
          <DownloadButton onClick={() => void download()} downloading={downloading} />
        </div>
      </div>
      {(dateFrom && !dateTo) || (!dateFrom && dateTo) ? (
        <p className="text-xs text-muted-foreground">Pick both dates to apply the range.</p>
      ) : null}

      {loading && <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>}
      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}
      {!loading && !error && data.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No advances match the filter.
        </div>
      )}
      {!loading && !error && data.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th>
                <th>Easyfixer</th>
                {/* Finance approves against what the tech already holds. */}
                <th className="!text-right">Tx Balance ₹</th>
                <th>Client</th>
                <th>City</th>
                <th className="!text-center">Job</th>
                <th className="!text-right">Job Total ₹</th>
                <th className="!text-right">Advance ₹</th>
                <th className="!text-center">Status</th>
                <th>Initiated</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.advance_id} className="hover:bg-ink-50">
                  <td className="!text-center font-mono text-xs">{a.advance_id}</td>
                  <td>
                    {a.efr_name || '—'}
                    <br />
                    <span className="text-xs text-muted-foreground font-mono">
                      #{a.efr_id} · {a.efr_no || '—'}
                    </span>
                  </td>
                  <td className="!text-right font-mono">
                    {a.current_balance != null ? Number(a.current_balance).toFixed(2) : '—'}
                  </td>
                  <td className="text-xs">
                    {a.client_name || '—'}
                    {a.client_id != null && (
                      <>
                        <br />
                        <span className="text-muted-foreground font-mono">#{a.client_id}</span>
                      </>
                    )}
                  </td>
                  <td className="text-xs">{a.city_name || '—'}</td>
                  <td className="!text-center font-mono text-xs">{a.job_id ?? '—'}</td>
                  <td className="!text-right font-mono">
                    {a.job_total_amt != null ? Number(a.job_total_amt).toFixed(2) : '—'}
                  </td>
                  <td className="!text-right font-mono">
                    {a.advance_amt != null ? Number(a.advance_amt).toFixed(2) : '—'}
                  </td>
                  <td className="!text-center text-xs">
                    {STATUS_LABEL[a.adv_status] ?? a.adv_status}
                  </td>
                  <td className="text-xs">{a.initiated_on ? formatDate(a.initiated_on) : '—'}</td>
                  <td className="!text-right whitespace-nowrap">
                    {a.adv_status === STATUS_AWAITING_OPS && (
                      <>
                        <button
                          onClick={() => act(a, 'ops-approve')}
                          className="text-xs text-primary hover:underline px-1.5"
                        >
                          <CheckCircle2 className="inline size-3 mb-0.5" /> Ops ✓
                        </button>
                        <button
                          onClick={() => act(a, 'reject')}
                          className="text-xs text-urgent hover:underline px-1.5"
                        >
                          <XCircle className="inline size-3 mb-0.5" /> Reject
                        </button>
                      </>
                    )}
                    {a.adv_status === STATUS_AWAITING_FINANCE && (
                      <>
                        <button
                          onClick={() => act(a, 'fin-approve')}
                          className="text-xs text-success-strong hover:underline px-1.5"
                        >
                          <CheckCircle2 className="inline size-3 mb-0.5" /> Fin ✓
                        </button>
                        <button
                          onClick={() => act(a, 'reject')}
                          className="text-xs text-urgent hover:underline px-1.5"
                        >
                          <XCircle className="inline size-3 mb-0.5" /> Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Pager — legacy showed an entries count and a page control; without one
          this screen silently stopped at its fetch limit. */}
      {!loading && !error && total > 0 && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-8"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              className="h-8"
              onClick={() => setPage((p) => p + 1)}
              disabled={(page + 1) * PAGE_SIZE >= total}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <RejectAdvanceDialog advance={rejecting} onClose={() => setRejecting(null)} onSubmit={submitReject} />
    </div>
  );
}

/*
 * RejectAdvanceDialog — replaces the legacy window.prompt with a real
 * modal capturing the optional rejection remarks. Submits with empty
 * remarks if the operator just clicks Reject.
 */
function RejectAdvanceDialog({ advance, onClose, onSubmit }: {
  advance: { advance_id: number } | null; onClose: () => void; onSubmit: (remarks: string) => Promise<void>;
}) {
  const [remarks, setRemarks] = useState('');
  useEffect(() => { if (advance) setRemarks(''); }, [advance]);
  // Hook order requires this BEFORE the conditional return, but the
  // handler still needs to read the latest `remarks` — useFormDirtyGuard
  // stores opts in a ref so inline closures stay current across renders.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => remarks.trim() !== '',
  });
  if (!advance) return null;
  return (
    <Dialog open={!!advance} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Reject Advance #{advance.advance_id}</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div>
            <Label>Remarks</Label>
            <Input
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Optional rejection reason"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onSubmit(remarks)}>Reject</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
