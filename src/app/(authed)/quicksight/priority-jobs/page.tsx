'use client';

/*
 * QuickSight — Priority Jobs (legacy "Hotspot City") report page.
 *
 *   registry slug : priorityJobs   ·   urlBase: priority-jobs
 *   action key    : isQuickSightPriorityJobsView
 *   BE endpoints  : POST /api/admin/quicksight/priority-jobs/grid
 *                   POST /api/admin/quicksight/priority-jobs/city-jobs
 *                   POST /api/admin/quicksight/priority-jobs/export?format=xlsx
 *
 * Native rebuild of the legacy "Priority Jobs" page: a city-wise aging
 * summary of OPEN, OWNED jobs (Today / Yesterday / 2–7 days / >7 days +
 * Total), paginated per-city-row, with two KPI chips (Open Escalation,
 * Unconfirmed), a server-side XLSX export, and a Total → drill-down dialog
 * that lists the actual jobs for that city.
 *
 * Gating: the page is gated on the per-report action key via actionFlags
 * (the family key is enforced server-side by requireQuickSight). A 403 from
 * the grid endpoint flips the scaffold's accessDenied panel.
 *
 * Fetch hygiene: data comes through the shared `usePostFetch` (from
 * `@/lib/hooks`) — a POST-capable sibling of the GET-only `useFetch` that
 * keeps the same dedup / Strict-Mode / cancellation guards (the report's
 * endpoints validate a Joi filter body, so they must POST). We never write a
 * raw useEffect+api.get.
 *
 * Ownership scoping is faithful legacy parity and handled SERVER-SIDE from
 * the JWT user (non-admins see only their own owned jobs; admins see all or
 * filter by the Job Owner picker) — the FE simply passes the selected owner
 * ids.
 */

import { useCallback, useMemo, useState } from 'react';
import { Flame, ExternalLink, Loader2 } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useLookup } from '@/lib/use-lookup';
import type { SearchOption } from '@/components/ui/search-select';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import type { QuickSightFilterValue } from '@/components/quicksight/QuickSightFilterBar';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import {
  TablePagination,
  pageSizeToLimit,
  type TablePageSize,
} from '@/components/ui/table-pagination';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ACTION_KEY = 'isQuickSightPriorityJobsView';
const API_BASE = '/admin/quicksight/priority-jobs';
const BE_PAGE_SIZE_MAX = 100; // mirror the BE Joi pageSize.max(100)

/* ── Row + response types (mirror the BE service response) ────────────── */
type GridRow = {
  cityId: number;
  cityName: string;
  stateName: string;
  todayCount: number;
  yesterdayCount: number;
  days2To7Count: number;
  greaterThan7Count: number;
  totalCount: number;
};

type GridResponse = {
  paginatedData: {
    data: GridRow[];
    totalRecords: number;
    pageNumber: number;
    pageSize: number;
    totalPages: number;
  };
  escalatedCount: number;
  unconfirmedCount: number;
};

type CityJob = {
  jobId: number;
  jobStatus: number;
  easyFixterId: number | null;
  statusMessage: string;
  jobOwner: string;
  userId: number | null;
  clientName: string;
  easyFixerName: string;
  jobAge: number;
  jobCurrentOwner: string;
};

/* The filter body shape the grid/export endpoints accept. */
type FilterBody = {
  serviceCategoryId: number[];
  stateId: number[];
  cityId: number[];
  ownerId: number[];
};

/* POST-based XLSX download (the shared download-xlsx helper is GET-only;
 * this endpoint validates the filter body, so the export must POST). */
async function downloadXlsxPost(path: string, body: unknown, filename: string) {
  const base = process.env.NEXT_PUBLIC_API_URL || '/api';
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* non-JSON body — keep the HTTP code */
    }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

const EMPTY_FILTERS: FilterBody = {
  serviceCategoryId: [],
  stateId: [],
  cityId: [],
  ownerId: [],
};

