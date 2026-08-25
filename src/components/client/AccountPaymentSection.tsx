'use client';

/*
 * Client Profile → Account & Payment.
 *
 * The legacy "Invoice Details" block that lives on tbl_client and had NO home
 * in the migrated CRM at all — billing_raised / billing_cycle / billing_name /
 * billing_start_date were writable only from the old Struts form
 * (addEditClients.vm), so a client migrated here could not have their invoicing
 * terms changed without a DB console.
 *
 * ─── billing_raised IS A MASTER SWITCH, NOT A CHECKBOX ──────────────────────
 * ClientDaoImpl#updateClient NULLs cycle, name and start date whenever
 * invoiceRaise is 0. This form mirrors that exactly rather than leaving stale
 * terms behind an "off" toggle — a cycle sitting under a disabled switch is
 * the kind of thing that comes back the day someone flips it on.
 *
 * ─── billing_cycle IS NOT AN INTEGER ────────────────────────────────────────
 * Despite `private int billingCycle` existing on the legacy model, the column
 * is written from `getInvoiceCycle()`, a STRING, and the legacy form's own
 * help text says "comma separated day number… if last of the month, enter 40".
 * So it is a CSV of days-of-month with 40 as a sentinel. Validated as that
 * shape on both sides; treating it as a number would corrupt every multi-cycle
 * client on first save.
 *
 * The invoice TOTALS underneath are read from the same summary endpoint that
 * feeds the page's headline strip, so the outstanding figure here and the one
 * at the top of the page cannot disagree.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import {
  BILLING_CYCLE_HINT, COLLECTED_BY_OPTIONS, PAID_BY_OPTIONS,
  type ClientDetail, type ClientSummary,
} from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

type FormState = {
  billingRaised: boolean;
  billingName: string;
  billingCycle: string;
  billingStartDate: string;
  paidBy: string;
  collectedBy: string;
};

const str = (v: unknown) => (v == null ? '' : String(v));

/* A DATE column arrives as an ISO timestamp or a plain date; <input type="date">
   only accepts yyyy-mm-dd, so trim anything after the day. */
