'use client';

/*
 * Admin Action — landing page that surfaces admin-only operations that
 * don't fit elsewhere. Mirrors the legacy CRM `generateClientInvoice` action
 * which was a misc-admin bucket.
 *
 * Each card links to the canonical implementation already shipped in the
 * app (Webhook re-dispatch, Bulk job upload, Manage Roles, etc.). This
 * avoids duplicating logic — Admin Action is a discovery surface, not a
 * second implementation.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ShieldCheck, Webhook, FileSpreadsheet, ShieldAlert, Workflow, Database, FileText, Trash2, Activity, Sparkles, AudioLines,
  Timer,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { useLookup } from '@/lib/use-lookup';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useFetchOnce } from '@/lib/hooks';
import { CallingModeToggle } from './CallingModeToggle';
import { OtpChannelToggle } from './OtpChannelToggle';
import { DeleteEntityDialog } from './DeleteEntityDialog';
import { DeletedRecordsDialog } from './DeletedRecordsDialog';

const ACTIONS = [
  {
    href: '/jobs/upload',
    icon: FileSpreadsheet,
    title: 'Bulk Job Upload',
    blurb: 'Excel-driven job import with dry-run mode and per-row error report.',
    actionKey: 'isJobUpload',
  },
  {
    href: '/settings/manage-roles',
    icon: ShieldCheck,
    title: 'Manage Roles & Permissions',
    blurb: 'Configure which menus + buttons each role can reach. Edits live-bust the 5-minute role cache.',
    actionKey: 'isRollEdit',
  },
  {
    href: '/settings/auto-allocation',
    icon: Workflow,
    title: 'Auto-Allocation Config',
    blurb: 'Tune the per-client auto-assignment engine — toggles, scoring weights, failure email.',
    actionKey: 'isAutoAllocationEdit',
  },
  {
    href: '/reports',
    icon: Database,
    title: 'Operational Reports',
    blurb: 'Completed jobs, payout sheet, easyfixer roll-up, user productivity. XLSX export.',
    actionKey: 'isReportView',
  },
  {
    href: '/tracking',
    icon: ShieldAlert,
    title: 'Job Tracking / Audit',
    blurb: 'Reconstruct any job’s scheduling-history timeline for dispute investigation.',
  },
  {
    href: '/admin-actions/webhooks',
    icon: Webhook,
    title: 'Webhook Manager',
    blurb: 'Inspect event registry, per-client callback mappings, and delivery audit logs.',
  },
  {
    href: '/admin-actions/tat-calculator',
    icon: Timer,
    title: 'TAT Calculator',
    blurb: 'Segment-wise turnaround for a job, a client\u2019s last 90 days, or a technician\u2019s lifetime. Read-only preview \u2014 nothing consumes it yet.',
    actionKey: 'isTatCalculatorView',
  },
];

export default function AdminActionsPage() {
  const { me } = useMe();
  const visible = ACTIONS.filter((a) => !a.actionKey || hasAction(me, a.actionKey));
  // RBAC for Generate Invoice — gated on either the read-side
  // (`isFinanceView`) or the dedicated write flag (`isInvoiceGenerate`).
  // No `|| true` short-circuit — users without either flag don't see
  // the card AND, even if they deep-link via ?focus=generate-invoice,
  // the dialog auto-open below short-circuits to a no-op because the
  // card isn't rendered.
  const canFinance = hasAction(me, 'isFinanceView') || hasAction(me, 'isInvoiceGenerate');
  // Property-gated Admin capabilities (Switch Call Mode, Delete/Restore) — driven
  // by a per-user easyfix_properties allowlist, NOT the user's role/RBAC. The BE
  // enforces the same allowlist on every gated route; these flags only show/hide
  // the cards. GET /admin/access/features → { canSwitchCallMode, canDeleteEntities }.
  const featureAccess = useFetchOnce<{ canSwitchCallMode: boolean; canDeleteEntities: boolean; canValidateFlows: boolean; canBuildSkillMatrix: boolean; canSwitchOtpChannel: boolean }>(
    '/admin/access/features',
  );
  const canSwitchCallMode = featureAccess.data?.canSwitchCallMode === true;
  const canDelete = featureAccess.data?.canDeleteEntities === true;
  const canRestore = canDelete;
  const canValidateFlows = featureAccess.data?.canValidateFlows === true;
  const canBuildSkillMatrix = featureAccess.data?.canBuildSkillMatrix === true;
  const canSwitchOtpChannel = featureAccess.data?.canSwitchOtpChannel === true;
  // Call-recording backfill — gated on the same isClickToCall action the BE
  // endpoint requires (requireClickToCallAction on /admin/calls/recordings/backfill).
  const canBackfillRecordings = hasAction(me, 'isClickToCall');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletedRecordsOpen, setDeletedRecordsOpen] = useState(false);
  const [recBackfillOpen, setRecBackfillOpen] = useState(false);
  // Legacy sidebar URL_MAP routes generateClientInvoice → /admin-actions?focus=generate-invoice
  // — auto-open the dialog when that param is present.
  const sp = useSearchParams();
  const wantsInvoice = sp.get('focus') === 'generate-invoice';
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const invoiceCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Only auto-open the dialog when the user actually has the permission.
    // Otherwise deep-linking ?focus=generate-invoice would silently open
    // a modal the user can't submit through.
    if (wantsInvoice && canFinance) {
      setInvoiceOpen(true);
      const t = setTimeout(() => {
        invoiceCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      return () => clearTimeout(t);
    }
  }, [wantsInvoice, canFinance]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="size-6" /> Admin Action
        </h1>
        <p className="text-sm text-muted-foreground">
          Privileged operations that don&apos;t fit elsewhere in the sidebar. Most cards link to
          their canonical screen — Admin Action is a discovery surface, not a second
          implementation.
        </p>
      </div>

      {/* Click-to-call mode switch (Web ⇄ Mobile) — Admin only; self-hides otherwise. */}
      {canSwitchCallMode && <CallingModeToggle />}
      {canSwitchOtpChannel && <OtpChannelToggle />}

      {visible.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to use any admin operations yet. Ask an admin to
            grant the relevant action permissions in Manage Roles.
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.title} href={a.href}>
              <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                      <Icon className="h-4 w-4" />
                    </div>
                    <h2 className="font-medium flex-1">{a.title}</h2>
                  </div>
                  <p className="text-xs text-muted-foreground">{a.blurb}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {/* Validate Flows — property-gated (validate.flows.emails): verify
            scheduled jobs + test push notifications. */}
        {canValidateFlows && (
          <Link href="/admin-actions/validate-flows">
            <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                    <Activity className="h-4 w-4" />
                  </div>
                  <h2 className="font-medium flex-1">Validate Flows</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  Verify scheduled jobs and send test push notifications to easyfixers — with full
                  delivery details for debugging.
                </p>
              </CardContent>
            </Card>
          </Link>
        )}
        {/* Build Skill Matrix — property-gated (skill.matrix.emails): AI-map
            services → deep skills so ranking matches a job's real skills. */}
        {canBuildSkillMatrix && (
          <Link href="/admin-actions/skill-matrix">
            <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <h2 className="font-medium flex-1">Job Skill Matrix</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use AI to map each service to the deep skill(s) it needs, so candidate ranking
                  matches a job&apos;s actual skills to a technician&apos;s.
                </p>
              </CardContent>
            </Card>
          </Link>
        )}
        {/* Generate Client Invoice — closes legacy URL_MAP gap. Opens
            a dialog that POSTs to /admin/finance/invoices/generate
            with { clientId, from, to }. Sidebar deep-link supported
            via ?focus=generate-invoice (auto-opens the dialog). */}
        {canFinance && (
          <div ref={invoiceCardRef}>
            <button
              type="button"
              onClick={() => setInvoiceOpen(true)}
              className="w-full text-left"
            >
              <Card className={
                'hover:border-primary hover:shadow-sm transition-colors h-full '
                + (wantsInvoice ? 'ring-2 ring-primary' : '')
              }>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                      <FileText className="h-4 w-4" />
                    </div>
                    <h2 className="font-medium flex-1">Generate Client Invoice</h2>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Roll up completed jobs for a client between two dates into a new invoice draft. Calls
                    <code className="mx-1">/admin/finance/invoices/generate</code> and returns the new invoice id.
                  </p>
                </CardContent>
              </Card>
            </button>
          </div>
        )}
        {/* Delete Easyfixer / User — OTP-gated hard-delete with an
            impact pre-check (blocks records that still have operational
            history). Opens DeleteEntityDialog. */}
        {canDelete && (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="w-full text-left"
          >
            <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-urgent-tint text-urgent grid place-items-center">
                    <ShieldAlert className="h-4 w-4" />
                  </div>
                  <h2 className="font-medium flex-1">Delete Easyfixer / User</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  OTP-gated hard-delete. Checks for linked operational history first and blocks the
                  delete if any exists (deactivate instead). Deleted records are archived and restorable.
                </p>
              </CardContent>
            </Card>
          </button>
        )}
        {/* Deleted Records — archive browser + OTP-gated restore. */}
        {canRestore && (
          <button
            type="button"
            onClick={() => setDeletedRecordsOpen(true)}
            className="w-full text-left"
          >
            <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                    <Trash2 className="h-4 w-4" />
                  </div>
                  <h2 className="font-medium flex-1">Deleted Records</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  Browse archived (hard-deleted) easyfixers and users. Restore any record via an
                  OTP-confirmed flow.
                </p>
              </CardContent>
            </Card>
          </button>
        )}
        {/* Backfill Call Recordings — recovers tbl_plivo_call_log.recording_url for
            calls whose Plivo push callback never landed, by pulling each from the
            Plivo Recording API. Gated on isClickToCall (same as the BE endpoint). */}
        {canBackfillRecordings && (
          <button
            type="button"
            onClick={() => setRecBackfillOpen(true)}
            className="w-full text-left"
          >
            <Card className="hover:border-primary hover:shadow-sm transition-colors h-full">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                    <AudioLines className="h-4 w-4" />
                  </div>
                  <h2 className="font-medium flex-1">Backfill Call Recordings</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  Recover missing call recordings — pulls each recorded call&apos;s audio URL from
                  Plivo for rows the provider&apos;s callback never delivered.
                </p>
              </CardContent>
            </Card>
          </button>
        )}
      </div>
      {canFinance && <GenerateInvoiceDialog open={invoiceOpen} onClose={() => setInvoiceOpen(false)} />}
      {canDelete && <DeleteEntityDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} />}
      {canRestore && <DeletedRecordsDialog open={deletedRecordsOpen} onClose={() => setDeletedRecordsOpen(false)} />}
      {canBackfillRecordings && <RecordingBackfillDialog open={recBackfillOpen} onClose={() => setRecBackfillOpen(false)} />}
    </div>
  );
}

