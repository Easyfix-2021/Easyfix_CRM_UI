'use client';

/*
 * Settings → Call Analytics.
 *
 * A call-history table (linked to the job where available) with a "View
 * Analysis" action per row that opens an AI coaching report generated from the
 * call's stored transcript (GET /admin/calls/:id/analysis). Transcript comes
 * from Plivo; the communication analysis is LLM-generated + cached server-side.
 * RBAC-gated by isCallAnalyticsView.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  PhoneCall, Loader2, Sparkles, TrendingUp, AlertTriangle, ThumbsUp, Ban, PlusCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';

type CallRow = {
  id: number;
  job_id: number | null;
  caller: string | null;
  caller_name: string | null;
  receiver: string | null;
  receiver_name: string | null;
  call_type: string | null;
  start_time: string | null;
  duration: number | null;
  provider: string | null;
  transcription_status?: string | null;
};
type ListResp = { total: number; page: number; limit: number; items: CallRow[] };

type Dimension = { name: string; score: number; notes?: string };
type Analysis = {
  overall_score?: number;
  summary?: string;
  dimensions?: Dimension[];
  strengths?: string[];
  areas_of_improvement?: string[];
  what_to_avoid?: string[];
  what_to_add?: string[];
};
type Metrics = {
  sentiment?: { agent?: number | null; customer?: number | null };
  talkTime?: { agentSec?: number; customerSec?: number; agentRatioPct?: number | null };
  interruptions?: number | null;
  nonTalkSec?: number | null;
};
type AnalysisResp = {
  status: string;
  analysis?: Analysis;
  metrics?: Metrics | null;
  metricsStatus?: string | null;
  reason?: string;
};

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(+d)) return String(v);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function fmtDuration(sec: number | null | undefined): string {
  const s = sec == null || !Number.isFinite(sec) ? 0 : Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function txBadge(status?: string | null): { label: string; cls: string } {
  const s = (status || '').toLowerCase();
  if (s === 'completed') return { label: 'Ready', cls: 'bg-emerald-100 text-emerald-700' };
  if (s === 'not_available') return { label: 'None', cls: 'bg-slate-100 text-slate-500' };
  if (s === 'failed') return { label: 'Failed', cls: 'bg-rose-100 text-rose-700' };
  return { label: 'Pending', cls: 'bg-amber-100 text-amber-700' };
}
function scoreColor(n?: number): string {
  const v = Number(n) || 0;
  if (v >= 8) return 'text-emerald-600';
  if (v >= 5) return 'text-amber-600';
  return 'text-rose-600';
}

export default function CallAnalyticsPage() {
  const { me } = useMe();
  const canView = hasAction(me, 'isCallAnalyticsView');

  // 0-indexed page + the shared TablePagination (matches the rest of the CRM,
  // and gives the page-size selector the raw table was missing). The backend
  // list endpoint is 1-indexed, so send `page + 1`.
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [jobQuery, setJobQuery] = React.useState('');
  const debouncedJob = useDebouncedValue(jobQuery.trim(), 400);
  const [analysisFor, setAnalysisFor] = React.useState<CallRow | null>(null);

  const limit = pageSizeToLimit(pageSize, 200); // backend callListQuery caps limit at 200
  const qs = new URLSearchParams({ page: String(page + 1), limit: String(limit) });
  if (debouncedJob) qs.set('jobId', debouncedJob);
  const { data, loading, error } = useFetch<ListResp>(canView ? `/admin/calls?${qs.toString()}` : null);

  if (!canView) {
    return (
      <Card className="max-w-lg">
        <CardContent className="pt-6 pb-6 text-center space-y-2">
          <AlertTriangle className="h-6 w-6 text-amber-500 mx-auto" />
          <h2 className="text-base font-semibold text-slate-900">Not Authorised</h2>
          <p className="text-sm text-muted-foreground">
            You don&apos;t have access to Call Analytics. Ask an admin to grant the
            &quot;View Call Analytics&quot; permission.
          </p>
        </CardContent>
      </Card>
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <PhoneCall className="h-5 w-5 text-sky-600" />
        <h1 className="text-lg font-semibold text-slate-900">Call Analytics</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Call history with AI coaching analysis. Click <span className="font-medium">View Analysis</span> to
        see per-call scores + areas of improvement (needs a stored transcript).
      </p>

      <div className="max-w-xs">
        <Input
          value={jobQuery}
          onChange={(e) => { setJobQuery(e.target.value.replace(/\D/g, '')); setPage(0); }}
          placeholder="Filter by Job #"
          inputMode="numeric"
        />
      </div>

      <div className="rounded-md border bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">Date / Time</th>
              <th className="px-3 py-2">Direction</th>
              <th className="px-3 py-2">Caller</th>
              <th className="px-3 py-2">Receiver</th>
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Transcript</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading…
              </td></tr>
            )}
            {!loading && error && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-rose-600">{error}</td></tr>
            )}
            {!loading && !error && items.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No calls found.</td></tr>
            )}
            {!loading && items.map((r) => {
              const b = txBadge(r.transcription_status);
              const outgoing = String(r.call_type || '').toUpperCase() === 'OUT';
              return (
                <tr key={r.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.start_time)}</td>
                  <td className="px-3 py-2">{outgoing ? 'Outgoing' : 'Incoming'}</td>
                  <td className="px-3 py-2">
                    <div>{r.caller_name || '—'}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.caller || ''}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.receiver_name || '—'}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.receiver || ''}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.job_id
                      ? <Link href={`/jobs?jobId=${r.job_id}`} className="text-sky-600 hover:underline font-mono">#{r.job_id}</Link>
                      : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono">{fmtDuration(r.duration)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${b.cls}`}>{b.label}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" className="!h-7 !px-2 text-xs" onClick={() => setAnalysisFor(r)}>
                      <Sparkles className="h-3.5 w-3.5 mr-1" /> View Analysis
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border bg-white px-3 py-2">
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        />
      </div>

      {analysisFor && <AnalysisModal call={analysisFor} onClose={() => setAnalysisFor(null)} />}
    </div>
  );
}

function AnalysisModal({ call, onClose }: { call: CallRow; onClose: () => void }) {
  const [resp, setResp] = React.useState<AnalysisResp | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setResp(null); setErr(null);
    api.get<AnalysisResp>(`/admin/calls/${call.id}/analysis`)
      .then((r) => { if (!cancelled) setResp(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load analysis.'); });
    return () => { cancelled = true; };
  }, [call.id]);

  // Read-only modal — never dirty; the guard just satisfies the shared
  // Dialog-close lint rule.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  const coachingReason = resp && resp.status !== 'ready'
    ? (resp.status === 'no_transcript' ? 'No transcript is available for this call yet.'
      : resp.status === 'llm_disabled' ? 'Coaching AI is not configured in this environment.'
      : resp.status === 'unavailable' ? 'Call analytics is not enabled in this environment.'
      : (resp.reason || 'Coaching could not be generated.'))
    : null;

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-2xl max-h-[calc(100vh-64px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-sky-600" /> Call Analysis{call.job_id ? ` · Job #${call.job_id}` : ''}
          </DialogTitle>
        </DialogHeader>

        {!resp && !err && (
          <div className="py-10 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Analysing the call…
          </div>
        )}
        {err && (
          <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-amber-500" />{err}
          </div>
        )}
        {resp && (
          <div className="space-y-5">
            {/* Objective metrics — Amazon Transcribe Call Analytics (cron-precomputed). */}
            <MetricsBody metrics={resp.metrics} status={resp.metricsStatus} />
            {/* Coaching narrative — LLM over the transcript. */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Coaching</div>
              {resp.status === 'ready' && resp.analysis
                ? <AnalysisBody a={resp.analysis} />
                : <div className="text-sm text-muted-foreground flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />{coachingReason}</div>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function sentimentLabel(n?: number | null): { label: string; cls: string } {
  if (n == null) return { label: '—', cls: 'text-muted-foreground' };
  // Transcribe OverallSentiment is a signed score (roughly -5..5); sign-based
  // bucketing is robust to the exact scale.
  if (n > 0.5) return { label: 'Positive', cls: 'text-emerald-600' };
  if (n < -0.5) return { label: 'Negative', cls: 'text-rose-600' };
  return { label: 'Neutral', cls: 'text-slate-600' };
}

function MetricsBody({ metrics, status }: { metrics?: Metrics | null; status?: string | null }) {
  if (!metrics) {
    const s = (status || '').toLowerCase();
    const msg = s === 'processing' ? 'Call metrics are being generated (Amazon Transcribe) — check back shortly.'
      : s === 'failed' ? 'Call metrics could not be generated for this call.'
      : 'Call metrics are not available yet.';
    return (
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Call Metrics</div>
        <div className="text-sm text-muted-foreground">{msg}</div>
      </div>
    );
  }
  const t = metrics.talkTime || {};
  const sa = sentimentLabel(metrics.sentiment?.agent);
  const sc = sentimentLabel(metrics.sentiment?.customer);
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Call Metrics</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Agent Sentiment" value={sa.label} cls={sa.cls} />
        <Metric label="Customer Sentiment" value={sc.label} cls={sc.cls} />
        <Metric label="Agent Talk" value={t.agentRatioPct != null ? `${t.agentRatioPct}%` : '—'} />
        <Metric label="Interruptions" value={metrics.interruptions != null ? String(metrics.interruptions) : '—'} />
      </div>
    </div>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className={`text-sm font-semibold ${cls || 'text-slate-800'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function AnalysisBody({ a }: { a: Analysis }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-3 rounded-md border bg-slate-50 px-3 py-2">
        <div className="text-center shrink-0">
          <div className={`text-2xl font-bold ${scoreColor(a.overall_score)}`}>
            {a.overall_score ?? '—'}<span className="text-sm text-muted-foreground">/10</span>
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Overall</div>
        </div>
        {a.summary && <p className="flex-1 text-slate-700">{a.summary}</p>}
      </div>

      {Array.isArray(a.dimensions) && a.dimensions.length > 0 && (
        <div className="space-y-2">
          {a.dimensions.map((d, i) => (
            <div key={i} className="rounded-md border px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.name}</span>
                <span className={`font-semibold ${scoreColor(d.score)}`}>{d.score}/10</span>
              </div>
              {d.notes && <p className="text-xs text-muted-foreground mt-0.5">{d.notes}</p>}
            </div>
          ))}
        </div>
      )}

      <ListBlock icon={<ThumbsUp className="h-4 w-4 text-emerald-600" />} title="Strengths" items={a.strengths} />
      <ListBlock icon={<TrendingUp className="h-4 w-4 text-sky-600" />} title="Areas of Improvement" items={a.areas_of_improvement} />
      <ListBlock icon={<Ban className="h-4 w-4 text-rose-600" />} title="What to Avoid Saying" items={a.what_to_avoid} />
      <ListBlock icon={<PlusCircle className="h-4 w-4 text-indigo-600" />} title="What to Add" items={a.what_to_add} />
    </div>
  );
}

function ListBlock({ icon, title, items }: { icon: React.ReactNode; title: string; items?: string[] }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 font-medium mb-1">{icon} {title}</div>
      <ul className="list-disc pl-6 space-y-0.5 text-slate-700">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}
