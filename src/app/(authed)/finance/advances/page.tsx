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

function useFetch<T>(url: string | null, deps: unknown[] = []): {
  data: T[]; loading: boolean; error: string | null; reload: () => void;
} {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const d = await api.get<T[]>(url);
        if (!cancelled) setData(Array.isArray(d) ? d : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, bump, ...deps]);
  return { data, loading, error, reload: () => setBump((b) => b + 1) };
}

export default function AdvancesPage() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const url = `/admin/advances${statusFilter ? `?status=${statusFilter}` : ''}`;
  const { data, loading, error, reload } = useFetch<Advance>(url, [statusFilter]);

  async function act(a: Advance, action: 'ops-approve' | 'fin-approve' | 'reject') {
    try {
      if (action === 'reject') {
        const remarks = prompt(`Reject advance #${a.advance_id}? Enter remarks (optional):`);
        if (remarks === null) return; // user cancelled the prompt
        await api.post(`/admin/advances/${a.advance_id}/reject`, { remarks });
      } else if (action === 'ops-approve') {
        await api.post(`/admin/advances/${a.advance_id}/ops-approve`, {});
      } else {
        await api.post(`/admin/advances/${a.advance_id}/fin-approve`, {});
      }
      reload();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Action failed');
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
    </div>
  );
}