function toDateInput(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function seed(c: ClientDetail): FormState {
  const r = c as Record<string, unknown>;
  return {
    billingRaised: Number(r.billing_raised) === 1,
    billingName: str(r.billing_name),
    billingCycle: str(r.billing_cycle),
    billingStartDate: toDateInput(r.billing_start_date),
    paidBy: str(r.paid_by),
    collectedBy: str(c.collected_by),
  };
}

const CYCLE_RE = /^\s*\d{1,2}(\s*,\s*\d{1,2})*\s*$/;

export function AccountPaymentSection({
  client, canEdit, onSaved,
}: {
  client: ClientDetail;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => seed(client));
  const [snapshot, setSnapshot] = useState<FormState>(() => seed(client));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = seed(client);
    setForm(next);
    setSnapshot(next);
  }, [client]);

  const { data: summary } = useFetch<ClientSummary>(`/admin/clients/${client.client_id}/summary`);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(snapshot), [form, snapshot]);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!canEdit || saving) return;
    if (form.billingRaised && form.billingCycle.trim() && !CYCLE_RE.test(form.billingCycle)) {
      showToast({ variant: 'error', message: BILLING_CYCLE_HINT });
      return;
    }
    const payload: Record<string, unknown> = { billingRaised: form.billingRaised ? 1 : 0 };
    if (form.billingRaised) {
      payload.billingName = form.billingName;
      payload.billingCycle = form.billingCycle.trim();
      payload.billingStartDate = form.billingStartDate; // '' clears it (BE maps '' → NULL for this column)
    } else {
      /*
       * Mirror ClientDaoImpl#updateClient exactly: invoiceRaise = 0 NULLs all
       * three. null rather than '' matters — an empty string is a VALUE, and a
       * later read cannot tell "cleared" from "someone saved a blank".
       */
      payload.billingName = null;
      payload.billingCycle = null;
      payload.billingStartDate = null;
    }
    if (form.paidBy !== '') payload.paidBy = Number(form.paidBy);
    if (form.collectedBy !== '') payload.collectedBy = Number(form.collectedBy);

    setSaving(true);
    try {
      await api.put(`/admin/clients/${client.client_id}`, payload as never);
      invalidateFetch((k) => k.startsWith('/admin/clients'));
      setSnapshot(form);
      onSaved();
      showToast({ variant: 'success', message: 'Payment terms updated.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  const ro = !canEdit;
  const fmt = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));

  return (
    <SectionShell
      title="Account & Payment"
      note="How this client is invoiced, and who collects on a job."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3 rounded border bg-card px-3 py-2.5">
            <div>
              <div className="text-sm font-medium">Raise Invoices</div>
              <p className="text-xs text-muted-foreground">
                Off means every job is settled at the job — no invoice cycle runs.
                Turning it off clears the three terms below.
              </p>
            </div>
            <Switch
              checked={form.billingRaised}
              disabled={ro}
              onCheckedChange={(v) => set('billingRaised', v)}
              aria-label="Raise invoices for this client"
            />
          </div>

          <fieldset disabled={ro || !form.billingRaised} className="space-y-4 disabled:opacity-50">
            <div className="space-y-1">
              <Label className="text-xs">Invoice Name</Label>
              <Input value={form.billingName} maxLength={255}
                onChange={(e) => set('billingName', e.target.value)} />
              <p className="text-xs text-muted-foreground">
                The name printed on the invoice. Shared with the Overview &ldquo;Billing Name&rdquo; field — same column.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Invoice Cycle</Label>
              <Input value={form.billingCycle} maxLength={100} placeholder="e.g. 1,15"
                onChange={(e) => set('billingCycle', e.target.value)} />
              <p className="text-xs text-muted-foreground">{BILLING_CYCLE_HINT}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Invoice Start Date</Label>
              <Input type="date" value={form.billingStartDate}
                onChange={(e) => set('billingStartDate', e.target.value)} />
            </div>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Paid By</Label>
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background disabled:opacity-60"
                value={form.paidBy} disabled={ro}
                onChange={(e) => set('paidBy', e.target.value)}
              >
                <option value="">— Not Set —</option>
                {PAID_BY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Collected By</Label>
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background disabled:opacity-60"
                value={form.collectedBy} disabled={ro}
                onChange={(e) => set('collectedBy', e.target.value)}
              >
                <option value="">— Not Set —</option>
                {COLLECTED_BY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {canEdit && (
            <div className="flex items-center gap-2 border-t pt-3">
              <Button onClick={save} disabled={!dirty || saving}>
                {saving ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Save className="size-4 mr-1" />}
                {saving ? 'Saving…' : 'Save Changes'}
              </Button>
              <Button variant="outline" onClick={() => setForm(snapshot)} disabled={!dirty || saving}>
                <RotateCcw className="size-4 mr-1" /> Discard
              </Button>
            </div>
          )}
        </div>

        {/* ── Ledger, straight from the page's own summary endpoint ── */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Invoice Ledger</h4>
          {!summary && <p className="text-sm text-muted-foreground">Loading…</p>}
          {summary && !summary.invoices && (
            <p className="text-sm text-muted-foreground">
              The invoice ledger (<span className="font-mono">tbl_client_invoice</span>) is not
              available on this environment, so nothing can be shown here.
            </p>
          )}
          {summary?.invoices && (
            <dl className="grid grid-cols-2 gap-3">
              <Stat label="Billed" value={`₹${fmt(summary.invoices.billed)}`} />
              <Stat label="Collected" value={`₹${fmt(summary.invoices.collected)}`} />
              <Stat label="Outstanding" value={`₹${fmt(summary.invoices.outstanding)}`} strong />
              <Stat label="Invoices Raised" value={fmt(summary.invoices.invoices)} />
            </dl>
          )}
          <p className="text-xs text-muted-foreground border-t pt-3">
            Billing ADDRESSES — the entities invoices are raised against — live
            under Billing &amp; Estimates.
          </p>
        </div>
      </div>
    </SectionShell>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded border bg-card px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${strong ? 'text-lg font-semibold' : 'text-sm'}`}>{value}</dd>
    </div>
  );
}
