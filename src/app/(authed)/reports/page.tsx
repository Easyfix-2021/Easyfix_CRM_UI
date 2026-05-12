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

import { useState } from 'react';
import {
  BarChart3, Building2, ScrollText, Wallet, Users, Clock, Activity, FileDown,
  AlertTriangle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useLookup } from '@/lib/use-lookup';

/*
 * Build a download URL with API base, JWT (from localStorage), and the
 * requested query. We can't use a normal <a download> because the auth
 * header is required. Instead fetch the response, blob it, and synthesize
 * an anchor click — same UX as a real download, no auth bypass.
 */
async function downloadXlsx(path: string, query: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  params.set('format', 'xlsx');
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';
  const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const res = await fetch(`${base}/admin/reports${path}?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Download failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (path.replace(/^\//, '') || 'report') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
      alert(`User Hours rows: ${rows.length}\n${rows.slice(0, 10).map((r: { user_id: number; date: string; actions: number }) => `${r.date} · user ${r.user_id} · ${r.actions} actions`).join('\n')}`);
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
    </ReportCard>
  );
}
