'use client';

/*
 * Seed India Locations Modal — wraps the BE
 *   GET  /api/admin/india-locations/list
 *   POST /api/admin/india-locations/seed                 (multipart CSV upload)
 *   GET  /api/admin/india-locations/seed/jobs/current    (reattach on open)
 *   GET  /api/admin/india-locations/seed/jobs/:jobId     (poll for progress)
 *   POST /api/admin/india-locations/seed/jobs/:jobId/cancel
 *   GET  /api/admin/india-locations/download             (streamed XLSX)
 * behind a single Admin Actions affordance.
 *
 * Operator flow:
 *   1. Open modal           → reattach to a running job if any; otherwise
 *                             show table + file picker.
 *   2. Pick CSV             → file input (.csv). Filename rendered next to
 *                             the Start Seeding button.
 *   3. Start Seeding        → uploads the CSV as multipart; BE returns
 *                             a jobId immediately. Modal flips to a
 *                             "running" state with live counts via polling.
 *   4. Stop (optional)      → POSTs /cancel; BE flags the loop to abort
 *                             at the next batch boundary.
 *   5. Closing while running does NOT cancel — only Stop does. Reopening
 *                             reattaches via /seed/jobs/current.
 *
 * State machine:
 *   idle → picking_file → uploading → running → (completed | failed | cancelled)
 *   Modal-open reattach path: idle → running (skips picking_file/uploading)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Upload, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  TablePagination, type TablePageSize, pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

interface ListItem {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_id: number | null;
  city_name: string | null;
  state_id: number | null;
  state_name: string | null;
  country_id: number | null;
  country_name: string | null;
  pincode_status: number;
  created_date: string | null;
  remark: 'Existing' | 'Added' | 'Updated';
}

interface ListResponse {
  items: ListItem[];
  total: number;
  limit: number;
  offset: number;
  seededAt: string | null;
  viewBaselineAt?: string | null;
}

/*
 * Column-sort tokens (2026-06-10). The BE whitelist accepts these six
 * sortBy values; anything else falls back to pincode_id DESC.
 */
type SortByKey =
  | 'pincode'
  | 'location'
  | 'city_name'
  | 'state_name'
  | 'country_name'
  | 'remark'
  | 'pincode_id';
type SortOrder = 'ASC' | 'DESC';

interface SeedStats {
  rows_seen: number;
  rows_invalid: number;
  states_created: number;
  cities_created: number;
  pincodes_inserted: number;
  pincodes_updated?: number; // 2026-06-11 — fill-blank UPDATEs on existing rows
  pincodes_skipped_dupe: number;
}

type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface JobSnapshot {
  jobId: string | null;
  status?: JobStatus;
  stats?: SeedStats;
  started_at?: string;
  finished_at?: string | null;
  error?: string | null;
  skipped?: boolean;
  reason?: string | null;
  took_ms?: number | null;
}

interface StartSeedResponse {
  jobId: string;
  status: 'running';
}

// BE Joi cap matches — pageSizeToLimit('all') resolves to 500.
const MAX_LIMIT = 500;
const POLL_MS = 2000;