export default function PriorityJobsPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  /* ── Filter state (applied vs draft) ───────────────────────────────
   * The dropdowns edit `draft`; Filter copies draft→applied (which re-keys
   * the fetch). Mirrors the legacy submit/reset model. */
  const [draft, setDraft] = useState<FilterBody>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<FilterBody>(EMPTY_FILTERS);

  /* ── Server-side pagination (per-city-row) ─────────────────────────── */
  const [page, setPage] = useState(0); // 0-indexed
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const limit = pageSizeToLimit(pageSize, BE_PAGE_SIZE_MAX); // 'all' → 100 (BE cap)

  /* Lookups for the four filters. Job Owner uses adminUsers as the picker
   * superset (the legacy "Job Owner" list = internal tbl_user rows); this is
   * the same convention the Open Orders report uses for its owner-style
   * filter. We reuse the existing auth-gated /api/shared/lookup/* — no new
   * BE lookup is introduced (registry: do NOT recreate /pmJobsFilterList). */
  const lookup = useLookup();
  const svcCatOpts: SearchOption[] = useMemo(
    () =>
      [...lookup.toOpts.serviceCategories].sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    [lookup.toOpts.serviceCategories],
  );
  const stateOpts = lookup.toOpts.states;
  const cityOpts = lookup.toOpts.cities;
  const ownerOpts = lookup.toOpts.adminUsers;

  /* The body the grid endpoint receives (applied filters + pagination). */
  const gridBody = useMemo(
    () => ({ ...applied, pageNo: page + 1, pageSize: limit }),
    [applied, page, limit],
  );

  /* The shared usePostFetch re-keys on url + serialized body, so it re-fetches
   * the grid only when applied filters / page change. */
  const grid = usePostFetch<GridResponse>(
    canView ? `${API_BASE}/grid` : null,
    gridBody,
    { enabled: canView },
  );

  const rows = grid.data?.paginatedData.data ?? [];
  const totalRecords = grid.data?.paginatedData.totalRecords ?? 0;
  const escalatedCount = grid.data?.escalatedCount ?? 0;
  const unconfirmedCount = grid.data?.unconfirmedCount ?? 0;
  const accessDenied = canView === false || grid.status === 403;
  const isEmpty = !grid.loading && !grid.error && rows.length === 0;

  /* ── Footer totals (client-side, CURRENT PAGE only — legacy parity) ──── */
  const totals = useMemo(() => {
    const acc = {
      todayCount: 0,
      yesterdayCount: 0,
      days2To7Count: 0,
      greaterThan7Count: 0,
      totalCount: 0,
    };
    for (const r of rows) {
      acc.todayCount += r.todayCount || 0;
      acc.yesterdayCount += r.yesterdayCount || 0;
      acc.days2To7Count += r.days2To7Count || 0;
      acc.greaterThan7Count += r.greaterThan7Count || 0;
      acc.totalCount += r.totalCount || 0;
    }
    return acc;
  }, [rows]);

  /* ── Drill-down dialog state ───────────────────────────────────────── */
  const [drill, setDrill] = useState<{ cityId: number; cityName: string } | null>(null);
  const drillBody = useMemo(
    () => (drill ? { ...applied, cityId: [drill.cityId] } : {}),
    [drill, applied],
  );
  const drillData = usePostFetch<CityJob[]>(
    drill ? `${API_BASE}/city-jobs` : null,
    drillBody,
    { enabled: !!drill },
  );
  /* Read-only drill-down modal — no form state to guard, so isDirty:false
   * makes every close (Esc / X / overlay-click) close immediately. */
  const closeDrill = useCallback(() => setDrill(null), []);
  const onDrillOpenChange = useFormDirtyGuard(closeDrill, { isDirty: false });

  /* ── Downloads ─────────────────────────────────────────────────────── */
  const [downloading, setDownloading] = useState(false);
  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadXlsxPost(
        `${API_BASE}/export`,
        { ...applied, format: 'xlsx' },
        'priority-jobs.xlsx',
      );
    } catch {
      /* keep silent on the page chrome; busy state simply clears */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  /* Apply / reset helpers — also reset pagination to page 0. */
  const applyFilters = useCallback(() => {
    setApplied(draft);
    setPage(0);
  }, [draft]);
  const resetFilters = useCallback(() => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(0);
  }, []);

  return (
    <ReportPageScaffold
      title="Priority Jobs"
      subtitle="City-Wise Aging Of Open, Owned Jobs — drill into a city's jobs from the Total cell."
      icon={Flame}
      loading={grid.loading}
      error={grid.status === 403 ? null : grid.error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Category Name">
              <SearchMultiSelect
                value={draft.serviceCategoryId}
                onChange={(v) => setDraft((d) => ({ ...d, serviceCategoryId: toNums(v) }))}
                options={svcCatOpts}
                placeholder="All Categories"
                selectedLabel="categories"
                disabled={grid.loading}
              />
            </Field>
            <Field label="State Name">
              <SearchMultiSelect
                value={draft.stateId}
                onChange={(v) => setDraft((d) => ({ ...d, stateId: toNums(v) }))}
                options={stateOpts}
                placeholder="All States"
                selectedLabel="states"
                disabled={grid.loading}
              />
            </Field>
            <Field label="City">
              <SearchMultiSelect
                value={draft.cityId}
                onChange={(v) => setDraft((d) => ({ ...d, cityId: toNums(v) }))}
                options={cityOpts}
                placeholder="All Cities"
                selectedLabel="cities"
                disabled={grid.loading}
              />
            </Field>
            <Field label="Job Owner">
              <SearchMultiSelect
                value={draft.ownerId}
                onChange={(v) => setDraft((d) => ({ ...d, ownerId: toNums(v) }))}
                options={ownerOpts}
                placeholder="All Job Owners"
                selectedLabel="owners"
                disabled={grid.loading}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={applyFilters} disabled={grid.loading}>
              Filter
            </Button>
            <Button variant="outline" onClick={resetFilters} disabled={grid.loading}>
              Reset
            </Button>
          </div>
        </div>
      }
    >
      {/* ── KPI chips ── */}
      <div className="flex flex-wrap gap-3">
        <KpiChip label="Open Escalation" value={escalatedCount} tone="orange" />
        <KpiChip label="Unconfirmed Orders" value={unconfirmedCount} tone="slate" />
      </div>

      {/* ── Grid ── */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left">City</th>
              <th className="!text-left">State</th>
              <th className="!text-center">Today</th>
              <th className="!text-center">Yesterday</th>
              <th className="!text-center">2 To 7</th>
              <th className="!text-center">&gt; 7</th>
              <th className="!text-center">Total Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cityId}>
                <td className="!text-left font-medium">{r.cityName}</td>
                <td className="!text-left">{r.stateName}</td>
                <td className="!text-center">{r.todayCount}</td>
                <td className="!text-center">{r.yesterdayCount}</td>
                <td className="!text-center">{r.days2To7Count}</td>
                <td className="!text-center text-red-600">{r.greaterThan7Count}</td>
                <td className="!text-center">
                  {r.totalCount > 0 ? (
                    <button
                      type="button"
                      className="font-semibold text-primary underline-offset-2 hover:underline"
                      onClick={() => setDrill({ cityId: r.cityId, cityName: r.cityName })}
                    >
                      {r.totalCount}
                    </button>
                  ) : (
                    r.totalCount
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/60 font-semibold">
              <td className="!text-left">Total</td>
              <td className="!text-left" />
              <td className="!text-center">{totals.todayCount}</td>
              <td className="!text-center">{totals.yesterdayCount}</td>
              <td className="!text-center">{totals.days2To7Count}</td>
              <td className="!text-center text-red-600">{totals.greaterThan7Count}</td>
              <td className="!text-center">{totals.totalCount}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Pagination (per-city-row, server-side) ── */}
      <TablePagination
        page={page}
        pageSize={pageSize}
        total={totalRecords}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(0);
        }}
      />

      {/* ── Drill-down dialog ── */}
      <Dialog open={!!drill} onOpenChange={onDrillOpenChange}>
        <DialogContent className="max-w-5xl">
          <DialogHeader className="bg-sidebar text-sidebar-foreground">
            <DialogTitle className="flex items-center justify-between gap-3">
              <span>
                {drill?.cityName} — {drillData.data?.length ?? 0} Jobs
              </span>
            </DialogTitle>
          </DialogHeader>

          {drillData.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> Loading…
            </div>
          ) : drillData.error ? (
            <div className="p-8 text-center text-sm text-red-600">{drillData.error}</div>
          ) : (drillData.data?.length ?? 0) === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No Jobs Found</div>
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="!text-left">Job ID</th>
                    <th className="!text-left">EasyFixer ID - Name</th>
                    <th className="!text-left">Client Name</th>
                    <th className="!text-left">Message</th>
                    <th className="!text-center">Job Age</th>
                    <th className="!text-left">Job Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {drillData.data!.map((j) => (
                    <tr key={j.jobId}>
                      <td className="!text-left">
                        <a
                          href={`/jobs?jobId=${j.jobId}&action=view`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          {j.jobId}
                          <ExternalLink className="size-3 opacity-60" />
                        </a>
                      </td>
                      <td className="!text-left">
                        {(j.easyFixterId ?? 'N/A')} - {j.easyFixerName || '-'}
                      </td>
                      <td className="!text-left">{j.clientName}</td>
                      <td className="!text-left">{j.statusMessage}</td>
                      <td className="!text-center">{j.jobAge}</td>
                      <td className="!text-left">{j.jobCurrentOwner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ReportPageScaffold>
  );
}

/* Small labelled wrapper so every filter shares the same Title-Case label
 * treatment without repeating markup. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

/* KPI chip — non-interactive count badge above the grid. */
function KpiChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'orange' | 'slate';
}) {
  const toneClass =
    tone === 'orange'
      ? 'border-orange-200 bg-orange-50 text-orange-700'
      : 'border-border bg-muted text-foreground';
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium ${toneClass}`}
    >
      {label}
      <span className="rounded bg-background/70 px-1.5 py-0.5 text-xs font-semibold">
        {value}
      </span>
    </span>
  );
}

/* Coerce the filter widget's (string|number)[] into a clean number[]. */
function toNums(v: QuickSightFilterValue): number[] {
  return v
    .map((x) => (typeof x === 'number' ? x : Number(x)))
    .filter((n) => Number.isFinite(n));
}
