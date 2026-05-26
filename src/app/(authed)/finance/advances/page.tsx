'use client';

/*
 * Audit Advance — multi-step approval workflow for advance payments to
 * easyfixers backed by `tbl_efr_advance_payment`.
 *
 * State machine (adv_status):
 *   0 = pending / initiated by PM
 *   1 = ops approved (mid-state)
 *   2 = finance approved (terminal)
 *   3 = rejected (by ops or finance)
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
};

const STATUS_LABEL: Record<number, string> = {
  0: 'Pending',
  1: 'Ops Approved',
  2: 'Finance Approved',
  3: 'Rejected',
};

/*
 * Adapter over the mandatory shared `@/lib/hooks` useFetch (per memory
 * `feedback_crm_ui_fetch_hooks`). The shared hook returns the raw
 * payload; this page consumes a list endpoint, so we normalise to
 * array semantics + `reload` naming to keep the call-site terse.
 */
function useFetch<T>(url: string | null): { data: T[]; loading: boolean; error: string | null; reload: () => void } {
  const { data, loading, error, refetch } = useSharedFetch<T[] | { items?: T[] }>(url);
  const arr: T[] = Array.isArray(data) ? data : ((data as { items?: T[] } | null)?.items ?? []);
  return { data: arr, loading, error, reload: refetch };
}

export default function AdvancesPage() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const url = `/admin/advances${statusFilter ? `?status=${statusFilter}` : ''}`;
  const { data, loading, error, reload } = useFetch<Advance>(url);

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
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Coins className="size-6" /> Audit Advance
        </h1>
        <p className="text-sm text-muted-foreground">
          Multi-step approval workflow for advance payments to easyfixers — PM initiates, Ops approves, Finance approves.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Status:</span>
        {['', '0', '1', '2', '3'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-0.5 rounded text-xs ${statusFilter === s ? 'bg-primary text-white' : 'bg-slate-200 text-slate-700'}`}
          >
            {s === '' ? 'All' : STATUS_LABEL[Number(s)]}
          </button>
        ))}
      </div>

      {loading && <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>}
      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
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
                <th>Client</th>
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
                <tr key={a.advance_id} className="hover:bg-slate-50">
                  <td className="!text-center font-mono text-xs">{a.advance_id}</td>
                  <td>
                    {a.efr_name || '—'}
                    <br />
                    <span className="text-xs text-muted-foreground font-mono">
                      #{a.efr_id} · {a.efr_no || '—'}
                    </span>
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
                    {a.adv_status === 0 && (
                      <>
                        <button
                          onClick={() => act(a, 'ops-approve')}
                          className="text-xs text-blue-600 hover:underline px-1.5"
                        >
                          <CheckCircle2 className="inline size-3 mb-0.5" /> Ops ✓
                        </button>
                        <button
                          onClick={() => act(a, 'reject')}
                          className="text-xs text-red-600 hover:underline px-1.5"
                        >
                          <XCircle className="inline size-3 mb-0.5" /> Reject
                        </button>
                      </>
                    )}
                    {a.adv_status === 1 && (
                      <>
                        <button
                          onClick={() => act(a, 'fin-approve')}
                          className="text-xs text-emerald-700 hover:underline px-1.5"
                        >
                          <CheckCircle2 className="inline size-3 mb-0.5" /> Fin ✓
                        </button>
                        <button
                          onClick={() => act(a, 'reject')}
                          className="text-xs text-red-600 hover:underline px-1.5"
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
  if (!advance) return null;
  return (
    <Dialog open={!!advance} onOpenChange={(o) => { if (!o) onClose(); }}>
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
