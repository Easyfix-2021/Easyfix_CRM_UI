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
import { Coins, AlertTriangle, FileSpreadsheet, FileText, Mail, CheckCircle2, XCircle, Plus, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { showToast } from '@/components/ui/toast';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFetch as useSharedFetch, useDebouncedValue } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

const TABS = ['invoices', 'transactions', 'purchase-orders', 'payouts', 'ndm-collection', 'efr-ledger'] as const;
type TabKey = typeof TABS[number];

export default function FinanceLandingPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialTab = (sp.get('tab') as TabKey) || 'invoices';
  const [tab, setTab] = useState<TabKey>(TABS.includes(initialTab) ? initialTab : 'invoices');
  const [clientId, setClientId] = useState('');
  const debouncedClientId = useDebouncedValue(clientId, 300);

  // Keep URL in sync so the Finance child menus light up the right tab.
  // Two-way sync (2026-05-26 fix):
  //   tab → URL   (when the operator clicks a TabsTrigger)
  //   URL → tab   (when a sidebar sub-menu link changes ?tab= while the
  //                page is already mounted; without this the page froze on
  //                the FIRST clicked sub-menu and ignored subsequent ones)
  useEffect(() => {
    const params = new URLSearchParams(sp.toString());
    if (params.get('tab') !== tab) {
      params.set('tab', tab);
      router.replace(`${pathname}?${params.toString()}`);
    }
  }, [tab, sp, router, pathname]);
  useEffect(() => {
    const urlTab = sp.get('tab');
    if (urlTab && TABS.includes(urlTab as TabKey) && urlTab !== tab) {
      setTab(urlTab as TabKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

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
        <TabsContent value="invoices"><InvoicesTab clientId={debouncedClientId} /></TabsContent>
        <TabsContent value="transactions"><TransactionsTab clientId={debouncedClientId} /></TabsContent>
        <TabsContent value="purchase-orders"><PurchaseOrdersTab clientId={debouncedClientId} /></TabsContent>
        <TabsContent value="payouts"><PayoutsTab /></TabsContent>
        <TabsContent value="ndm-collection"><NdmCollectionTab /></TabsContent>
        <TabsContent value="efr-ledger"><EfrLedgerTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/*
 * Adapter over the mandatory `@/lib/hooks` useFetch (per memory
 * `feedback_crm_ui_fetch_hooks`). The shared hook returns the raw
 * payload; finance tabs all consume list endpoints, so we normalise
 * to an array here. `reload` is the shared hook's `refetch` renamed
 * for backwards-compat with the call-sites. The `deps` arg from the
 * old local hook is now folded into the `url` key (every call-site
 * already builds a URL that captures its own state).
 */
function useFetch<T>(url: string | null): { data: T[]; loading: boolean; error: string | null; reload: () => void } {
  const { data, loading, error, refetch } = useSharedFetch<T[] | { items?: T[] }>(url);
  const arr: T[] = Array.isArray(data) ? data : ((data as { items?: T[] } | null)?.items ?? []);
  return { data: arr, loading, error, reload: refetch };
}

type Invoice = {
  id: number; fk_client_id: number | null; invoice_number: string | null;
  billing_from_date: string | null; billing_to_date: string | null;
  total_invoice_amount: number | null; total_paid_amount: number | null;
  is_paid: number | null; amount_due_date: string | null;
};
function InvoicesTab({ clientId }: { clientId: string }) {
  const url = `/admin/finance/invoices?${clientId ? `clientId=${clientId}&` : ''}limit=200`;
  const { data, loading, error, reload } = useFetch<Invoice>(url);
  const { me } = useMe();
  const can = actionFlags(me, ['isInvoicePay', 'isInvoiceStatusChange']);
  // Dialog state lives on the tab — a single dialog is reused across
  // rows for both Record Payment and Change Status.
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [statusing, setStatusing] = useState<Invoice | null>(null);
  return (
    <div className="space-y-2 mt-2">
      {loading ? <Loading /> : error ? <Err msg={error} /> : data.length === 0 ? <Empty msg="No invoices match the filter." /> : (
    <div className="rounded-lg border bg-card overflow-hidden">
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
                {can.isInvoicePay && !inv.is_paid && (
                  <button onClick={() => setPaying(inv)} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 rounded">
                    <CheckCircle2 className="size-3.5" /> Record Payment
                  </button>
                )}
                {can.isInvoiceStatusChange && (
                  <button onClick={() => setStatusing(inv)} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded">
                    <Pencil className="size-3.5" /> Status
                  </button>
                )}
                <DownloadLink href={`/api/admin/finance/invoices/${inv.id}/excel`} label="Excel" icon={<FileSpreadsheet className="size-3.5" />} />
                <DownloadLink href={`/api/admin/finance/invoices/${inv.id}/pdf`} label="PDF" icon={<FileText className="size-3.5" />} />
                <EmailButton invoiceId={inv.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
      )}
      <RecordPaymentDialog invoice={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); reload(); }} />
      <ChangeInvoiceStatusDialog invoice={statusing} onClose={() => setStatusing(null)} onSaved={() => { setStatusing(null); reload(); }} />
    </div>
  );
}

/*
 * RecordPaymentDialog — POST /admin/finance/invoices/:id/payment.
 * Joi: { amount (positive), paid_date, paid_by, comments?, upload_documents? }.
 * Captures the minimal happy path; comments/document upload are optional.
 */
function RecordPaymentDialog({ invoice, onClose, onSaved }: { invoice: Invoice | null; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
  const [paidBy, setPaidBy] = useState('');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (invoice) {
      const remaining = Math.max(0, Number(invoice.total_invoice_amount ?? 0) - Number(invoice.total_paid_amount ?? 0));
      setAmount(remaining > 0 ? remaining.toFixed(2) : '');
      setComments('');
      setPaidBy('');
    }
  }, [invoice]);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  if (!invoice) return null;
  async function submit() {
    if (!amount || !paidDate || !paidBy) {
      showToast({ variant: 'error', message: 'Amount, Paid Date, Paid By are required' });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/admin/finance/invoices/${invoice!.id}/payment`, {
        amount: Number(amount),
        paid_date: paidDate,
        paid_by: paidBy,
        comments: comments || undefined,
      });
      showToast({ variant: 'success', message: 'Payment Recorded' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!invoice} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Record Payment · Invoice #{invoice.id}</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            Total ₹{Number(invoice.total_invoice_amount ?? 0).toFixed(2)} · Paid ₹{Number(invoice.total_paid_amount ?? 0).toFixed(2)}
          </div>
          <div><Label>Amount ₹ *</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>Paid Date *</Label><Input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} /></div>
          <div><Label>Paid By *</Label><Input value={paidBy} onChange={(e) => setPaidBy(e.target.value)} placeholder="UTR / cheque # / contact name" /></div>
          <div><Label>Comments</Label>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * ChangeInvoiceStatusDialog — PATCH /admin/finance/invoices/:id/status.
 * Joi: { is_paid (0|1), is_raised (0|1)?, updated_comments? }. Mirror of
 * legacy /pages/invoice/changeInvoiceStatus.vm.
 */
function ChangeInvoiceStatusDialog({ invoice, onClose, onSaved }: { invoice: Invoice | null; onClose: () => void; onSaved: () => void }) {
  const [isPaid, setIsPaid] = useState(0);
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (invoice) {
      setIsPaid(invoice.is_paid ?? 0);
      setComments('');
    }
  }, [invoice]);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  if (!invoice) return null;
  async function submit() {
    setBusy(true);
    try {
      await api.patch(`/admin/finance/invoices/${invoice!.id}/status`, {
        is_paid: Number(isPaid),
        updated_comments: comments || undefined,
      });
      showToast({ variant: 'success', message: 'Invoice Status Updated' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!invoice} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Change Status · Invoice #{invoice.id}</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div><Label>Paid Status</Label>
            <select value={isPaid} onChange={(e) => setIsPaid(Number(e.target.value))} className="border rounded h-9 px-2 text-sm bg-background w-full">
              <option value={0}>Unpaid</option>
              <option value={1}>Paid</option>
            </select>
          </div>
          <div><Label>Comments</Label>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} placeholder="Reason for the status change" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  const { data, loading, error, reload } = useFetch<Transaction>(url);
  const [showCreate, setShowCreate] = useState(false);
  // RBAC gate — Add Transaction is now a separately-seeded action.
  const { me } = useMe();
  const can = actionFlags(me, ['isTransactionAdd']);
  return (
    <div className="space-y-2 mt-2">
      <div className="flex justify-end">
        {can.isTransactionAdd && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-3.5 mr-1" /> Add Transaction
          </Button>
        )}
      </div>
      {loading ? <Loading /> : error ? <Err msg={error} /> : data.length === 0 ? <Empty msg="No transactions match the filter." /> : (
    <div className="rounded-lg border bg-card overflow-hidden">
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
      )}
      <CreateTransactionDialog
        open={showCreate}
        defaultClientId={clientId}
        onClose={() => setShowCreate(false)}
        onSaved={() => { setShowCreate(false); reload(); }}
      />
    </div>
  );
}

/*
 * CreateTransactionDialog — minimal form mapped to POST /admin/finance/transactions.
 * Joi schema requires { clientId, transactionType, amount }; description + jobId
 * optional. transactionType is a legacy code (1=Debit, 2=Credit, etc.); we expose
 * the most common 2 codes + leave others passable via the raw number input.
 */
function CreateTransactionDialog({ open, defaultClientId, onClose, onSaved }: {
  open: boolean; defaultClientId: string; onClose: () => void; onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(defaultClientId || '');
  const [jobId, setJobId] = useState('');
  const [transactionType, setTransactionType] = useState('1');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setClientId(defaultClientId || ''); }, [open, defaultClientId]);

  async function submit() {
    if (!clientId || !amount) {
      showToast({ variant: 'error', message: 'Client ID + Amount are required' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/admin/finance/transactions', {
        clientId: Number(clientId),
        jobId: jobId ? Number(jobId) : undefined,
        transactionType: Number(transactionType),
        amount: Number(amount),
        description: description || undefined,
      });
      showToast({ variant: 'success', message: 'Transaction Added' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Transaction</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div><Label>Client ID *</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value.replace(/\D/g, ''))} className="font-mono" /></div>
          <div><Label>Job ID</Label><Input value={jobId} onChange={(e) => setJobId(e.target.value.replace(/\D/g, ''))} className="font-mono" placeholder="optional" /></div>
          <div><Label>Type</Label>
            <select value={transactionType} onChange={(e) => setTransactionType(e.target.value)} className="border rounded h-9 px-2 text-sm bg-background w-full">
              <option value="1">1 — Debit</option>
              <option value="2">2 — Credit</option>
              <option value="3">3 — Adjustment</option>
            </select>
          </div>
          <div><Label>Amount ₹ *</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>Description</Label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !clientId || !amount}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  const { data, loading, error, reload } = useFetch<PurchaseOrder>(url);
  const [showCreate, setShowCreate] = useState(false);
  const { me } = useMe();
  const can = actionFlags(me, ['isPurchaseOrderAdd']);
  return (
    <div className="space-y-2 mt-2">
      <div className="flex justify-end">
        {can.isPurchaseOrderAdd && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-3.5 mr-1" /> Add Purchase Order
          </Button>
        )}
      </div>
      {loading ? <Loading /> : error ? <Err msg={error} /> : data.length === 0 ? <Empty msg="No purchase orders match the filter." /> : (
    <div className="rounded-lg border bg-card overflow-hidden">
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
      )}
      <CreatePurchaseOrderDialog
        open={showCreate}
        defaultClientId={clientId}
        onClose={() => setShowCreate(false)}
        onSaved={() => { setShowCreate(false); reload(); }}
      />
    </div>
  );
}

/* CreatePurchaseOrderDialog — calls POST /admin/finance/purchase-orders. */
function CreatePurchaseOrderDialog({ open, defaultClientId, onClose, onSaved }: {
  open: boolean; defaultClientId: string; onClose: () => void; onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(defaultClientId || '');
  const [poNumber, setPoNumber] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setClientId(defaultClientId || ''); }, [open, defaultClientId]);

  async function submit() {
    if (!clientId || !poNumber || !startDate || !endDate || !totalAmount) {
      showToast({ variant: 'error', message: 'Client + PO Number + Dates + Total are required' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/admin/finance/purchase-orders', {
        clientId: Number(clientId), poNumber, description: description || undefined,
        startDate, endDate, totalAmount: Number(totalAmount),
      });
      showToast({ variant: 'success', message: 'Purchase Order Added' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Purchase Order</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div><Label>Client ID *</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value.replace(/\D/g, ''))} className="font-mono" /></div>
          <div><Label>PO Number *</Label><Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Start Date *</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            <div><Label>End Date *</Label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
          </div>
          <div><Label>Total Amount ₹ *</Label><Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>Description</Label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  const { data, loading, error, reload } = useFetch<Payout>(url);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const { me } = useMe();
  const can = actionFlags(me, ['isPayoutCreate', 'isPayoutBulkApprove']);
  const STATUS_LABEL: Record<number, string> = { 0: 'Pending', 1: 'Ops Approved', 2: 'Finance Approved', 3: 'Rejected' };
  // Bulk Ops-Approve handler — surfaces the existing
  // POST /admin/finance/payouts/bulk-ops-approve endpoint.
  async function bulkOpsApprove() {
    if (selectedIds.size === 0) return;
    try {
      await api.post('/admin/finance/payouts/bulk-ops-approve', { payoutIds: Array.from(selectedIds) });
      showToast({ variant: 'success', message: 'Bulk Ops Approval Submitted' });
      setSelectedIds(new Set());
      reload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    }
  }
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
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
  }
  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
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
        <div className="flex items-center gap-2">
          {can.isPayoutBulkApprove && selectedIds.size > 0 && (
            <Button size="sm" variant="outline" onClick={bulkOpsApprove}>
              <CheckCircle2 className="size-3.5 mr-1" /> Bulk Ops-Approve ({selectedIds.size})
            </Button>
          )}
          {can.isPayoutCreate && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="size-3.5 mr-1" /> Create Payout
            </Button>
          )}
        </div>
      </div>
      {loading && <Loading />}
      {error && <Err msg={error} />}
      {!loading && !error && data.length === 0 && <Empty msg="No payouts match the filter." />}
      {!loading && !error && data.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                {can.isPayoutBulkApprove && <th className="!text-center w-8"></th>}
                <th className="!text-center">ID</th><th>Easyfixer</th>
                <th className="!text-right">Balance</th><th className="!text-right">PM Req</th>
                <th className="!text-right">Ops Approved</th><th className="!text-right">Fin Approved</th>
                <th className="!text-center">Status</th><th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.payout_id} className="hover:bg-slate-50">
                  {can.isPayoutBulkApprove && (
                    <td className="!text-center">
                      {p.is_approved_by_fin === 0 && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.payout_id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds);
                            if (e.target.checked) next.add(p.payout_id); else next.delete(p.payout_id);
                            setSelectedIds(next);
                          }}
                        />
                      )}
                    </td>
                  )}
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
      <CreatePayoutDialog open={showCreate} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); reload(); }} />
    </div>
  );
}

/*
 * CreatePayoutDialog — POST /admin/finance/payouts. Body Joi:
 *   { efrId, efrBalance, opsAmount, pmRequestAmount } all >= 0 / positive.
 * Easyfixer scoping is enforced by `assertEfrInScope`.
 */
function CreatePayoutDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [efrId, setEfrId] = useState('');
  const [efrBalance, setEfrBalance] = useState('');
  const [opsAmount, setOpsAmount] = useState('');
  const [pmRequestAmount, setPmRequestAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setEfrId(''); setEfrBalance(''); setOpsAmount(''); setPmRequestAmount(''); }
  }, [open]);
  async function submit() {
    if (!efrId || !efrBalance || !opsAmount || !pmRequestAmount) {
      showToast({ variant: 'error', message: 'All four fields are required' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/admin/finance/payouts', {
        efrId: Number(efrId), efrBalance: Number(efrBalance),
        opsAmount: Number(opsAmount), pmRequestAmount: Number(pmRequestAmount),
      });
      showToast({ variant: 'success', message: 'Payout Created' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Create Payout</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div><Label>Easyfixer ID *</Label><Input value={efrId} onChange={(e) => setEfrId(e.target.value.replace(/\D/g, ''))} className="font-mono" /></div>
          <div><Label>EFR Current Balance *</Label><Input value={efrBalance} onChange={(e) => setEfrBalance(e.target.value)} className="font-mono" /></div>
          <div><Label>Ops Amount *</Label><Input value={opsAmount} onChange={(e) => setOpsAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>PM Request Amount *</Label><Input value={pmRequestAmount} onChange={(e) => setPmRequestAmount(e.target.value)} className="font-mono" /></div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  const { data, loading, error, reload } = useFetch<NdmRecharge>(url);
  const [showCreate, setShowCreate] = useState(false);
  const { me } = useMe();
  const can = actionFlags(me, ['isNdmRechargeAdd']);
  const confirm = useConfirm();
  async function approve(r: NdmRecharge) {
    try {
      await api.post(`/admin/finance/ndm-recharges/${r.recharge_id}/approve`, {});
      showToast({ variant: 'success', message: 'NDM Recharge Approved' });
      reload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Approve failed' }); }
  }
  async function reject(r: NdmRecharge) {
    const ok = await confirm({
      title: `Reject recharge #${r.recharge_id}?`,
      description: 'This deletes the row permanently. Continue?',
      confirmLabel: 'Reject',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.post(`/admin/finance/ndm-recharges/${r.recharge_id}/reject`, {});
      showToast({ variant: 'success', message: 'NDM Recharge Rejected' });
      reload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reject failed' }); }
  }
  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filter:</span>
          <button onClick={() => setFlag('4')} className={`px-2 py-0.5 rounded text-xs ${flag === '4' ? 'bg-primary text-white' : 'bg-slate-200'}`}>Pending Approval</button>
          <button onClick={() => setFlag('2')} className={`px-2 py-0.5 rounded text-xs ${flag === '2' ? 'bg-primary text-white' : 'bg-slate-200'}`}>By NDM</button>
        </div>
        {can.isNdmRechargeAdd && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-3.5 mr-1" /> Submit NDM Recharge
          </Button>
        )}
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
      <CreateNdmRechargeDialog open={showCreate} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); reload(); }} />
    </div>
  );
}

