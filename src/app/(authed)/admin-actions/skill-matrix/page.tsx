'use client';

/*
 * Job Skill Matrix — property-gated Admin Action (skill.matrix.emails).
 * Triggers the AI build that maps services → deep skills (keyed by service
 * category) and shows the resulting matrix table for review. NOT (yet) used by
 * candidate-ranking — this is a review-only surface. BE enforces the gate.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Sparkles, ArrowLeft, Loader2, AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';

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
type ListResponse = { items: MatrixRow[]; total: number };

// Must mirror SORTABLE_COLUMNS in services/service-skill-matrix.service.js —
// the BE rejects (400) anything not on that whitelist.
type SortKey = 'service_catg_name' | 'service_name' | 'deepskill_name' | 'confidence' | 'source';

/*
 * The endpoint's real Joi ceiling (listQuery in routes/admin/skill-matrix.js).
 * TablePagination's 'All' otherwise resolves to pageSizeToLimit's 1000 default,
 * which this endpoint would reject with a 400.
 */
const MATRIX_LIMIT_CAP = 500;

export default function SkillMatrixPage() {
  const [categoryId, setCategoryId] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BuildSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const catgQ = useFetchOnce<Catg[]>('/shared/lookup/service-categories');
  const statsQ = useFetch<Stats>('/admin/skill-matrix/stats');

  /*
   * Search / sort / pagination are ALL server-side. A full build spans
   * thousands of (category, service) pairs — far past any single-request cap —
   * so a client-side sort could only ever reorder the arbitrary window that
   * happened to load, never surface a row from outside it.
   */
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 300).trim();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  // Nullable sortBy: the 3rd click clears sort entirely (canonical cycleSort
  // cycle) and we then omit both params so the BE applies its default order.
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
  }

  // Every input that affects the result set is part of the key, so useFetch
  // re-fires automatically on search / filter / sort / page changes.
  const limit = pageSizeToLimit(pageSize, MATRIX_LIMIT_CAP);
  const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
  const params = new URLSearchParams();
  if (categoryId) params.set('categoryId', String(Number(categoryId)));
  if (q) params.set('q', q);
  if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const listKey = `/admin/skill-matrix?${params.toString()}`;

  const listQ = useFetch<ListResponse>(listKey);
  const rows = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;
  const stats = statsQ.data;
  const llmOff = stats && !stats.llmConfigured;

  // A filter change can leave `page` pointing past the end of the new result
  // set — snap back to the first page. (`q` self-delays via the debounce.)
  useEffect(() => { setPage(0); }, [q, categoryId]);

  async function build() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const body: { categoryId?: number; dryRun: boolean } = { dryRun };
      if (categoryId) body.categoryId = Number(categoryId);
      const summary = await api.post<BuildSummary>('/admin/skill-matrix/build', body);
      setResult(summary);
      if (!dryRun) {
        // A build rewrites rows across every page/sort window, so drop the
        // whole cached key-space for this endpoint, not just the current key.
        invalidateFetch((k) => k.startsWith('/admin/skill-matrix'));
        statsQ.refetch();
        listQ.refetch();
      }
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
            ) : (
              // One label in both modes — the Dry Run checkbox already tells the
              // operator which of the two this run will be.
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
            {/* Count is the SERVER total for the current filters, not the
                loaded page — the page is one window onto a much larger set. */}
            <div className="text-sm font-semibold">
              Job Matrix{total ? ` (${total.toLocaleString('en-IN')})` : ''}
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

          {listQ.error && (
            <div className="mb-2 flex items-center gap-1 text-xs text-red-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {listQ.error}
            </div>
          )}

          {listQ.loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            // With server-side filtering an empty page means either "nothing
            // built yet" or "nothing matches" — the active filters tell us which.
            <div className="py-10 text-center text-sm text-muted-foreground">
              {q || categoryId
                ? <>No mappings match the current filters.</>
                : <>No mappings yet. Run a build to populate the matrix.</>}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="data-table text-xs">
                  <thead>
                    <tr>
                      <SortHeader<SortKey> col="service_catg_name" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Category</SortHeader>
                      <SortHeader<SortKey> col="service_name"      sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service</SortHeader>
                      <SortHeader<SortKey> col="deepskill_name"    sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Deep Skill</SortHeader>
                      <SortHeader<SortKey> col="confidence" align="right" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Confidence</SortHeader>
                      <SortHeader<SortKey> col="source"           sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Source</SortHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
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
                // Divider above the footer — the table and pagination share one
                // card here, so without it the footer reads as another table row.
                className="mt-3 border-t pt-3"
                page={page}
                pageSize={pageSize}
                // Server total for the current filters — drives the real page
                // count, not just what happens to be loaded.
                total={total}
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
