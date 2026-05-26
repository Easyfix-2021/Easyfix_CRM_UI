'use client';

/*
 * Reports landing — surfaces all 7 admin reports backed by
 * /api/admin/reports/* (Phase 11 — DONE on backend per EasyFix_Backend/CLAUDE.md).
 *
 * Each report card has its own filter row + a "Download XLSX" button that
 * triggers a server-rendered Excel download via `?format=xlsx`. The same
 * endpoint without `?format=xlsx` returns JSON for in-app preview.
 *
 * Endpoints surfaced:
 *   /completed-jobs     (from, to, clientId?)
 *   /easyfixer          (from?, to?, efrId?)
 *   /payout-sheet       (from, to)
 *   /city-analysis      (no filters)
 *   /job-tracking       (jobId — lives on /tracking page, not duplicated here)
 *   /user-productivity  (from, to, userId?, roleId?)
 *   /user-hours         (from?, to?, userId?)
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  BarChart3, Building2, ScrollText, Wallet, Users, Clock, Activity, FileDown,
  AlertTriangle, Flame, Banknote,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useLookup } from '@/lib/use-lookup';
import { downloadXlsx as sharedDownloadXlsx } from '@/lib/download-xlsx';

/*
 * Reports-specific wrapper around the shared xlsx download helper
 * (src/lib/download-xlsx.ts). Adds the `format=xlsx` query flag the
 * /admin/reports endpoints require, picks a sensible filename from
 * the path, and delegates the fetch/blob/anchor mechanics.
 */
