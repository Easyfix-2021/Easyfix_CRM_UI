'use client';

/*
 * Finance hub — invoices, transactions, POs, payouts, NDM collections.
 *
 * Each sub-menu in the legacy CRM sidebar (Client Invoice, Servicemen
 * Payout, NDM Collection, Collection Approval) routes here with a
 * `?tab=` query param. Sidebar URL_MAP keys are kept in lockstep.
 *
 * Backend wiring (all real):
 *   GET    /admin/finance/invoices
 *   GET    /admin/finance/invoices/:id/excel  (file download)
 *   GET    /admin/finance/invoices/:id/pdf    (file download)
 *   GET    /admin/finance/invoices/zip        (file download)
 *   POST   /admin/finance/email-statement
 *   GET    /admin/finance/transactions
 *   GET    /admin/finance/purchase-orders
 *   GET    /admin/finance/payouts?efrId=&status=
 *   POST   /admin/finance/payouts/:id/ops-approve
 *   POST   /admin/finance/payouts/:id/fin-approve
 *   POST   /admin/finance/payouts/:id/fin-reject
 *   GET    /admin/finance/ndm-recharges?flag=
 *   POST   /admin/finance/ndm-recharges/:id/approve
 *   POST   /admin/finance/ndm-recharges/:id/reject
 */

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Coins, AlertTriangle, FileSpreadsheet, FileText, Mail, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

const TABS = ['invoices', 'transactions', 'purchase-orders', 'payouts', 'ndm-collection', 'efr-ledger'] as const;
type TabKey = typeof TABS[number];

export default function FinanceLandingPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialTab = (sp.get('tab') as TabKey) || 'invoices';
  const [tab, setTab] = useState<TabKey>(TABS.includes(initialTab) ? initialTab : 'invoices');
  const [clientId, setClientId] = useState('');

  // Keep URL in sync so the Finance child menus light up the right tab
  useEffect(() => {
    const params = new URLSearchParams(sp.toString());
    if (params.get('tab') !== tab) {
      params.set('tab', tab);
      router.replace(`${pathname}?${params.toString()}`);
    }
  }, [tab, sp, router, pathname]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Coins className="size-6" /> Finance
        </h1>
        <p className="text-sm text-muted-foreground">
          Invoices, transactions, POs, easyfixer payouts and NDM collection approvals.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <label className="text-xs font-medium block mb-1">Filter by Client ID (optional)</label>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value.replace(/\D/g, ''))}
            placeholder="Leave blank for all"
            className="font-mono max-w-[200px]"
          />
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="purchase-orders">Purchase Orders</TabsTrigger>
          <TabsTrigger value="payouts">Payouts</TabsTrigger>
          <TabsTrigger value="ndm-collection">NDM Collection</TabsTrigger>
          <TabsTrigger value="efr-ledger">EFR Ledger</TabsTrigger>
        </TabsList>
        <TabsContent value="invoices"><InvoicesTab clientId={clientId} /></TabsContent>
        <TabsContent value="transactions"><TransactionsTab clientId={clientId} /></TabsContent>
        <TabsContent value="purchase-orders"><PurchaseOrdersTab clientId={clientId} /></TabsContent>
        <TabsContent value="payouts"><PayoutsTab /></TabsContent>
        <TabsContent value="ndm-collection"><NdmCollectionTab /></TabsContent>
        <TabsContent value="efr-ledger"><EfrLedgerTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function useFetch<T>(url: string | null, deps: unknown[] = []): { data: T[]; loading: boolean; error: string | null; reload: () => void } {
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

type Invoice = {
  id: number; fk_client_id: number | null; invoice_number: string | null;
  billing_from_date: string | null; billing_to_date: string | null;
  total_invoice_amount: number | null; total_paid_amount: number | null;
  is_paid: number | null; amount_due_date: string | null;
};
function InvoicesTab({ clientId }: { clientId: string }) {
  const url = `/admin/finance/invoices?${clientId ? `clientId=${clientId}&` : ''}limit=200`;
  const { data, loading, error } = useFetch<Invoice>(url);
  if (loading) return <Loading />;
  if (error) return <Err msg={error} />;
  if (data.length === 0) return <Empty msg="No invoices match the filter." />;
  return (
    <div className="rounded-lg border bg-card overflow-hidden mt-2">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th className="!text-center">ID</th><th>Invoice #</th><th>Period</th>
            <th className="!text-right">Total ₹</th><th className="!text-right">Paid ₹</th>
            <th className="!text-center">Status</th><th className="!text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.map((inv) => (
            <tr key={inv.id} className="hover:bg-slate-50">
              <td className="!text-center font-mono text-xs">{inv.id}</td>
              <td className="font-mono text-xs">{inv.invoice_number ?? '—'}</td>
              <td className="text-xs">
                {inv.billing_from_date ? formatDate(inv.billing_from_date) : '—'} → {inv.billing_to_date ? formatDate(inv.billing_to_date) : '—'}
              </td>
              <td className="!text-right font-mono">{inv.total_invoice_amount != null ? Number(inv.total_invoice_amount).toFixed(2) : '—'}</td>
              <td className="!text-right font-mono">{inv.total_paid_amount != null ? Number(inv.total_paid_amount).toFixed(2) : '—'}</td>
              <td className="!text-center text-xs">
                {inv.is_paid ? <span className="badge bg-emerald-50 text-emerald-700">Paid</span> : <span className="badge bg-amber-50 text-amber-700">Unpaid</span>}
              </td>
              <td className="!text-right whitespace-nowrap">
                <DownloadLink href={`/api/admin/finance/invoices/${inv.id}/excel`} label="Excel" icon={<FileSpreadsheet className="size-3.5" />} />
                <DownloadLink href={`/api/admin/finance/invoices/${inv.id}/pdf`} label="PDF" icon={<FileText className="size-3.5" />} />
                <EmailButton invoiceId={inv.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DownloadLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded">
      {icon} {label}
    </a>
  );
}
function EmailButton({ invoiceId }: { invoiceId: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function send() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ recipients: string[] }>('/admin/finance/email-statement', { invoiceId, ccOps: true });
      setMsg(`Sent to ${r.recipients.length} recipient(s)`);
    } catch (e) {
      setMsg(e instanceof ApiError ? `✗ ${e.message}` : '✗ send failed');
    } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex items-center">
      <button onClick={send} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded disabled:opacity-50">
        <Mail className="size-3.5" /> {busy ? 'Sending…' : 'Email'}
      </button>
      {msg && <span className="text-[10px] text-slate-500 ml-1">{msg}</span>}
    </span>
  );
}

