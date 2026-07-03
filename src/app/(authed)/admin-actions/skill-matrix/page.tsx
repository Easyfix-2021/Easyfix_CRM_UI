'use client';

/*
 * Build Skill Matrix — property-gated Admin Action (skill.matrix.emails).
 * Triggers the AI build that maps services → deep skills (keyed by service
 * category) and shows the resulting matrix table for review. NOT (yet) used by
 * candidate-ranking — this is a review-only surface. BE enforces the gate.
 */

import Link from 'next/link';
import { useState } from 'react';
import { Sparkles, ArrowLeft, Loader2, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce } from '@/lib/hooks';

type Stats = { total: number; categories: number; skills: number; manual: number; llmConfigured: boolean };
type BuildSummary = {
  categoriesProcessed: number; servicesSeen: number; mappingsFound: number;
  mappingsWritten: number; llmCalls: number; dryRun: boolean; model: string;
};
type Catg = { service_catg_id: number; service_catg_name: string };
type MatrixRow = {
  id: number; service_catg_name: string | null; service_name: string;
  deepskill_name: string | null; confidence: number | null; source: string;
};

export default function SkillMatrixPage() {
  const [categoryId, setCategoryId] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BuildSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const catgQ = useFetchOnce<Catg[]>('/shared/lookup/service-categories');
  const statsQ = useFetch<Stats>('/admin/skill-matrix/stats');
  const listKey = `/admin/skill-matrix?limit=200${categoryId ? `&categoryId=${Number(categoryId)}` : ''}`;
  const listQ = useFetch<{ items: MatrixRow[] }>(listKey);
  const rows = listQ.data?.items ?? [];
  const stats = statsQ.data;
  const llmOff = stats && !stats.llmConfigured;

  async function build() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const body: { categoryId?: number; dryRun: boolean } = { dryRun };
      if (categoryId) body.categoryId = Number(categoryId);
      const summary = await api.post<BuildSummary>('/admin/skill-matrix/build', body);
      setResult(summary);
      if (!dryRun) { statsQ.refetch(); listQ.refetch(); }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <Link
          href="/admin-actions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Admin Actions
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
          <Sparkles className="h-5 w-5 text-primary" /> Build Skill Matrix
        </h1>
        <p className="text-sm text-muted-foreground">
          AI-map each service to the deep skill(s) it requires (keyed by service category). Review
          the matrix below — it is <strong>not</strong> used in candidate ranking yet.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Mappings" value={stats?.total} />
            <Stat label="Categories" value={stats?.categories} />
            <Stat label="Deep Skills" value={stats?.skills} />
            <Stat label="Manual Overrides" value={stats?.manual} />
          </div>
        </CardContent>
      </Card>

      {llmOff && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            OpenAI is not configured on this environment (<code>OPENAI_API_KEY_SKILL_MATRIX</code>). A
            build will fail until it&apos;s set.
          </span>
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Service Category (scopes build &amp; table)</Label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">All categories with deep skills</option>
                {(catgQ.data ?? []).map((c) => (
                  <option key={c.service_catg_id} value={c.service_catg_id}>
                    {c.service_catg_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                Dry run (classify &amp; count, don&apos;t write)
              </label>
            </div>
          </div>

          <Button onClick={build} disabled={busy}>
            {busy ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-4 w-4 animate-spin" /> Building…
              </span>
            ) : dryRun ? (
              'Run Dry Run'
            ) : (
              'Build Matrix'
            )}
          </Button>

          {err && <div className="text-sm text-red-700">{err}</div>}
          {result && (
            <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex items-center gap-1 font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" /> {result.dryRun ? 'Dry run complete' : 'Matrix built'}
              </div>
              <div className="text-xs text-muted-foreground">
                Categories: {result.categoriesProcessed} · Services seen: {result.servicesSeen} ·
                Mappings found: {result.mappingsFound}
                {!result.dryRun && <> · Written: {result.mappingsWritten}</>} · LLM calls:{' '}
                {result.llmCalls} · Model: {result.model}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Current matrix — always shown for review. */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-sm font-semibold flex-1">
              Current Matrix{rows.length ? ` (${rows.length}${rows.length >= 200 ? '+' : ''})` : ''}
            </div>
            <button
              type="button"
              onClick={() => listQ.refetch()}
              title="Refresh"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>

          {listQ.loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No mappings yet. Run a build to populate the matrix.
            </div>
          ) : (
            <div className="max-h-[55vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Category</th>
                    <th className="py-1.5 pr-3 font-medium">Service</th>
                    <th className="py-1.5 pr-3 font-medium">Deep Skill</th>
                    <th className="py-1.5 pr-3 font-medium">Conf.</th>
                    <th className="py-1.5 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/60">
                      <td className="py-1.5 pr-3">{r.service_catg_name || '—'}</td>
                      <td className="py-1.5 pr-3">{r.service_name}</td>
                      <td className="py-1.5 pr-3">{r.deepskill_name || '—'}</td>
                      <td className="py-1.5 pr-3">{r.confidence != null ? r.confidence : '—'}</td>
                      <td className="py-1.5">{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-lg font-semibold">{value ?? '—'}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