type Phase =
  | 'idle'
  | 'uploading'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export function SeedIndiaLocationsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  // Resolve 'all' through the shared helper so we never request more than
  // the BE Joi max — kept for future query-string use even though the
  // list endpoint currently takes pageSize directly.
  void pageSizeToLimit(pageSize, MAX_LIMIT);
  const effectivePageSize = pageSize === 'all' ? 50 : pageSize;

  /*
   * Fetch key (2026-06-11). REVERTED back to auto-fetching on modal
   * open — operators want to ALWAYS see the catalogue, with each row
   * tagged Existing/Added per the last seed run. The earlier
   * `showingList` gate (which hid the table until Refresh was clicked)
   * was confusing for operators who expected to land on the list
   * directly; the "No Seeding Run Yet" empty state appeared even when
   * the catalogue had thousands of rows that just weren't from a
   * tracked seed run. The `remark=Existing` filter is also dropped —
   * the FE shows BOTH remarks because both are meaningful (Existing =
   * pre-seed, Added = inserted by last seed). The "Last Seeding
   * Details" summary panel remains as supplementary context above the
   * table.
   */
  const [tick, setTick] = useState(0);
  /*
   * Per-column sort state (2026-06-10). Default mirrors the BE legacy
   * ordering — newest pincode_id first — so unsorted view matches the
   * previous behaviour byte-for-byte. Click a header to switch column;
   * click again to toggle ASC/DESC.
   */
  const [sortBy, setSortBy] = useState<SortByKey>('pincode_id');
  const [sortOrder, setSortOrder] = useState<SortOrder>('DESC');
  const listKey = open
    ? `/admin/india-locations/list?page=${page}&pageSize=${effectivePageSize}&sortBy=${sortBy}&sortOrder=${sortOrder}&t=${tick}`
    : null;
  const { data, loading, error, refetch } = useFetch<ListResponse>(listKey);

  /*
   * Header click handler — toggles ASC/DESC on the active column,
   * resets to ASC when picking a fresh column. Resets `page` so the
   * operator lands on the first page of the new ordering.
   */
  /*
   * 3-state sort cycle (2026-06-11). Clicks rotate through:
   *   inactive    → ASC
   *   ASC         → DESC
   *   DESC        → reset to default (pincode_id, DESC)
   * Operators can fully back out of a sort instead of being stuck
   * toggling ASC↔DESC. Active sort + arrow icon hide automatically
   * once the column drops back to its inactive state.
   */
  const onSortHeaderClick = useCallback((key: SortByKey) => {
    setPage(0);
    if (sortBy !== key) {
      setSortBy(key);
      setSortOrder('ASC');
      return;
    }
    if (sortOrder === 'ASC') {
      setSortOrder('DESC');
      return;
    }
    // currently DESC on active column → revert to default ordering
    setSortBy('pincode_id');
    setSortOrder('DESC');
  }, [sortBy, sortOrder]);

  // ─── Seed state machine ────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('idle');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobSnap, setJobSnap] = useState<JobSnapshot | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /*
   * Source URL (2026-06-10). Fetched once when the modal opens so the
   * operator can see WHICH open-data CSV the BE will hit before they
   * click Start Seeding. Useful for ops sanity-checks and for the
   * audit trail when documenting which dataset version landed.
   */
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Modal-open-gated
    // informational fetch (best-effort, no error surfaced). useFetchOnce
    // doesn't support an `enabled` flag tied to a parent prop like `open`
    // without mounting/unmounting the host component; this lightweight
    // effect is simpler than the alternative.
    // eslint-disable-next-line no-restricted-syntax
    api.get<{ url: string }>('/admin/india-locations/seed/source-url')
      .then((r) => { if (!cancelled) setSourceUrl(r.url); })
      .catch(() => { /* silent — source-url is informational only */ });
    return () => { cancelled = true; };
  }, [open]);

  /*
   * Last-completed snapshot (2026-06-10). Fetched on modal open so the
   * operator sees a summary card with stats from the most recent good
   * seed run — without us having to load the full pincode list. The BE
   * returns null if no completed run has happened yet.
   *
   * The `tick` dependency ensures we re-fetch this when a new seed
   * completes (the polling loop bumps `tick`), so the panel reflects
   * the freshest run.
   */
  const [lastCompleted, setLastCompleted] = useState<JobSnapshot | null>(null);
  const [lastCompletedLoading, setLastCompletedLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLastCompletedLoading(true);
    // Re-fetched on every
    // seed completion (the `tick` dep changes from the polling loop),
    // gated on `open`. The "last-completed snapshot" is mutable state
    // that re-keys on completion; useFetch would work with a tick-laced
    // URL but adds noise without removing the cancelled-flag bookkeeping.
    // eslint-disable-next-line no-restricted-syntax
    api.get<JobSnapshot | null>('/admin/india-locations/seed/last-completed')
      .then((r) => { if (!cancelled) setLastCompleted(r || null); })
      .catch(() => { if (!cancelled) setLastCompleted(null); })
      .finally(() => { if (!cancelled) setLastCompletedLoading(false); });
    return () => { cancelled = true; };
  }, [open, tick]);

  // ─── On open: reattach to any in-flight job ─────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        // "Reattach to
        // in-flight job" on modal open: drives the phase machine
        // (setPhase('running')) only when an active job exists. The
        // hook abstraction would have us route a server response through
        // an effect anyway to update phase state — same shape, more code.
        // eslint-disable-next-line no-restricted-syntax
        const snap = await api.get<JobSnapshot>('/admin/india-locations/seed/jobs/current');
        if (cancelled) return;
        if (snap?.jobId && snap.status === 'running') {
          setJobId(snap.jobId);
          setJobSnap(snap);
          setPhase('running');
        }
      } catch {
        // Endpoint failure is non-fatal — operator can still start a fresh seed.
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // ─── Polling while running ──────────────────────────────────────
  useEffect(() => {
    if (phase !== 'running' || !jobId) return;
    let cancelled = false;
    const tickPoll = async () => {
      try {
        // Polling loop.
        // Fires every interval inside a setInterval/setTimeout chain; this
        // is exactly the "fetch from inside useEffect for orchestration"
        // pattern that has nothing to do with the Strict-Mode double-fire
        // hazard. The phase state machine owns the cancel flag.
        // eslint-disable-next-line no-restricted-syntax
        const snap = await api.get<JobSnapshot>(`/admin/india-locations/seed/jobs/${jobId}`);
        if (cancelled) return;
        setJobSnap(snap);
        if (snap.status && snap.status !== 'running') {
          // Map terminal status into the phase machine and refresh the list.
          const nextPhase: Phase =
            snap.status === 'completed' ? 'completed'
              : snap.status === 'cancelled' ? 'cancelled'
                : 'failed';
          setPhase(nextPhase);
          setCancelling(false);
          setPage(0);
          setTick((t) => t + 1);
          // After a real seed completes, auto-flip showingList so the
          // (Removed the auto-flip-to-list step from the prior revision;
          //  the list is now always visible, so there's nothing to flip.)
          if (nextPhase === 'completed') {
            if (snap.skipped) {
              showToast({ variant: 'success', message: snap.reason || 'Already seeded' });
            } else {
              const ins = (snap.stats?.pincodes_inserted ?? 0).toLocaleString('en-IN');
              showToast({
                variant: 'success',
                message: `Seed complete — ${ins} pincodes inserted in ${((snap.took_ms || 0) / 1000).toFixed(1)}s`,
              });
            }
          } else if (nextPhase === 'cancelled') {
            showToast({ variant: 'success', message: 'Seed cancelled' });
          } else {
            showToast({ variant: 'error', message: snap.error || 'Seed failed' });
          }
        }
      } catch {
        // transient — keep polling.
      }
    };
    // Fire one immediately for the just-attached case, then on interval.
    void tickPoll();
    const id = setInterval(tickPoll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [phase, jobId]);

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setCsvFile(f);
  }, []);

  const clearPickedFile = useCallback(() => {
    setCsvFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  /*
   * startSeeding (2026-06-10 v2). No CSV file required — BE auto-fetches
   * the canonical India pincode CSV from a public URL (env or default).
   * Simple JSON POST with `force: true`; the BE returns a jobId we then
   * poll for progress.
   */
  async function startSeeding() {
    setPhase('uploading');
    setJobSnap(null);
    try {
      const resp = await api.post<StartSeedResponse>(
        '/admin/india-locations/seed',
        { force: true },
      );
      setJobId(resp.jobId);
      setPhase('running');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Seed failed to start';
      setPhase('failed');
      setJobSnap({ jobId: null, status: 'failed', error: msg });
      showToast({ variant: 'error', message: msg });
    }
  }

  async function stopSeeding() {
    if (!jobId) return;
    setCancelling(true);
    try {
      await api.post<JobSnapshot>(`/admin/india-locations/seed/jobs/${jobId}/cancel`);
      // Polling will surface the terminal 'cancelled' status soon.
    } catch (e) {
      setCancelling(false);
      showToast({
        variant: 'error',
        message: e instanceof Error ? e.message : 'Cancel failed',
      });
    }
  }

  async function downloadCurrent() {
    setDownloading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await downloadXlsx({
        url: '/admin/india-locations/download',
        filename: `india-locations-${today}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  }

  function dismissBanner() {
    setPhase('idle');
    setJobSnap(null);
    setJobId(null);
    clearPickedFile();
  }

  // ─── Close-guard ────────────────────────────────────────────────
  // Running jobs survive a modal close (the BE keeps going) — operator
  // reattaches on reopen. Only the file-picking phase counts as "dirty":
  // they've picked a file but not yet started.
  const guardedOpenChange = useFormDirtyGuard(
    () => {
      // Reset transient state ONLY when there's no running job.
      // A running job needs to stay reattachable, so leave jobId set.
      if (phase !== 'running') {
        setPhase('idle');
        setJobSnap(null);
        setJobId(null);
        clearPickedFile();
        setPage(0);
      }
      onClose();
    },
    {
      isDirty: phase === 'idle' && csvFile != null,
      when: () => phase !== 'uploading', // never close mid-upload
      title: 'Discard Selected CSV?',
      description: 'The Picked File Will Be Cleared. The Seed Has Not Started Yet.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep Editing',
    },
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  // `seededAt` drives the "Re-Run Seeding" vs "Start Seeding" label +
  // the "Already Seeded At" banner. Falls back to the last-completed
  // snapshot's finished_at when the list hasn't been fetched yet
  // (the modal no longer auto-loads the list on open).
  const seededAt = data?.seededAt ?? lastCompleted?.finished_at ?? null;
  const liveStats = jobSnap?.stats;

  const isRunning = phase === 'running';
  const isUploading = phase === 'uploading';
  const isTerminal = phase === 'completed' || phase === 'failed' || phase === 'cancelled';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/*
        * Modal scrollability fix (2026-06-11 v5). Earlier attempts used
        * Tailwind `!important` class overrides, but in this project's
        * Tailwind/shadcn class-merge pipeline they didn't consistently
        * win against shadcn's defaults at every zoom level. Switching
        * to INLINE STYLE — which beats any class-based rule unless the
        * class explicitly carries `!important` in CSS (shadcn's don't).
        *
        * The modal is now BRACKETED: top:1rem and bottom:1rem are
        * inline style anchors that the browser respects deterministically.
        * `transform: translateX(-50%)` keeps horizontal centering while
        * killing the vertical translate that shadcn applies by default.
        * `height: auto` + `maxHeight: none` make sure no other style
        * intervenes to cap the modal short of bottom:1rem.
        *
        * The inner flex layout (`shrink-0` header + `flex-1` scrollable
        * body + `shrink-0` footer) handles overflow within that frame.
        */}
      {/*
        * `noPadding` (2026-06-11) tells DialogContent to render with
        * `p-0` body padding AND publish a context value that auto-
        * applies the matching `!mx-0 !mt-0 !mb-0` overrides on
        * DialogHeader and `!mx-0 !mb-0` on DialogFooter. We no longer
        * need to repeat those overrides at the call site — see the
        * DialogPaddingContext block in components/ui/dialog.tsx for
        * the full rationale. The inline `style` block below still
        * handles the unusual positioning (anchored top:1rem /
        * bottom:1rem instead of shadcn's default center).
        */}
      <DialogContent
        noPadding
        className="flex flex-col gap-0"
        style={{
          top: '1rem',
          bottom: '1rem',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '90vw',
          maxWidth: '64rem',
          height: 'auto',
          maxHeight: 'none',
        }}
      >
        <DialogHeader className="bg-sidebar text-sidebar-foreground px-6 py-4 shrink-0">
          <DialogTitle className="text-sidebar-foreground text-lg font-semibold">Seed India Locations</DialogTitle>
          <DialogDescription className="text-sidebar-foreground/80">
            Bulk-Import The Canonical India Pincode / City / State / Country Dataset. Idempotent; Re-Runs Are Safe.
          </DialogDescription>
        </DialogHeader>

        {/* Single scroll container: banner + table + everything between header + footer */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

        {/* Action row */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-1">
          <div className="text-sm text-muted-foreground">
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading Current State…
              </span>
            ) : (
              <span>
                <strong>{total.toLocaleString('en-IN')}</strong> Pincodes In Catalog
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <DownloadButton
              onClick={downloadCurrent}
              disabled={isRunning || isUploading}
              downloading={downloading}
              label="Download Current State"
              loadingLabel="Preparing…"
              title="Export The Entire tbl_pincode Table To XLSX (All Columns + Existing/Added Remark)."
            />

            {/*
              * Start Seeding (2026-06-10 v2). No CSV upload — the BE
              * auto-fetches the canonical India pincode CSV from a
              * configurable public URL. Operator just clicks the
              * button. The fileInputRef + csvFile state below are
              * kept so the existing FormDirtyGuard `isDirty` check
              * remains harmless (csvFile stays null in this code path).
              */}
            {!isRunning && !isUploading && (
              <Button
                onClick={startSeeding}
                disabled={isUploading}
                className="h-9"
                /*
                 * Title attribute carries the source-URL info now (was
                 * a separate visible line; removed per ops UX — too
                 * cluttered next to the button). The `sourceUrl` state
                 * is still fetched + kept so the tooltip can show the
                 * concrete URL for audit purposes.
                 */
                title={sourceUrl
                  ? `Auto-fetch from ${sourceUrl} and seed all tables. Idempotent — existing rows are preserved.`
                  : 'Auto-fetch the canonical India pincode CSV and seed all tables. Idempotent — existing rows are preserved.'}
              >
                {isUploading
                  ? 'Starting…'
                  : (seededAt ? 'Re-Run Seeding' : 'Start Seeding')}
              </Button>
            )}

            {/* Stop button — shown while running */}
            {isRunning && (
              <Button
                variant="destructive"
                onClick={stopSeeding}
                disabled={cancelling}
                className="h-9"
              >
                {cancelling ? 'Cancelling…' : 'Stop Seeding'}
              </Button>
            )}
          </div>
        </div>

        {/* Live progress while running */}
        {isRunning && (
          <div className="mx-1 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 space-y-1">
            <div className="font-medium inline-flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Seeding In Progress…
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5">
              <span>Rows Seen: {(liveStats?.rows_seen ?? 0).toLocaleString('en-IN')}</span>
              <span>Rows Invalid: {(liveStats?.rows_invalid ?? 0).toLocaleString('en-IN')}</span>
              <span>States Created: {liveStats?.states_created ?? 0}</span>
              <span>Cities Created: {liveStats?.cities_created ?? 0}</span>
              <span>Pincodes Inserted: {(liveStats?.pincodes_inserted ?? 0).toLocaleString('en-IN')}</span>
              <span>Pincodes Updated: {(liveStats?.pincodes_updated ?? 0).toLocaleString('en-IN')}</span>
              <span>Pincodes Skipped (Dupe): {(liveStats?.pincodes_skipped_dupe ?? 0).toLocaleString('en-IN')}</span>
            </div>
          </div>
        )}

        {/* Status banners */}
        {seededAt && phase === 'idle' && (
          <div className="mx-1 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            Already Seeded At <strong>{formatTimestamp(seededAt)}</strong>. Re-Running Will Skip Duplicates But Insert Any New Pincodes From The CSV.
          </div>
        )}
        {phase === 'completed' && jobSnap && !jobSnap.skipped && jobSnap.stats && (
          <div className="mx-1 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium">
                Seed Run Completed In {((jobSnap.took_ms || 0) / 1000).toFixed(1)}s
              </div>
              <button
                type="button"
                onClick={dismissBanner}
                className="text-emerald-700 hover:text-emerald-900"
                title="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5">
              <span>Rows Seen: {jobSnap.stats.rows_seen.toLocaleString('en-IN')}</span>
              <span>Rows Invalid: {jobSnap.stats.rows_invalid.toLocaleString('en-IN')}</span>
              <span>States Created: {jobSnap.stats.states_created}</span>
              <span>Cities Created: {jobSnap.stats.cities_created}</span>
              <span>Pincodes Inserted: {jobSnap.stats.pincodes_inserted.toLocaleString('en-IN')}</span>
              <span>Pincodes Updated: {(jobSnap.stats.pincodes_updated ?? 0).toLocaleString('en-IN')}</span>
              <span>Pincodes Skipped (Dupe): {jobSnap.stats.pincodes_skipped_dupe.toLocaleString('en-IN')}</span>
            </div>
          </div>
        )}
        {phase === 'completed' && jobSnap?.skipped && (
          <div className="mx-1 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start justify-between gap-2">
            <span>{jobSnap.reason || 'Seed Skipped.'}</span>
            <button type="button" onClick={dismissBanner} className="text-amber-700 hover:text-amber-900" title="Dismiss">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {phase === 'cancelled' && (
          <div className="mx-1 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 flex items-start justify-between gap-2 space-y-0">
            <div>
              <strong>Seed Cancelled.</strong> Rows Processed Before Cancel Are Persisted.
              {liveStats && (
                <span className="ml-2 text-slate-500">
                  ({liveStats.pincodes_inserted.toLocaleString('en-IN')} Pincodes Inserted)
                </span>
              )}
            </div>
            <button type="button" onClick={dismissBanner} className="text-slate-500 hover:text-slate-800" title="Dismiss">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {phase === 'failed' && (
          <div className="mx-1 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 flex items-start justify-between gap-2">
            <span><strong>Seed Failed:</strong> {jobSnap?.error || 'Unknown Error'}</span>
            <button type="button" onClick={dismissBanner} className="text-red-700 hover:text-red-900" title="Dismiss">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/*
          * Last Seeding Details panel (2026-06-11). Shown ONLY when we
          * have a successful prior run on record — purely supplementary
          * context above the always-visible pincode table. No empty
          * state any more: the table itself communicates the catalogue
          * status, so we don't need a "No Seeding Run Yet" placeholder
          * stealing the spotlight.
          */}
        {phase === 'idle' && lastCompleted && lastCompleted.stats && !lastCompleted.skipped && (
          <div className="mx-1">
            <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 space-y-1">
              <div className="font-medium">
                Last Seed Run On {lastCompleted.finished_at ? formatTimestamp(lastCompleted.finished_at) : '—'}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5">
                <span>Rows Seen: {(lastCompleted.stats.rows_seen ?? 0).toLocaleString('en-IN')}</span>
                <span>Rows Invalid: {(lastCompleted.stats.rows_invalid ?? 0).toLocaleString('en-IN')}</span>
                <span>States Created: {lastCompleted.stats.states_created ?? 0}</span>
                <span>Cities Created: {lastCompleted.stats.cities_created ?? 0}</span>
                <span>Pincodes Inserted: {(lastCompleted.stats.pincodes_inserted ?? 0).toLocaleString('en-IN')}</span>
                <span>Pincodes Updated: {(lastCompleted.stats.pincodes_updated ?? 0).toLocaleString('en-IN')}</span>
                <span>Pincodes Skipped (Dupe): {(lastCompleted.stats.pincodes_skipped_dupe ?? 0).toLocaleString('en-IN')}</span>
              </div>
              <div className="text-emerald-700/80">
                Took {((lastCompleted.took_ms || 0) / 1000).toFixed(1)}s
              </div>
            </div>
          </div>
        )}

        {/* Table — always visible (2026-06-11). Rows carry per-row
            Existing/Added remarks driven by the last-seed timestamp on
            the BE so operators can read the catalogue state at a glance
            regardless of whether a seed has finished, been cancelled
            mid-flight, or never run. */}
        <div className="border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr className="text-left text-slate-600">
                {([
                  ['Pincode', 'pincode'],
                  ['Location', 'location'],
                  ['City', 'city_name'],
                  ['State', 'state_name'],
                  ['Country', 'country_name'],
                  ['Remark', 'remark'],
                ] as Array<[string, SortByKey]>).map(([label, key]) => {
                  const active = sortBy === key;
                  return (
                    <th key={key} className="px-2 py-1.5 font-medium">
                      <button
                        type="button"
                        onClick={() => onSortHeaderClick(key)}
                        className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-900"
                        title={`Sort By ${label}`}
                      >
                        <span>{label}</span>
                        {active && (sortOrder === 'ASC'
                          ? <ChevronUp className="h-3 w-3" />
                          : <ChevronDown className="h-3 w-3" />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/*
                * Stale-while-revalidate rendering (2026-06-11). useFetch
                * keeps the previous data in state while a new fetch is
                * in flight, so we render the existing rows even when
                * `loading` is true. Only when there's NO data yet do we
                * show the "Loading…" placeholder. Result: clicking Next
                * preserves the visible table during the request instead
                * of flashing a full-row spinner. The action-row
                * indicator above the table still signals "fetching".
                */}
              {loading && items.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && error && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-red-700">{error}</td></tr>
              )}
              {!loading && !error && items.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">No Pincodes Yet — Click Start Seeding To Import From The Open-Data Source.</td></tr>
              )}
              {items.map((r) => (
                <tr key={r.pincode_id} className="border-t hover:bg-slate-50/60">
                  <td className="px-2 py-1.5 tabular-nums font-mono">{r.pincode}</td>
                  <td className="px-2 py-1.5">{r.location || '—'}</td>
                  <td className="px-2 py-1.5">{r.city_name || '—'}</td>
                  <td className="px-2 py-1.5">{r.state_name || '—'}</td>
                  <td className="px-2 py-1.5">{r.country_name || '—'}</td>
                  <td className="px-2 py-1.5">
                    <StatusChip
                      tone={
                        r.remark === 'Added'
                          ? 'emerald'
                          : r.remark === 'Updated'
                            ? 'amber'
                            : 'slate'
                      }
                      size="sm"
                    >
                      {r.remark}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={(p) => setPage(p)}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(0);
          }}
          className="px-1"
        />

        </div>
        {/*
          * Sticky footer (2026-06-10). Sits below the scroll container
          * so Close / Refresh are always reachable regardless of how
          * tall the body content grows. shrink-0 keeps it from
          * collapsing when the table is empty.
          */}
        {/*
          * `!mx-0 !mb-0` override (2026-06-11) — same reason as the
          * DialogHeader above. Default DialogFooter has `-mx-6 -mb-6`
          * negative margins assuming DialogContent's `p-6`; with our
          * `p-0` they'd push the footer below the modal frame.
          */}
        <DialogFooter className="!mx-0 !mb-0 shrink-0 border-t bg-background px-6 py-3 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => guardedOpenChange(false)}
            disabled={isUploading}
          >
            Close
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              /*
               * Refresh sequence (2026-06-10): acknowledge → refetch.
               * Setting the view-baseline to "now" causes every row's
               * remark to flip back to 'Existing' on the very next list
               * fetch — gives the operator a clean slate for tracking
               * subsequent Adds/Updates against this baseline. If the
               * acknowledge POST fails we still refetch (the user
               * explicitly asked for fresh data; the baseline write is
               * best-effort).
               */
              try {
                await api.post('/admin/india-locations/seed/acknowledge', {});
              } catch {
                /* non-fatal — still refresh below */
              }
              // Bump `tick` so the listKey changes and useFetch can't
              // serve the previous URL's cached response — that cache
              // hit is exactly why operators were seeing stale 'Added'
              // remarks for minutes after clicking Refresh (2026-06-11).
              // `refetch()` alone keeps the same URL key; the module-level
              // cache in @/lib/hooks returns the prior payload instantly.
              setTick((t) => t + 1);
              refetch();
            }}
            disabled={isUploading || loading}
            title="Refresh: Acknowledge Current Catalog As Baseline"
          >
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTimestamp(ts: string): string {
  // BE writes 'YYYY-MM-DD HH:mm:ss' (server local). Display as-is —
  // operators just want to know "before or after the last run".
  try {
    const d = new Date(ts.replace(' ', 'T'));
    if (!Number.isFinite(d.getTime())) return ts;
    return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return ts;
  }
}
