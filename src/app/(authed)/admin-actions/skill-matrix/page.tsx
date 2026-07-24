'use client';

/*
 * Job Skill Matrix — property-gated Admin Action (skill.matrix.emails).
 * Triggers the AI build that maps services → deep skills (keyed by service
 * category) and shows the resulting matrix table for review. NOT (yet) used by
 * candidate-ranking — this is a review-only surface. BE enforces the gate.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Sparkles, ArrowLeft, Loader2, AlertTriangle, CheckCircle2, Search, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';

type Stats = { total: number; categories: number; skills: number; manual: number; llmConfigured: boolean; schemaReady?: boolean };
type BuildSummary = {
  categoriesProcessed: number; servicesSeen: number; mappingsFound: number;
  mappingsWritten: number; llmCalls: number; dryRun: boolean; model: string;
  // Coverage diagnostics. servicesUnmapped = services the build left with NO
  // skill (visit/charge line items the model skips by design + any genuine
  // gaps). llmFailedBatches > 0 means some batches failed even after a retry,
  // so those services are missing for a transient reason — rebuild to recover.
  servicesUnmapped?: number; llmFailedBatches?: number;
};
type Catg = { service_catg_id: number; service_catg_name: string };
type MatrixRow = {
  id: number; service_catg_name: string | null; service_name: string;
  deepskill_name: string | null; confidence: number | null; source: string;
};
type ListResponse = { items: MatrixRow[]; total: number };
// Add-mapping dialog lookups.
type DeepSkill = { deep_skill_id: number; deepskill_name: string; service_type_name: string | null };
type CatgService = { service_name: string; mapped: boolean };

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
  const [gapsOnly, setGapsOnly] = useState(false);

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
  // Gaps view — unmapped services in the selected category. Same endpoint/key
  // as the Add-dialog service picker (shared cache). Requires a category since
  // services are per-category (thousands total).
  const gapsQ = useFetch<CatgService[]>(
    gapsOnly && categoryId ? `/admin/skill-matrix/category-services?categoryId=${Number(categoryId)}` : null,
  );
  const gapServices = (gapsQ.data ?? []).filter((s) => !s.mapped);
  // Lightweight per-category gap count for the toggle badge — integers only,
  // so it's cheap to fetch on every category selection (unlike category-services,
  // which ships the whole 1000+ service list). Shown even when gapsOnly is OFF.
  const gapsCountQ = useFetch<{ total: number; mapped: number; unmapped: number; schemaReady?: boolean }>(
    categoryId ? `/admin/skill-matrix/gaps-count?categoryId=${Number(categoryId)}` : null,
  );
  const stats = statsQ.data;
  const llmOff = stats && !stats.llmConfigured;
  // The BE reports schemaReady:false when this host's tbl_service_skill_mapping
  // is the pre-recut (service_type_id) shape — the reads return empty instead of
  // 500ing, and this banner tells ops why the matrix is blank + how to fix it.
  const schemaDrifted = stats && stats.schemaReady === false;

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
        gapsCountQ.refetch();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  /* ── Manual gap-fill (Add / Remove a mapping) ──────────────────────────── */
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);
  const [mCatg, setMCatg] = useState('');
  const [mService, setMService] = useState('');
  const [mSkill, setMSkill] = useState('');
  const [showMapped, setShowMapped] = useState(false);
  const [saving, setSaving] = useState(false);

  // Dialog lookups — only fetched once the dialog is open AND a category chosen.
  const dlgSkillsQ = useFetch<DeepSkill[]>(
    addOpen && mCatg ? `/admin/skill-matrix/deep-skills?categoryId=${Number(mCatg)}` : null,
  );
  const dlgSvcQ = useFetch<CatgService[]>(
    addOpen && mCatg ? `/admin/skill-matrix/category-services?categoryId=${Number(mCatg)}` : null,
  );
  const dlgServices = (dlgSvcQ.data ?? []).filter((s) => showMapped || !s.mapped);

  function openAdd() {
    // Seed from the page's active category filter, if any — the common case is
    // "I'm looking at category X's gaps, let me fill this one".
    setMCatg(categoryId || '');
    setMService(''); setMSkill(''); setShowMapped(false);
    setAddOpen(true);
  }

  // Open the SAME Add Mapping dialog, pre-filled with the active category +
  // this specific gap service. The service is unmapped, so it appears in the
  // dialog's unmapped service list and the pre-selected value matches an option.
  function openAddForService(serviceName: string) {
    setMCatg(categoryId || '');
    setMService(serviceName);
    setMSkill('');
    setShowMapped(false);
    setAddOpen(true);
  }

  // A build/add/remove rewrites rows across every page+sort window, so drop the
  // whole cached key-space for this endpoint (not just the current key) then
  // refresh the two visible queries — mirrors build()'s invalidation.
  function refreshMatrix() {
    invalidateFetch((k) => k.startsWith('/admin/skill-matrix'));
    statsQ.refetch();
    listQ.refetch();
    gapsQ.refetch();
    gapsCountQ.refetch();
  }

  async function saveMapping() {
    if (!mCatg || !mService || !mSkill) return;
    setSaving(true);
    try {
      await api.post('/admin/skill-matrix/mapping', {
        categoryId: Number(mCatg), serviceName: mService, deepSkillId: Number(mSkill),
      });
      refreshMatrix();
      showToast({ variant: 'success', message: 'Mapping saved' });
      setAddOpen(false);
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not save mapping' });
    } finally {
      setSaving(false);
    }
  }

  async function removeRow(r: MatrixRow) {
    const ok = await confirm({
      title: 'Remove mapping?',
      description: (
        <>
          Remove <strong>{r.service_name}</strong> → <strong>{r.deepskill_name || '—'}</strong>?
          {r.source !== 'Manual' &&
            ' This is an AI mapping — it will return the next time you build the matrix.'}
        </>
      ),
      confirmLabel: 'Remove',
      variant: 'destructive',
      icon: <Trash2 className="h-4 w-4" />,
      iconAccent: 'rose',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/skill-matrix/mapping/${r.id}`);
      refreshMatrix();
      showToast({ variant: 'success', message: 'Mapping removed' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not remove mapping' });
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
          AI-map each service to the deep skill(s) it requires (keyed by service category), and fill
          any gaps by hand. Mappings refine candidate ranking where they exist — a service with no
          mapping falls back to category matching.
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

      {schemaDrifted && (
        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The Job Skill Matrix table on this environment has an outdated schema, so it can&apos;t be
            read or built here yet. A database reconcile is needed
            (<code>2026-07-24-reconcile-service-skill-mapping-schema.sql</code>), after which
            &ldquo;Build Matrix&rdquo; will repopulate it.
          </span>
        </div>
      )}

      {llmOff && !schemaDrifted && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The AI provider is not configured on this environment
            (<code>SOPHY_API_KEY_SKILL_MATRIX</code>). A build will fail until it&apos;s set. Manual
            mappings still work.
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
                {result.servicesUnmapped != null && (
                  <> · No skill: {result.servicesUnmapped}</>
                )}
              </div>
              {/* Genuine (transient) misses only — visible so ops can rebuild to
                  recover them, distinct from the "No skill" count which mostly
                  reflects visit/charge line items the model skips by design. */}
              {result.llmFailedBatches != null && result.llmFailedBatches > 0 && (
                <div className="text-xs text-amber-700">
                  {result.llmFailedBatches} batch(es) failed even after a retry — some services are
                  temporarily unmapped. Re-run the build to recover them.
                </div>
              )}
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
              {gapsOnly
                ? `Gaps${gapServices.length ? ` (${gapServices.length})` : ''}`
                : `Job Matrix${total ? ` (${total.toLocaleString('en-IN')})` : ''}`}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-8"
              onClick={openAdd}
              // Can't write on a drifted schema — the reconcile migration must
              // run first (the rose banner above says so).
              disabled={!!schemaDrifted}
              title={schemaDrifted ? 'Reconcile the schema first' : 'Add a manual mapping'}
            >
              <Plus className="h-3.5 w-3.5" /> Add Mapping
            </Button>
            <button
              type="button"
              onClick={() => setGapsOnly((v) => !v)}
              aria-pressed={gapsOnly}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                gapsOnly
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-slate-300 bg-background text-muted-foreground hover:bg-muted'
              }`}
              title="Show only services that have no mapping"
            >
              <AlertTriangle className="h-3.5 w-3.5" /> Gaps Only
              {categoryId && gapsCountQ.data ? ` (${gapsCountQ.data.unmapped.toLocaleString('en-IN')})` : ''}
            </button>
            <div className="relative w-full sm:w-72">
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

          {gapsOnly ? (
            !categoryId ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Select a service category above to see its gaps.
              </div>
            ) : gapsQ.loading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : gapServices.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No gaps — every active service in this category is mapped.
              </div>
            ) : (
              <ul className="divide-y">
                {gapServices.map((s) => (
                  <li key={s.service_name} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span>{s.service_name}</span>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => openAddForService(s.service_name)}>
                      <Plus className="h-3.5 w-3.5" /> Add
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : listQ.loading ? (
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
                      <th className="text-right font-medium">Actions</th>
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
                        <td className="text-right">
                          <button
                            type="button"
                            onClick={() => removeRow(r)}
                            title="Remove mapping"
                            aria-label="Remove mapping"
                            className="text-muted-foreground transition-colors hover:text-rose-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
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

      {/* Add Manual Mapping — fill a gap the AI build left (or add a 2nd skill
          to a mapped service). Saved as source='Manual'; preserved on rebuild. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Manual Mapping</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Map a service to the deep skill it needs. Saved as a <strong>Manual</strong> override —
              kept when the matrix is rebuilt, and used in candidate ranking.
            </p>

            <div className="space-y-1">
              <Label className="text-xs">Service Category</Label>
              <select
                value={mCatg}
                onChange={(e) => { setMCatg(e.target.value); setMService(''); setMSkill(''); }}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">Select a category…</option>
                {(catgQ.data ?? []).map((c) => (
                  <option key={c.service_catg_id} value={c.service_catg_id}>{c.service_catg_name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Service</Label>
                {mCatg && (
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <input type="checkbox" checked={showMapped} onChange={(e) => setShowMapped(e.target.checked)} />
                    Show already-mapped
                  </label>
                )}
              </div>
              <select
                value={mService}
                onChange={(e) => setMService(e.target.value)}
                disabled={!mCatg || dlgSvcQ.loading}
                className="w-full rounded-md border px-3 py-2 text-sm disabled:opacity-60"
              >
                <option value="">
                  {!mCatg ? 'Pick a category first' : dlgSvcQ.loading ? 'Loading…' : 'Select a service…'}
                </option>
                {dlgServices.map((s) => (
                  <option key={s.service_name} value={s.service_name}>
                    {s.service_name}{s.mapped ? ' · already mapped' : ''}
                  </option>
                ))}
              </select>
              {mCatg && !dlgSvcQ.loading && dlgServices.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {showMapped
                    ? 'No active services in this category.'
                    : 'Every service here is already mapped — tick “Show already-mapped” to add another skill.'}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Deep Skill</Label>
              <select
                value={mSkill}
                onChange={(e) => setMSkill(e.target.value)}
                disabled={!mCatg || dlgSkillsQ.loading}
                className="w-full rounded-md border px-3 py-2 text-sm disabled:opacity-60"
              >
                <option value="">
                  {!mCatg ? 'Pick a category first' : dlgSkillsQ.loading ? 'Loading…' : 'Select a deep skill…'}
                </option>
                {(dlgSkillsQ.data ?? []).map((s) => (
                  <option key={s.deep_skill_id} value={s.deep_skill_id}>
                    {s.deepskill_name}{s.service_type_name ? ` (${s.service_type_name})` : ''}
                  </option>
                ))}
              </select>
              {mCatg && !dlgSkillsQ.loading && (dlgSkillsQ.data ?? []).length === 0 && (
                <p className="text-[11px] text-amber-700">This category has no active deep skills to map to.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={saveMapping} disabled={saving || !mCatg || !mService || !mSkill}>
              {saving
                ? <span className="inline-flex items-center gap-1"><Loader2 className="h-4 w-4 animate-spin" /> Saving…</span>
                : 'Save Mapping'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