type Transaction = {
  client_trans_id: number; client_id: number; job_id: number | null;
  transaction_type: number | null; amount: number | null; balance: number | null;
  description: string | null; transaction_date: string | null;
};
function TransactionsTab({ clientId }: { clientId: string }) {
  const url = `/admin/finance/transactions?${clientId ? `clientId=${clientId}&` : ''}limit=200`;
  const { data, loading, error } = useFetch<Transaction>(url);
  if (loading) return <Loading />;
  if (error) return <Err msg={error} />;
  if (data.length === 0) return <Empty msg="No transactions match the filter." />;
  return (
    <div className="rounded-lg border bg-card overflow-hidden mt-2">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th className="!text-center">ID</th><th className="!text-center">Client</th><th className="!text-center">Job</th>
            <th className="!text-center">Type</th><th className="!text-right">Amount ₹</th><th className="!text-right">Balance ₹</th>
            <th>Date</th><th>Description</th>
          </tr>
        </thead>
        <tbody>
          {data.map((t) => (
            <tr key={t.client_trans_id}>
              <td className="!text-center font-mono text-xs">{t.client_trans_id}</td>
              <td className="!text-center font-mono text-xs">{t.client_id}</td>
              <td className="!text-center font-mono text-xs">{t.job_id ?? '—'}</td>
              <td className="!text-center text-xs">{t.transaction_type ?? '—'}</td>
              <td className="!text-right font-mono">{t.amount != null ? Number(t.amount).toFixed(2) : '—'}</td>
              <td className="!text-right font-mono">{t.balance != null ? Number(t.balance).toFixed(2) : '—'}</td>
              <td className="text-xs">{t.transaction_date ? formatDate(t.transaction_date) : '—'}</td>
              <td className="text-xs">{t.description ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PurchaseOrder = {
  inv_po_id: number; fk_client_id: number | null;
  inv_client_po_num: string | null; inv_po_desc: string | null;
  inv_po_total_amnt: number | null;
  inv_po_start_date: string | null; inv_po_end_date: string | null;
};
function PurchaseOrdersTab({ clientId }: { clientId: string }) {
  const url = `/admin/finance/purchase-orders${clientId ? `?clientId=${clientId}` : ''}`;
  const { data, loading, error } = useFetch<PurchaseOrder>(url);
  if (loading) return <Loading />;
  if (error) return <Err msg={error} />;
  if (data.length === 0) return <Empty msg="No purchase orders match the filter." />;
  return (
    <div className="rounded-lg border bg-card overflow-hidden mt-2">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th className="!text-center">ID</th><th className="!text-center">Client</th>
            <th>PO #</th><th>Description</th>
            <th className="!text-right">Total ₹</th><th>Validity</th>
          </tr>
        </thead>
        <tbody>
          {data.map((po) => (
            <tr key={po.inv_po_id}>
              <td className="!text-center font-mono text-xs">{po.inv_po_id}</td>
              <td className="!text-center font-mono text-xs">{po.fk_client_id ?? '—'}</td>
              <td className="font-mono text-xs">{po.inv_client_po_num ?? '—'}</td>
              <td className="text-xs">{po.inv_po_desc ?? '—'}</td>
              <td className="!text-right font-mono">{po.inv_po_total_amnt != null ? Number(po.inv_po_total_amnt).toFixed(2) : '—'}</td>
              <td className="text-xs">
                {po.inv_po_start_date ? formatDate(po.inv_po_start_date) : '—'} → {po.inv_po_end_date ? formatDate(po.inv_po_end_date) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Payout = {
  payout_id: number; efr_id: number; efr_name: string | null; efr_no: string | null;
  efr_balance: number | null; ops_amount: number | null; ops_approved_amount: number | null;
  fin_approved_amount: number | null; is_approved_by_fin: number;
};
function PayoutsTab() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const url = `/admin/finance/payouts${statusFilter ? `?status=${statusFilter}` : ''}`;
  const { data, loading, error, reload } = useFetch<Payout>(url, [statusFilter]);
  const STATUS_LABEL: Record<number, string> = { 0: 'Pending', 1: 'Ops Approved', 2: 'Finance Approved', 3: 'Rejected' };
  async function act(p: Payout, action: 'ops-approve' | 'fin-approve' | 'fin-reject') {
    try {
      if (action === 'ops-approve') {
        await api.post(`/admin/finance/payouts/${p.payout_id}/ops-approve`, {
          efrId: p.efr_id, opsApprovedAmount: p.ops_amount ?? 0,
        });
      } else if (action === 'fin-approve') {
        await api.post(`/admin/finance/payouts/${p.payout_id}/fin-approve`, {
          efrId: p.efr_id, finApprovedAmount: p.ops_approved_amount ?? p.ops_amount ?? 0,
        });
      } else {
        await api.post(`/admin/finance/payouts/${p.payout_id}/fin-reject`, { efrId: p.efr_id });
      }
      reload();
    } catch (e) { alert(e instanceof ApiError ? e.message : 'Failed'); }
  }
  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Status:</span>
        {['', '0', '1', '2', '3'].map((s) => (
          <button key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-0.5 rounded text-xs ${statusFilter === s ? 'bg-primary text-white' : 'bg-slate-200 text-slate-700'}`}>
            {s === '' ? 'All' : STATUS_LABEL[Number(s)]}
          </button>
        ))}
      </div>
      {loading && <Loading />}
      {error && <Err msg={error} />}
      {!loading && !error && data.length === 0 && <Empty msg="No payouts match the filter." />}
      {!loading && !error && data.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th><th>Easyfixer</th>
                <th className="!text-right">Balance</th><th className="!text-right">PM Req</th>
                <th className="!text-right">Ops Approved</th><th className="!text-right">Fin Approved</th>
                <th className="!text-center">Status</th><th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.payout_id} className="hover:bg-slate-50">
                  <td className="!text-center font-mono text-xs">{p.payout_id}</td>
                  <td>{p.efr_name || '—'}<br/><span className="text-xs text-muted-foreground font-mono">#{p.efr_id} · {p.efr_no || '—'}</span></td>
                  <td className="!text-right font-mono">{p.efr_balance != null ? Number(p.efr_balance).toFixed(2) : '—'}</td>
                  <td className="!text-right font-mono">{p.ops_amount != null ? Number(p.ops_amount).toFixed(2) : '—'}</td>
                  <td className="!text-right font-mono">{p.ops_approved_amount != null ? Number(p.ops_approved_amount).toFixed(2) : '—'}</td>
                  <td className="!text-right font-mono">{p.fin_approved_amount != null ? Number(p.fin_approved_amount).toFixed(2) : '—'}</td>
                  <td className="!text-center text-xs">{STATUS_LABEL[p.is_approved_by_fin] ?? p.is_approved_by_fin}</td>
                  <td className="!text-right whitespace-nowrap">
                    {p.is_approved_by_fin === 0 && (
                      <button onClick={() => act(p, 'ops-approve')} className="text-xs text-blue-600 hover:underline px-1.5">Ops ✓</button>
                    )}
                    {p.is_approved_by_fin === 1 && (
                      <>
                        <button onClick={() => act(p, 'fin-approve')} className="text-xs text-emerald-700 hover:underline px-1.5">Fin ✓</button>
                        <button onClick={() => act(p, 'fin-reject')} className="text-xs text-red-600 hover:underline px-1.5">Fin ✗</button>
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

type NdmRecharge = {
  recharge_id: number; efr_id: number; efr_name: string | null; efr_no: string | null;
  ndm_id: number; user_name: string | null;
  recharge_amount: number | null; recharge_date: string; approved_by_finance: number;
  payment_mode: string | null; reference_id: string | null; comments: string | null;
};
function NdmCollectionTab() {
  const [flag, setFlag] = useState('4'); // 4 = pending-approval (default)
  const url = `/admin/finance/ndm-recharges?flag=${flag}`;
  const { data, loading, error, reload } = useFetch<NdmRecharge>(url, [flag]);
  async function approve(r: NdmRecharge) {
    try {
      await api.post(`/admin/finance/ndm-recharges/${r.recharge_id}/approve`, {});
      reload();
    } catch (e) { alert(e instanceof ApiError ? e.message : 'Approve failed'); }
  }
  async function reject(r: NdmRecharge) {
    if (!confirm(`Reject recharge #${r.recharge_id}? This DELETES the row.`)) return;
    try {
      await api.post(`/admin/finance/ndm-recharges/${r.recharge_id}/reject`, {});
      reload();
    } catch (e) { alert(e instanceof ApiError ? e.message : 'Reject failed'); }
  }
  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter:</span>
        <button onClick={() => setFlag('4')} className={`px-2 py-0.5 rounded text-xs ${flag === '4' ? 'bg-primary text-white' : 'bg-slate-200'}`}>Pending Approval</button>
        <button onClick={() => setFlag('2')} className={`px-2 py-0.5 rounded text-xs ${flag === '2' ? 'bg-primary text-white' : 'bg-slate-200'}`}>By NDM</button>
      </div>
      {loading && <Loading />}
      {error && <Err msg={error} />}
      {!loading && !error && data.length === 0 && <Empty msg="No recharges match." />}
      {!loading && !error && data.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th><th>Easyfixer</th><th>NDM</th>
                <th className="!text-right">Amount ₹</th><th>Mode</th><th>Reference</th>
                <th>Date</th><th className="!text-center">Status</th><th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.recharge_id} className="hover:bg-slate-50">
                  <td className="!text-center font-mono text-xs">{r.recharge_id}</td>
                  <td className="text-xs">{r.efr_name || '—'}<br/><span className="text-muted-foreground">#{r.efr_id}</span></td>
                  <td className="text-xs">{r.user_name || '—'}</td>
                  <td className="!text-right font-mono">{r.recharge_amount != null ? Number(r.recharge_amount).toFixed(2) : '—'}</td>
                  <td className="text-xs">{r.payment_mode || '—'}</td>
                  <td className="font-mono text-xs">{r.reference_id || '—'}</td>
                  <td className="text-xs">{formatDate(r.recharge_date)}</td>
                  <td className="!text-center text-xs">
                    {r.approved_by_finance === 1 ? <span className="badge bg-emerald-50 text-emerald-700">Approved</span> : <span className="badge bg-amber-50 text-amber-700">Pending</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    {r.approved_by_finance === 0 && (
                      <>
                        <button onClick={() => approve(r)} className="text-xs text-emerald-700 hover:underline px-1.5"><CheckCircle2 className="inline size-3 mb-0.5" /> Approve</button>
                        <button onClick={() => reject(r)} className="text-xs text-red-600 hover:underline px-1.5"><XCircle className="inline size-3 mb-0.5" /> Reject</button>
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

// ─── EFR Ledger ─────────────────────────────────────────────────────
// Backend: GET /admin/finance/efr-transactions?type=&efrId=&from=&to=&limit=
// `type` map (legacy convention): 1 = Credit, 2 = Debit.
type EfrTxn = {
  transaction_id: number; easyfixer_id: number;
  efr_name: string | null; efr_no: string | null;
  transaction_type: number; transaction_date: string;
  amount: number | null; balance: number | null;
  source: string | null; description: string | null;
  job_id: number | null;
};
function EfrLedgerTab() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialType = sp.get('type') || '';
  const [type, setType] = useState<string>(initialType);
  const [efrId, setEfrId] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(sp.toString());
    if (type && params.get('type') !== type) {
      params.set('type', type);
      router.replace(`${pathname}?${params.toString()}`);
    } else if (!type && params.has('type')) {
      params.delete('type');
      router.replace(`${pathname}?${params.toString()}`);
    }
  }, [type, sp, router, pathname]);

  const qs = new URLSearchParams();
  if (type) qs.set('type', type);
  if (efrId) qs.set('efrId', efrId);
  qs.set('limit', '200');
  const url = `/admin/finance/efr-transactions?${qs.toString()}`;
  const { data, loading, error } = useFetch<EfrTxn>(url, [type, efrId]);

  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Type:</span>
        {[['', 'All'], ['1', 'Credit'], ['2', 'Debit']].map(([v, label]) => (
          <button key={v}
            onClick={() => setType(v)}
            className={`px-2 py-0.5 rounded text-xs ${type === v ? 'bg-primary text-white' : 'bg-slate-200 text-slate-700'}`}>
            {label}
          </button>
        ))}
        <Input className="ml-auto max-w-[180px] font-mono"
          placeholder="Filter by Easyfixer ID"
          value={efrId}
          onChange={(e) => setEfrId(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      {loading && <Loading />}
      {error && <Err msg={error} />}
      {!loading && !error && data.length === 0 && <Empty msg="No ledger rows match." />}
      {!loading && !error && data.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">Txn</th><th>Easyfixer</th>
                <th className="!text-center">Type</th>
                <th className="!text-right">Amount ₹</th><th className="!text-right">Balance ₹</th>
                <th>Source</th><th>Description</th>
                <th className="!text-center">Job</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.transaction_id} className="hover:bg-slate-50">
                  <td className="!text-center font-mono text-xs">{t.transaction_id}</td>
                  <td className="text-xs">{t.efr_name || '—'}<br/><span className="text-muted-foreground font-mono">#{t.easyfixer_id} · {t.efr_no || ''}</span></td>
                  <td className="!text-center text-xs">
                    {t.transaction_type === 1
                      ? <span className="badge bg-emerald-50 text-emerald-700">Credit</span>
                      : t.transaction_type === 2
                        ? <span className="badge bg-rose-50 text-rose-700">Debit</span>
                        : t.transaction_type}
                  </td>
                  <td className="!text-right font-mono">{t.amount != null ? Number(t.amount).toFixed(2) : '—'}</td>
                  <td className="!text-right font-mono">{t.balance != null ? Number(t.balance).toFixed(2) : '—'}</td>
                  <td className="text-xs">{t.source || '—'}</td>
                  <td className="text-xs">{t.description || '—'}</td>
                  <td className="!text-center text-xs">{t.job_id ?? '—'}</td>
                  <td className="text-xs">{formatDate(t.transaction_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Loading() { return <div className="text-sm text-muted-foreground py-6 text-center mt-2">Loading…</div>; }
function Err({ msg }: { msg: string }) {
  return (
    <Card className="mt-2"><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
      <AlertTriangle className="size-4" /> {msg}
    </CardContent></Card>
  );
}
function Empty({ msg }: { msg: string }) {
  return <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground mt-2">{msg}</div>;
}
