'use client';

/*
 * Job Skill Matrix — property-gated Admin Action (skill.matrix.emails).
 * Triggers the AI build that maps services → deep skills (keyed by service
 * category) and shows the resulting matrix table for review. NOT (yet) used by
 * candidate-ranking — this is a review-only surface. BE enforces the gate.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Sparkles, ArrowLeft, Loader2, AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, useDebouncedValue } from '@/lib/hooks';
import { SortHeader, useSort } from '@/lib/use-sort';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';

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
  // limit=500 = the endpoint's Joi cap, and the whole matrix is well under it
  // (the Mappings stat card shows the true total). So the full set loads in one
  // request and search / sort / pagination all run CLIENT-side — instant, and no
  // BE round-trip per keystroke or page. `matrixCapped` warns if the matrix ever
  // outgrows the cap, at which point this would need server-side paging.
  const MATRIX_LIMIT = 500;
  const listKey = `/admin/skill-matrix?limit=${MATRIX_LIMIT}${categoryId ? `&categoryId=${Number(categoryId)}` : ''}`;
  const listQ = useFetch<{ items: MatrixRow[] }>(listKey);
  const rows = useMemo(() => listQ.data?.items ?? [], [listQ.data]);
  const stats = statsQ.data;
  const llmOff = stats && !stats.llmConfigured;
  const matrixCapped = rows.length >= MATRIX_LIMIT;

  // Client-side search across the three name columns (Category / Service / Deep
  // Skill), debounced so typing doesn't thrash the filter on every keystroke.
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 200).trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return rows;
    return rows.filter((r) =>
      (r.service_catg_name || '').toLowerCase().includes(q)
      || (r.service_name || '').toLowerCase().includes(q)
      || (r.deepskill_name || '').toLowerCase().includes(q));
  }, [rows, q]);

  // Sort (client-side, any column) then paginate the sorted+filtered set.
  const { sorted, sortKey, sortDir, toggle } = useSort<MatrixRow>(filtered);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const perPage = pageSize === 'all' ? sorted.length || 1 : pageSize;
  const pageRows = sorted.slice(page * perPage, page * perPage + perPage);

  // Any change to the result set (search or category filter) can leave `page`
  // pointing past the end — snap back to the first page.
  useEffect(() => { setPage(0); }, [q, categoryId]);

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
    <div className="space-y-5">
      <div>
        <Link
          href="/admin-actions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Admin Actions
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
          <Sparkles className="h-5 w-5 text-primary" /> Job Skill Matrix
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

      {/* Job Matrix — always shown for review. No manual refresh button: a
          non-dry-run build already refetches this list (see build()), and it's
          a review surface that isn't edited elsewhere, so there is nothing to
          poll for. */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">
              Job Matrix{rows.length ? ` (${filtered.length === rows.length ? rows.length : `${filtered.length} of ${rows.length}`})` : ''}
            </div>
            <div className="relative ml-auto w-full sm:w-72">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Category, Service or Deep Skill"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          {matrixCapped && (
            <div className="mb-2 text-[11px] text-amber-700">
              Showing the first {MATRIX_LIMIT} mappings — the matrix has outgrown the single-page cap.
            </div>
          )}

          {listQ.loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No mappings yet. Run a build to populate the matrix.
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No mappings match &ldquo;{search}&rdquo;.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="data-table text-xs">
                  <thead>
                    <tr>
                      <SortHeader col={'service_catg_name' as keyof MatrixRow} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Category</SortHeader>
                      <SortHeader col={'service_name'      as keyof MatrixRow} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Service</SortHeader>
                      <SortHeader col={'deepskill_name'    as keyof MatrixRow} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Deep Skill</SortHeader>
                      <SortHeader col={'confidence'        as keyof MatrixRow} align="right" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Conf.</SortHeader>
                      <SortHeader col={'source'            as keyof MatrixRow} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Source</SortHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <tr key={r.id} className="hover:bg-muted/40">
                        <td>{r.service_catg_name || '—'}</td>
                        <td>{r.service_name}</td>
                        <td>{r.deepskill_name || '—'}</td>
                        <td className="text-right">{r.confidence != null ? r.confidence : '—'}</td>
                        <td>{r.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePagination
                page={page}
                pageSize={pageSize}
                total={filtered.length}
                onPageChange={setPage}
                onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              />
            </>
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
