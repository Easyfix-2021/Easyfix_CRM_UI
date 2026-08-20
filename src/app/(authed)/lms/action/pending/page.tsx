'use client';

/*
 * B-02 · Pending drilldown.
 *
 * Opened from any row or counter on B-01. One row per (technician, module)
 * that is still outstanding, with the chase actions attached to the row so
 * the person reading the list is the person who can act on it.
 *
 * THE SERVER OWNS EVERY NUMBER.
 *
 * The chips across the top render `data.chips` verbatim. There is deliberately
 * no client-side counting anywhere in this file: the endpoint computes each
 * chip from the SAME SQL predicate it filters by (see CHIP_PREDICATES in
 * services/lms-action.service.js), so a chip and the rows behind it cannot
 * disagree. Recounting the current page here would produce a number that
 * changes as the operator pages through — which is exactly the "counter says
 * 12, list shows 9" failure this whole tool exists to avoid.
 *
 * THE CHIPS ARE NOT A PARTITION, and the hint under them says so out loud.
 * "Overdue" is a statement about a DEADLINE; "Not Started" / "Part Done" /
 * "Done" are statements about PROGRESS. An overdue technician is very often
 * also a not-started one, so the five counts do not sum to the population and
 * five numbers in a row must not invite anyone to add them up.
 *
 * ONE URLSearchParams DEFINES THE SET.
 *
 * `filterParams` is built once per render and is the only description of
 * "which rows". The table key is that object plus limit/offset; the export
 * link is that object unchanged. The two therefore cannot describe different
 * populations — the backend's export route carries the same rule in a comment
 * because /jobs' list and export drifted apart once already.
 *
 * WHY THERE IS NO SORTING.
 *
 * GET /admin/lms/action/pending has no `sortBy` parameter — it always orders
 * by deadline, soonest first, with undated rows last. Sorting the fifty rows
 * that happen to be on screen would silently reorder a SLICE of the result and
 * read as a sort of the whole list, so the headers are plain text and the
 * ordering is stated instead. Inventing a server parameter that does not exist
 * would 400 at the Joi layer.
 *
 * WHY THERE IS NO MOBILE COLUMN.
 *
 * `efr_no` is the technician's MOBILE NUMBER (mask-mobile.js masks it on the
 * way out of /admin/*), not an identifier — so a column of "9876••••••" would
 * look like data while being useless for the one thing a number is for. "EFX
 * ID" is `easyfixer_id`, which is also what the export sheet's EFX ID column
 * carries, so a row here and a row in the spreadsheet name the same thing.
 */

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ClipboardList, Lock, Search, Send, X } from 'lucide-react';

import {
  CHIP_LABEL,
  CHIP_ORDER,
  CHIP_TONE,
  dueLabel,
  type ChipKey,
  type DetectorKey,
  type PendingPage,
  type PendingRow,
} from '@/lib/lms-action';
import { ChaseButtons } from '@/components/lms/ChaseButtons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DownloadButton } from '@/components/ui/download-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useMe } from '@/lib/auth-context';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useDebouncedValue, useFetch, invalidateFetch } from '@/lib/hooks';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate } from '@/lib/utils';

/* The endpoint's own Joi ceilings, not invented ones.
 * `limit` maxes at 500 (pendingQuery), and every chase/hand-off body caps
 * `efrIds` at 500 items (chaseBody). Hard-coding a different number here would
 * mean the UI offering work the API refuses. */
const PENDING_LIMIT_CAP = 500;
const BULK_MAX = 500;

/*
 * 'All' is deliberately absent. TablePagination's "All" renders one
 * un-navigable page whose footer claims "Showing 1–<total> of <total>", and
 * this endpoint caps `limit` at 500 — so on any filter with more than 500 rows
 * that claim is false AND the operator has no way to reach the rest. A missing
 * option is better than one that lies about what is on screen.
 */
const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];
const DEFAULT_PAGE_SIZE: TablePageSize = 20;

/*
 * Which B-01 row opened this drilldown, in words.
 *
 * B-01 owns the authoritative copy for its own rows; this map exists only so
 * the deep-linked filter can name itself instead of showing a raw key. It is
 * typed `Record<DetectorKey, string>` on purpose — rename a detector in
 * lib/lms-action.ts and this file stops compiling rather than silently
 * rendering nothing.
 */
