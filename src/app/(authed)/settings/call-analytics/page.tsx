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
type AnalysisResp = { status: string; analysis?: Analysis; reason?: string };

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

const PAGE_SIZE = 25;

export default function CallAnalyticsPage() {
  const { me } = useMe();
  const canView = hasAction(me, 'isCallAnalyticsView');

  const [page, setPage] = React.useState(1);
  const [jobQuery, setJobQuery] = React.useState('');
  const debouncedJob = useDebouncedValue(jobQuery.trim(), 400);
  const [analysisFor, setAnalysisFor] = React.useState<CallRow | null>(null);

  const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
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
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
          onChange={(e) => { setJobQuery(e.target.value.replace(/\D/g, '')); setPage(1); }}
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

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{total} call{total === 1 ? '' : 's'}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
          <span className="text-xs text-muted-foreground">Page {page} / {totalPages}</span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
        </div>
      </div>

      {analysisFor && <AnalysisModal call={analysisFor} onClose={() => setAnalysisFor(null)} />}
    </div>
  );
}

type ModalState =
  | { kind: 'loading' }
  | { kind: 'ready'; a: Analysis }
  | { kind: 'empty'; reason: string };

function AnalysisModal({ call, onClose }: { call: CallRow; onClose: () => void }) {
  const [state, setState] = React.useState<ModalState>({ kind: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api.get<AnalysisResp>(`/admin/calls/${call.id}/analysis`)
      .then((r) => {
        if (cancelled) return;
        if (r.status === 'ready' && r.analysis) { setState({ kind: 'ready', a: r.analysis }); return; }
        const msg = r.status === 'no_transcript' ? 'No transcript is available for this call yet.'
          : r.status === 'llm_disabled' ? 'Call-analysis AI is not configured in this environment.'
          : r.status === 'unavailable' ? 'Call analytics is not enabled in this environment.'
          : (r.reason || 'Analysis could not be generated.');
        setState({ kind: 'empty', reason: msg });
      })
      .catch((e) => { if (!cancelled) setState({ kind: 'empty', reason: e instanceof Error ? e.message : 'Failed to load analysis.' }); });
    return () => { cancelled = true; };
  }, [call.id]);

  // Read-only modal — never dirty; the guard just satisfies the shared
  // Dialog-close lint rule.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-2xl max-h-[calc(100vh-64px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-sky-600" /> Call Analysis{call.job_id ? ` · Job #${call.job_id}` : ''}
          </DialogTitle>
        </DialogHeader>

        {state.kind === 'loading' && (
          <div className="py-10 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Analysing the call…
          </div>
        )}
        {state.kind === 'empty' && (
          <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
            {state.reason}
          </div>
        )}
        {state.kind === 'ready' && <AnalysisBody a={state.a} />}
      </DialogContent>
    </Dialog>
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