/*
 * CreateNdmRechargeDialog — POST /admin/finance/ndm-recharges. Body Joi:
 *   { efrId (positive), rechargeAmount (positive), rechargeType?, comments?,
 *     documentPath?, paymentMode?, referenceId? }.
 */
function CreateNdmRechargeDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [efrId, setEfrId] = useState('');
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [referenceId, setReferenceId] = useState('');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setEfrId(''); setRechargeAmount(''); setPaymentMode('Cash'); setReferenceId(''); setComments(''); }
  }, [open]);
  async function submit() {
    if (!efrId || !rechargeAmount) {
      showToast({ variant: 'error', message: 'Easyfixer ID + Amount are required' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/admin/finance/ndm-recharges', {
        efrId: Number(efrId),
        rechargeAmount: Number(rechargeAmount),
        paymentMode: paymentMode || undefined,
        referenceId: referenceId || undefined,
        comments: comments || undefined,
      });
      showToast({ variant: 'success', message: 'NDM Recharge Submitted' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });
  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Submit NDM Recharge</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div><Label>Easyfixer ID *</Label><Input value={efrId} onChange={(e) => setEfrId(e.target.value.replace(/\D/g, ''))} className="font-mono" /></div>
          <div><Label>Recharge Amount ₹ *</Label><Input value={rechargeAmount} onChange={(e) => setRechargeAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>Payment Mode</Label>
            <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)} className="border rounded h-9 px-2 text-sm bg-background w-full">
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
              <option value="Bank Transfer">Bank Transfer</option>
              <option value="Cheque">Cheque</option>
            </select>
          </div>
          <div><Label>Reference ID</Label><Input value={referenceId} onChange={(e) => setReferenceId(e.target.value)} className="font-mono" placeholder="UTR / cheque #" /></div>
          <div><Label>Comments</Label>
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} className="w-full border rounded px-3 py-2 text-sm" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  const debouncedEfrId = useDebouncedValue(efrId, 300);

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
  if (debouncedEfrId) qs.set('efrId', debouncedEfrId);
  qs.set('limit', '200');
  const url = `/admin/finance/efr-transactions?${qs.toString()}`;
  const { data, loading, error } = useFetch<EfrTxn>(url);

  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Type:</span>
        {[['', 'All'], ['1', 'Debit'], ['2', 'Credit']].map(([v, label]) => (
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
                      ? <span className="badge bg-rose-50 text-rose-700">Debit</span>
                      : t.transaction_type === 2
                        ? <span className="badge bg-emerald-50 text-emerald-700">Credit</span>
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