/*
 * GenerateInvoiceDialog — three-field form (client + date range) that
 * posts to /admin/finance/invoices/generate. On success, surfaces the
 * new invoice id + a deep link to /finance for follow-up actions
 * (PDF/Excel/payment recording). Failures bubble through showToast.
 */
function GenerateInvoiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lookup = useLookup();
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ invoiceId: number; jobCount: number; totalAmount: number } | null>(null);

  async function submit() {
    if (!clientId || !from || !to) {
      showToast({ variant: 'error', message: 'Please select Client + From + To dates' });
      return;
    }
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ data: { invoiceId: number; jobCount: number; totalAmount: number } }>(
        '/admin/finance/invoices/generate',
        { clientId: Number(clientId), from, to },
      );
      const data = (r as unknown as { data?: typeof result; invoiceId?: number; jobCount?: number; totalAmount?: number });
      // Service returns either modernOk envelope `{ data: {...} }` or
      // the flat row — handle both shapes defensively.
      const payload = data?.data ?? (data as { invoiceId: number; jobCount: number; totalAmount: number });
      setResult(payload);
      showToast({ variant: 'success', message: 'Invoice Generated' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }

  const guardedOpenChange = useFormDirtyGuard(
    () => { onClose(); setResult(null); },
    { when: () => !busy },
  );

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Client Invoice</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          <div className="space-y-1">
            <Label>Client *</Label>
            <SearchSelect
              value={clientId}
              onChange={(v) => setClientId(String(v))}
              options={lookup.clients.map((c) => ({ value: String(c.client_id), label: c.client_name }))}
              placeholder="— Select a client —"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>From *</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>To *</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {result && (
            <div className="rounded border bg-success-tint border-success/30 p-3 text-sm space-y-1">
              <div><strong>Invoice #{result.invoiceId}</strong> created.</div>
              <div className="text-xs">{result.jobCount} jobs · ₹{Number(result.totalAmount || 0).toFixed(2)} total.</div>
              <div className="text-xs mt-1">
                <Link href="/finance" className="text-primary underline">Open Finance section</Link> to download PDF or record payment.
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onClose()}>Close</Button>
            <Button onClick={submit} disabled={busy || !clientId || !from || !to}>
              {busy ? 'Generating…' : 'Generate Invoice'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * RecordingBackfillDialog — one-click sweep that recovers missing call-recording
 * URLs. POSTs /admin/calls/recordings/backfill (pulls each requested-but-missing
 * recording from Plivo by call_uuid) and shows { scanned, recovered, stillMissing }.
 * The Plivo PUSH callback has proven unreliable, so this pull-based sweep is how
 * ops clears the "Missing Call Recordings" report on demand.
 */
function RecordingBackfillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ scanned: number; recovered: number; stillMissing: number; errors: number } | null>(null);

  async function run() {
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ data?: { scanned: number; recovered: number; stillMissing: number; errors: number } }>(
        '/admin/calls/recordings/backfill?limit=100',
        {},
      );
      const d = r as unknown as { data?: typeof result; scanned?: number; recovered?: number; stillMissing?: number; errors?: number };
      const payload = d?.data ?? (d as { scanned: number; recovered: number; stillMissing: number; errors: number });
      setResult(payload);
      showToast({ variant: 'success', message: `Recovered ${payload?.recovered ?? 0} recording(s)` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Backfill failed' });
    } finally { setBusy(false); }
  }

  const guardedOpenChange = useFormDirtyGuard(
    () => { onClose(); setResult(null); },
    { when: () => !busy },
  );

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Backfill Call Recordings</DialogTitle></DialogHeader>
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            Sweeps recorded calls that are missing their recording URL and pulls each one from Plivo
            (up to 100 per run). Safe to run repeatedly — run again if more than 100 are missing.
          </p>
          {result && (
            <div className="rounded border bg-success-tint border-success/30 p-3 text-sm space-y-1">
              <div><strong>{result.recovered}</strong> recovered of <strong>{result.scanned}</strong> scanned.</div>
              <div className="text-xs">
                {result.stillMissing} still missing{result.errors ? ` · ${result.errors} error(s)` : ''}.
                {result.stillMissing > 0 && ' Still-missing calls have no recording on Plivo for their call id (e.g. web calls filed under another leg).'}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { onClose(); setResult(null); }} disabled={busy}>Close</Button>
            <Button onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run Backfill'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