async function downloadXlsx(path: string, query: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  params.set('format', 'xlsx');
  await sharedDownloadXlsx({
    url: `/admin/reports${path}?${params.toString()}`,
    filename: (path.replace(/^\//, '') || 'report') + '.xlsx',
  });
}

// Default the date range to "last 30 days" so cards aren't blank on first load.
function defaultRange() {
  const to = new Date();
  const from = new Date(); from.setDate(to.getDate() - 30);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export default function ReportsLandingPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isReportView', 'isReportDownload']);

  // Sidebar legacy URL_MAP routes manageFinanceReport → /reports?focus=finance
  // and manageEscalationReport → /reports?focus=escalation. We honour the
  // query param by scrolling the matching card into view + briefly
  // highlighting it. Falls through to the default landing when absent.
  const sp = useSearchParams();
  const focus = sp.get('focus');
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      focusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(t);
  }, [focus]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="size-6" /> Reports
        </h1>
        <p className="text-sm text-muted-foreground">
          Download operational reports as XLSX. All reports are admin-only.
        </p>
      </div>
      {!can.isReportView && !can.isReportDownload && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to view reports. Ask an admin to grant
            <code className="mx-1">isReportView</code> or <code className="mx-1">isReportDownload</code>.
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CompletedJobsCard />
        <PayoutSheetCard />
        <EasyfixerReportCard />
        <UserProductivityCard />
        <CityAnalysisCard />
        <UserHoursCard />
        {/* Escalation + Finance cards close the legacy sidebar links
            (manageEscalationReport / manageFinanceReport). The focus
            query param scrolls the matching card into view. */}
        <div ref={focus === 'escalation' ? focusRef : null} className={focus === 'escalation' ? 'ring-2 ring-sky-400 rounded-lg' : undefined}>
          <EscalationReportCard />
        </div>
        <div ref={focus === 'finance' ? focusRef : null} className={focus === 'finance' ? 'ring-2 ring-sky-400 rounded-lg' : undefined}>
          <FinanceReportCard />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-cards ──────────────────────────────────────────────────────

function ReportCard({
  title, blurb, Icon, children,
}: {
  title: string; blurb: string; Icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Icon className="size-5 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{title}</div>
            <div className="text-xs text-muted-foreground">{blurb}</div>
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function CompletedJobsCard() {
  const lookup = useLookup();
  const [{ from, to }, setRange] = useState(defaultRange());
  const [clientId, setClientId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try { await downloadXlsx('/completed-jobs', { from, to, clientId }); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="Completed Jobs" blurb="Jobs with status COMPLETED in the date range. Optional client filter." Icon={ScrollText}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="border rounded h-9 px-2 text-sm bg-background w-full">
        <option value="">All clients</option>
        {lookup.clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
      </select>
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy || !from || !to}>
        <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download XLSX'}
      </Button>
    </ReportCard>
  );
}

function PayoutSheetCard() {
  const [{ from, to }, setRange] = useState(defaultRange());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try { await downloadXlsx('/payout-sheet', { from, to }); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="Payout Sheet" blurb="Active easyfixers + jobs completed in range + current wallet balance." Icon={Wallet}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy || !from || !to}>
        <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download XLSX'}
      </Button>
    </ReportCard>
  );
}

function EasyfixerReportCard() {
  const [{ from, to }, setRange] = useState(defaultRange());
  const [efrId, setEfrId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try { await downloadXlsx('/easyfixer', { from, to, efrId }); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="Easyfixer Performance" blurb="Per-tech roll-up: completed / cancelled / total. Optional single-tech filter." Icon={Users}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      <Input placeholder="Easyfixer ID (optional)" value={efrId} onChange={(e) => setEfrId(e.target.value.replace(/\D/g, ''))} className="font-mono" />
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy}>
        <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download XLSX'}
      </Button>
    </ReportCard>
  );
}

function UserProductivityCard() {
  const lookup = useLookup();
  const [{ from, to }, setRange] = useState(defaultRange());
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try { await downloadXlsx('/user-productivity', { from, to, userId, roleId }); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="User Productivity" blurb="CRM-user active hours from login/logout logs. Filterable by user or role." Icon={Activity}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="border rounded h-9 px-2 text-sm bg-background w-full">
        <option value="">All roles</option>
        {lookup.roles.map((r) => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}
      </select>
      <Input placeholder="User ID (optional)" value={userId} onChange={(e) => setUserId(e.target.value.replace(/\D/g, ''))} className="font-mono" />
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy || !from || !to}>
        <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download XLSX'}
      </Button>
    </ReportCard>
  );
}

function CityAnalysisCard() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try { await downloadXlsx('/city-analysis', {}); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="City Analysis" blurb="All active cities ranked by job volume (total / completed / cancelled). No date filter — full lifetime." Icon={Building2}>
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy}>
        <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download XLSX'}
      </Button>
    </ReportCard>
  );
}

function UserHoursCard() {
  const [{ from, to }, setRange] = useState(defaultRange());
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline preview list — replaces the native window.alert that was here
  // previously (UX regression vs. shipped pattern).
  const [preview, setPreview] = useState<Array<{ user_id: number; date: string; actions: number }>>([]);
  async function run() {
    setBusy(true); setErr(null);
    try {
      // user-hours is JSON-only (no XLSX path on backend). Open as JSON and
      // present row-count back to the operator as a sanity check.
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to)   params.set('to',   to);
      if (userId) params.set('userId', userId);
      const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const res = await fetch(`${base}/admin/reports/user-hours?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      const data = await res.json();
      const rows = data?.data ?? [];
      // Replaced native alert (UX regression vs. shipped pattern) with
      // a stored preview that renders below the button.
      setPreview(rows);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="User Hours (raw)" blurb="Per-day login/logout action counts. JSON only — preview shows top 10 rows." Icon={Clock}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      <Input placeholder="User ID (optional)" value={userId} onChange={(e) => setUserId(e.target.value.replace(/\D/g, ''))} className="font-mono" />
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy}>
        <Activity className="size-3.5 mr-1" /> {busy ? 'Loading…' : 'Preview'}
      </Button>
      {preview.length > 0 && (
        <div className="rounded border bg-slate-50 p-2 text-xs max-h-40 overflow-auto">
          <div className="font-medium mb-1">{preview.length} rows · showing top 10:</div>
          <ul className="space-y-0.5 font-mono">
            {preview.slice(0, 10).map((r, i) => (
              <li key={i}>{r.date} · user {r.user_id} · {r.actions} actions</li>
            ))}
          </ul>
        </div>
      )}
    </ReportCard>
  );
}

/*
 * EscalationReportCard — wraps the existing /admin/jobs/escalated/export.xlsx
 * endpoint (already used by the Escalated Jobs modal on /admin-actions).
 * Closes the broken sidebar link manageEscalationReport → /reports?focus=escalation.
 * Filters mirror what the escalated list page supports: date range +
 * optional client.
 */
function EscalationReportCard() {
  const lookup = useLookup();
  const [{ from, to }, setRange] = useState(defaultRange());
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to)   params.set('to',   to);
      if (clientId) params.set('clientId', clientId);
      await sharedDownloadXlsx({
        url: `/admin/jobs/escalated/export.xlsx?${params.toString()}`,
        filename: 'escalation-report.xlsx',
      });
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="Escalation Report" blurb="All escalated jobs in the date range with reasons and current SLA status." Icon={Flame}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="border rounded h-9 px-2 text-sm bg-background w-full">
        <option value="">All clients</option>
        {lookup.clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
      </select>
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <Button size="sm" onClick={run} disabled={busy || !from || !to}>
        <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download XLSX'}
      </Button>
    </ReportCard>
  );
}

/*
 * FinanceReportCard — landing for the /finance section (which hosts
 * invoices, EFR ledger, payouts, NDM). Sidebar legacy URL focus=finance
 * routes here; we surface a "Go to Finance" CTA + direct downloads of
 * the EFR transactions ledger as XLSX. The Finance hub itself houses
 * the full write-op flows (invoices, POs, payouts).
 */
function FinanceReportCard() {
  const [{ from, to }, setRange] = useState(defaultRange());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to)   params.set('to',   to);
      params.set('format', 'xlsx');
      await sharedDownloadXlsx({
        url: `/admin/finance/efr-transactions?${params.toString()}`,
        filename: 'finance-efr-transactions.xlsx',
      });
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }
  return (
    <ReportCard title="Finance Report" blurb="Easyfixer ledger (deposits, payouts, recharges) for the period. For invoices and PO listings, open the Finance section." Icon={Banknote}>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <Input type="date" value={to}   onChange={(e) => setRange((r) => ({ ...r, to:   e.target.value }))} />
      </div>
      {err && <div className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="size-3.5" /> {err}</div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={run} disabled={busy || !from || !to}>
          <FileDown className="size-3.5 mr-1" /> {busy ? 'Downloading…' : 'Download EFR Ledger'}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href="/finance">Open Finance Section</a>
        </Button>
      </div>
    </ReportCard>
  );
}