const DETECTOR_LABEL: Record<DetectorKey, string> = {
  deadline_passed: 'Deadline Passed',
  session_48h: 'Session Within 48 Hours',
  assessment_failed: 'Assessment Failed',
  paused_not_started: 'Paused And Not Started',
  client_uncertified: 'Client Certification Gap',
  stale_module: 'Stale Module',
};

/* Chip tones come from lib/lms-action's CHIP_TONE, whose five values are
 * exactly the semantic StatusChip tone names — so the filter chip and the
 * row's own status chip are the same colour for the same fact. */
const TONE_PLATE: Record<StatusChipTone, string> = {
  urgent: 'bg-urgent-tint text-urgent-strong',
  warning: 'bg-warning-tint text-warning-strong',
  info: 'bg-info-tint text-info-strong',
  success: 'bg-success-tint text-success-strong',
  gold: 'bg-gold-tint text-gold-strong',
  neutral: 'bg-neutral-tint text-neutral-strong',
  red: 'bg-urgent-tint text-urgent-strong',
  rose: 'bg-urgent-tint text-urgent-strong',
  amber: 'bg-warning-tint text-warning-strong',
  orange: 'bg-warning-tint text-warning-strong',
  sky: 'bg-info-tint text-info-strong',
  emerald: 'bg-success-tint text-success-strong',
  violet: 'bg-gold-tint text-gold-strong',
  slate: 'bg-neutral-tint text-neutral-strong',
};

type CourseRow = { id: number; name: string };
type CourseListResponse = { rows: CourseRow[]; total: number };

/* POST /admin/lms/action/handoff/preview */
type HandoffPreview = {
  batchPreview: { city_id: number | null; state_manager: string | null; count: number }[];
  total: number;
  unassignable: number;
  outOfScope: number;
};

type HandoffState = { preview: HandoffPreview; sending: boolean };

/*
 * A row's identity is the PAIR. One technician can owe two modules, and those
 * are two rows an operator may want to treat differently, so selection is
 * keyed on both. The chase endpoints take efrIds, so the ids are de-duplicated
 * at post time — see `selectedEfrIds`.
 */
function rowKey(r: Pick<PendingRow, 'easyfixer_id' | 'course_id'>): string {
  return `${r.easyfixer_id}:${r.course_id}`;
}

/* 'YYYY-MM-DD' out of a DATE or DATETIME string, read character-wise.
 * `new Date('2026-08-13')` parses as UTC midnight and shifts the calendar day
 * for anyone whose browser is not on IST, so the value never becomes a Date.
 * MySQL's zero-date reads as "no date" rather than surfacing as "0000". */
function toYmd(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* 'YYYY-MM-DD' → '13 Aug 2026', assembled from the string's own parts. */
function formatYmd(v: string | null | undefined): string | null {
  const ymd = toYmd(v);
  if (!ymd) return null;
  return `${ymd.slice(8, 10)} ${MONTH_ABBR[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
}

/* mysql2 can widen COUNT columns to BIGINT strings; "10" >= 100 would be a
 * lexicographic comparison in disguise. Coerce once at the edge. */
function toNum(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isChipKey(v: string | null | undefined): v is ChipKey {
  return !!v && (CHIP_ORDER as string[]).includes(v);
}

export default function LmsPendingDrilldownPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { me, loading: meLoading } = useMe();
  const can = actionFlags(me, ['isLmsAction', 'isLmsChaseHandoff']);
  const canView = can.isLmsAction;
  /* Requirement: the hand-off button is HIDDEN, not disabled, without the key.
   * The route enforces it too (requireHandoff → 403), so this is presentation,
   * not the control. */
  const canHandoff = can.isLmsChaseHandoff;

  /* ── URL state ────────────────────────────────────────────────────────
   *
   * Read ONCE, in lazy initialisers, so a B-01 deep link lands on exactly the
   * view it described. The write-back effect below keeps the URL current from
   * then on; it deliberately does not read `searchParams` as a dependency, so
   * the read and the write can never chase each other round a loop.
   */
  const [detector, setDetector] = React.useState<DetectorKey | ''>(() => {
    const v = searchParams.get('detector');
    return v && v in DETECTOR_LABEL ? (v as DetectorKey) : '';
  });
  /*
   * `clientId` travels with the `client_uncertified` deep link from B-01 and is
   * accepted by the endpoint's Joi schema — but pendingList() does not read it,
   * so the list it returns is NOT narrowed to that client. It is carried here
   * (URL + query string) so the link round-trips and the export describes the
   * same request, and the banner below states plainly that no narrowing
   * happened. Rendering a "filtered by client" pill would be a lie.
   */
  const [clientId, setClientId] = React.useState<string>(() => {
    const v = searchParams.get('clientId');
    return v && /^\d+$/.test(v) ? v : '';
  });
  const [courseId, setCourseId] = React.useState<string>(() => {
    const v = searchParams.get('courseId');
    return v && /^\d+$/.test(v) ? v : '';
  });
  const [status, setStatus] = React.useState<ChipKey | ''>(() => {
    const v = searchParams.get('status');
    return isChipKey(v) ? v : '';
  });
  const [search, setSearch] = React.useState<string>(() => searchParams.get('q') ?? '');
  const [page, setPage] = React.useState<number>(() => {
    const v = Number(searchParams.get('page'));
    /* 1-indexed in the URL because that is what the pagination footer shows an
     * operator; 0-indexed everywhere else because that is the API boundary. */
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) - 1 : 0;
  });
  const [pageSize, setPageSize] = React.useState<TablePageSize>(() => {
    const v = Number(searchParams.get('size'));
    return PAGE_SIZE_OPTIONS.some((o) => o.value === v) ? (v as TablePageSize) : DEFAULT_PAGE_SIZE;
  });

  const debouncedSearch = useDebouncedValue(search, 300);
  const q = debouncedSearch.trim();

  /* ── Selection ────────────────────────────────────────────────────────
   *
   * Whole ROWS, not ids: the hand-off preview names cities the server only
   * identifies by id, and the bulk chase needs to know whether every selected
   * row shares one module. Keeping the row means neither has to re-fetch what
   * is already on screen, and a selection that spans pages still knows what it
   * is made of.
   */
  const [selected, setSelected] = React.useState<Map<string, PendingRow>>(() => new Map());
  const [handoff, setHandoff] = React.useState<HandoffState | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  /* ── The set ──────────────────────────────────────────────────────────
   *
   * `filterParams` alone says which rows. `listParams` is that plus the window
   * onto them. The export is handed `filterParams`, so it can only ever be the
   * same set — a page's worth of it is not a different population, one is the
   * whole and one is a window.
   */
  const filterParams = new URLSearchParams();
  if (detector) filterParams.set('detector', detector);
  if (clientId) filterParams.set('clientId', clientId);
  if (courseId) filterParams.set('courseId', courseId);
  if (status) filterParams.set('status', status);
  if (q) filterParams.set('q', q);

  const limit = pageSizeToLimit(pageSize, PENDING_LIMIT_CAP);
  const offset = page * limit;

  const listParams = new URLSearchParams(filterParams);
  listParams.set('limit', String(limit));
  listParams.set('offset', String(offset));

  /*
   * Every input that changes the result set is inside the key, so useFetch
   * re-fires on its own — no orchestration effect, which is the point of the
   * shared-hooks rule. A null key while permissions are unknown keeps the
   * request from firing at all rather than firing and 403-ing.
   */
  const listFetch = useFetch<PendingPage>(
    canView ? `/admin/lms/action/pending?${listParams.toString()}` : null,
  );
  const data = listFetch.data;
  const rows: PendingRow[] = React.useMemo(() => data?.rows ?? [], [data]);
  const total = data?.total ?? 0;
  const today = data?.today ?? '';
  const chips = data?.chips ?? null;

  /* Course filter options. includeInactive=true on purpose: a retired module
   * still has outstanding assignments in this list, and hiding it from the
   * filter would make those rows unreachable. */
  const { data: coursesData } = useFetch<CourseListResponse>(
    canView ? '/admin/lms/courses?includeInactive=true&limit=1000' : null,
  );
  const courseOptions: SearchOption[] = React.useMemo(
    () => [
      { value: '', label: 'All Modules' },
      ...(coursesData?.rows ?? []).map((c) => ({ value: String(c.id), label: c.name })),
    ],
    [coursesData],
  );

  /* ── URL write-back ───────────────────────────────────────────────────
   *
   * So the view survives a remount after a modal action, and so a link to the
   * exact filtered page is shareable. Debounced through `q`, so typing does not
   * spam history. Deps deliberately EXCLUDE `searchParams`: the guard below
   * reads it, and depending on it would make this effect re-run on its own
   * write.
   */
  React.useEffect(() => {
    const p = new URLSearchParams();
    if (detector) p.set('detector', detector);
    if (clientId) p.set('clientId', clientId);
    if (courseId) p.set('courseId', courseId);
    if (status) p.set('status', status);
    if (q) p.set('q', q);
    if (page > 0) p.set('page', String(page + 1));
    if (pageSize !== DEFAULT_PAGE_SIZE) p.set('size', String(pageSize));
    const next = p.toString();
    if (next !== searchParams.toString()) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detector, clientId, courseId, status, q, page, pageSize]);

  /*
   * Narrowing the set invalidates the page number — page 5 of everything is
   * usually past the end of one chip's worth. Without this the offset asks for
   * rows the smaller set does not have and the table empties with no visible
   * cause.
   *
   * Every control that can be clicked also calls setPage(0) inline, so the very
   * next render already carries offset 0; this effect exists for the ONE input
   * that cannot do that — the debounced search box, whose value lands a beat
   * after the keystroke. The mount guard keeps a deep-linked `?page=3` from
   * being reset to 1 on arrival.
   */
  const filterMountRef = React.useRef(true);
  React.useEffect(() => {
    if (filterMountRef.current) { filterMountRef.current = false; return; }
    setPage(0);
  }, [q, courseId, status, detector, clientId]);

  /*
   * Drop the selection whenever the set is redefined — ticked rows that are no
   * longer in the population would still be chased. Paging is deliberately NOT
   * in here: a selection built across two pages is a deliberate act.
   */
  React.useEffect(() => {
    setSelected((s) => (s.size ? new Map() : s));
  }, [q, courseId, status, detector, clientId]);

  /* ── Selection helpers ────────────────────────────────────────────────*/

  const selectedRows = React.useMemo(() => Array.from(selected.values()), [selected]);
  /* The endpoints take technicians, not rows — two modules owed by one person
   * is one nudge. */
  const selectedEfrIds = React.useMemo(
    () => Array.from(new Set(selectedRows.map((r) => Number(r.easyfixer_id)))),
    [selectedRows],
  );
  /*
   * A chase is logged against ONE module. When every selected row is the same
   * module (which the Module filter guarantees) that is the honest value; a
   * mixed selection sends null rather than picking one row's module and
   * labelling the rest with it.
   */
  const selectedCourseId = React.useMemo(() => {
    const ids = new Set(selectedRows.map((r) => Number(r.course_id)));
    return ids.size === 1 ? Number(selectedRows[0].course_id) : null;
  }, [selectedRows]);

  const pageKeys = React.useMemo(() => rows.map(rowKey), [rows]);
  const allOnPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const someOnPageSelected = pageKeys.some((k) => selected.has(k));

  function toggleRow(row: PendingRow, checked: boolean) {
    setSelected((cur) => {
      const next = new Map(cur);
      const key = rowKey(row);
      if (!checked) { next.delete(key); return next; }
      /* Adding one at a time still respects the ceiling — see toggleAllOnPage. */
      if (next.size >= BULK_MAX && !next.has(key)) {
        showToast({ variant: 'warning', message: `A Chase Is Capped At ${BULK_MAX} Technicians.` });
        return cur;
      }
      next.set(key, row);
      return next;
    });
  }

  /*
   * Header checkbox — the CURRENT PAGE, and it says so on the label. "Select
   * All" across a 4,000-row filter would build a selection the endpoint refuses
   * (efrIds caps at 500) and that nobody can see the contents of.
   */
  function toggleAllOnPage(checked: boolean) {
    setSelected((cur) => {
      const next = new Map(cur);
      if (!checked) {
        for (const r of rows) next.delete(rowKey(r));
        return next;
      }
      let capped = false;
      for (const r of rows) {
        const key = rowKey(r);
        if (next.has(key)) continue;
        if (next.size >= BULK_MAX) { capped = true; break; }
        next.set(key, r);
      }
      if (capped) {
        showToast({
          variant: 'warning',
          message: `Selection Stopped At ${BULK_MAX} — That Is The Chase Limit Per Batch.`,
        });
      }
      return next;
    });
  }

  const clearSelection = React.useCallback(() => setSelected(new Map()), []);

  /*
   * After any chase or hand-off: evict the cached list AND refetch the one on
   * screen. Neither half is redundant — eviction fixes the next mount, the
   * refetch fixes the mount that is already here (a page open all morning would
   * otherwise keep serving the response it got at 9am).
   */
  const afterMutation = React.useCallback(() => {
    invalidateFetch((k) => k.startsWith('/admin/lms/action'));
    listFetch.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFetch.refetch]);

  /* ── Send to state managers ───────────────────────────────────────────
   *
   * Two steps, because the split is the thing being approved. Step one asks the
   * server who each technician would land with; step two commits it. The
   * preview names the technicians nobody owns rather than dropping them — a
   * person who silently belongs to no one is worse than one the training team
   * knowingly keeps.
   */
  async function openHandoffPreview() {
    if (!selectedEfrIds.length) return;
    setPreviewing(true);
    try {
      const preview = await api.post<HandoffPreview>('/admin/lms/action/handoff/preview', {
        efrIds: selectedEfrIds,
        courseId: selectedCourseId,
        detectorKey: detector || undefined,
      });
      setHandoff({ preview, sending: false });
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not build the split' }) });
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmHandoff() {
    setHandoff((h) => (h ? { ...h, sending: true } : h));
    try {
      const out = await api.post<{ batchId: string; handedOff: number; outOfScope: number }>(
        '/admin/lms/action/handoff',
        {
          efrIds: selectedEfrIds,
          courseId: selectedCourseId,
          detectorKey: detector || undefined,
          confirm: true,
        },
      );
      const extra = out.outOfScope ? ` · ${out.outOfScope} outside your scope` : '';
      showToast({
        variant: 'success',
        message: `${out.handedOff} sent to state managers${extra}`,
      });
      setHandoff(null);
      clearSelection();
      afterMutation();
    } catch (e) {
      setHandoff((h) => (h ? { ...h, sending: false } : h));
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Hand-off failed' }) });
    }
  }

  /* No-op while the POST is in flight — the dialog must not vanish out from
   * under a hand-off that is still being written. */
  const closeHandoff = React.useCallback(() => {
    setHandoff((h) => (h && h.sending ? h : null));
  }, []);
  /*
   * Routed through the shared guard rather than an inline arrow (the ESLint
   * rule is about every close path going through one place). `isDirty: false`
   * because nothing is typed into this dialog — it previews a decision, so
   * dismissing it discards nothing and must not prompt.
   */
  const guardedHandoffOpenChange = useFormDirtyGuard(closeHandoff, { isDirty: false });

  /* City names are not in the preview — the server groups by `city_id`. The
   * rows on screen already carry the name, so the map is built from what was
   * selected rather than fetched again. */
  const cityNameById = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const r of selectedRows) {
      if (r.efr_cityId != null && r.city_name) m.set(Number(r.efr_cityId), r.city_name);
    }
    return m;
  }, [selectedRows]);

  /* ── Export ───────────────────────────────────────────────────────────
   *
   * Handed `filterParams` — the same object the table's key is built from — so
   * the sheet cannot describe a different set from the screen. It is NOT
   * limited to the current page or the selection, which is why it sits with the
   * filters rather than among the bulk actions, and the tooltip says so.
   */
  async function exportXlsx() {
    setExporting(true);
    try {
      const qs = filterParams.toString();
      await downloadXlsx({
        url: `/admin/lms/action/pending/export.xlsx${qs ? `?${qs}` : ''}`,
        filename: `lms-pending_${today || 'export'}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Export failed' }) });
    } finally {
      setExporting(false);
    }
  }

  /* ── Render ───────────────────────────────────────────────────────────*/

  if (!meLoading && !canView) {
    return (
      <div className="space-y-4">
        <PageHeading />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
              <Lock className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don&rsquo;t have permission to view the training action tool. Ask an admin to
                grant you <code className="mx-0.5">isLmsAction</code> in Settings &rarr; Manage
                Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selectionCount = selected.size;
  const technicianCount = selectedEfrIds.length;
  /*
   * The list key is null until `me` lands (permissions fail closed while
   * loading), so useFetch reports `loading: false` with no rows for that first
   * beat. Folding `meLoading` in keeps the table from asserting "nothing
   * outstanding" about a query it has not run yet.
   */
  const listLoading = meLoading || listFetch.loading;

  return (
    <div className="space-y-4">
      <PageHeading />

      {/* The deep link's own context, and the one place it does not do what it
          looks like it does. */}
      {(detector || clientId) && (
        <div className="flex flex-wrap items-center gap-2">
          {detector && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-info-tint px-2.5 py-1 text-xs font-medium text-info-strong">
              Opened From: {DETECTOR_LABEL[detector]}
              <button
                type="button"
                aria-label="Clear The Detector Filter"
                title="Show Everything Outstanding"
                onClick={() => { setDetector(''); setPage(0); }}
                className="rounded-full p-0.5 hover:bg-info/20"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {clientId && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-tint px-2.5 py-1 text-xs font-medium text-warning-strong">
              <AlertTriangle className="size-3" />
              Client {clientId} Was Requested, But This List Is Not Narrowed To It
              <button
                type="button"
                aria-label="Drop The Client Parameter"
                title="Drop The Client Parameter From This View"
                onClick={() => { setClientId(''); setPage(0); }}
                className="rounded-full p-0.5 hover:bg-warning/20"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
        </div>
      )}

      {/* Filters. Both are server-side query params; the export uses the same
          two, so the sheet and the screen agree by construction. */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="min-w-[240px] flex-1">
            <Label className="mb-1 block">Search</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search By Technician Name Or Mobile…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <div className="w-64">
            <Label className="mb-1 block">Module</Label>
            {/* `required` suppresses the inline clear "×" — "All Modules" is
                already the reachable no-filter option. */}
            <SearchSelect
              value={courseId}
              onChange={(v) => { setCourseId(v); setPage(0); }}
              options={courseOptions}
              required
              placeholder="All Modules"
            />
          </div>
          <DownloadButton
            onClick={exportXlsx}
            downloading={exporting}
            disabled={total === 0}
            label="Export"
            title={
              total === 0
                ? 'Nothing To Export For The Current Filters'
                : 'Exports Every Row Matching The Current Filters — Not Just This Page Or The Selection.'
            }
          />
        </CardContent>
      </Card>

      {/* ── Filter chips ────────────────────────────────────────────────
          Counts are `data.chips`, rendered exactly as the server sent them. */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <ChipButton
            label="All Outstanding"
            count={null}
            plate="bg-neutral-tint text-neutral-strong"
            active={status === ''}
            onClick={() => { setStatus(''); setPage(0); }}
          />
          {CHIP_ORDER.map((key) => (
            <ChipButton
              key={key}
              label={CHIP_LABEL[key]}
              count={chips ? chips[key] : null}
              plate={TONE_PLATE[CHIP_TONE[key]]}
              active={status === key}
              /* Clicking the active chip clears it — the same control that
                 narrowed the list is the one that widens it again. */
              onClick={() => { setStatus(status === key ? '' : key); setPage(0); }}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          These Are Not Five Slices Of One Pie — Overdue Describes A Deadline While Not Started,
          Part Done And Done Describe Progress, So An Overdue Technician Is Usually Counted Twice.
          Rows Are Ordered By Deadline, Soonest First; The Endpoint Offers No Other Ordering.
        </p>
      </div>

      {listFetch.error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-3 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/* Select */}
              <col style={{ width: '36px' }} />
              {/* Technician */}
              <col style={{ width: '16%' }} />
              {/* EFX ID */}
              <col style={{ width: '8%' }} />
              {/* Grade */}
              <col style={{ width: '7%' }} />
              {/* City */}
              <col style={{ width: '11%' }} />
              {/* Module */}
              <col style={{ width: '15%' }} />
              {/* Progress */}
              <col style={{ width: '9%' }} />
              {/* Status */}
              <col style={{ width: '9%' }} />
              {/* Due */}
              <col style={{ width: '11%' }} />
              {/* Last Chased */}
              <col style={{ width: '11%' }} />
              {/* Chase */}
              <col style={{ width: '13%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-center">
                  <Checkbox
                    checked={allOnPageSelected}
                    indeterminate={someOnPageSelected}
                    onChange={toggleAllOnPage}
                    label="Select Every Row On This Page"
                    title="Selects This Page Only"
                  />
                </th>
                <th className="!text-left">Technician</th>
                <th className="!text-center">EFX ID</th>
                <th className="!text-center">Grade</th>
                <th className="!text-left">City</th>
                <th className="!text-left">Module</th>
                <th className="!text-center">Progress</th>
                <th className="!text-center">Status</th>
                <th className="!text-left">Due</th>
                <th className="!text-left">Last Chased</th>
                <th className="!text-left">Chase</th>
              </tr>
            </thead>
            <tbody>
              {listLoading && (
                <tr>
                  <td colSpan={11} className="!text-center py-6 text-muted-foreground">Loading…</td>
                </tr>
              )}
              {!listLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="!text-center py-6 text-muted-foreground">
                    Nothing outstanding for this filter.
                  </td>
                </tr>
              )}
              {!listLoading && rows.map((r) => {
                const key = rowKey(r);
                const chip = isChipKey(r.status) ? r.status : null;
                const done = toNum(r.videos_done);
                const totalVideos = toNum(r.videos_total);
                const dueYmd = formatYmd(r.due_date);
                return (
                  <tr key={key}>
                    <td className="!text-center">
                      <Checkbox
                        checked={selected.has(key)}
                        onChange={(next) => toggleRow(r, next)}
                        label={`Select ${r.technician_name ?? `technician ${r.easyfixer_id}`}`}
                      />
                    </td>
                    <td className="!text-left truncate font-medium" title={r.technician_name ?? ''}>
                      {r.technician_name || <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* The numeric easyfixer id — the same value the export
                        sheet's EFX ID column carries. */}
                    <td className="!text-center tabular-nums">{r.easyfixer_id}</td>
                    <td className="!text-center">
                      {r.grade
                        ? <StatusChip tone="gold" size="sm">{r.grade}</StatusChip>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-left truncate" title={r.city_name ?? ''}>
                      {r.city_name || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-left truncate" title={r.course_name ?? ''}>
                      {r.course_name || <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* Videos watched over videos in the module. A module with
                        no content reads 0/0 rather than a percentage that would
                        blame the technician for an empty course. */}
                    <td className="!text-center whitespace-nowrap tabular-nums">
                      {done} / {totalVideos}
                    </td>
                    <td className="!text-center">
                      {chip
                        ? <StatusChip tone={CHIP_TONE[chip]} size="sm">{CHIP_LABEL[chip]}</StatusChip>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* `dueLabel` is the shared display helper — the SERVER
                        decides what is overdue, and this only says how far past
                        a date the row already is. Rendered verbatim. */}
                    <td className="!text-left whitespace-nowrap text-xs">
                      <div>{today ? dueLabel(r.due_date, today) : '—'}</div>
                      {dueYmd && <div className="text-muted-foreground">{dueYmd}</div>}
                    </td>
                    {/* "Never Chased" rather than an em-dash: a blank cell reads
                        as missing data, and whether anyone has contacted this
                        technician is the one fact this column exists to state. */}
                    <td className="!text-left whitespace-nowrap text-xs">
                      {r.last_chased_at ? (
                        <>
                          <div>{formatDate(r.last_chased_at)}</div>
                          {r.chase_count_7d > 0 && (
                            <div className="text-muted-foreground">
                              {r.chase_count_7d} In The Last 7 Days
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">Never Chased</span>
                      )}
                    </td>
                    <td className="!text-left">
                      <ChaseButtons
                        compact
                        target={{
                          efrIds: [Number(r.easyfixer_id)],
                          courseId: Number(r.course_id),
                          detectorKey: detector || undefined,
                        }}
                        onDone={afterMutation}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
      />

      {/* ── Bulk actions ────────────────────────────────────────────────
          Only rendered with a selection: an always-present bar of disabled
          buttons teaches nothing about what they would do. */}
      {selectionCount > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-3">
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{selectionCount}</span>
              {selectionCount === 1 ? ' row' : ' rows'} selected
              {/* Stated whenever the two differ — a nudge goes to a PERSON, so
                  "12 rows" that are really 9 people would over-report the
                  chase. */}
              {technicianCount !== selectionCount && (
                <span className="text-muted-foreground">
                  {' '}· {technicianCount} {technicianCount === 1 ? 'technician' : 'technicians'}
                </span>
              )}
              {selectionCount >= BULK_MAX && (
                <span className="text-warning-strong"> · At The {BULK_MAX} Per-Batch Limit</span>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={clearSelection}>Clear Selection</Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <ChaseButtons
                target={{
                  efrIds: selectedEfrIds,
                  courseId: selectedCourseId,
                  detectorKey: detector || undefined,
                }}
                onDone={afterMutation}
              />
              {/* Hidden without isLmsChaseHandoff — the route 403s a hand-crafted
                  POST regardless, so this is presentation, not the control. */}
              {canHandoff && (
                <Button
                  variant="default"
                  disabled={previewing || !technicianCount}
                  onClick={openHandoffPreview}
                  title="Push These Technicians To Their State Manager's Own Screen, Split By City"
                >
                  <Send className="size-4" />
                  <span className="ml-1.5">
                    {previewing ? 'Building The Split…' : 'Send To State Managers'}
                  </span>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {handoff && (
        <Dialog open onOpenChange={guardedHandoffOpenChange}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Send To State Managers</DialogTitle>
            </DialogHeader>

            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This moves the chase from the training team to the field. Each technician lands on
                the state manager&rsquo;s own screen for the city they belong to, and every hand-off
                is logged.
              </p>

              <div className="rounded-md border">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th className="!text-left">City</th>
                      <th className="!text-left">State Manager</th>
                      <th className="!text-center">Technicians</th>
                    </tr>
                  </thead>
                  <tbody>
                    {handoff.preview.batchPreview.length === 0 && (
                      <tr>
                        <td colSpan={3} className="!text-center py-4 text-muted-foreground">
                          Nothing in scope to send.
                        </td>
                      </tr>
                    )}
                    {handoff.preview.batchPreview.map((c) => (
                      <tr key={String(c.city_id)}>
                        <td className="!text-left">
                          {(c.city_id != null && cityNameById.get(Number(c.city_id)))
                            || <span className="text-muted-foreground">No City On Record</span>}
                        </td>
                        <td className="!text-left">
                          {c.state_manager || (
                            <span className="text-warning-strong">No State Manager</span>
                          )}
                        </td>
                        <td className="!text-center tabular-nums">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-1 text-sm">
                <div>
                  <span className="font-semibold tabular-nums">{handoff.preview.total}</span>
                  {handoff.preview.total === 1 ? ' technician' : ' technicians'} across{' '}
                  <span className="tabular-nums">{handoff.preview.batchPreview.length}</span>
                  {handoff.preview.batchPreview.length === 1 ? ' city' : ' cities'}.
                </div>
                {/* Named, never dropped. A technician who silently belongs to
                    nobody is worse than one the training team knowingly keeps. */}
                {handoff.preview.unassignable > 0 ? (
                  <div className="rounded-md bg-warning-tint px-2 py-1.5 text-warning-strong">
                    {handoff.preview.unassignable}{' '}
                    {handoff.preview.unassignable === 1 ? 'technician has' : 'technicians have'} no
                    state manager — they stay with the training team.
                  </div>
                ) : (
                  <div className="text-muted-foreground">
                    Every technician in this batch has a state manager.
                  </div>
                )}
                {handoff.preview.outOfScope > 0 && (
                  <div className="text-muted-foreground">
                    {handoff.preview.outOfScope} selected{' '}
                    {handoff.preview.outOfScope === 1 ? 'technician is' : 'technicians are'} outside
                    your geography and will not be sent.
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={closeHandoff} disabled={handoff.sending}>
                Cancel
              </Button>
              <Button
                onClick={confirmHandoff}
                disabled={handoff.sending || handoff.preview.total === 0}
              >
                {handoff.sending ? 'Sending…' : 'Send To State Managers'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <ClipboardList className="size-6" /> Pending Training
      </h1>
      <p className="text-sm text-muted-foreground">
        Every outstanding module, with the chase attached to the row. Each chase is logged.
      </p>
    </div>
  );
}

/*
 * One filter chip. The count is passed in and printed — this component does no
 * arithmetic of its own, which is the whole reason the chips can be trusted.
 * `null` renders nothing rather than 0: "no count yet" and "none" are different
 * facts and must not look the same.
 */
function ChipButton({
  label,
  count,
  plate,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
  plate: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
        plate,
        active ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'hover:opacity-80',
      ].join(' ')}
    >
      <span>{label}</span>
      {count !== null && <span className="tabular-nums">{count.toLocaleString('en-IN')}</span>}
    </button>
  );
}
