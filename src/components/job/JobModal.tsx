'use client';

import * as React from 'react';
import { useSlotRecommendations, SlotAdvisory } from '@/components/job/SlotRecommendations';
import { useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { useFetch, useUiFlags } from '@/lib/hooks';
import { Sparkles, Search, CalendarCheck, History, Eye, Plus, X, Pencil, CalendarPlus, CheckCircle2, BarChart3, Trash2, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { DateTimeSlotPicker, TimeSelect } from '@/components/ui/date-time-slot-picker';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Switch } from '@/components/ui/switch';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { AddressPickerWithMap, type AddressValue } from '@/components/ui/address-picker-with-map';
import { AddressEditDialog, type EditableAddress } from './AddressEditDialog';
import { JobTransactionView } from './JobTransactionView';
import { SkillImageLightbox, type SkillImageLightboxValue } from '@/components/easyfixer/SkillImageLightbox';
import { CustomerSubmissionPanel } from './CustomerSubmissionPanel';
import { AddRemarksDialog } from './AddRemarksDialog';
import { CancelWithReasonDialog } from './CancelWithReasonDialog';
// Audited reschedule dialog (PATCH /admin/jobs/:id/reschedule → job.reschedule:
// offer-expiry + scheduling_history). Kept aliased for a descriptive name;
// both ActionBar and the customer-request "apply" flow use it.
import { RescheduleDialog as ApptRescheduleDialog } from './RescheduleDialog';
import { fetchReasonsCached } from './jobActionReasons';
import type { JobComment } from './jobTypes';
import { JobRemarksView } from './JobRemarksView';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StatusChip } from '@/components/ui/StatusChip';
import { api, ApiError } from '@/lib/api';
import { resolveParentAddressId, buildJobAddressPayload } from '@/lib/job-address';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName, statusLabel, statusTone, toIstClockTime } from '@/lib/utils';
import { maskMobile, formatServiceAddress, INDIAN_MOBILE_REGEX, INDIAN_MOBILE_ERROR, isValidIndianMobile } from '@/lib/format';

/*
 * safeMobile(v) — defends against round-tripping a masked display value
 * back into a save payload. If the string still contains a bullet (•),
 * the source fetch wasn't `?unmasked=true` and we'd corrupt the DB by
 * sending it back; return undefined so the field gets omitted from the
 * PATCH payload entirely (leaves the existing DB value untouched).
 * The BE also rejects bullets at the wire via reject-masked-mobile.js,
 * but stopping the leak FE-side avoids the 400 round-trip + makes the
 * partial save succeed for non-mobile fields. Idempotent + null-safe.
 */
function safeMobile(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.includes('•')) return undefined;
  return s;
}
import { CallableMobile } from '@/components/calls/CallButton';
import { CallHistoryTable, type CallRow } from '@/components/calls/CallHistoryButton';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

/*
 * Unified Job modal — create | view | edit in one component.
 *
 * Mirrors the EasyfixerModal pattern so both entities have the same mental
 * model: list-page + modal overlay. A single record type, one form definition,
 * three presentation modes. The form for create/edit shares fields with a
 * read-only card layout for view; view mode also hosts the status-driven action
 * buttons (Assign / Start / Complete / Cancel / Mark InComplete) so the user
 * can drive the full job lifecycle without leaving the list.
 *
 * Status-code → visible-button map matches jobs/[id]/page.tsx exactly so the
 * behaviour is identical whether the user enters via direct URL or the modal.
 */

export const ST = { BOOKED: 0, SCHEDULED: 1, IN_PROGRESS: 2, COMPLETED: 3, COMPLETED_ALT: 5, CANCELLED: 6, ENQUIRY: 7, CALL_LATER: 9, REVISIT: 10 } as const;

/*
 * PII masking helper — show only the first 4 digits of any mobile
 * number; mask the rest with bullets. Used wherever a mobile is
 * rendered read-only inside JobModal (view summary, confirm header,
 * confirm form's disabled inputs, etc.). Editable inputs are
 * deliberately NOT masked so operators can still type/edit numbers
 * during create.
 *
 * Non-digits are stripped before masking so country codes / spaces /
 * dashes don't throw the prefix-4 count off.
 */
// Mobile masking is shared via src/lib/format.ts (import at top of file).
// The helper is idempotent so it's safe even though the /admin/* response
// middleware also masks every mobile-bearing field before it crosses the
// wire.
// Unconfirmed (CALL_LATER = 9) is intentionally excluded from canAssign
// and canCancel: ops should drive those orders through the dedicated
// Confirm-and-Schedule flow (purple CalendarCheck on the row), not
// directly assign/cancel from the View modal. Legacy CRM behaviour.
const canAssign         = (s: number) => [ST.BOOKED, ST.SCHEDULED, ST.ENQUIRY, ST.REVISIT].includes(s as never);
const canChangeOwner    = (s: number) => ![ST.COMPLETED, ST.COMPLETED_ALT, ST.CANCELLED].includes(s as never);
/*
 * isJobClosed — true when the job has reached a terminal-completion
 * state. Operators may still VIEW closed jobs but cannot edit their
 * services or materials. CANCELLED is intentionally NOT considered
 * "closed" here because ops sometimes recover cancelled orders by
 * editing them back to a workable state.
 */
const isJobClosed = (s: number) => [ST.COMPLETED, ST.COMPLETED_ALT].includes(s as never);
const canStart          = (s: number) => [ST.SCHEDULED, ST.REVISIT].includes(s as never);
const canComplete       = (s: number) => s === ST.IN_PROGRESS;
const canCancel         = (s: number) => [ST.BOOKED, ST.SCHEDULED, ST.IN_PROGRESS, ST.ENQUIRY, ST.REVISIT].includes(s as never);
const canMarkIncomplete = (s: number) => [ST.COMPLETED, ST.COMPLETED_ALT].includes(s as never);
// NOTE: Confirm & Schedule for Unconfirmed orders (status 9 → 0) is handled
// via JobModal's dedicated `'confirm'` mode, launched from the row-level
// CalendarCheck icon — no predicate needed here.

/*
 * Modes:
 *   create  — blank form, POST /admin/jobs
 *   edit    — prefilled form, PATCH /admin/jobs/:id (scalar fields only)
 *   view    — read-only + ActionBar (Edit / Assign / Start / Complete / etc.)
 *   confirm — prefilled edit form WITH services basket and a "Confirm &
 *             Schedule" footer that saves then promotes status 9 → 0. This is
 *             the replacement for the legacy `addEditJob?loc=home → Book Call`
 *             modal used on the Unconfirmed Orders queue.
 */
export type JobModalMode = 'create' | 'edit' | 'view' | 'confirm';

type Job = Record<string, unknown> & {
  job_id: number; job_status: number;
  services?: unknown[]; images?: unknown[];
  // Customer-shared videos via the WhatsApp conversational order-confirmation
  // flow. Lives in tbl_job_media (separate from tbl_job_image because that
  // table is image-only). Backend includes it in /admin/jobs/:id; absent on
  // pre-2026-06-03 deploys → treated as []. Rendered next to images in the
  // Confirm view (see JobVideosStrip).
  videos?: Array<{ media_id: number; s3_key?: string; content_type?: string | null; source?: string | null; created_at?: string | null }>;
};

export function JobModal({
  open, onClose, mode: initialMode, jobId, onSaved, initialTab,
}: {
  open: boolean;
  onClose: () => void;
  mode: JobModalMode;
  jobId?: number;
  /* Called after any successful save. On a CREATE (Book New Call) the newly
   * created job is passed so the parent can route straight into Schedule &
   * Assign; edit/confirm/other saves call it with no argument. */
  onSaved?: (job?: Job) => void;
  /*
   * Optional initial Tabs value for view-mode (2026-05-28). Threaded
   * from URL `?tab=` by the list page so deep-links like
   *   /jobs?jobId=482453&action=view&tab=services
   * land directly on the Services tab instead of the default Summary.
   * Ignored in non-view modes (JobForm has no tabs).
   *
   * Known values match the TabsTrigger values rendered by ViewBody:
   *   'summary' | 'services' | 'schedule' | 'images' |
   *   'questionnaire' | 'comments' | 'materials' | 'quotations'
   */
  initialTab?: string;
}) {
  const [mode, setMode] = useState<JobModalMode>(initialMode);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Unsaved-quantity guard (2026-06-01, refined 2026-06-02). The Services
   * tab edits quantity inline with auto-save-on-blur. Clicking Close
   * blurs the focused input FIRST, which auto-commits any VALID pending
   * value (→ "Quantity updated." toast) — so a valid edit is already
   * saved by the time we reach here and must NOT also trigger a warning
   * (the earlier bug: the alert and the success toast appeared together).
   *
   * Therefore ServicesTabBody reports only its "blocking" subset through
   * `onDirtyChange`: pending values that are INVALID (out of 1..100) and
   * thus can't be auto-saved. Those are the only edits a close would
   * genuinely discard, so they're the only ones worth a prompt. A ref
   * (not state) suffices since the close handlers only READ at click-time.
   */
  const hasUnsavedQtyRef = React.useRef(false);
  /*
   * `hasUnsavedFormRef` — set by JobForm whenever the operator edits any
   * form field on the Confirm & Schedule / Book New Call modal that
   * would be discarded on close. JobForm flips it true on any user-
   * initiated state change and back to false after a successful save.
   * Read at close-time only (no re-render needed), hence a ref.
   *
   * Why a separate signal from `hasUnsavedQtyRef`: that one tracks
   * INVALID qty edits specifically (auto-save skips them). This one
   * tracks any dirty-form state — including valid edits that just
   * haven't been submitted yet. Both feed `guardedClose` below.
   */
  const hasUnsavedFormRef = React.useRef(false);
  const confirm = useConfirm();
  /*
   * guardedClose — intercepts every close path (footer Close button,
   * the Dialog's X / Escape / overlay-click via onOpenChange).
   *
   * Two-tier prompt:
   *   • Invalid qty edits — explicit "this will be discarded" message
   *     (auto-save can't commit them, so closing genuinely throws them away).
   *   • Any other dirty form state — generic discard-changes confirm.
   *
   * Clean close skips both prompts and is one click. The order of
   * checks matters: the qty-specific message is more actionable, so
   * we surface it first when both flags are set.
   */
  async function guardedClose() {
    /*
     * View mode is read-only by contract — none of the editable
     * fields render, so there's nothing the operator could have
     * touched. Skip both prompts unconditionally. Defends against
     * stale dirty-flags set by child component hydration (e.g. a
     * SearchSelect committing its initial value on mount counts as
     * a "change" to the form-state tracker even though no human
     * input occurred) which would otherwise produce a phantom
     * "Discard Unsaved Changes?" prompt on a pure-read flow.
     */
    if (mode === 'view') {
      hasUnsavedQtyRef.current = false;
      hasUnsavedFormRef.current = false;
      onClose();
      return;
    }
    if (hasUnsavedQtyRef.current) {
      const ok = await confirm({
        title: 'Discard Invalid Quantity?',
        description: 'A quantity you entered is invalid and won’t be saved. Close and discard it?',
        confirmLabel: 'Close Anyway',
        cancelLabel: 'Keep Editing',
        variant: 'destructive',
      });
      if (!ok) return;
    } else if (hasUnsavedFormRef.current) {
      // Generic dirty-form prompt — covers address instructions, customer
      // edits, services tab adds/removes etc. The qty-specific branch
      // above is more specific so it wins when both are dirty.
      const ok = await confirm({
        title: 'Discard Unsaved Changes?',
        description: 'You have unsaved changes that will be lost. Close anyway?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    hasUnsavedQtyRef.current = false;
    hasUnsavedFormRef.current = false;
    onClose();
  }
  // Add-Remarks popup for the Unconfirmed view-mode footer. Lives at
  // the modal root so it can dismiss without unmounting JobForm/View.
  const [addRemarksOpen, setAddRemarksOpen] = useState(false);
  // Bumped by every AddRemarksDialog save — drives JobCommentsTab's refetch
  // so the just-added remark shows up immediately without manual refresh.
  // (The Comments tab maintains its own list state and isn't re-mounted on
  // refresh(), so a separate trigger is needed.)
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  /*
   * Optimistic pending-comment list (2026-06-05).
   *
   * When the operator clicks Save in AddRemarksDialog, we synthesise a
   * client-side JobComment row and prepend it here immediately — the
   * dialog closes, the comment is visible at the top of the Comments tab
   * with a "Sending…" pill, and the actual POST runs in the background.
   * Reconciliation: when JobCommentsTab's refetch completes (triggered by
   * `commentsRefreshKey` bump after POST resolves), `onCommentsLoaded`
   * fires and we drop the matching pending row. On POST failure the
   * dialog's catch removes the pending row and toasts the error.
   *
   * Negative `id` is the sentinel — real `tbl_job_comment` rows are
   * AUTO_INCREMENT positives, so a negative tempId is collision-free and
   * `key={c.id}` in the list render stays stable.
   */
  const [pendingComments, setPendingComments] = useState<Array<JobComment & { _pending?: true }>>([]);
  const { me: currentMe } = useMe();
  /*
   * `compact` shrinks the modal to fit-to-content while the create-flow
   * mobile gate is showing. Once the operator submits the mobile and
   * the gate transitions to the full form, the gate calls
   * setCompact(false) and the dialog expands to its standard 5xl/85vh
   * footprint. For non-create modes the dialog is always full-size.
   */
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    // Reset to compact every time the modal re-opens in create mode.
    if (open) setCompact(initialMode === 'create');
  }, [open, initialMode]);

  useEffect(() => { if (open) { setMode(initialMode); setError(null); } }, [open, initialMode, jobId]);

  // Reset or load as the modal opens with a different job.
  //
  // Stale-data fix: clear `job` to null BEFORE awaiting the fetch. Without
  // this, the header (title `Job #N`, status badge, ActionBar) renders
  // from the previously-loaded job for the duration of the request — the
  // operator saw last-modal's customer name flash on every re-open. With
  // `job` cleared up front, the header falls through to the "Loading…"
  // branch (see render below) until the new payload arrives.
  /*
   * Mode-aware fetch. The /admin/* response middleware masks mobile
   * fields by default; edit/confirm modes need the unmasked values so
   * the form pre-fill round-trips cleanly (saving without changing the
   * mobile would otherwise send "9310••••••" back and fail Joi's
   * digits-only validator). The `?unmasked=true` query opts out of the
   * masking middleware. View mode keeps masking on so the network-tab
   * payload doesn't leak full digits during read-only browsing.
   *
   * `mode` is in the deps so flipping View → Edit triggers a refetch.
   * Brief loading state when the operator clicks Edit; acceptable
   * latency for the privacy-vs-edit trade-off.
   */
  const fetchQuery = (mode === 'edit' || mode === 'confirm') ? { unmasked: 'true' } : undefined;
  useEffect(() => {
    if (!open) return;
    /*
     * Create-flow post-save symptom (2026-05-25 fix): when the user
     * books a new call, `onSaved(saved)` sets `job` to the freshly-
     * created row and flips `mode` to 'view'. The mode flip re-runs
     * this effect, but `jobId` (a prop) is still undefined because
     * the parent hasn't re-mounted with the new id yet — which used
     * to hit the `setJob(null)` line and leave the modal blank.
     *
     * Fix: if we already have an in-memory `job` (set by the save
     * callback) AND the prop `jobId` is missing, use that job's id
     * to drive the refetch instead. Falls back to the prop when
     * present so plain Edit-flow re-fetches still work.
     */
    const effectiveJobId = jobId ?? (job?.job_id != null ? Number(job.job_id) : undefined);
    if (!effectiveJobId) { setJob(null); return; }
    // Hide stale header immediately ONLY when we're navigating to a
    // genuinely different job. If we just got `saved` from the create
    // callback, keep it visible while the fresh GET resolves.
    if (jobId && jobId !== job?.job_id) setJob(null);
    setError(null);
    setLoading(true);
    (async () => {
      try { setJob(await api.get<Job>(`/admin/jobs/${effectiveJobId}`, fetchQuery)); }
      catch { setError('Could not load job details'); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId, mode]);

  async function refresh() {
    if (!jobId) return;
    try { setJob(await api.get<Job>(`/admin/jobs/${jobId}`, fetchQuery)); }
    catch { /* swallow — outer error state is set by action handlers */ }
  }

  // NOTE: no interval polling on the modal — the job re-pulls on ACTION via the
  // silent refresh() already wired to ActionBar.onChanged (assign / reschedule /
  // remarks etc.). Event-driven avoids refreshing the panel under an operator
  // who is reading or editing it.

  // While loading a fresh job we render a neutral title so the operator
  // doesn't see last-modal's job id flash. The non-view modes embed the
  // jobId from props (always current — no stale risk) so they render
  // normally. View mode depends on `job`, so we wait for the fetch.
  //
  // We deliberately do NOT show "Loading job…" in the title while
  // loading — that produced two visible loading indicators (one in the
  // header, one in the body). The body now owns the single centered
  // loader; the header just stays generic ("Job") until the payload
  // lands and the real `Job #N` title can render.
  // Create-mode title is now "Book New Call" to match the legacy CRM
  // header button label exactly. Edit/Confirm/View titles unchanged.
  // Deep-link hardening: `?action=confirm&jobId=N` opens confirm mode for ANY
  // jobId. Once `job` is loaded, downgrade confirm→view when it isn't actually
  // Unconfirmed (job_status=9), so a pasted link to a non-unconfirmed job can't
  // open the full Confirm & Schedule flow with all its actions. While the job is
  // still loading (job null) confirm stays so the loader shows; a genuine
  // unconfirmed job is unaffected. create/edit/view are never downgraded.
  const effectiveMode = (mode === 'confirm' && job && Number(job.job_status) !== 9) ? 'view' : mode;
  const title = effectiveMode === 'create'  ? 'Book New Call'
             : effectiveMode === 'edit'    ? `Edit Job #${jobId}`
             : effectiveMode === 'confirm' ? `Confirm & Schedule · Job #${jobId}`
             : job                          ? `Job #${job.job_id}`
             :                                'Job';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) guardedClose(); }}>
      {/* Fixed-height modal so different tabs (Summary / Services / Schedule)
          don't cause the whole dialog to jump in size as the user switches.
          hideClose drops the top-right X since we have a footer Close button. */}
      {/* Compact while the create-flow mobile gate is up; full-size
          once the gate transitions to the form (or in non-create
          modes). `compact` adapts width + height + scroll model so the
          empty modal doesn't look stranded behind the small mobile
          input. */}
      <DialogContent
        hideClose
        className={
          compact
            ? 'max-w-md w-[min(95vw,480px)] p-0 flex flex-col'
            // Near-full-viewport modal per ops spec — leaves ~24px on every
            // side. `!max-w-none` overrides DialogContent's default
            // `max-w-lg`; `!important` because the base class wins
            // otherwise due to Tailwind specificity.
            : '!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden p-0 flex flex-col'
        }
      >
        {/* The global DialogHeader uses `-mx-6 -mt-6` to claw back the
            standard DialogContent's p-6 so the dark-slate band runs
            edge-to-edge. JobModal uses `p-0` (the body has its own
            scrolling padding), so those negative margins would push
            the band OUTSIDE the rounded corners. `!important` overrides
            force the margins back to 0; px-6 + py-3.5 + !mb-0 produces
            the same edge-to-edge band without the offset. */}
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 !mb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Sky-accented icon tile gives the header a visual anchor
                  instead of a lone text title. CalendarPlus signals
                  "schedule a new call" for create; Pencil for edit;
                  Eye for view. */}
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sky-500/20 ring-1 ring-sky-400/40">
                {effectiveMode === 'create'  ? <CalendarPlus className="h-4 w-4 text-sky-300" />
                 : effectiveMode === 'edit'  ? <Pencil className="h-4 w-4 text-sky-300" />
                 : effectiveMode === 'confirm' ? <CheckCircle2 className="h-4 w-4 text-sky-300" />
                 : <Eye className="h-4 w-4 text-sky-300" />}
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate">{title}</DialogTitle>
                {/* Status badge + job-type sub-line only show once we have
                    the fresh `job` payload — gated on `!loading` so the
                    previous job's badge can't flash on re-open. */}
                {mode === 'view' && !loading && job && (
                  <DialogDescription className="mt-1 flex items-center gap-2">
                    <StatusChip tone={statusTone(Number(job.job_status))}>
                      {statusLabel(Number(job.job_status), { assigned: job.fk_easyfixter_id != null })}
                    </StatusChip>
                    <span className="text-xs">{String(job.job_type ?? '')}</span>
                  </DialogDescription>
                )}
              </div>
            </div>
            {/* ActionBar relocated to the footer (see below). Header now
                carries title + status badge ONLY — single visual lane for
                identity, while every interactive control lives in the
                footer cluster. */}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Single, properly-centered loader. Replaces the prior small
              left-aligned "Loading…" text which combined with the
              header's "Loading job…" string to produce TWO loading
              indicators on every modal open. The wrapper takes the full
              remaining vertical space so the spinner+label sit in the
              optical centre, not at the top edge. */}
          {loading && (
            <div className="flex items-center justify-center h-full">
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading…
              </span>
            </div>
          )}
          {error && !job && <div className="text-sm text-destructive">{error}</div>}
          {!loading && effectiveMode === 'view' && job && (
            // Unconfirmed (status=9) gets the legacy "Job Transaction"
            // single-page read-only layout — no tabs, no edits. Every
            // other status keeps the tabbed Summary/Services/Schedule/
            // Images/etc. view that ops uses for active jobs.
            <>
              {/* A `?action=confirm` deep-link to a non-Unconfirmed job was
                  downgraded to read-only — tell the operator why so it isn't
                  mistaken for a broken Confirm & Schedule. */}
              {mode === 'confirm' && (
                <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
                  This order isn’t Unconfirmed, so Confirm &amp; Schedule isn’t available — opened in read-only view.
                </div>
              )}
              {Number(job.job_status) === 9
                ? <JobTransactionView jobId={Number(job.job_id)} />
                : <ViewBody
                    job={job}
                    onRefresh={refresh}
                    initialTab={initialTab}
                    onDirtyChange={(dirty) => { hasUnsavedQtyRef.current = dirty; }}
                    commentsRefreshKey={commentsRefreshKey}
                    pendingComments={pendingComments}
                    onCommentsLoaded={() => setPendingComments([])}
                  />}
            </>
          )}
          {/* Mobile-first gate for the CREATE flow. Mirrors legacy
              `addEditJob.vm` which opened with a single mobile-number
              field and only revealed the rest of the form (customer
              details + address picker) AFTER the operator typed the
              number and hit Enter. The gate calls
              `/admin/customers/by-mobile/lookup`:
                - 200 → existing customer found → pass customer +
                  address list down to JobForm so it pre-fills + shows
                  the address picker.
                - 404 → fresh customer → pass just the mobile down,
                  JobForm renders empty customer fields + a single
                  inline address-entry block.
              In edit/confirm modes the gate is bypassed (the job
              already has a customer + address). */}
          {!loading && mode === 'create' && (
            <CreateJobMobileGate
              onExpand={() => setCompact(false)}
              onContract={() => setCompact(true)}
              onCancel={onClose}
              onProceed={(prefill) => (
                <JobForm
                  mode="create"
                  initial={null}
                  prefillCustomer={prefill}
                  onCancel={onClose}
                  onFormDirty={(dirty) => { hasUnsavedFormRef.current = dirty; }}
                  onSaved={(saved) => {
                    // Pass the created job up so the list page can jump straight
                    // into Schedule & Assign (parent guards on create mode).
                    if (saved?.job_id) { setJob(saved); setMode('view'); onSaved?.(saved); }
                  }}
                />
              )}
            />
          )}
          {!loading && (effectiveMode === 'edit' || effectiveMode === 'confirm') && (
            <JobForm
              mode={effectiveMode}
              initial={job}
              /*
               * Cancel returns the operator to the View modal (where
               * they came from) instead of closing the whole drawer.
               * The previous `onClose` handler dismissed both the Edit
               * form AND the parent View, forcing the operator to
               * navigate back through the list. Edit-mode reverts to
               * View; Confirm-mode (which is opened standalone from
               * the Unconfirmed list) keeps the original close-on-
               * cancel since there's no underlying view to fall back
               * to.
               */
              onCancel={() => {
                if (mode === 'edit') setMode('view');
                else onClose();
              }}
              onSaved={(saved, opts) => {
                // Outcome-only path (Unreachable / Enquiry): close the
                // modal immediately and notify the parent to refresh
                // its list. Skips the setMode('view') + refetch cycle
                // that previously caused a ~2-3s blank-modal flash.
                if (opts?.closeAfter) {
                  onSaved?.();
                  onClose();
                  return;
                }
                // Book / Confirm path: stay open, switch to view mode,
                // notify parent. The mode-dep useEffect still fires a
                // refetch — that's intentional here so the view-mode
                // payload comes through the masking middleware.
                setJob(saved); setMode('view'); onSaved?.();
              }}
              // Re-fetch the parent modal's job state. Used by the
              // inline already-uploaded images grid in Confirm mode
              // after the X-delete on a thumbnail — without this the
              // tile stays visible and a retry click 404s.
              onRefresh={refresh}
              // Dirty-form signal — drives the Esc / X / overlay
              // "Discard Unsaved Changes?" prompt in guardedClose.
              onFormDirty={(dirty) => { hasUnsavedFormRef.current = dirty; }}
            />
          )}
        </div>

        {effectiveMode === 'view' && (
          <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-between gap-2 flex-wrap">
            {/* LEFT cluster — only Add Remarks lives here per ops 2026-05-21.
                Mirrors the legacy "Job Transaction → Add Remarks" affordance
                and writes to tbl_job_comment with comment_on=1 via
                POST /admin/jobs/:id/comments. Rendered only once `job` loads
                so it doesn't flash during the initial fetch. When the job
                isn't Unconfirmed (status≠9) this cluster is an empty
                placeholder div so the flex layout keeps the right cluster
                anchored to the right edge. */}
            <div className="flex items-center gap-2">
              {!loading && job && Number(job.job_status) === 9 && (
                <Button
                  variant="outline"
                  className="bg-teal-500 hover:bg-teal-600 text-white border-teal-500 hover:text-white"
                  onClick={() => setAddRemarksOpen(true)}
                >
                  Add Remarks
                </Button>
              )}
            </div>
            {/* RIGHT cluster — Close sits IMMEDIATELY LEFT of the primary
                lifecycle actions, not at the far left of the footer. The
                ordering preserves the "less-used → more-used" reading
                direction inside the cluster: Close (exit) on the left,
                then ActionBar's status-aware buttons (Edit, Assign, Start,
                Complete, Cancel, …) on the right. ActionBar already
                applies its own flex-wrap, so this composed cluster
                degrades gracefully on narrow viewports. */}
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Button variant="outline" onClick={guardedClose}>Close</Button>
              {!loading && job && (
                <ActionBar
                  job={job}
                  jobId={Number(jobId)}
                  onChanged={() => { refresh(); onSaved?.(); }}
                  onEdit={() => setMode('edit')}
                />
              )}
            </div>
          </div>
        )}
      </DialogContent>
      {/* AddRemarks popup — POSTs to /admin/jobs/:id/comments with the
          legacy "created" stage code (comment_on=1). Reuses the
          existing comments endpoint so the remark lands in
          tbl_job_comment alongside any prior follow-up notes.
          Optimistic flow (2026-06-05): the dialog closes the MOMENT
          Save is clicked and synthesises a pending JobComment row
          (`onOptimisticAdd`); the real POST runs in the background
          and `onSaved` fires when it lands. Reconciliation happens
          inside JobCommentsTab.onLoaded → clearing pendingComments.
          POST failure → onPendingFailed removes the pending row + a
          toast surfaces the error since the dialog is already gone. */}
      {jobId && (
        <AddRemarksDialog
          open={addRemarksOpen}
          jobId={Number(jobId)}
          currentUserName={(currentMe?.user?.user_name || currentMe?.user?.official_email || 'You') as string}
          onClose={() => setAddRemarksOpen(false)}
          onOptimisticAdd={(row) => {
            // Prepend the pending row + close the dialog immediately.
            // The Comments tab will surface it with a "Sending…" pill.
            setPendingComments((prev) => [row, ...prev]);
            setAddRemarksOpen(false);
          }}
          onPendingFailed={(tempId) => {
            // POST rejected — drop the optimistic row + surface error.
            setPendingComments((prev) => prev.filter((c) => c.id !== tempId));
          }}
          onSaved={() => {
            // POST succeeded — bump refresh key so JobCommentsTab refetches
            // and the canonical row replaces the pending one. (Pending
            // cleanup happens via onCommentsLoaded after refetch finishes.)
            setCommentsRefreshKey((k) => k + 1);
            onSaved?.();
          }}
        />
      )}
    </Dialog>
  );
}

// ─── Action bar (status-driven buttons with per-button loaders) ──────────────

type BusyKey = 'start' | 'complete' | 'cancel' | 'incomplete' | 'assign' | 'owner' | 'confirm' | null;

/*
 * collectedByCode — coerce the form's `collected_by` field (a
 * human-readable label like "Easyfix" / "Easyfixer" / "Client", per
 * the legacy default at line 5610) into the integer enum tbl_job
 * expects. Returns `undefined` for unknown values so the BE falls
 * back to whatever default it prefers.
 *
 *   1 = Easyfixer (technician collects)
 *   2 = Easyfix   (operator/CRM collects)
 *   3 = Client    (client collects)
 */
function collectedByCode(label: unknown): number | undefined {
  if (label == null || label === '') return undefined;
  if (typeof label === 'number') return label;
  const s = String(label).trim().toLowerCase();
  if (s === 'easyfixer') return 1;
  if (s === 'easyfix')   return 2;
  if (s === 'client')    return 3;
  // Allow numeric strings too (e.g. "2") for forward-compat.
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/*
 * collectedByLabel — inverse of collectedByCode. tbl_job stores the enum as an
 * INTEGER (1/2/3), but the Collected By <SearchSelect> options are the string
 * labels. On reload we must map the stored integer back to its label, else the
 * dropdown value matches no option and renders blank — the "Collected By not
 * saved" symptom. Tolerant of already-label values (legacy rows). Returns
 * undefined for unknown so the caller can apply its default.
 */
function collectedByLabel(code: unknown): string | undefined {
  if (code == null || code === '') return undefined;
  const s = String(code).trim().toLowerCase();
  if (s === '1' || s === 'easyfixer') return 'Easyfixer';
  if (s === '2' || s === 'easyfix')   return 'Easyfix';
  if (s === '3' || s === 'client')    return 'Client';
  return undefined;
}

/*
 * Customer-facing wording for Collected By. The stored enum and the wire
 * vocabulary are UNCHANGED — 'Easyfixer'/'Easyfix' remain the option values and
 * the BE's /collected-by-preference still answers with them (routes/admin/
 * clients.js COLLECTED_BY_MAP). Only the words ops read change, from "who
 * physically collects" to "who bears the cost", which is the same fact:
 *   1 Easyfixer → the technician takes payment on site → Paid By Customer
 *   2 Easyfix   → Easyfix invoices the client          → Free For Customer
 * Keeping value≠label is deliberate: relabelling the VALUES would silently
 * reinterpret 82k jobs already storing 1 and break collectedByCode()'s mapping.
 *
 * 3 (Client) is intentionally NOT offered per job — ops set it on the client
 * profile, and production has 13 such jobs. Any unmapped value falls through
 * verbatim so a legacy 'Client' row still renders its own name rather than blank.
 */
const COLLECTED_BY_CUSTOMER_LABEL: Record<string, string> = {
  Easyfixer: 'Paid By Customer',
  Easyfix:   'Free For Customer',
};
function collectedByDisplay(v: unknown): string {
  const s = String(v ?? '').trim();
  return COLLECTED_BY_CUSTOMER_LABEL[s] ?? s;
}

/*
 * The two options the booking flow offers when the client profile says "Any"
 * (tbl_client.collected_by = 0). Ops MUST pick one — leaving it unset is what
 * wrote 0 to tbl_job and blocked those jobs from checking out.
 */
const COLLECTED_BY_JOB_OPTIONS = [
  { value: 'Easyfix',   label: 'Free For Customer' },
  { value: 'Easyfixer', label: 'Paid By Customer' },
];

function ActionBar({ job, jobId, onChanged, onEdit }: {
  job: Job; jobId: number; onChanged: () => void; onEdit: () => void;
}) {
  const s = Number(job.job_status);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  // Three new legacy-parity dialogs:
  //   - Reschedule: change requested_date_time + time_slot (without
  //     re-assigning a tech). Legacy `jobReshedule.vm`.
  //   - Change Description: edit job_desc inline. Legacy `changeJobDesc.vm`.
  //   - Cancel With Reason: PATCH /:id/status with status=6 + reason picker
  //     from /lookup/cancel-reasons. Legacy `jobCancel.vm`.
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Modal-internal permission gates. Each button maps to a legacy
  // Constants.actionPermissions key so the seeded role_menu_action rows
  // for the Admin role govern visibility. Status guards (canAssign,
  // canCancel, etc.) AND the permission flag must both be true for the
  // button to render.
  const { me } = useMe();
  const can = actionFlags(me, [
    'isJobEdit',          // Edit form open + Change Owner
    'isJobAssign',        // Auto-assign + Manual pick (initial)
    'isJobReassign',      // Auto-reassign + Manual pick (when already assigned)
    'isJobStatusChange',  // Start + Complete + Mark Incomplete
    'isJobCancel',        // Cancel button (destructive — separate key)
  ]);
  const isReassign = !!job.fk_easyfixter_id;
  const canPickTech = isReassign ? can.isJobReassign : can.isJobAssign;
  // Legacy Auto-assign / Manual-pick buttons retired (2026-07-09) — assignment
  // now flows exclusively through the Schedule & Assign modal (?action=schedule).
  // Gated off (not deleted) so the dialogs below stay wired for a quick revert.
  const LEGACY_ASSIGN_BUTTONS = false;

  async function doStatus(key: BusyKey, status: number, reasonId?: number, comment?: string) {
    setBusy(key);
    try { await api.patch(`/admin/jobs/${jobId}/status`, { status, reasonId, comment }); onChanged(); }
    finally { setBusy(null); }
  }

  return (
    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
      {/* Outbound calling is consolidated onto the customer mobile cell
          itself across the CRM (see <CallableMobile> in
          src/components/calls/CallButton.tsx). The action bar deliberately
          carries no Call button — keeps the lifecycle controls
          (Edit / Assign / Start / Complete / Cancel) visually distinct
          from the contact-the-customer action. */}
      {/*
        * Edit button — kept visible until the job is CLOSED
        * (status 3/5 COMPLETED). The Edit modal carries the
        * services + materials affordances; gating it here is the
        * single source of truth for "can the operator edit
        * services / materials" until-closed.
        */}
      {can.isJobEdit && !isJobClosed(s) && <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>}
      {/* Confirm & Schedule for Unconfirmed orders is exposed as a dedicated
          modal mode launched from the list row (purple CalendarCheck icon),
          not a button in this action bar. That matches the legacy flow where
          ops click the calendar icon on the row and land directly in the
          addEditJob form. */}
      {/* Primary action is now the engine-ranked picker (top-10 in real time) for
          BOTH initial assign and reassign — ops see who the engine recommends
          before choosing. Explicit "Auto-" prefix + Sparkles icon makes the
          engine action visually distinct from the generic Edit / Change Owner
          buttons next to it. Manual searchable picker stays available beside as
          a fallback for the "I need this specific person" cases. */}
      {LEGACY_ASSIGN_BUTTONS && canAssign(s) && canPickTech && (
        <Button size="sm" onClick={() => setAutoAssignOpen(true)}>
          <Sparkles className="h-3.5 w-3.5 mr-1" />
          {isReassign ? 'Auto-reassign' : 'Auto-assign'}
        </Button>
      )}
      {LEGACY_ASSIGN_BUTTONS && canAssign(s) && canPickTech && (
        <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
          <Search className="h-3.5 w-3.5 mr-1" />
          Manual pick
        </Button>
      )}
      {canChangeOwner(s)    && can.isJobEdit && <Button size="sm" variant="outline" onClick={() => setOwnerOpen(true)}>Change Owner</Button>}
      {/* Reschedule only makes sense AFTER the job has been assigned a
          slot (SCHEDULED, status=1) and BEFORE the technician starts
          (status >= IN_PROGRESS would conflict with the in-flight job).
          Reduced from "any non-closed status" to status===SCHEDULED
          per 2026-05-26 ops feedback. Each reschedule writes a row to
          tbl_job_comment with appointment_on set (the existing comment
          POST already does this), which the JobRescheduleHistory
          component surfaces in the Summary tab. */}
      {can.isJobEdit && s === ST.SCHEDULED && <Button size="sm" variant="outline" onClick={() => setRescheduleOpen(true)}>Reschedule</Button>}
      {can.isJobEdit && <Button size="sm" variant="outline" onClick={() => setDescOpen(true)}>Edit Description</Button>}
      {/* Feedback is only relevant after the job has reached a terminal
          state — COMPLETED (3 or 5) or CANCELLED (6). Logging customer
          feedback against an in-progress job lets ops capture sentiment
          before the work is done, which legacy operators flagged as
          mistake-prone. */}
      {can.isJobEdit && (isJobClosed(s) || s === ST.CANCELLED) && <Button size="sm" variant="outline" onClick={() => setFeedbackOpen(true)}>Feedback</Button>}
      {canStart(s)          && can.isJobStatusChange && <LoadBtn size="sm" variant="outline" loading={busy === 'start'}      onClick={() => doStatus('start', ST.IN_PROGRESS)}>Start</LoadBtn>}
      {canComplete(s)       && can.isJobStatusChange && <LoadBtn size="sm" variant="outline" loading={busy === 'complete'}   onClick={() => doStatus('complete', ST.COMPLETED)}>Complete</LoadBtn>}
      {canCancel(s)         && can.isJobCancel       && <Button size="sm" variant="destructive" onClick={() => setCancelOpen(true)}>Cancel</Button>}
      {canMarkIncomplete(s) && can.isJobStatusChange && <LoadBtn size="sm" variant="outline" loading={busy === 'incomplete'} onClick={() => doStatus('incomplete', ST.REVISIT, undefined, 'Marked incomplete from CRM')}>Mark InComplete</LoadBtn>}

      <AssignDialog
        open={assignOpen} onClose={() => setAssignOpen(false)}
        currentTech={job.fk_easyfixter_id as number | null}
        onSubmit={async (efrId) => {
          await api.patch(`/admin/jobs/${jobId}/assign`, { easyfixerId: efrId });
          setAssignOpen(false); onChanged();
        }}
      />
      <AutoAssignDialog
        open={autoAssignOpen} onClose={() => setAutoAssignOpen(false)}
        jobId={jobId}
        currentTech={job.fk_easyfixter_id as number | null}
        onAssigned={() => { setAutoAssignOpen(false); onChanged(); }}
      />
      <ChangeOwnerDialog
        open={ownerOpen} onClose={() => setOwnerOpen(false)}
        onSubmit={async (newOwnerId, reason) => {
          await api.patch(`/admin/jobs/${jobId}/owner`, { newOwnerId, reason });
          setOwnerOpen(false); onChanged();
        }}
      />
      {/* Audited reschedule: goes through PATCH /admin/jobs/:id/reschedule →
          job.reschedule (derives the slot columns, logs reason+remarks to
          scheduling_history + a tbl_job_comment with appointment_on so the
          JobRescheduleHistory trail still populates, and expires open offers).
          Replaces the old generic PATCH /:id path which skipped all of that. */}
      <ApptRescheduleDialog
        open={rescheduleOpen}
        jobId={jobId}
        onClose={() => setRescheduleOpen(false)}
        onDone={() => { setRescheduleOpen(false); onChanged(); }}
      />
      <ChangeDescriptionDialog
        open={descOpen} onClose={() => setDescOpen(false)}
        initialDesc={String(job.job_desc ?? '')}
        onSubmit={async (desc) => {
          await api.patch(`/admin/jobs/${jobId}`, { job_desc: desc });
          setDescOpen(false); onChanged();
        }}
      />
      <CancelWithReasonDialog
        open={cancelOpen} onClose={() => setCancelOpen(false)}
        onSubmit={async (reasonId, comment) => {
          await api.patch(`/admin/jobs/${jobId}/status`, {
            status: ST.CANCELLED, reasonId, comment,
          });
          showToast({ variant: 'success', message: 'Job Cancelled' });
          setCancelOpen(false); onChanged();
        }}
      />
      <FeedbackDialog
        open={feedbackOpen} onClose={() => setFeedbackOpen(false)}
        jobId={jobId}
        onSaved={() => { setFeedbackOpen(false); onChanged(); }}
      />
    </div>
  );
}

// ─── View body (tabbed read-only display) ────────────────────────────────────

function ViewBody({ job, onRefresh, initialTab, onDirtyChange, commentsRefreshKey = 0, pendingComments = [], onCommentsLoaded }: { job: Job; onRefresh?: () => void; initialTab?: string; onDirtyChange?: (dirty: boolean) => void; commentsRefreshKey?: number; pendingComments?: Array<JobComment & { _pending?: true }>; onCommentsLoaded?: () => void }) {
  const images = Array.isArray((job as Record<string, unknown>).images)
    ? ((job as Record<string, unknown>).images as Array<Record<string, unknown>>)
    : [];
  /*
   * Whitelist of recognised tab values so a malformed `?tab=` URL can't
   * leave the Tabs widget in an unrenderable state (no panel matches).
   * Anything not in this set falls back to 'summary'.
   */
  const KNOWN_TABS = new Set(['summary', 'services', 'schedule', 'images', 'questionnaire', 'comments', 'materials', 'quotations']);
  const startingTab = initialTab && KNOWN_TABS.has(initialTab) ? initialTab : 'summary';
  return (
    <Tabs defaultValue={startingTab}>
      <TabsList>
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="services">Services ({Array.isArray(job.services) ? job.services.length : 0})</TabsTrigger>
        <TabsTrigger value="schedule">Schedule</TabsTrigger>
        <TabsTrigger value="images">Images ({images.length})</TabsTrigger>
        <TabsTrigger value="questionnaire">Questionnaire</TabsTrigger>
        <TabsTrigger value="comments">Comments</TabsTrigger>
        <TabsTrigger value="materials">Materials</TabsTrigger>
        <TabsTrigger value="quotations">Quotations</TabsTrigger>
      </TabsList>

      <TabsContent value="summary">
        {/* Customer Cancel/Reschedule requests — attention banner pinned
            to the top of the Summary tab so ops action pending asks
            before anything else. Renders nothing when there are none. */}
        <JobCustomerRequests jobId={Number(job.job_id)} jobStatus={Number(job.job_status)} onJobChanged={onRefresh} />
        {/* 3-column layout (2026-05-26 per ops): packs the four short
            DlCards (Customer / Client / Job meta / Audit & History) into
            a denser grid so the page doesn't read as half-empty. Address
            spans the full second row since its values are long. On
            narrower screens the grid collapses gracefully (lg→md→sm). */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <DlCard title="Customer" rows={[
            ['Name', job.customer_name],
            ['Mobile', <CallableMobile key="cust-mob" jobId={Number(job.job_id)} mobile={job.customer_mob_no as string | null} />],
            ['Email', job.customer_email],
            ['Alt Name', (job as Record<string, unknown>).additional_name as string],
            // Alt Number rendered via CallableMobile with useAlt=true so
            // clicking the green chip dials tbl_job.additional_number
            // through the same Kaleyra route the rest of the modal uses.
            // The mobile prop is the masked value (display); the actual
            // dial number is resolved server-side from the job row.
            ['Alt Number', (job as Record<string, unknown>).additional_number ? (
              <CallableMobile
                key="alt-mob"
                jobId={Number(job.job_id)}
                useAlt
                mobile={(job as Record<string, unknown>).additional_number as string | null}
                hideWhenUnauthorized
              />
            ) : ((job as Record<string, unknown>).additional_number as string)],
          ]}/>
          <DlCard title="Client" rows={[
            ['Client', job.client_name],
            ['Ref ID', job.client_ref_id],
            ['SPOC', job.client_spoc_name],
            ['SPOC Email', job.client_spoc_email],
            ['SPOC Phone', job.reporting_contact_id
              ? <CallableMobile
                  key="spoc-mob"
                  reportingContactId={Number(job.reporting_contact_id)}
                  jobContextId={Number(job.job_id)}
                  mobile={job.client_spoc as string | null}
                />
              : (job.client_spoc as string | null)],
          ]}/>
          <DlCard title="Job Meta" rows={[
            // No ⓘ popup here — the modal's inline "Calling History" section
            // (JobCallHistory below) already shows the full party-aware log.
            ['Job ID', job.job_id],
            ['Reference', job.job_reference_id],
            ['Type', job.job_type],
            ['Source', job.source_type],
            ['Owner', job.owner_name],
            ['Description', job.job_desc],
          ]}/>
          {/* Address — full-width because the address line is long and
              wraps awkwardly inside a one-third column. Includes an
              Edit Address button (gated by isJobEdit + status < IN_PROGRESS)
              that opens the AddressPickerWithMap in dialog form. The
              same status guard the BE PATCH would enforce — we don't
              let an operator open the editor for a job that's already
              started/completed because the technician is on the move. */}
          <div className="md:col-span-2 lg:col-span-2">
            <JobAddressCard job={job} onSaved={onRefresh} />
          </div>
          {/* Audit & History — one-third on lg, full-width below. */}
          <DlCard title="Audit & History" rows={[
            ['Created By', job.created_by_name],
            ['Created On', formatDate(job.created_date_time as string)],
            ['Approval Sent', formatDate((job as Record<string, unknown>).approval_sent_on_date_time as string)],
            ['Approved On', formatDate((job as Record<string, unknown>).approved_on_date_time as string)],
            ['Approved By', (job as Record<string, unknown>).approved_by_client_contact as string],
            ['Rejected On', formatDate((job as Record<string, unknown>).approval_reject_date_time as string)],
            ['Last Updated', formatDate((job as Record<string, unknown>).last_update_time as string)],
          ]}/>
        </div>
        <JobRescheduleHistory jobId={Number(job.job_id)} />
        <JobCallHistory jobId={Number(job.job_id)} />
      </TabsContent>

      <TabsContent value="services">
        <ServicesTabBody job={job} onMutated={onRefresh} onDirtyChange={onDirtyChange} />
      </TabsContent>

      <TabsContent value="schedule">
        <div className="grid md:grid-cols-2 gap-5">
          <DlCard title="Timeline" rows={[
            ['Requested', formatDate(job.requested_date_time as string)],
            ['Scheduled', formatDate(job.scheduled_date_time as string)],
            ['Check-in',  formatDate(job.checkin_date_time  as string)],
            ['Check-out', formatDate(job.checkout_date_time as string)],
            ['Cancelled', formatDate(job.cancel_date_time   as string)],
            ['Last update', formatDate(job.last_update_time as string)],
          ]}/>
          <DlCard title="Assignment" rows={[
            ['Technician',   job.easyfixer_name ? formatEasyfixerName(String(job.easyfixer_name)) : null],
            // Tech mobile calls dial through tbl_easyfixer.efr_no.
            // fk_easyfixter_id is the FK column (typo preserved per
            // backend CLAUDE.md). When unassigned, the cell shows a
            // static dash via the falsy fallback inside DlCard.
            ['Tech mobile', job.fk_easyfixter_id
              ? <CallableMobile
                  key="tech-mob"
                  efrId={Number(job.fk_easyfixter_id)}
                  jobContextId={Number(job.job_id)}
                  mobile={job.easyfixer_mobile as string | null}
                />
              : (job.easyfixer_mobile as string | null)],
            ['Helper req',   job.helper_req ? 'Yes' : 'No'],
            ['Time slot',    job.time_slot],
          ]}/>
        </div>
        {/* Reached-location selfie (proof of arrival). Renders nothing when the
            job has no selfie — see TechnicianSelfieTile. */}
        <TechnicianSelfieTile
          jobId={Number(job.job_id)}
          selfieId={(job as Record<string, unknown>).tx_selfie_id}
        />
      </TabsContent>

      {/*
        * Images tab — legacy `jobImg.vm` + `jobImageList.vm`. Data already
        * lives on `job.images` (returned by services/job.service.js::getById
        * line 217). Each row has `image` (filename) which is served by
        * Nginx under `/easydoc/upload_jobs/<filename>` per CLAUDE.md's
        * file-storage table.
        */}
      <TabsContent value="images">
        {/*
         * onChanged is forwarded so the X-delete on each tile can ask the
         * parent to re-fetch the job after a successful DELETE — making
         * the deleted tile disappear without a manual page refresh.
         *
         * Gating (2026-05-28): once a job is in a terminal state — 3
         * COMPLETED, 5 COMPLETED_ALT, 6 CANCELLED, 7 ENQUIRY — image
         * removals would rewrite audit history that finance/clients
         * may already be looking at. We hide the X by not passing
         * onChanged in those states; JobImagesTab interprets the absence
         * as "read-only" and skips the overlay entirely. Active states
         * (BOOKED/SCHEDULED/IN_PROGRESS) plus pre-confirm states
         * (CALL_LATER, REVISIT) keep the X — operators may still need
         * to clean up wrong attachments during confirmation/revisit.
         */}
        <JobImagesTab
          images={images}
          onChanged={[3, 5, 6, 7].includes(Number(job.job_status)) ? undefined : onRefresh}
        />
      </TabsContent>

      {/*
        * Questionnaire Answers tab — legacy `jobQuestionaireAnswerList.vm`.
        * Backend: GET /admin/questionnaires/answers/:jobId.
        */}
      <TabsContent value="questionnaire">
        <JobQuestionnaireTab jobId={job.job_id as number} />
      </TabsContent>

      {/* Comments tab — legacy `jobComment.vm` + `jobCommentList.vm`.
          Backend: GET/POST /admin/jobs/:id/comments (tbl_job_comment).
          comment_on stages: 1=created, 2=check_in, 3=check_out, 4=in_progress. */}
      <TabsContent value="comments">
        <JobCommentsTab
          jobId={job.job_id as number}
          refreshKey={commentsRefreshKey}
          pendingComments={pendingComments}
          onLoaded={onCommentsLoaded}
        />
        {/* commentsRefreshKey is bumped by the JobModal-level AddRemarksDialog
            onSaved (see ~line 514); prop-drilled through ViewBody so the
            Comments tab refetches the moment a remark lands, without
            needing to be re-mounted. `pendingComments` carries the optimistic
            row the dialog stamps on Save-click (~line 524) so it renders
            instantly at the top of the list with a "Sending…" pill — once
            the refetch completes, `onCommentsLoaded` fires and the parent
            clears pendings so they're replaced by the canonical rows. */}
      </TabsContent>

      {/* Materials tab — legacy `material.vm` + MaterialAction.java.
          Backend: GET /admin/aux/materials/job/:jobId, POST /admin/aux/materials,
          DELETE /admin/aux/materials/:id (job_material table). */}
      <TabsContent value="materials">
        <JobMaterialsTab jobId={job.job_id as number} jobStatus={Number(job.job_status)} />
      </TabsContent>

      {/* Quotations tab — read-only list of product+material quotations against
          this job. Backend: GET /admin/quotations?jobId=… (quotation_details table).
          Create/edit deferred — typical flow is technician submits via mobile app. */}
      <TabsContent value="quotations">
        <JobQuotationsTab jobId={job.job_id as number} />
      </TabsContent>
    </Tabs>
  );
}

// ─── Quotations tab ─────────────────────────────────────────────────
// Quotation rows come from `quotation_details` (legacy + ACD_APIs schema).
// Columns observed: id, job_id, quotation_type ('product'|'material'),
// product_name / material_name, quantity, unit_price, total_price,
// status, insert_date. Schema varies — we render any subset gracefully.
type QuotationRow = Record<string, unknown> & {
  id: number;
  job_id: number | null;
  quotation_type?: string | null;
  product_name?: string | null;
  material_name?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  client_charge?: number | string | null;
  total_price?: number | string | null;
  status?: string | null | number;
  insert_date?: string | null;
};

/*
 * JobAddressCard — read-only Address summary + an Edit button gated
 * by (isJobEdit OR Admin role) AND status < IN_PROGRESS. Clicking the
 * button opens a modal that hosts the shared AddressPickerWithMap;
 * on submit it PATCHes /admin/jobs/:id with the address payload. The
 * BE validator already accepts the full address block (see earlier
 * extension for address_instruction).
 *
 * Status gating mirrors what ops asked for (2026-05-26): once the
 * technician has started the job (status >= 2) the destination is
 * effectively locked because the tech is already en route or on-site.
 */
function JobAddressCard({ job, onSaved }: { job: Job; onSaved?: () => void }) {
  const { me } = useMe();
  const can = actionFlags(me, ['isJobEdit']);
  const status = Number(job.job_status);
  // Editable status set: BOOKED(0), SCHEDULED(1), ENQUIRY(7),
  // CALL_LATER(9), REVISIT(10). Block IN_PROGRESS(2), COMPLETED(3,5),
  // CANCELLED(6).
  const editableStatuses = new Set([
    ST.BOOKED, ST.SCHEDULED, ST.ENQUIRY, ST.CALL_LATER, ST.REVISIT,
  ]);
  const canEditAddress = can.isJobEdit && editableStatuses.has(status as never);
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="rounded-lg border bg-card p-3 h-full">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium">Address</div>
          {canEditAddress && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="!h-7 !px-2 text-xs">
              <Pencil className="size-3 mr-1" /> Edit Address
            </Button>
          )}
        </div>
        <dl className="text-sm divide-y divide-border">
          <DlRow label="Service Address" value={formatServiceAddress(job)} />
          <DlRow label="GPS" value={job.gps_location} />
        </dl>
      </div>
      {open && (
        <JobAddressEditDialog
          job={job}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onSaved?.(); }}
        />
      )}
    </>
  );
}

/*
 * DlRow — single description-list row matching the look-and-feel of
 * the legacy DlCard rows (label left, value right). Used only inside
 * JobAddressCard so it doesn't need to be exported.
 */
function DlRow({ label, value }: { label: string; value: unknown }) {
  const display = value == null || value === '' ? '—' : String(value);
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{display}</dd>
    </div>
  );
}

/*
 * JobAddressEditDialog — wraps the shared AddressPickerWithMap in a
 * modal so the same UI ops uses on Book New Call is available for
 * post-creation edits. PATCH body shape matches the existing
 * address-edit branch in services/job.service.js#update.
 *
 * Exported so JobTransactionView (the Unconfirmed-job single-page
 * view) can reuse it without duplicating the picker + submit logic.
 */
export function JobAddressEditDialog({ job, onClose, onSaved }: {
  job: Job; onClose: () => void; onSaved: () => void;
}) {
  const lk = useLookup();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    address: String(job.address ?? ''),
    building: String(job.building ?? ''),
    landmark: String(job.landmark ?? ''),
    city_id: String((job as Record<string, unknown>).city_id ?? ''),
    pin_code: String(job.pin_code ?? ''),
    gps_location: String(job.gps_location ?? ''),
    address_instruction: String((job as Record<string, unknown>).address_instruction ?? ''),
  });
  async function submit() {
    if (!draft.address || !draft.city_id || !draft.pin_code) {
      showToast({ variant: 'error', message: 'Address, City and PIN are required' });
      return;
    }
    if (!/^[0-9]{6}$/.test(draft.pin_code)) {
      showToast({ variant: 'error', message: 'PIN must be exactly 6 digits' });
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/admin/jobs/${job.job_id}`, {
        address: {
          address: draft.address,
          building: draft.building || undefined,
          landmark: draft.landmark || undefined,
          city_id: Number(draft.city_id) || undefined,
          pin_code: draft.pin_code,
          gps_location: draft.gps_location || undefined,
          address_instruction: draft.address_instruction || undefined,
        },
      });
      showToast({ variant: 'success', message: 'Address Updated' });
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to update address' });
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="!max-w-5xl !max-h-[calc(100vh-48px)] !h-[calc(100vh-48px)] flex flex-col !p-0 gap-0 overflow-hidden">
        <DialogHeader className="!mx-0 !mt-0 !mb-0 px-6 py-4 shrink-0">
          <DialogTitle>Edit Address · Job #{job.job_id}</DialogTitle>
        </DialogHeader>
        <div className="p-4 flex-1 overflow-y-auto">
          <AddressPickerWithMap
            value={draft}
            onChange={(next) => setDraft({
              address: next.address,
              building: next.building || '',
              landmark: next.landmark || '',
              city_id: String(next.city_id || ''),
              pin_code: next.pin_code,
              gps_location: next.gps_location,
              address_instruction: next.address_instruction || '',
            })}
            cities={lk.toOpts.cities.map((o) => ({ value: String(o.value), label: String(o.label) }))}
          />
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save Address'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * JobRescheduleHistory — surfaces every entry on tbl_job_comment that
 * carries an `appointment_on` value, which is the canonical reschedule
 * trail (the legacy CRM wrote one row per reschedule). Falls back to
 * empty list when no rows or the endpoint isn't reachable.
 */
/*
 * JobCustomerRequests — attention banner for customer-initiated Cancel /
 * Reschedule requests on this job. The customer (via the public/client
 * surface) can ask ops to cancel or reschedule a booked job; the BE
 * records each as a row in tbl_job customer-request store and exposes
 * them at GET /admin/jobs/:id/customer-requests (newest first).
 *
 * This component renders a prominent banner at the TOP of the Summary
 * tab so ops can't miss a pending ask — amber for reschedule, rose for
 * cancel. Each pending request gets Mark Actioned / Dismiss buttons that
 * PATCH /admin/customer-requests/:id then refetch. Non-pending requests
 * collapse into a subtle one-line history. If there are no requests at
 * all the component renders nothing (no empty box).
 *
 * Action buttons are gated by the same edit capability the modal uses
 * elsewhere (isJobEdit + job-not-closed) — view-only users still see the
 * banner but without the action controls.
 */
type CustomerRequest = {
  request_id: number;
  request_type: 'cancel' | 'reschedule';
  reason?: string | null;
  remarks?: string | null;
  preferred_datetime?: string | null;
  request_status: 'pending' | 'actioned' | 'dismissed';
  created_at?: string | null;
};

function JobCustomerRequests({ jobId, jobStatus, onJobChanged }: { jobId: number; jobStatus: number; onJobChanged?: () => void }) {
  const { data, error, refetch } = useFetch<CustomerRequest[] | { items?: CustomerRequest[] }>(
    `/admin/jobs/${jobId}/customer-requests`,
  );
  const { me } = useMe();
  const can = actionFlags(me, ['isJobEdit']);
  // Same gate the modal's other write surfaces use: edit capability AND
  // the job is not in a terminal-completion state.
  const canAct = can.isJobEdit && !isJobClosed(jobStatus);
  const [busyId, setBusyId] = useState<number | null>(null);
  // The reschedule request the operator chose to APPLY — opens the audited
  // reschedule dialog pre-filled from the request. null = dialog closed.
  const [applyReq, setApplyReq] = useState<CustomerRequest | null>(null);

  const rows: CustomerRequest[] = useMemo(
    () => (Array.isArray(data) ? data : (data?.items ?? [])),
    [data],
  );
  const pending = rows.filter((r) => r.request_status === 'pending');
  const history = rows.filter((r) => r.request_status !== 'pending');

  // Render nothing when the job has no customer requests at all.
  if (error || rows.length === 0) return null;

  async function act(id: number, request_status: 'actioned' | 'dismissed') {
    setBusyId(id);
    try {
      await api.patch(`/admin/customer-requests/${id}`, { request_status });
      await refetch();
      showToast({
        variant: 'success',
        message: request_status === 'actioned' ? 'Request Marked Actioned.' : 'Request Dismissed.',
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to update request' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mb-4 space-y-2">
      {pending.map((r) => {
        const isCancel = r.request_type === 'cancel';
        const band = isCancel
          ? 'border-rose-300 bg-rose-50'
          : 'border-amber-300 bg-amber-50';
        return (
          <div key={r.request_id} className={`rounded-lg border px-4 py-3 ${band}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusChip tone={isCancel ? 'rose' : 'amber'} size="sm">
                    {isCancel ? 'Cancellation' : 'Reschedule'}
                  </StatusChip>
                  <span className="text-sm font-semibold">
                    Customer Requested {isCancel ? 'Cancellation' : 'Reschedule'}
                  </span>
                </div>
                <div className="mt-1.5 space-y-0.5 text-xs text-slate-700">
                  {r.reason ? <div><span className="font-medium">Reason:</span> {r.reason}</div> : null}
                  {r.remarks ? <div><span className="font-medium">Remarks:</span> {r.remarks}</div> : null}
                  {!isCancel && r.preferred_datetime ? (
                    <div><span className="font-medium">Preferred:</span> {formatDate(r.preferred_datetime)}</div>
                  ) : null}
                  {r.created_at ? (
                    <div className="text-slate-500">Requested {formatDate(r.created_at)}</div>
                  ) : null}
                </div>
              </div>
              {canAct && (
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {/* One-click apply: reschedule the job to the customer's
                      requested date via the AUDITED /reschedule endpoint
                      (offer-expiry + scheduling_history), pre-filled so Ops
                      only confirms the reason. Only for reschedule requests
                      that carry a preferred date. */}
                  {!isCancel && r.preferred_datetime && (
                    <Button size="sm" onClick={() => setApplyReq(r)}>
                      Apply Requested Date &amp; Reschedule
                    </Button>
                  )}
                  <div className="flex gap-2">
                    <LoadBtn
                      size="sm"
                      loading={busyId === r.request_id}
                      onClick={() => act(r.request_id, 'actioned')}
                    >
                      Mark Actioned
                    </LoadBtn>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === r.request_id}
                      onClick={() => act(r.request_id, 'dismissed')}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {/* Resolved requests collapse into a subtle history line so they
          don't compete with pending asks for attention. */}
      {history.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {history.map((r, i) => (
            <span key={r.request_id}>
              {i > 0 ? ' · ' : ''}
              {r.request_type === 'cancel' ? 'Cancellation' : 'Reschedule'} {r.request_status}
              {r.created_at ? ` (${formatDate(r.created_at)})` : ''}
            </span>
          ))}
        </div>
      )}
      {/* Audited reschedule dialog, pre-filled from the request the operator
          chose to apply. On success it marks that request actioned and
          refreshes both this banner and the parent job view (new appointment). */}
      <ApptRescheduleDialog
        open={!!applyReq}
        jobId={applyReq ? jobId : null}
        initialDateTime={
          applyReq?.preferred_datetime
            ? String(applyReq.preferred_datetime).slice(0, 16).replace(' ', 'T')
            : ''
        }
        initialRemarks={
          applyReq
            ? `Customer requested reschedule${applyReq.reason ? `: ${applyReq.reason}` : ''}${applyReq.remarks ? ` — ${applyReq.remarks}` : ''}`
            : ''
        }
        onClose={() => setApplyReq(null)}
        onDone={async () => {
          const req = applyReq;
          if (req) {
            try {
              await api.patch(`/admin/customer-requests/${req.request_id}`, { request_status: 'actioned' });
            } catch {
              // Non-fatal: the reschedule already applied via the audited
              // endpoint. The request stays pending so Ops can Mark Actioned
              // manually.
            }
          }
          await refetch();
          onJobChanged?.();
        }}
      />
    </div>
  );
}

function JobRescheduleHistory({ jobId }: { jobId: number }) {
  type JobComment = Record<string, unknown> & {
    comment_id?: number;
    appointment_on?: string | null;
    comments?: string | null;
    commented_by_name?: string | null;
    created_on?: string | null;
  };
  const { data } = useFetch<JobComment[] | { items?: JobComment[] }>(`/admin/jobs/${jobId}/comments`);
  const rows: JobComment[] = useMemo(() => {
    const arr = Array.isArray(data) ? data : (data?.items ?? []);
    return arr.filter((r) => r.appointment_on);
  }, [data]);
  return (
    <div className="mt-5">
      <div className="font-medium text-sm mb-1">Rescheduling History</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground rounded border border-dashed px-3 py-2">
          No reschedules recorded.
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Rescheduled To</th>
                <th className="!text-left">By</th>
                <th className="!text-left">On</th>
                <th className="!text-left">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.comment_id ?? i}>
                  <td className="text-xs">{formatDate(r.appointment_on as string)}</td>
                  <td className="text-xs">{r.commented_by_name ?? '—'}</td>
                  <td className="text-xs">{formatDate(r.created_on as string)}</td>
                  <td className="text-xs">{r.comments ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/*
 * JobCallHistory — the job's call log, inline in the detail modal. Uses the
 * SAME job-scoped /admin/calls endpoint + shared CallHistoryTable as the ⓘ
 * popup on the Job ID row, so the party-aware "With" column shows here too.
 *
 * Was previously pointed at /admin/calls/preview, which returns a single
 * preview object ({mode, dialFrom, dialTo, provider}) — never an items list —
 * so this section rendered "No calls recorded" for EVERY job. Fixed 2026-07-03.
 */
function JobCallHistory({ jobId }: { jobId: number }) {
  const { data, loading, error } = useFetch<{ items?: CallRow[] }>(`/admin/calls?jobId=${jobId}&limit=50`);
  if (error) return null; // graceful hide on failure
  const items = data?.items ?? [];
  return (
    <div className="mt-5">
      <div className="font-medium text-sm mb-1">Calling History</div>
      <div className="rounded-lg border bg-card overflow-hidden px-3 py-1">
        <CallHistoryTable items={items} loading={loading} />
      </div>
    </div>
  );
}

function JobQuotationsTab({ jobId }: { jobId: number }) {
  // Migrated to the mandatory shared `useFetch` hook (per memory
  // `feedback_crm_ui_fetch_hooks`). The hook handles dedup, cleanup
  // and StrictMode double-fire. `refetch` is renamed to `reload` for
  // call-site clarity inside the approve/reject handlers below.
  const { data, loading, error, refetch } = useFetch<QuotationRow[]>(`/admin/quotations?jobId=${jobId}`);
  const rows: QuotationRow[] = Array.isArray(data) ? data : [];
  const reload = refetch;
  const [busyId, setBusyId] = useState<number | null>(null);
  const confirm = useConfirm();
  // RBAC — Approve/Reject is a new admin write surface (legacy CRM had
  // only the client-side approval flow). Gated by `isQuotationApprove`,
  // seeded by 2026-05-26-add-finance-quotation-write-actions.sql.
  const { me } = useMe();
  const can = actionFlags(me, ['isQuotationApprove']);

  // Approve flow — BE expects { approvedCharge: number }. We surface
  // the proposed amount in the QuotationApproveDialog so ops can edit
  // it before submitting. State for the dialog lives on the tab so
  // multiple rows can re-use it.
  const [approvingRow, setApprovingRow] = useState<QuotationRow | null>(null);
  async function submitApproval(approvedCharge: number) {
    if (!approvingRow) return;
    if (!Number.isFinite(approvedCharge) || approvedCharge < 0) {
      showToast({ variant: 'error', message: 'Invalid amount' });
      return;
    }
    setBusyId(Number(approvingRow.id));
    try {
      await api.patch(`/admin/quotations/${approvingRow.id}/approve`, { approvedCharge });
      showToast({ variant: 'success', message: 'Quotation Approved' });
      setApprovingRow(null);
      await reload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusyId(null); }
  }
  function approveRow(r: QuotationRow) {
    setApprovingRow(r);
  }

  async function rejectRow(r: QuotationRow) {
    const ok = await confirm({
      title: 'Reject Quotation?',
      description: 'The technician will be notified and asked to resubmit if needed.',
      confirmLabel: 'Reject',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(Number(r.id));
    try {
      await api.patch(`/admin/quotations/${r.id}/reject`, {});
      showToast({ variant: 'success', message: 'Quotation Rejected' });
      await reload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusyId(null); }
  }

  if (loading) return <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>;
  if (error)   return <div className="text-sm text-red-600 py-3">{error}</div>;
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No quotations recorded for this job. Quotations are typically submitted by the technician via the mobile app.
      </div>
    );
  }

  const total = rows.reduce((sum, r) => sum + (Number(r.total_price) || 0), 0);

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        {rows.length} quotation row{rows.length === 1 ? '' : 's'} · Total: ₹{total.toFixed(2)}
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-center w-12">#</th>
              <th className="!text-left">Type</th>
              <th className="!text-left">Item</th>
              <th className="!text-right">Qty</th>
              <th className="!text-right">Unit ₹</th>
              <th className="!text-right">Total ₹</th>
              <th className="!text-center">Status</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const type = String(r.quotation_type ?? '—');
              const name = String(r.product_name ?? r.material_name ?? '—');
              // BE status code map (legacy):
              //   0 = Pending Approval, 1 = Approved, 2 = Rejected.
              // Buttons only show on pending rows.
              const status = Number(r.status ?? 0);
              const isPending = status === 0;
              const isApproved = status === 1;
              const isRejected = status === 2;
              const busy = busyId === Number(r.id);
              return (
                <tr key={r.id}>
                  <td className="!text-center text-xs text-muted-foreground">{i + 1}</td>
                  <td className="!text-left text-xs">
                    <span className="inline-block bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">{type}</span>
                  </td>
                  <td className="!text-left">{name}</td>
                  <td className="!text-right font-mono text-xs">{String(r.quantity ?? '')}</td>
                  <td className="!text-right font-mono text-xs">{r.unit_price != null ? Number(r.unit_price).toFixed(2) : '—'}</td>
                  <td className="!text-right font-mono">{r.total_price != null ? Number(r.total_price).toFixed(2) : '—'}</td>
                  <td className="!text-center text-xs">
                    {isApproved && <span className="inline-block bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5">Approved</span>}
                    {isRejected && <span className="inline-block bg-rose-50 text-rose-700 rounded px-1.5 py-0.5">Rejected</span>}
                    {isPending  && <span className="inline-block bg-amber-50 text-amber-700 rounded px-1.5 py-0.5">Pending</span>}
                  </td>
                  <td className="!text-right">
                    {isPending && can.isQuotationApprove ? (
                      <div className="inline-flex gap-1 justify-end">
                        <button
                          type="button"
                          className="text-xs px-2 py-1 rounded border bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                          onClick={() => approveRow(r)}
                          disabled={busy}
                        >
                          {busy ? '…' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          className="text-xs px-2 py-1 rounded border bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                          onClick={() => rejectRow(r)}
                          disabled={busy}
                        >
                          {busy ? '…' : 'Reject'}
                        </button>
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <QuotationApproveDialog
        row={approvingRow}
        onClose={() => setApprovingRow(null)}
        onSubmit={submitApproval}
      />
    </div>
  );
}

/*
 * QuotationApproveDialog — modal alternative to a native window.prompt
 * for capturing the final agreed amount. Number input with min=0 +
 * step=0.01 + autofocus; submits on Enter.
 */
function QuotationApproveDialog({ row, onClose, onSubmit }: {
  row: QuotationRow | null; onClose: () => void; onSubmit: (n: number) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (row) {
      const proposed = Number(row.client_charge ?? row.unit_price ?? 0);
      setValue(proposed > 0 ? proposed.toFixed(2) : '');
    }
  }, [row]);
  if (!row) return null;
  return (
    <Dialog open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Approve Quotation #{row.id}</DialogTitle></DialogHeader>
        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            Set the final agreed charge (₹). The technician will be notified.
          </div>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(Number(value)); }}
            className="font-mono"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onSubmit(Number(value))} disabled={!value}>Approve</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Materials tab ──────────────────────────────────────────────────
type JobMaterial = {
  id: number;
  job_id: number;
  material_name: string;
  description: string | null;
  sku: string | null;
  unit: string | null;
  unit_price: number | null;
  total_price: number | null;
};

/*
 * Per-service charge breakdown — fetched lazily on tab open from
 * GET /admin/jobs/:id/service-breakdown. The Show Breakdown control
 * on each service row reveals an inline cascade summary (per-unit +
 * line total). One network call covers all rows on the job.
 */
type ServiceBreakdownLayer = { variableAmt: number; fixedAmt: number; total: number };
type ServiceBreakdownLine = {
  job_service_id: number;
  service_type_name: string | null;
  service_category_name: string | null;
  quantity: number;
  perUnit: {
    totalCharge: number;
    easyfixDirect: ServiceBreakdownLayer;
    overhead:      ServiceBreakdownLayer;
    clientShare:   ServiceBreakdownLayer;
    remainder: number;
  };
  lineTotal: {
    totalCharge: number;
    easyfixDirect: ServiceBreakdownLayer;
    overhead:      ServiceBreakdownLayer;
    clientShare:   ServiceBreakdownLayer;
    remainder: number;
  };
};
type ServiceBreakdownResponse = {
  job_id: number;
  lineItems: ServiceBreakdownLine[];
  totals: { totalCharge: number; easyfixDirect: number; overhead: number; clientShare: number; remainder: number };
};

/*
 * Module-level breakdown cache (2026-05-26). The Services tab opens
 * with whatever is in cache (instant render); when the operator
 * performs an action that could mutate cost (Remove / Restore /
 * material change) we explicitly invalidate so the next Show
 * Breakdown click refetches. Soft TTL = 60s as a safety net for
 * cross-job staleness.
 */
const SERVICE_BREAKDOWN_CACHE = new Map<number, { at: number; data: ServiceBreakdownResponse }>();
const SERVICE_BREAKDOWN_TTL_MS = 60_000;
function readBreakdownCache(jobId: number): ServiceBreakdownResponse | null {
  const hit = SERVICE_BREAKDOWN_CACHE.get(jobId);
  if (!hit) return null;
  if (Date.now() - hit.at > SERVICE_BREAKDOWN_TTL_MS) {
    SERVICE_BREAKDOWN_CACHE.delete(jobId);
    return null;
  }
  return hit.data;
}
function writeBreakdownCache(jobId: number, data: ServiceBreakdownResponse) {
  SERVICE_BREAKDOWN_CACHE.set(jobId, { at: Date.now(), data });
}
function invalidateBreakdownCache(jobId: number) {
  SERVICE_BREAKDOWN_CACHE.delete(jobId);
}

function ServicesTabBody({ job, onMutated, onDirtyChange }: { job: Job; onMutated?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const services = Array.isArray(job.services) ? job.services : [];
  // Active vs. inactive split — operators get a "Show Inactive" toggle
  // so the soft-deleted rows can be inspected (and restored when we
  // add that affordance).
  const [showInactive, setShowInactive] = useState(false);
  const visible = useMemo(() => {
    const arr = (services as Array<Record<string, unknown>>);
    return showInactive ? arr : arr.filter((s) => Number(s.job_service_status) !== 0);
  }, [services, showInactive]);

  // Inline Add-Service panel state (replaces the old AddJobServiceDialog).
  // Inline panel chosen over modal because (a) operators told us the
  // extra click + context switch was friction-heavy, and (b) nesting a
  // second Dialog on top of JobModal burns Z-index real estate. The
  // inline panel restores the FULL capability the old modal had:
  // Category → Service Type(s) cascade and a Job Type multi-select.
  // The service picker itself now reuses AutoServicesTable for +/×
  // parity with Book New Call / Confirm & Schedule — the operator picks
  // Service Type(s), the catalog rows auto-populate as candidates, and
  // they "+" the ones they want (with a qty + "×" remove) before
  // committing the batch.
  const clientIdForCatalog = Number((job as Record<string, unknown>).fk_client_id);
  const catalogUrl = clientIdForCatalog > 0
    ? `/shared/lookup/client-services?clientId=${clientIdForCatalog}`
    : null;
  // The endpoint returns the FULL ClientService row, so we type the
  // catalog as ClientService[] — the exact shape AutoServicesTable
  // consumes (no cast needed at the call site).
  const { data: catalogRaw } = useFetch<ClientService[] | { items?: ClientService[] }>(catalogUrl);
  const catalog: ClientService[] = useMemo(() => (
    Array.isArray(catalogRaw) ? catalogRaw : ((catalogRaw as { items?: ClientService[] } | null)?.items ?? [])
  ), [catalogRaw]);
  const [addCatgId, setAddCatgId] = useState<string>('');
  const [addTypeIds, setAddTypeIds] = useState<string[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  // Synchronous re-entrancy guard. `addBusy` is React state, so a fast
  // double-click can fire submitInlineAdd() twice before the disabled
  // re-render paints — double-POSTing the whole basket. This ref flips
  // synchronously on the first call and blocks the second within the
  // same tick (the disabled+addBusy button covers the slower case).
  const addInFlightRef = React.useRef(false);
  // Authoritative basket — the same ServiceRow[] contract AutoServicesTable
  // owns. AutoServicesTable assigns each row's tempId internally on "+",
  // so we just hold the array here. Reuses AutoServicesTable for +/×
  // parity with Book New Call / Confirm & Schedule.
  const [addRows, setAddRows] = useState<ServiceRow[]>([]);
  // Job Type mirrors the per-job CSV (tbl_job.job_type), initialised
  // from the job. On Add, if it changed, we PATCH the job alongside the
  // service inserts — identical to the old modal's behaviour. Vocabulary
  // is the same fixed 3-value set the modal used (matches Book New Call).
  const initialJobTypes = useMemo(() => {
    const csv = String((job as Record<string, unknown>).job_type ?? '');
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
  }, [job]);
  const [pickedJobTypes, setPickedJobTypes] = useState<string[]>(initialJobTypes);
  // Reset Type picks AND the basket when Category changes — stale
  // selections from another category would silently bleed into the add.
  useEffect(() => { setAddTypeIds([]); setAddRows([]); }, [addCatgId]);
  // Drop the basket on a Type change so the operator can't accidentally
  // submit rows for service types that are no longer picked.
  useEffect(() => { setAddRows([]); }, [addTypeIds]);
  const addCategories = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of catalog) {
      if (c.service_catg_id != null && c.service_catg_name) {
        m.set(String(c.service_catg_id), c.service_catg_name);
      }
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [catalog]);
  const addTypes = useMemo(() => {
    if (!addCatgId) return [];
    const m = new Map<string, string>();
    for (const c of catalog) {
      if (String(c.service_catg_id) === addCatgId && c.service_type_id != null && c.service_type_name) {
        m.set(String(c.service_type_id), c.service_type_name);
      }
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [catalog, addCatgId]);

  // The committed basket rows — a row "counts" once it has a real
  // client_service_id (i.e. it was "+"-ed in AutoServicesTable) and a
  // positive quantity. Used for the Add-button gate and the submit set.
  const committedAddRows = useMemo(
    () => addRows.filter((r) => r.client_service_id && Number(r.quantity) > 0),
    [addRows],
  );

  async function submitInlineAdd() {
    // Only rows that were actually "+"-ed (real client_service_id) with a
    // positive qty are committed — same gate as the Add button.
    const toAdd = committedAddRows;
    if (toAdd.length === 0) return;
    if (addInFlightRef.current) return; // same-tick double-click guard
    addInFlightRef.current = true;
    setAddBusy(true);
    try {
      // One POST per basket row carrying its chosen quantity.
      // Promise.allSettled so a single 4xx doesn't abort the rest —
      // mirrors the old modal's basket commit. Body shape matches the
      // existing endpoint contract: { service_id, service_type_id,
      // service_category_id, quantity }. service_type_id /
      // service_category_id are resolved from the catalog by
      // client_service_id (same meta-lookup the checklist used).
      const results = await Promise.allSettled(
        toAdd.map((r) => {
          const clientServiceId = Number(r.client_service_id);
          const meta = catalog.find((c) => c.client_service_id === clientServiceId);
          return api.post(`/admin/jobs/${job.job_id}/services`, {
            service_id: clientServiceId,
            service_type_id: meta?.service_type_id ?? null,
            service_category_id: meta?.service_catg_id ?? null,
            quantity: Number(r.quantity),
          });
        }),
      );
      // Apply Job Type to the job per the old-modal behaviour — only
      // when it actually changed from the initial set.
      const newJobTypeCsv = pickedJobTypes.join(',');
      if (newJobTypeCsv !== initialJobTypes.join(',')) {
        try {
          await api.patch(`/admin/jobs/${job.job_id}`, { job_type: newJobTypeCsv });
        } catch (e) {
          showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to update job type' });
        }
      }
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (ok > 0) {
        invalidateBreakdownCache(Number(job.job_id));
        setBreakdown(null);
        showToast({
          variant: fail === 0 ? 'success' : 'error',
          message: fail === 0 ? 'Service(s) added.' : `${ok} added, ${fail} failed`,
        });
        // Clear the panel selections only when at least one row landed —
        // otherwise the operator likely wants to retry the same picks.
        setAddCatgId('');
        setAddTypeIds([]);
        setAddRows([]);
        onMutated?.();
      } else {
        showToast({ variant: 'error', message: 'Failed to add services' });
      }
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to add services' });
    } finally { setAddBusy(false); addInFlightRef.current = false; }
  }

  // ─── Inline qty edit — AUTO-SAVE (no explicit Save button) ───────────
  // pendingQty holds only rows the operator has touched (input value !=
  // server value, or a commit in flight). Auto-save fires on BLUR and on
  // Enter; Escape reverts. We chose auto-save-on-blur over an explicit
  // Save button because ops edit quantities across many rows in a tight
  // loop and the per-row Save click added up — blurring the field (Tab,
  // click elsewhere) is the natural "I'm done with this cell" signal.
  // The unsaved-changes close guard (lifted to JobModal) covers the one
  // failure mode of blur-commit: typing a value and then closing the
  // modal without ever blurring the input.
  const [pendingQty, setPendingQty] = useState<Record<number, number>>({});
  const [savingQtyId, setSavingQtyId] = useState<number | null>(null);
  async function saveQty(jobServiceId: number, qty: number) {
    if (!Number.isFinite(qty) || qty < 1 || qty > 100) {
      showToast({ variant: 'error', message: 'Quantity must be between 1 and 100' });
      return;
    }
    setSavingQtyId(jobServiceId);
    try {
      await api.patch(`/admin/jobs/${job.job_id}/services/${jobServiceId}`, { quantity: qty });
      invalidateBreakdownCache(Number(job.job_id));
      setBreakdown(null);
      setPendingQty((prev) => {
        const next = { ...prev };
        delete next[jobServiceId];
        return next;
      });
      showToast({ variant: 'success', message: 'Quantity updated.' });
      onMutated?.();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to update quantity' });
    } finally { setSavingQtyId(null); }
  }
  // commitQty — shared blur/Enter handler. No-ops when the value is
  // unchanged from the server (avoids a pointless PATCH on a plain Tab
  // through an untouched field) or out of range.
  function commitQty(jobServiceId: number, serverQty: number) {
    const edited = pendingQty[jobServiceId];
    if (edited === undefined || edited === serverQty) return;
    if (!Number.isFinite(edited) || edited < 1 || edited > 100) return;
    if (savingQtyId === jobServiceId) return;
    saveQty(jobServiceId, edited);
  }

  // Lazy fetch of breakdown — opens instantly from module cache if
  // present, otherwise one round-trip on first Show Breakdown click.
  // Cache is shared across all JobModal instances within the session
  // (~60s TTL); any mutating action below explicitly invalidates so
  // the next open refetches.
  const [breakdown, setBreakdown] = useState<ServiceBreakdownResponse | null>(
    () => readBreakdownCache(Number(job.job_id)),
  );
  const [bdLoading, setBdLoading] = useState(false);
  const [openLineId, setOpenLineId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const confirm = useConfirm();
  async function ensureBreakdown(force = false) {
    if (!force && breakdown) return;
    if (bdLoading) return;
    setBdLoading(true);
    try {
      const r = await api.get<ServiceBreakdownResponse>(`/admin/jobs/${job.job_id}/service-breakdown`);
      writeBreakdownCache(Number(job.job_id), r);
      setBreakdown(r);
    } catch {
      // Silent fallback — tooltip just shows "—" if breakdown unavailable.
    } finally { setBdLoading(false); }
  }

  function breakdownFor(jobServiceId: unknown): ServiceBreakdownLine | null {
    if (!breakdown) return null;
    return breakdown.lineItems.find((l) => l.job_service_id === Number(jobServiceId)) ?? null;
  }

  // Mutating helpers — Remove (soft-delete) and Restore (undelete).
  // Both invalidate the module cache so the next breakdown refetches.
  async function removeService(jobServiceId: number) {
    const ok = await confirm({
      title: 'Remove Service?',
      description: 'This will mark the service as inactive. You can restore it later from the "Show Inactive" view.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(jobServiceId);
    try {
      await api.delete(`/admin/jobs/${job.job_id}/services/${jobServiceId}`);
      invalidateBreakdownCache(Number(job.job_id));
      setBreakdown(null);
      setOpenLineId(null);
      showToast({ variant: 'success', message: 'Service Removed' });
      onMutated?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to remove service';
      showToast({ variant: 'error', message: msg });
    } finally { setBusyId(null); }
  }

  async function restoreService(jobServiceId: number) {
    setBusyId(jobServiceId);
    try {
      await api.post(`/admin/jobs/${job.job_id}/services/${jobServiceId}/restore`, {});
      invalidateBreakdownCache(Number(job.job_id));
      setBreakdown(null);
      showToast({ variant: 'success', message: 'Service Restored' });
      onMutated?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to restore service';
      showToast({ variant: 'error', message: msg });
    } finally { setBusyId(null); }
  }

  // dirtyQty — the set of job_service_ids whose input differs from the
  // server value, plus any row with a save in flight. Drives both the
  // per-row amber tint and the lifted unsaved-changes close guard. We
  // compare against the live `services` array each render so a row that
  // has been committed (pendingQty cleared) immediately drops out.
  const serverQtyById = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of services as Array<Record<string, unknown>>) {
      m.set(Number(s.job_service_id), Number(s.quantity ?? 0));
    }
    return m;
  }, [services]);
  const dirtyQty = useMemo(() => {
    const set = new Set<number>();
    for (const [idStr, v] of Object.entries(pendingQty)) {
      const id = Number(idStr);
      if (v !== (serverQtyById.get(id) ?? 0)) set.add(id);
    }
    if (savingQtyId != null) set.add(savingQtyId);
    return set;
  }, [pendingQty, serverQtyById, savingQtyId]);
  // blockingUnsaved — the SUBSET of dirty rows whose pending value is
  // INVALID (out of 1..100) and therefore will NOT auto-save. This is
  // what the in-app close guard keys off, NOT `dirtyQty`.
  //
  // Why narrower than dirtyQty: clicking the modal's Close button blurs
  // the focused qty input first, and that blur auto-commits any VALID
  // pending value (→ "Quantity updated." toast). So a valid edit is
  // already saved by the time the close handler runs — alerting
  // "unsaved changes" there is wrong (the bug: alert + success toast
  // appeared together). Only an INVALID value genuinely can't be saved,
  // so only that should prompt the guard. `dirtyQty` still drives the
  // row tint + the beforeunload guard (hard nav can't rely on blur).
  const blockingUnsaved = useMemo(() => {
    const set = new Set<number>();
    for (const [idStr, v] of Object.entries(pendingQty)) {
      const id = Number(idStr);
      const changed = v !== (serverQtyById.get(id) ?? 0);
      const valid = Number.isFinite(v) && v >= 1 && v <= 100;
      if (changed && !valid) set.add(id);
    }
    return set;
  }, [pendingQty, serverQtyById]);
  // Lift the boolean up to JobModal's close guard. Reported via effect
  // (not during render) to avoid a parent setState-during-child-render
  // warning. Reset to clean on unmount so a stale flag can't outlive the
  // Services tab.
  useEffect(() => {
    onDirtyChange?.(blockingUnsaved.size > 0);
    return () => onDirtyChange?.(false);
  }, [blockingUnsaved, onDirtyChange]);
  // Browser-level exit guard. The in-app modal Close is already protected
  // by the onDirtyChange → useConfirm path, but that can't intercept a
  // hard navigation (tab close, refresh, browser Back). While any qty
  // edit is uncommitted, arm `beforeunload` so the browser shows its
  // native "Leave site?" prompt; tear it down the moment the rows are
  // clean so we never nag without reason.
  useEffect(() => {
    if (dirtyQty.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyQty]);

  const inactiveCount = (services as Array<Record<string, unknown>>).filter((s) => Number(s.job_service_status) === 0).length;
  const canEdit = !isJobClosed(Number(job.job_status));
  const canAddInline = canEdit && addCategories.length > 0;

  return (
    <div className="space-y-2">
      {/* Inline Add-Service panel — always visible (no collapse) when the
          job is still editable. Restores the full capability the old
          AddJobServiceDialog had, rendered inline above the table:
            Row 1 — [Service Category] [Service Type(s)] [Job Type]
            Section 2 — selectable checklist of matching catalog rows,
                        each with its own quantity input.
          Nothing is auto-added: the operator ticks the services they
          want and sets quantities, then clicks Add. */}
      {canAddInline && (
        <div className="rounded-lg border bg-card p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-start">
            <div>
              <Label className="text-xs">Service Category</Label>
              <SearchSelect
                value={addCatgId}
                onChange={(v) => setAddCatgId(String(v))}
                options={addCategories}
                placeholder={addCategories.length ? '— Select a Category —' : 'No Categories on Rate Card'}
              />
            </div>
            <div>
              <Label className="text-xs">Service Type(s)</Label>
              <SearchMultiSelect
                value={addTypeIds}
                onChange={(next) => setAddTypeIds((next as Array<string | number>).map(String))}
                options={addTypes}
                disabled={!addCatgId}
                placeholder={addCatgId ? (addTypes.length ? '— Select Service Type(s) —' : 'No Types in This Category') : 'Pick a Category First'}
                selectedLabel="types"
              />
            </div>
            <div>
              {/* Job Type mirrors the per-job CSV (tbl_job.job_type).
                  Editing here PATCHes the job alongside the service
                  inserts so the operator can correct it without a
                  separate dialog. Same fixed 3-value vocabulary the old
                  modal used (matches Book New Call). */}
              <Label className="text-xs">Job Type</Label>
              <SearchMultiSelect
                value={pickedJobTypes}
                onChange={(next) => setPickedJobTypes((next as Array<string | number>).map(String))}
                placeholder="— Select Job Type(s) —"
                selectedLabel="types"
                options={[
                  { value: 'Installation',   label: 'Installation' },
                  { value: 'Repair',         label: 'Repair' },
                  { value: 'Uninstallation', label: 'Uninstallation' },
                ]}
              />
            </div>
          </div>

          {/* Service picker — reuses AutoServicesTable for +/× parity
              with Book New Call / Confirm & Schedule. It derives the
              candidate rows itself from the picked Service Type(s); the
              operator "+"-adds the rows they want (each with a qty + "×"
              remove) and the basket lives in addRows. Prices + footer
              Total are shown here too, matching the other two surfaces. */}
          <AutoServicesTable
            services={catalog}
            loading={!catalogRaw && !!catalogUrl}
            serviceTypeIds={addTypeIds}
            rows={addRows}
            setRows={setAddRows}
          />

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {committedAddRows.length > 0
                ? `${committedAddRows.length} Service${committedAddRows.length === 1 ? '' : 's'} Selected`
                : 'Add Services to the Basket'}
            </span>
            <Button
              size="sm"
              onClick={submitInlineAdd}
              disabled={addBusy || committedAddRows.length === 0}
            >
              <Plus className="size-3.5 mr-1" />
              {addBusy ? 'Adding…' : committedAddRows.length > 1 ? `Add ${committedAddRows.length} Services` : 'Add Service'}
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {/* Show Inactive toggle remains on the right of the table. The
            old "+ Add Service" trigger lived here too; it's now in the
            inline panel above so this row only carries the toggle. */}
        {inactiveCount > 0 && (
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show Inactive ({inactiveCount})
          </label>
        )}
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Job#</th>
              <th>Service Name</th>
              <th>Service Type</th>
              <th>Service Category</th>
              <th>Qty</th>
              <th>Status</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={7} className="text-center text-muted-foreground py-8">No services on this job</td></tr>
            )}
            {visible.map((s, i) => {
              const sr = s as Record<string, unknown>;
              const id = Number(sr.job_service_id);
              const isActive = Number(sr.job_service_status) !== 0;
              const isOpen = openLineId === id;
              const line = breakdownFor(id);
              const busy = busyId === id;
              const serverQty = Number(sr.quantity ?? 0);
              const editedQty = pendingQty[id];
              const currentQty = editedQty ?? serverQty;
              const isDirty = editedQty !== undefined && editedQty !== serverQty;
              const isQtyValid = Number.isFinite(currentQty) && currentQty >= 1 && currentQty <= 100;
              const qtyEditable = isActive && canEdit;
              return (
                <Fragment key={i}>
                  {/* Dirty rows get a light amber tint so the operator can
                      see pending unsaved edits at a glance. */}
                  <tr className={
                    (isActive ? '' : 'opacity-60')
                    + (isDirty ? ' bg-amber-50' : '')
                  }>
                    {/* Column order: Job# · Service Name · Service Type · Service Category */}
                    <td className="text-xs text-muted-foreground">{String(sr.job_service_id ?? '')}</td>
                    <td>{sr.service_name ? String(sr.service_name) : '—'}</td>
                    <td>{String(sr.service_type_name ?? '—')}</td>
                    <td>{String(sr.service_catg_name ?? '—')}</td>
                    <td>
                      {qtyEditable ? (
                        <div className="inline-flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            value={String(currentQty)}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setPendingQty((prev) => ({ ...prev, [id]: v }));
                            }}
                            onBlur={() => {
                              // Auto-save on blur — the natural "done with
                              // this cell" signal. No-op if unchanged/invalid.
                              if (isQtyValid) commitQty(id, serverQty);
                            }}
                            onKeyDown={(e) => {
                              // Enter commits immediately; Escape reverts to
                              // the server value. Keyboard-driven ops staff
                              // edit qty in a tight loop, so both shortcuts
                              // keep hands on the keyboard.
                              if (e.key === 'Enter' && isDirty && isQtyValid && savingQtyId !== id) {
                                e.preventDefault();
                                saveQty(id, currentQty);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setPendingQty((prev) => {
                                  const next = { ...prev };
                                  delete next[id];
                                  return next;
                                });
                              }
                            }}
                            className="h-7 w-16 text-right font-mono"
                            disabled={savingQtyId === id}
                          />
                          {/* Status slot — fixed width so it never reflows
                              the column when content toggles. The "unsaved"
                              state is conveyed purely by the row's amber tint
                              (no text tag — the old tag shifted the layout on
                              every keystroke). Only the in-flight spinner
                              renders here, briefly, during a commit. */}
                          <span className="inline-flex w-4 shrink-0 items-center justify-center">
                            {savingQtyId === id ? <Spinner /> : null}
                          </span>
                        </div>
                      ) : (
                        // Inactive (soft-deleted) services stay read-only.
                        // Restore first, then edit. Mirror the active input's
                        // h-7 w-16 footprint with centered content so the
                        // read-only qty lines up in the same column position
                        // as the editable inputs above it (no left-stuck text).
                        <span className="inline-flex h-7 w-16 items-center justify-center font-mono text-muted-foreground">
                          {String(sr.quantity ?? '')}
                        </span>
                      )}
                    </td>
                    <td>
                      {/* Colored chip instead of plain text — emerald =
                          active/live, slate = soft-deleted/inactive.
                          Uses the shared StatusChip primitive for parity
                          with the rest of the app's status badges. */}
                      <StatusChip tone={isActive ? 'emerald' : 'slate'} size="sm">
                        {isActive ? 'Active' : 'Inactive'}
                      </StatusChip>
                    </td>
                    <td className="!text-right">
                      {/* Icon action cluster — Show/Hide Breakdown is always
                          available; Remove (active rows) and Restore (inactive
                          rows) are gated by `canEdit` (job not yet closed). */}
                      <div className="inline-flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          title={isOpen ? 'Hide Breakdown' : 'Show Breakdown'}
                          aria-label={isOpen ? 'Hide Breakdown' : 'Show Breakdown'}
                          className={
                            'inline-flex items-center justify-center w-7 h-7 rounded border ' +
                            (isOpen
                              ? 'bg-sky-50 border-sky-300 text-sky-700'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50')
                          }
                          onClick={async () => {
                            await ensureBreakdown();
                            setOpenLineId(isOpen ? null : id);
                          }}
                          disabled={bdLoading}
                        >
                          <BarChart3 className="h-3.5 w-3.5" />
                        </button>
                        {isActive && canEdit && (
                          <button
                            type="button"
                            title="Remove Service"
                            aria-label="Remove Service"
                            className="inline-flex items-center justify-center w-7 h-7 rounded border bg-white border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                            onClick={() => removeService(id)}
                            disabled={busy}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {!isActive && canEdit && (
                          <button
                            type="button"
                            title="Restore Service"
                            aria-label="Restore Service"
                            className="inline-flex items-center justify-center w-7 h-7 rounded border bg-white border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                            onClick={() => restoreService(id)}
                            disabled={busy}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isOpen && line && (
                    <tr>
                      <td colSpan={6} className="bg-slate-50 p-3">
                        <BreakdownTable line={line} />
                      </td>
                    </tr>
                  )}
                  {isOpen && !line && breakdown && (
                    <tr>
                      <td colSpan={6} className="bg-slate-50 p-3 text-xs text-muted-foreground italic">
                        No rate-card cost data available for this service.
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Job Totals only appears alongside an OPEN breakdown row — closing
          the breakdown also collapses the totals strip so the Services tab
          returns to its clean read-only state (2026-05-26 ops feedback). */}
      {openLineId !== null && breakdown && breakdown.lineItems.length > 0 && (
        <div className="rounded-lg border bg-slate-50 p-3 text-xs">
          <div className="font-medium mb-1">Job Totals</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <Stat label="Total Charge"   value={breakdown.totals.totalCharge} />
            <Stat label="Easyfix Direct" value={breakdown.totals.easyfixDirect} />
            <Stat label="Overhead"       value={breakdown.totals.overhead} />
            <Stat label="Client Share"   value={breakdown.totals.clientShare} />
            {/* "Remainder" in the BE response IS what flows to the
                Easyfixer technician after every platform / overhead
                deduction (see services/client-rate-cards.service.js
                comment around line 250). Label renamed for clarity. */}
            <Stat label="Easyfixer Share" value={breakdown.totals.remainder} highlight />
          </div>
        </div>
      )}
      {/* AddJobServiceDialog removed 2026-06-01 — its functionality is
          now served by the inline Add-Service panel rendered above the
          services table at the top of this component. */}
    </div>
  );
}


function BreakdownTable({ line }: { line: ServiceBreakdownLine }) {
  // Center-aligned amount columns (2026-05-26 per ops). `!text-center`
  // beats `.data-table` ancestor CSS specificity in all nesting depths.
  //
  // Each rate-card layer (Easyfix Direct, Overhead, Client Share) has
  // BOTH a Variable percent AND a Fixed amount component. We show both
  // explicitly so the operator can tell at a glance which lever is
  // driving the deduction.
  //
  // Easyfixer Share is the residual after every layer above has been
  // deducted, so there isn't a clean "variable vs fixed" split for it.
  // We surface (a) the amount itself, (b) the % of total it represents,
  // and (c) a tooltip explaining the cascade formula so the operator can
  // audit the math.
  const Row = ({ label, layer }: { label: string; layer: ServiceBreakdownLayer }) => (
    <tr>
      <td className="px-2 py-1 text-muted-foreground">{label}</td>
      <td className="px-2 py-1 font-mono !text-center">{layer.variableAmt.toFixed(2)}</td>
      <td className="px-2 py-1 font-mono !text-center">{layer.fixedAmt.toFixed(2)}</td>
      <td className="px-2 py-1 font-mono !text-center font-medium">{layer.total.toFixed(2)}</td>
    </tr>
  );
  // Cascade-formula tooltip — identical text for both per-unit and
  // line-total tables since the formula is the same shape; only the
  // running total differs.
  const formulaTooltip =
    'Cascade formula:\n'
    + 'Start with Total Charge\n'
    + '− Easyfix Direct Variable (% of running total)\n'
    + '− Easyfix Direct Fixed (flat ₹)\n'
    + '− Overhead Variable (% of running total)\n'
    + '− Overhead Fixed (flat ₹)\n'
    + '− Client Share Variable (% of running total)\n'
    + '− Client Share Fixed (flat ₹)\n'
    + '= Easyfixer Share (what flows to the technician)';
  const EasyfixerShareRow = ({ amount, total }: { amount: number; total: number }) => {
    const pct = total > 0 ? (amount / total) * 100 : 0;
    return (
      <tr className="bg-emerald-50/50" title={formulaTooltip}>
        <td className="px-2 py-1 font-medium">
          Easyfixer Share
          <span className="ml-1 text-[10px] text-muted-foreground cursor-help">ⓘ</span>
        </td>
        <td className="px-2 py-1 font-mono !text-center text-muted-foreground" colSpan={2}>
          residual
        </td>
        <td className="px-2 py-1 font-mono !text-center font-medium">
          {amount.toFixed(2)}
          <span className="ml-1 text-[10px] text-muted-foreground">({pct.toFixed(1)}%)</span>
        </td>
      </tr>
    );
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
      <div>
        <div className="font-medium mb-1">Per Unit · Total ₹{line.perUnit.totalCharge.toFixed(2)}</div>
        <table className="w-full border">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left px-2 py-1">Layer</th>
              <th className="!text-center px-2 py-1">Variable</th>
              <th className="!text-center px-2 py-1">Fixed</th>
              <th className="!text-center px-2 py-1">Total</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Easyfix Direct" layer={line.perUnit.easyfixDirect} />
            <Row label="Overhead"       layer={line.perUnit.overhead} />
            <Row label="Client Share"   layer={line.perUnit.clientShare} />
            <EasyfixerShareRow amount={line.perUnit.remainder} total={line.perUnit.totalCharge} />
          </tbody>
        </table>
      </div>
      <div>
        <div className="font-medium mb-1">Line Total · qty {line.quantity} · ₹{line.lineTotal.totalCharge.toFixed(2)}</div>
        <table className="w-full border">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left px-2 py-1">Layer</th>
              <th className="!text-center px-2 py-1">Variable</th>
              <th className="!text-center px-2 py-1">Fixed</th>
              <th className="!text-center px-2 py-1">Total</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Easyfix Direct" layer={line.lineTotal.easyfixDirect} />
            <Row label="Overhead"       layer={line.lineTotal.overhead} />
            <Row label="Client Share"   layer={line.lineTotal.clientShare} />
            <EasyfixerShareRow amount={line.lineTotal.remainder} total={line.lineTotal.totalCharge} />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border px-2 py-1 ${highlight ? 'bg-emerald-50 border-emerald-200' : 'bg-white'}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-medium">₹{Number(value).toFixed(2)}</div>
    </div>
  );
}

function JobMaterialsTab({ jobId, jobStatus }: { jobId: number; jobStatus: number }) {
  // Until-closed gate (2026-05-25 per ops): once the job is in a
  // terminal completed state (3 or 5), no more material edits.
  const canEdit = !isJobClosed(jobStatus);
  const [items, setItems] = useState<JobMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const confirmDialog = useConfirm();

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await api.get<JobMaterial[]>(`/admin/aux/materials/job/${jobId}`);
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load materials');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [jobId]);

  async function deleteItem(id: number) {
    // Migrated from native window.confirm to the shared useConfirm()
    // dialog (per modal-header convention + UX consistency rule).
    const ok = await confirmDialog({
      title: 'Remove Material Line Item?',
      description: 'The line item will be deleted from this job. This cannot be undone.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/aux/materials/${id}`);
      await load();
      showToast({ variant: 'success', message: 'Material Removed' });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Delete failed';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    }
  }

  const totalCost = items.reduce((sum, it) => sum + (Number(it.total_price) || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {items.length} line item{items.length === 1 ? '' : 's'} · Total: ₹{totalCost.toFixed(2)}
        </div>
        {canEdit && <Button size="sm" onClick={() => setAddOpen(true)}>Add Material</Button>}
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {loading && <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          No materials recorded for this job.
        </div>
      )}
      {!loading && items.length > 0 && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-center w-12">#</th>
                <th className="!text-left">Material</th>
                <th className="!text-left">SKU</th>
                <th className="!text-left">Unit</th>
                <th className="!text-right">Unit ₹</th>
                <th className="!text-right">Total ₹</th>
                <th className="!text-right w-16">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, i) => (
                <tr key={m.id}>
                  <td className="!text-center text-xs text-muted-foreground">{i + 1}</td>
                  <td className="!text-left">
                    <div className="font-medium">{m.material_name}</div>
                    {m.description && <div className="text-xs text-muted-foreground">{m.description}</div>}
                  </td>
                  <td className="!text-left font-mono text-xs">{m.sku ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left text-xs">{m.unit ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-right font-mono text-xs">{m.unit_price != null ? Number(m.unit_price).toFixed(2) : '—'}</td>
                  <td className="!text-right font-mono">{m.total_price != null ? Number(m.total_price).toFixed(2) : '—'}</td>
                  <td className="!text-right">
                    {canEdit && (
                      <button onClick={() => deleteItem(m.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddMaterialDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={async (payload) => {
          await api.post('/admin/aux/materials', { jobId, ...payload });
          setAddOpen(false);
          await load();
        }}
      />
    </div>
  );
}

function AddMaterialDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void;
  onSubmit: (payload: { materialName: string; description?: string; sku?: string; unit?: string; unitPrice?: number; quantity?: number; totalPrice?: number }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Field-level invalid markers — set by the submit guard and cleared as
  // the operator types. Drives the red border on each input so they can
  // see WHICH field needs attention instead of just reading a single
  // top-of-modal error message.
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setName(''); setDescription(''); setSku(''); setUnit('');
      setUnitPrice(''); setQty('1'); setErr(null);
      setInvalid(new Set());
    }
  }, [open]);

  // Total ₹ auto-computes from Unit ₹ × Qty and is shown read-only. We
  // also POST this server-side, but the backend recomputes from
  // unitPrice × quantity so the stored value can't drift if the client
  // ever sent something inconsistent.
  const totalPrice = (Number(unitPrice) || 0) * (Number(qty) || 0);

  // Mark a field valid as soon as the operator types into it. Cheap UX
  // win — the red border disappears the moment they engage with it.
  function clearInvalid(field: string) {
    setInvalid((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev); next.delete(field); return next;
    });
  }
  // Tailwind doesn't compose `aria-invalid` styles by default — we
  // toggle a red border class explicitly so the visual cue is obvious.
  const errCls = (f: string) => invalid.has(f) ? 'border-red-500 focus-visible:ring-red-500' : '';

  async function go() {
    // Collect EVERY missing/invalid field in one pass so the operator
    // sees them all highlighted at once, not one-at-a-time on each click.
    const next = new Set<string>();
    if (!name.trim())                                  next.add('materialName');
    if (!sku.trim())                                   next.add('sku');
    if (!unit.trim())                                  next.add('unit');
    const upn = Number(unitPrice);
    if (!unitPrice || !Number.isFinite(upn) || upn <= 0) next.add('unitPrice');
    const qn = Number(qty);
    if (!qty || !Number.isFinite(qn) || qn <= 0)       next.add('quantity');
    if (next.size > 0) {
      setInvalid(next);
      setErr('Please fill the highlighted fields.');
      return;
    }
    setLoading(true); setErr(null);
    try {
      await onSubmit({
        materialName: name.trim(),
        description: description.trim() || undefined,
        sku: sku.trim(),
        unit: unit.trim(),
        unitPrice: upn,
        quantity: qn,
        totalPrice,
      });
    } catch (e) {
      // Backend returns `details.missing: [...]` on its own validation
      // failure — translate that into the same red borders for parity
      // (defence in depth: covers the case where the client validator
      // is lenient but the backend rejects).
      if (e instanceof ApiError) {
        type Details = { missing?: string[] };
        const d = (e.details as Details | undefined);
        if (Array.isArray(d?.missing)) setInvalid(new Set(d.missing));
        setErr(e.message);
      } else {
        setErr('Save failed');
      }
    } finally { setLoading(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Material</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium block mb-1">Material Name *</Label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); clearInvalid('materialName'); }}
              placeholder='e.g. "Copper wire — 2.5 sqmm"'
              className={errCls('materialName')}
            />
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional spec / brand" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-sm font-medium block mb-1">SKU *</Label>
              <Input
                value={sku}
                onChange={(e) => { setSku(e.target.value); clearInvalid('sku'); }}
                className={`font-mono ${errCls('sku')}`}
              />
            </div>
            <div>
              <Label className="text-sm font-medium block mb-1">Unit *</Label>
              <Input
                value={unit}
                onChange={(e) => { setUnit(e.target.value); clearInvalid('unit'); }}
                placeholder='e.g. "m", "pcs"'
                className={errCls('unit')}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-sm font-medium block mb-1">Unit ₹ *</Label>
              <Input
                value={unitPrice}
                onChange={(e) => { setUnitPrice(e.target.value.replace(/[^\d.]/g, '')); clearInvalid('unitPrice'); }}
                className={`font-mono ${errCls('unitPrice')}`}
                inputMode="decimal"
              />
            </div>
            <div>
              <Label className="text-sm font-medium block mb-1">Qty *</Label>
              <Input
                value={qty}
                onChange={(e) => { setQty(e.target.value.replace(/[^\d.]/g, '')); clearInvalid('quantity'); }}
                className={`font-mono ${errCls('quantity')}`}
                inputMode="decimal"
              />
            </div>
            <div>
              <Label className="text-sm font-medium block mb-1">Total ₹</Label>
              <Input
                value={totalPrice ? totalPrice.toFixed(2) : ''}
                readOnly
                className="font-mono bg-muted/30"
                title="Auto-calculated as Unit ₹ × Qty"
              />
            </div>
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={loading} />
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : 'Add'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Comments tab ───────────────────────────────────────────────────
// Schema VERIFIED 2026-05-12 against legacy tbl_job_comment:
//   created_on (auto-stamp), commented_by (FK tbl_user.user_id),
//   appointment_on, enum_reason_id, efr_id.
// `user_name` comes from the LEFT JOIN on tbl_user.
// JobComment type moved to ./jobTypes (imported at top) so the extracted
// AddRemarksDialog can share the exact same shape.

const COMMENT_STAGE_LABEL: Record<number, string> = {
  1: 'On Creation',
  2: 'On Check-In',
  3: 'On Check-Out',
  4: 'In Progress',
};

function JobCommentsTab({ jobId, refreshKey = 0, pendingComments = [], onLoaded }: { jobId: number; refreshKey?: number; pendingComments?: Array<JobComment & { _pending?: true }>; onLoaded?: () => void }) {
  const [comments, setComments] = useState<JobComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [stage, setStage] = useState<number>(4);
  const [posting, setPosting] = useState(false);
  // Local optimistic state for THIS tab's inline textarea. Parent-supplied
  // pendings (from AddRemarksDialog) come via `pendingComments` prop;
  // local pendings (from postComment below) stay self-contained because
  // the input + the list live inside the same component.
  const [localPending, setLocalPending] = useState<Array<JobComment & { _pending?: true }>>([]);
  const { me: currentMeForTab } = useMe();
  const currentUserName = (currentMeForTab?.user?.user_name || currentMeForTab?.user?.official_email || 'You') as string;

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await api.get<JobComment[]>(`/admin/jobs/${jobId}/comments`);
      setComments(Array.isArray(data) ? data : []);
      // Reconciliation hook — parent uses this to clear its pendings
      // (the canonical rows are now in `comments`, so the optimistic
      // placeholders are redundant).
      onLoaded?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load comments');
    } finally { setLoading(false); }
  }
  // Refetch on mount, on jobId change, AND whenever the parent bumps
  // `refreshKey` (e.g. after AddRemarksDialog saves a remark from the
  // view-mode footer — the dialog lives outside this component's tree
  // so a parent-driven trigger is the only way the new row reaches us).
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [jobId, refreshKey]);

  async function postComment() {
    const text = draft.trim();
    if (!text) return;
    // Optimistic prepend (2026-06-05) — synthesise a pending row + clear
    // the input immediately. Real POST runs after; success path reaches
    // load() which fetches the canonical row; we then drop the matching
    // local pending. Failure path drops the pending + surfaces a toast.
    const tempId = -Date.now() - Math.floor(Math.random() * 1000);
    const optimistic: JobComment & { _pending?: true } = {
      id: tempId,
      job_id: jobId,
      comments: text,
      comment_on: stage,
      stage: COMMENT_STAGE_LABEL[stage] ?? String(stage),
      created_on: new Date().toISOString(),
      appointment_on: null,
      commented_by: null,
      user_name: currentUserName,
      efr_id: null,
      enum_reason_id: null,
      enum_desc: null,
      _pending: true,
    };
    setLocalPending((prev) => [optimistic, ...prev]);
    setDraft('');
    setPosting(true); setError(null);
    try {
      await api.post(`/admin/jobs/${jobId}/comments`, { comments: text, comment_on: stage });
      await load();
      // Drop the matching pending now that the canonical row is in the list.
      setLocalPending((prev) => prev.filter((c) => c.id !== tempId));
    } catch (e) {
      // POST rejected — pull the pending row so the operator isn't left
      // with a phantom comment, and surface the error.
      setLocalPending((prev) => prev.filter((c) => c.id !== tempId));
      const msg = e instanceof ApiError ? e.message : 'Failed to post comment';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally { setPosting(false); }
  }

  // Merge parent + local pendings ABOVE the fetched list. Parent pendings
  // first (they came from the AddRemarksDialog which closes before this
  // tab's own input is interacted with), then local pendings, then the
  // canonical comments (already DESC-sorted by the BE).
  const allRows: Array<JobComment & { _pending?: true }> = [
    ...pendingComments,
    ...localPending,
    ...comments,
  ];

  return (
    <div className="space-y-3">
      {/* Add form */}
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <Label className="text-sm font-medium">Add a comment</Label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
          placeholder="Note about the job, check-in observation, customer remark…"
          maxLength={2000}
        />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <select
            value={stage}
            onChange={(e) => setStage(Number(e.target.value))}
            className="border rounded h-9 px-2 text-sm bg-background"
          >
            {Object.entries(COMMENT_STAGE_LABEL).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <Button size="sm" onClick={postComment} disabled={posting || !draft.trim()}>
            {posting ? 'Posting…' : 'Post Comment'}
          </Button>
        </div>
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      {/* List
       * Loading UX rules:
       *  • First-ever load (no comments yet) → big centered "Loading…" placeholder.
       *  • Refetch with existing comments     → keep the list visible AND show a
       *                                          subtle "Refreshing…" pill at the
       *                                          top. The existing rows stay so the
       *                                          operator doesn't lose their place
       *                                          mid-scroll. The new row pops in at
       *                                          the top once the refetch resolves
       *                                          (DESC order — latest first).
       *  • No comments, not loading           → empty-state card.
       */}
      {loading && allRows.length === 0 && (
        <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>
      )}
      {!loading && allRows.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          No comments on this job yet.
        </div>
      )}
      {allRows.length > 0 && (
        <>
          {loading && (
            <div className="text-[11px] text-muted-foreground text-center py-1.5 inline-flex items-center justify-center gap-1.5 w-full">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-sky-500/30 border-t-sky-500 animate-spin" aria-hidden />
              Refreshing comments…
            </div>
          )}
          {/*
            Remarks history rebuilt as a 4-column table (2026-06-03 per ops):
              • Date/Time   — `formatDate(c.created_on)`
              • Remarks     — comment text + Sending/pending pill on optimistic rows
              • Remarks By  — `c.user_name`
              • Reason      — `c.enum_desc` (BE joins tbl_job_comment.enum_reason_id
                              → action_taken_reason.id, projects .action_desc as
                              `enum_desc` for FE contract stability).
            The previous list-card layout surfaced stage + author inline; ops asked
            for the table form because it's scannable at scale. Stage label is
            dropped from the visible columns per the same spec — it's still in
            c.comment_on if any future audit needs it.
          */}
          <div className="rounded border bg-card overflow-hidden">
            <table className="data-table w-full text-xs">
              <thead>
                {/* Width strategy: Date/Time + Remarks By + Reason are
                    short, content-shaped strings — collapse each to its
                    own content width via the `w-1 whitespace-nowrap`
                    trick (the table layout algorithm hands the cell its
                    intrinsic width when w-1 is below the content's
                    natural minimum). Remarks (free-text) gets no width
                    cap and takes the remaining space. */}
                <tr>
                  <th className="!text-left w-1 whitespace-nowrap">Date/Time</th>
                  <th className="!text-left">Remarks</th>
                  <th className="!text-left w-1 whitespace-nowrap">Remarks By</th>
                  <th className="!text-left w-1 whitespace-nowrap">Reason</th>
                </tr>
              </thead>
              <tbody>
                {allRows.map((c) => (
                  <tr
                    key={c.id}
                    className={c._pending ? 'opacity-75 bg-sky-50/40' : ''}
                  >
                    <td className="!text-left text-muted-foreground whitespace-nowrap align-top">
                      {formatDate(c.created_on)}
                    </td>
                    <td className="!text-left align-top">
                      <div className="whitespace-pre-wrap">{c.comments}</div>
                      {c._pending && (
                        <span className="inline-flex items-center gap-1 mt-1 bg-sky-100 text-sky-800 rounded px-1.5 py-0.5 text-[11px]">
                          <span className="inline-block h-2 w-2 rounded-full border-2 border-sky-600/30 border-t-sky-600 animate-spin" aria-hidden />
                          Sending…
                        </span>
                      )}
                    </td>
                    {/* Remarks By + Reason cells get whitespace-nowrap so
                        the column collapses to its intrinsic content
                        width (matches the header's `w-1 whitespace-nowrap`
                        and lets the Remarks column take all remaining
                        horizontal space). Remarks itself keeps the inner
                        `whitespace-pre-wrap` div so long free-text wraps. */}
                    <td className="!text-left align-top whitespace-nowrap">
                      <span className="font-medium">{c.user_name ?? 'Unknown'}</span>
                    </td>
                    <td className="!text-left align-top text-muted-foreground whitespace-nowrap">
                      {c.enum_desc ? c.enum_desc : <span className="italic">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Images tab ─────────────────────────────────────────────────────
/*
 * Single image tile.
 *
 * URL contains `?token=<jwt>` — the image file endpoint accepts the
 * JWT either via Authorization header (default) or query string for
 * exactly this use case (`<img src>` requests carry no Authorization
 * header, and we want "open in new tab" to work too). See
 * EasyFix_Backend/middleware/auth.js for the CSRF/leakage trade-off
 * write-up. The token here is the same one stored in localStorage by
 * the api wrapper.
 *
 * `onError` flips to the "Image not found" empty state when the BE
 * responds 404 (image lost from S3 AND local disk, or imageId stale).
 */
function JobImageTile({ id, url, label, tooltip, onDelete, deleting, compact, pendingDelete, onView }: {
  id: string;
  url: string;
  label: string;
  tooltip: string;
  /* When provided, clicking the thumbnail opens an in-app ENLARGE lightbox
   * (SkillImageLightbox) instead of opening the raw file in a new browser tab.
   * Ctrl/middle-click still opens the new tab (the <a> href is preserved). */
  onView?: (v: { url: string; name: string }) => void;
  /* When provided, renders a top-right X overlay that calls this on
   * click (with stopPropagation so the tile's "open in new tab"
   * behaviour is preserved for clicks elsewhere on the tile). */
  onDelete?: () => void;
  /* While true, the tile dims + shows a small "Deleting…" badge and
   * the X is disabled — prevents double-clicks during the network
   * round-trip. */
  deleting?: boolean;
  /*
   * Compact 72×72 variant (2026-05-28) — used inside the Confirm-mode
   * Job Image section to match the staged-tile size so already-
   * uploaded thumbnails sit alongside locally-staged previews in the
   * same visual rhythm. The default (full-size, ~128px tall with
   * caption row) is what the read-only Images tab uses.
   */
  compact?: boolean;
  /*
   * Pending-delete treatment (2026-05-28). When true, the tile renders
   * with a red overlay + strikethrough label + the corner X turns into
   * an undo arrow (↺). Clicking the corner still routes to `onDelete`
   * — the parent decides whether the call mark-or-unmark based on the
   * current set membership. Visible signal that the operator has
   * staged this removal but hasn't committed; undoing brings the tile
   * back to normal styling without any BE round-trip.
   */
  pendingDelete?: boolean;
}) {
  const [broken, setBroken] = useState(false);

  const authedUrl = React.useMemo(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
    if (!token) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }, [url]);

  /*
   * Compact tile dimensions match the Confirm-mode staged-file preview
   * (72×72 with a tiny caption row beneath). Default tile is the
   * larger ~128px variant used on the read-only Images tab where
   * thumbnails get more breathing room.
   */
  if (compact) {
    return (
      <div
        className={`relative border rounded-md overflow-hidden ${pendingDelete ? 'border-rose-400 ring-1 ring-rose-300' : 'bg-muted/40'} ${deleting ? 'opacity-50 pointer-events-none' : ''}`}
        style={{ width: 72, height: 72 }}
        title={pendingDelete ? `${tooltip} — marked for deletion (click ↺ to undo)` : tooltip}
      >
        <a
          href={authedUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { if (onView) { e.preventDefault(); onView({ url: authedUrl, name: label }); } }}
          className="block w-full h-full"
        >
          {broken ? (
            <div className="w-full h-full flex flex-col items-center justify-center text-[9px] text-muted-foreground p-1 text-center">
              <span className="text-base leading-none">⚠️</span>
              <span className="mt-0.5">Lost</span>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={authedUrl}
              alt={label}
              /*
               * Pending-delete visual treatment (2026-05-28). Drops
               * opacity + adds a grayscale tint so the tile clearly
               * reads as "scheduled for removal" without hiding the
               * thumbnail — the operator can still see what they're
               * about to lose. The diagonal strikethrough below
               * reinforces the intent.
               */
              className={`w-full h-full object-cover ${pendingDelete ? 'opacity-50 grayscale' : ''}`}
              loading="lazy"
              onError={() => setBroken(true)}
            />
          )}
        </a>
        {/* Diagonal strikethrough ribbon — pure CSS, pointer-events
            none so the X / undo button below stays clickable. The
            absolute red bar visually "crosses out" the image when
            marked for deletion. */}
        {pendingDelete && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="w-[110%] h-[2px] bg-rose-500 rotate-[-25deg] origin-center shadow-[0_0_0_1px_rgba(255,255,255,0.6)]" />
          </div>
        )}
        {/* Caption row removed in compact mode — the 72px footprint
            doesn't have room for both the thumbnail and a legible
            label. The full label remains accessible via the title
            tooltip on hover. */}
        {onDelete && (
          <button
            type="button"
            /*
             * Dual-purpose corner button (2026-05-28):
             *   - default state → × (delete / mark for delete)
             *   - pendingDelete state → ↺ (undo the mark)
             * Same click handler, parent decides what to do based on
             * current set membership. Colour shifts to amber when
             * marked so the affordance reads as "restore" rather than
             * "destroy".
             */
            aria-label={pendingDelete ? `Undo delete ${label}` : `Delete ${label}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            disabled={deleting}
            className={`absolute top-0 right-0 text-white rounded-bl-md w-5 h-5 flex items-center justify-center text-xs font-bold leading-none disabled:opacity-60 ${pendingDelete ? 'bg-amber-600 hover:bg-amber-700' : 'bg-black/65 hover:bg-black/90'}`}
            title={pendingDelete ? 'Undo — keep this image' : 'Mark for deletion'}
          >
            {pendingDelete ? '↺' : '×'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`relative ${deleting ? 'opacity-50 pointer-events-none' : ''}`}>
      <a
        key={id}
        href={authedUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { if (onView) { e.preventDefault(); onView({ url: authedUrl, name: label }); } }}
        className="block border rounded-md overflow-hidden hover:shadow-sm transition-shadow"
        title={tooltip}
      >
        {broken ? (
          <div className="flex h-32 w-full flex-col items-center justify-center gap-1 bg-muted text-[11px] text-muted-foreground">
            <span className="text-base">⚠️</span>
            <span>Image not found</span>
            <span className="text-[10px]">Re-upload to restore</span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={authedUrl}
            alt={label}
            className="w-full h-32 object-cover bg-muted"
            loading="lazy"
            onError={() => setBroken(true)}
          />
        )}
        <div className="px-2 py-1 text-[10px] text-muted-foreground truncate">
          {label}
        </div>
      </a>
      {/*
       * Delete affordance (2026-05-28). Rendered ABOVE the anchor (not
       * inside it) so the click handler can stopPropagation cleanly
       * without browsers treating "click on a button inside an anchor"
       * inconsistently. Absolute-positioned top-right to mirror the
       * staging-tile X in the Confirm-mode picker.
       */}
      {onDelete && (
        <button
          type="button"
          aria-label={`Delete ${label}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          disabled={deleting}
          className="absolute top-1 right-1 bg-black/65 hover:bg-black/90 text-white rounded w-6 h-6 flex items-center justify-center text-sm font-bold leading-none disabled:opacity-60"
          title="Delete image"
        >
          ×
        </button>
      )}
    </div>
  );
}

function JobImagesTab({ images, onChanged, compact, onImageDeleted, deferDelete, pendingDeleteIds }: {
  images: Array<Record<string, unknown>>;
  /* Called after a successful image delete so the parent can refetch
   * `job.images`. Optional — if not provided, the tile X is hidden
   * (read-only view). */
  onChanged?: () => void;
  /*
   * Compact mode (2026-05-28) — switches the grid container to a
   * flex-wrap row of 72×72 tiles. Used inside the Confirm-mode Job
   * Image section to size already-uploaded thumbnails the same as the
   * staged-file previews directly beneath. Default (false) keeps the
   * spacious responsive grid for the read-only Images tab.
   */
  compact?: boolean;
  /*
   * Per-delete callback (2026-05-28). In NON-defer mode: fires AFTER
   * the BE DELETE succeeds (BEFORE `onChanged`). In defer mode: fires
   * INSTEAD of the BE DELETE — the X is a staging gesture, parent
   * accumulates intent and flushes on submit.
   */
  onImageDeleted?: (imageId: string) => void;
  /*
   * Deferred delete (2026-05-28) — when true, the X button does NOT
   * call the BE DELETE or fire the success toast. It simply notifies
   * the parent via `onImageDeleted(id)`. Used by Confirm-mode so a
   * tile removal can be undone by clicking Cancel on the modal —
   * matches the symmetry of the staged-file upload pattern
   * (uploads also only happen on submit). The destructive confirm
   * dialog is suppressed because there's nothing destructive yet —
   * the operator can still bail out before any BE write lands.
   */
  deferDelete?: boolean;
  /*
   * IDs the parent has staged for deletion but hasn't committed yet
   * (2026-05-28). Tiles whose `image_id` is in this set render with
   * the strikethrough/red-tinted treatment + an undo arrow corner
   * button. Empty/undefined → all tiles render normally. Used only
   * with `deferDelete`; if you set this without `deferDelete` the
   * tile mark would be visually marked but the X would also fire the
   * BE call immediately, which is incoherent.
   */
  pendingDeleteIds?: Set<string>;
}) {
  /*
   * Image URL resolution (2026-05-14 ops update):
   *
   *   Use the backend redirect endpoint `/api/admin/jobs/images/:id/file`
   *   instead of constructing /easydoc URLs client-side. The endpoint
   *   reads the stored `tbl_job_image.image` value and decides:
   *     1. If the file exists in S3 at Job_Images/<key> → 302 to a
   *        presigned URL (5-min TTL).
   *     2. Else → 302 to the legacy local URL `/easydoc/upload_jobs/<file>`.
   *
   *   This keeps the S3-or-local fallback decision SERVER-SIDE so the
   *   frontend doesn't need to know the storage convention, and any
   *   future move (e.g. migrating older filesystem images into S3)
   *   doesn't require a frontend redeploy.
   *
   *   API base note: the api wrapper rewrites /api/* to the backend,
   *   but a 302 redirect to a presigned URL OR /easydoc/* needs to be
   *   FOLLOWED by the browser. Setting `src` to the absolute API path
   *   triggers a normal browser fetch that follows redirects naturally.
   */
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
  const fileUrl = (imageId: string | number) => `${apiBase}/admin/jobs/images/${imageId}/file`;

  /*
   * Delete affordance (2026-05-28). Mirrors the staging-tile X in the
   * Confirm-mode picker. Uses the same useConfirm/showToast pattern as
   * the rest of JobModal so the affirmative-double-tap UX is consistent.
   * Tracks "currently-deleting" image IDs in a Set so the tile can dim
   * and disable its X while the round-trip is in flight.
   */
  const confirm = useConfirm();
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // Click-to-enlarge lightbox target for an uploaded job-image thumbnail.
  const [lightbox, setLightbox] = useState<SkillImageLightboxValue>(null);

  async function handleDelete(imageId: string, label: string) {
    /*
     * Deferred mode (Confirm-mode usage): skip the confirm dialog and
     * the BE call entirely — the X is a staging gesture, parent
     * accumulates intent and flushes on submit. Symmetric with the
     * staged-file upload pattern: uploads happen only on Save Draft /
     * Book Call, so removals should too. The operator can recover
     * from an accidental X by clicking Cancel on the modal.
     */
    if (deferDelete) {
      onImageDeleted?.(imageId);
      return;
    }
    const ok = await confirm({
      title: 'Delete Image?',
      description: `Remove "${label}" from this job? This also removes the file from storage and cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    setDeletingIds((prev) => {
      const next = new Set(prev);
      next.add(imageId);
      return next;
    });
    try {
      await api.delete(`/admin/jobs/images/${imageId}`);
      showToast({ variant: 'success', message: 'Image Deleted' });
      // Optimistic hide BEFORE the parent refetch lands. Prevents a
      // race where the operator double-clicks the same tile and the
      // second click 404s on a row that's already gone.
      onImageDeleted?.(imageId);
      onChanged?.();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to delete image';
      showToast({ variant: 'error', message: msg });
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(imageId);
        return next;
      });
    }
  }

  if (images.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No images uploaded for this job.
      </div>
    );
  }
  /*
   * Two layouts: spacious responsive grid for the read-only Images tab,
   * compact flex-wrap of 72×72 thumbnails for the Confirm-mode inline
   * usage. The compact rhythm sits alongside the staged-file previews
   * (also 72×72) without a size jump between "already uploaded" and
   * "about to upload" tiles.
   */
  const containerClass = compact
    ? 'flex flex-wrap gap-2'
    : 'grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3';
  return (
    <>
    <div className={containerClass}>
      {images.map((img) => {
        const id       = String(img.image_id ?? '');
        const stored   = String(img.image ?? '');
        const stage    = String(img.job_stage ?? '');
        const category = String(img.image_category ?? '');
        if (!id || !stored) return null;
        const url = fileUrl(id);
        // Friendly category label for the alt text + tooltip — avoids
        // the placeholder rendering "0" as alt when job_stage is the
        // sentinel `0` (Booking). Falls back to the stored filename so
        // legacy local-only rows still get something useful.
        const friendly = category
          ? category.charAt(0).toUpperCase() + category.slice(1)
          : (stage && stage !== '0' ? `Stage ${stage}` : stored || `Image ${id}`);
        return (
          <JobImageTile
            key={id}
            id={id}
            url={url}
            label={friendly}
            tooltip={`${friendly}${stored ? ` · ${stored}` : ''}`}
            onDelete={onChanged ? () => handleDelete(id, friendly) : undefined}
            deleting={deletingIds.has(id)}
            compact={compact}
            // Visual mark when id is in the parent's pending-delete
            // set. Drives the strikethrough overlay + undo arrow on
            // the corner button.
            pendingDelete={pendingDeleteIds?.has(id) ?? false}
            onView={setLightbox}
          />
        );
      })}
      </div>
      <SkillImageLightbox value={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}

// Map a tbl_job_media.source value → a short channel badge. WhatsApp chat and
// the public web form both feed tbl_job_media; the badge tells ops which.
function videoSourceBadge(source?: string | null): { label: string; cls: string } | null {
  switch (source) {
    case 'customer_whatsapp':    return { label: 'Chat', cls: 'bg-emerald-600' };
    case 'customer_public_form': return { label: 'Form', cls: 'bg-sky-600' };
    default:                     return null;
  }
}

/*
 * JobVideosStrip — sibling of JobImagesTab for tbl_job_media rows (videos the
 * customer shared, via the WhatsApp conversational flow OR the public
 * job-completion form). Distinguished per-tile by `source`.
 *
 * Tiles are 72×72 to line up with the compact image strip. Each tile lazy-loads
 * its POSTER FRAME via IntersectionObserver: the `<video preload="metadata">`
 * is only mounted once the tile actually enters the viewport (with a 200px
 * rootMargin so it lands "just in time"). This matters because a job can carry
 * up to several customer-shared videos and the Confirm-modal scroll area is
 * tall — kicking off N range-byte metadata fetches on open is wasted bandwidth
 * for the operator's machine. A play-glyph + source badge always overlay;
 * clicking opens the full video in a new tab via the redirect endpoint.
 *
 * Read-only: no delete affordance here in v1.
 */
function JobVideosStrip({ videos, compact = false }: {
  videos: Array<{ media_id: number; s3_key?: string; content_type?: string | null; source?: string | null }>;
  compact?: boolean;
}) {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
  if (!videos || videos.length === 0) return null;
  const tileSize = compact ? 'w-[72px] h-[72px]' : 'w-32 h-32';
  return (
    <div className={`flex flex-wrap ${compact ? 'gap-1.5' : 'gap-2'}`}>
      {videos.map((v) => (
        <LazyVideoPosterTile
          key={v.media_id}
          mediaId={v.media_id}
          url={`${apiBase}/admin/jobs/videos/${v.media_id}/file`}
          source={v.source}
          contentType={v.content_type}
          tileSize={tileSize}
        />
      ))}
    </div>
  );
}

/*
 * LazyVideoPosterTile — single tile inside JobVideosStrip. Mounts the
 * `<video preload="metadata">` ONLY after the tile is observed entering the
 * viewport, using IntersectionObserver with a 200px rootMargin. Before that
 * the tile shows a plain dark background + play-glyph. Once loaded, the video
 * frame stays mounted (no unmount on scroll-out) — re-mounting on every scroll
 * would defeat the bandwidth savings.
 */
function LazyVideoPosterTile({ mediaId, url, source, contentType, tileSize }: {
  mediaId: number;
  url: string;
  source?: string | null;
  contentType?: string | null;
  tileSize: string;
}) {
  const ref = React.useRef<HTMLAnchorElement | null>(null);
  const [visible, setVisible] = React.useState(false);
  const badge = videoSourceBadge(source);

  React.useEffect(() => {
    if (visible) return; // already loaded, no need to watch any more
    const el = ref.current;
    if (!el) return;
    // SSR / older browsers without IntersectionObserver → render eagerly so the
    // tile still works (degraded perf, but no missing thumbnails).
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect(); // one-shot — keep poster mounted afterwards
            break;
          }
        }
      },
      { root: null, rootMargin: '200px', threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  return (
    <a
      ref={ref}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`relative ${tileSize} rounded border bg-slate-800 overflow-hidden flex items-center justify-center group`}
      title={`Customer video #${mediaId}${badge ? ` · via ${badge.label}` : ''}${contentType ? ` · ${contentType}` : ''}`}
    >
      {/* Poster frame — only rendered once the tile is visible. `#t=0.1` makes
          the browser seek to the first 100ms and render that frame from the
          range-byte response; no autoplay, no full download. */}
      {visible && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={`${url}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        />
      )}
      <span className="relative z-10 inline-flex items-center justify-center w-8 h-8 rounded-full bg-black/45 text-white">
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
      {badge && (
        <span className={`absolute z-10 top-0.5 left-0.5 text-[8px] font-semibold text-white px-1 py-px rounded ${badge.cls}`}>
          {badge.label}
        </span>
      )}
      <span className="absolute z-10 bottom-0 right-0 left-0 text-[9px] text-center bg-black/55 text-white py-0.5">
        Video #{mediaId}
      </span>
    </a>
  );
}

// ─── Questionnaire Answers tab ──────────────────────────────────────
type QAnswer = {
  id: number;
  question_id: number;
  question_text: string | null;
  answer_text: string | null;
  answer_value: string | null;
};

function JobQuestionnaireTab({ jobId }: { jobId: number }) {
  const [answers, setAnswers] = useState<QAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const data = await api.get<QAnswer[]>(`/admin/questionnaires/answers/${jobId}`);
        if (!cancelled) setAnswers(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load questionnaire answers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  if (loading) return <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>;
  if (error)   return <div className="text-sm text-red-600 py-3">{error}</div>;
  if (answers.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No questionnaire answers recorded for this job.
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="data-table">
        <thead>
          <tr>
            <th className="!text-center w-12">#</th>
            <th className="!text-left">Question</th>
            <th className="!text-left">Answer</th>
          </tr>
        </thead>
        <tbody>
          {answers.map((a, i) => (
            <tr key={a.id}>
              <td className="!text-center text-xs text-muted-foreground">{i + 1}</td>
              <td className="!text-left text-sm">{a.question_text ?? `Q-${a.question_id}`}</td>
              <td className="!text-left text-sm">{a.answer_text ?? a.answer_value ?? <span className="text-muted-foreground">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Create/Edit form (condensed — essential fields, detail form lives on /jobs/new for now) ─

/*
 * Client-rate-card service shape — returned by
 * GET /shared/lookup/client-services?clientId=X. `client_service_id` is the FK
 * the backend expects as `service_id` in the job create payload's services[].
 */
type ClientService = {
  client_service_id: number;
  client_id: number;
  service_type_id: number;
  service_catg_id: number;
  rate_card_id: number | null;
  /*
   * `charge_type` is an INT in tbl_client_service. Legacy convention
   * (addEditServices.vm radio buttons):
   *   1 = Fixed     — total_amount is the bookable rate
   *   0 = Variable  — total_amount is "00.00" by design; the real rate
   *                   is computed at invoice time from EFDF/EFDV/OF/OV
   *                   splits on the rate-card row (not exposed here).
   * Old type said `string | null`; corrected to number | null.
   */
  charge_type: number | null;
  total_amount: number | string | null;  // DECIMAL from MySQL comes as string
  service_status: number;
  service_type_name: string | null;
  service_catg_name: string | null;
  crc_ratecard_name: string | null;
};

// A row in the form's local service basket. `tempId` is a render key — not
// sent to backend (the real key is `client_service_id` once selected).
type ServiceRow = { tempId: number; client_service_id: string; quantity: string };

/*
 * `prefillCustomer` — populated by CreateJobMobileGate after the
 * mobile-first lookup completes. Mirrors the legacy `getCustomerDetailsForJob`
 * response shape used by addEditJob.vm.
 *
 *   - mobile        : the 10-digit mobile the operator typed (always set
 *                     for create mode after the gate runs).
 *   - found         : true when the by-mobile lookup matched an active
 *                     customer; false for the "new customer" path.
 *   - customer      : full customer row when found.
 *   - addresses     : the customer's addresses (existing rows). The
 *                     operator picks one as the job address OR clicks
 *                     "Add new address" inline to enter fresh fields.
 */
type PrefillCustomer = {
  mobile: string;
  found: boolean;
  customer?: { customer_id: number; customer_name?: string | null; customer_email?: string | null };
  /* Address shape matches the /admin/customers/by-mobile/lookup
   * response. Column names (`pin_code`, not `pincode`; no `area`)
   * verified against tbl_address via job.service.insertAddress(). */
  addresses?: Array<{
    address_id: number;
    address: string;
    building?: string | null;
    landmark?: string | null;
    locality?: string | null;
    city_id: number | null;
    city_name?: string | null;
    pin_code?: string | null;
    gps_location?: string | null;
  }>;
};

/*
 * CreateJobMobileGate — mobile-first prompt that gates the Create Job
 * form. Mirrors the legacy `addEditJob.vm` behaviour: the modal opens
 * showing only "Mobile Number" + Continue, and the rest of the form
 * (customer + address + schedule + services) only renders AFTER the
 * operator types a 10-digit number and the by-mobile lookup completes.
 *
 *   Step 1 ("mobile")  — Input + Continue.
 *   Step 2 ("form")    — renders the children function, passing the
 *                        PrefillCustomer descriptor (found + customer
 *                        + addresses, OR just mobile when 404).
 *
 * The lookup is forgiving: a 404 from /admin/customers/by-mobile/lookup
 * means "fresh customer", NOT a hard error — we transition to the
 * form with `found: false` and let the operator type a new customer
 * inline. Only network/server errors surface as red text.
 */
function CreateJobMobileGate({
  onProceed,
  onExpand,
  onContract,
  onCancel,
}: {
  onProceed: (prefill: PrefillCustomer) => React.ReactNode;
  /* Called when the gate transitions from mobile-prompt to form so
   * the parent dialog can grow from fit-to-content to full size. */
  onExpand?: () => void;
  /* Called when the operator clicks "Change Mobile" so the parent can
   * shrink back to the compact prompt. */
  onContract?: () => void;
  /* Called when the operator clicks the Cancel button on the mobile
   * prompt — closes the whole modal. Previously wired to nothing,
   * which is why operators reported "Cancel doesn't work, only the
   * overlay click closes the modal". */
  onCancel?: () => void;
}) {
  const [step, setStep] = React.useState<'mobile' | 'form'>('mobile');
  const [mobile, setMobile] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [prefill, setPrefill] = React.useState<PrefillCustomer | null>(null);
  // Address selection moved INSIDE the JobForm's Address section. The
  // gate is now just: mobile prompt → banner → form. No add-new-address
  // toggle here because the form's address radio list does it inline.

  async function lookup() {
    // Tighter validation (2026-06-03): use the shared
    // INDIAN_MOBILE_REGEX so the gate rejects junk numbers like
    // 1111111111 before any backend lookup fires. The previous
    // "exactly 10 digits" check accepted any leading digit.
    if (!INDIAN_MOBILE_REGEX.test(mobile)) {
      setErr(INDIAN_MOBILE_ERROR);
      return;
    }
    setErr(null); setBusy(true);
    try {
      const r = await api.get<{
        customer_id: number; customer_name?: string | null; customer_email?: string | null;
        addresses?: PrefillCustomer['addresses'];
      }>('/admin/customers/by-mobile/lookup', { mobile });
      setPrefill({
        mobile,
        found: true,
        customer: {
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          customer_email: r.customer_email,
        },
        addresses: r.addresses,
      });
      setStep('form');
      onExpand?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Not an error — this is the "new customer" branch.
        setPrefill({ mobile, found: false });
        setStep('form');
        onExpand?.();
      } else {
        setErr(e instanceof ApiError ? e.message : 'Lookup failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (step === 'form' && prefill) {
    return (
      <>
        {/* Banner reflects which branch of the legacy flow we landed on.
            Lets the operator confirm at a glance whether their typed
            mobile matched an existing customer. */}
        <div className={`mb-3 rounded-md border px-3 py-2 text-sm flex items-center justify-between gap-3 ${prefill.found ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <div>
            {prefill.found
              ? <>Existing customer <strong>{prefill.customer?.customer_name || '—'}</strong> · {prefill.addresses?.length ?? 0} saved address{(prefill.addresses?.length ?? 0) === 1 ? '' : 'es'} · pre-filled below.</>
              : <>New customer — mobile <strong>{prefill.mobile}</strong> not on file. Fill the form below to create.</>}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setStep('mobile'); setPrefill(null); onContract?.(); }}
          >
            Change Mobile
          </Button>
        </div>
        {/* If the customer has multiple existing addresses, expose them
            as a simple radio list above the form so the operator can
            switch from the auto-selected first one. Picking a different
            address re-seeds the address/city/pincode fields in the form
            below via a small callback we hand off through PrefillCustomer. */}
        {/* Address picker moved INTO the JobForm's Address section
            (renders below). The gate now only shows the
            existing/new-customer banner; address selection happens
            alongside the address fields, which keeps related controls
            visually grouped and avoids two stacked banners at the
            top of the modal. */}
        {/* Pass prefill through to the form. JobForm now owns the
            address-picker UI internally (rendered inside its Address
            section), so we don't need to remount on every address
            swap — switching between existing addresses just patches
            form state. */}
        {onProceed(prefill)}
      </>
    );
  }

  // Step 1: mobile prompt. `py-6` previously left a visually-empty
  // band above the input — when the dialog is in compact mode the
  // operator just sees ~50px of background before the label. Drop
  // top padding so the label sits right under the dialog header.
  return (
    <div className="max-w-md mx-auto pt-1 pb-2 space-y-3">
      <div>
        <label className="text-sm font-medium block mb-1">
          Mobile Number <span className="text-destructive">*</span>
        </label>
        <Input
          autoFocus
          value={mobile}
          onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup(); } }}
          placeholder="10-digit mobile number"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Enter the customer&apos;s mobile to either pre-fill an existing record or start a new one.
        </p>
      </div>
      {err && <div className="text-sm text-destructive">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" disabled={busy} onClick={() => onCancel?.()}>Cancel</Button>
        <Button onClick={lookup} disabled={busy || !INDIAN_MOBILE_REGEX.test(mobile)}>
          {busy ? 'Looking up…' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}

/*
 * `onSaved` carries an optional `opts.closeAfter` flag so the parent
 * JobModal can decide whether to close the modal immediately or refresh
 * in-place. For outcome-only submits (Unreachable / Enquiry) the
 * operator's intent is "log and move on" — the modal should close right
 * away rather than flicker through a refetch. For Book / Confirm the
 * operator typically wants to see the updated view so we stay open.
 *
 * Without `closeAfter`, the previous flow was: setJob(saved) →
 * setMode('view') → mode-dep useEffect re-fires → setJob(null) +
 * setLoading(true) + fetch → operator sees blank/loading modal for
 * 2-3 seconds. That blank state was perceived as "the modal closed and
 * nothing happened" — the explicit-close path skips it entirely for
 * outcome-only flows.
 */
type JobFormSavedOpts = { closeAfter?: boolean; variant?: 'book' | 'enquiry' | 'unreachable' | 'draft' };
function JobForm({ mode, initial, onCancel, onSaved, onRefresh, prefillCustomer, onFormDirty }: {
  mode: 'create' | 'edit' | 'confirm';
  initial: Job | null;
  onCancel: () => void;
  onSaved: (saved: Job, opts?: JobFormSavedOpts) => void;
  /*
   * `onFormDirty` (2026-06-03) — flipped to `true` on every set()
   * mutation so the parent JobModal's `hasUnsavedFormRef` can power
   * the Esc / X / overlay-click → "Discard Unsaved Changes?" prompt.
   * Parent resets back to false when the close completes or a save
   * succeeds (the latter via unmount on `closeAfter`). Same mechanism
   * the Services tab already uses for the qty-edit dirty flag.
   */
  onFormDirty?: (dirty: boolean) => void;
  /*
   * `onRefresh` (2026-05-28) — re-fetches the parent modal's `job`
   * state from `/admin/jobs/:id`. Used by the inline already-uploaded
   * images grid in Confirm mode so deleting a thumbnail (which hits
   * DELETE /admin/jobs/images/:id) immediately refreshes the displayed
   * grid. Without this, the tile stayed visible after delete and a
   * second click 404'd because the BE row was already gone.
   * Edit/Confirm modes pass it; create mode doesn't have a job yet so
   * the prop is optional.
   */
  onRefresh?: () => void;
  prefillCustomer?: PrefillCustomer;
}) {
  const lk = useLookup();
  const confirmDialog = useConfirm();
  const isEdit    = mode === 'edit';
  const isConfirm = mode === 'confirm';
  // "Edit-shaped" modes share the compact layout (no client re-pick, no
  // customer/address rewrite) but confirm mode ALSO shows the services basket
  // so ops can add rate-carded products before promoting the job.
  const isEditShape = isEdit || isConfirm;

  // Global customer-number visibility flag. Confirm-mode customer-mobile
  // displays fetch the RAW number (?unmasked=true) to power the call button
  // and re-mask it client-side via maskMobile(); when this flag is ON we skip
  // that re-mask so the operator sees the full number. Technician/SPOC numbers
  // are unaffected (they stay masked).
  const { customerNumberVisible } = useUiFlags();

  /*
   * When the create-flow gate found an existing customer, seed the form
   * with their name + email + mobile (always editable; operator can
   * overwrite for one-off cases). When the gate hit 404 (new customer),
   * we still seed the mobile so the operator doesn't have to re-type it
   * — but customer_name + email stay blank for the operator to fill.
   * In edit/confirm modes there's no gate, so toFormShape pulls from
   * the existing job record as before.
   */
  const [f, setF] = useState(() => {
    const base = toFormShape(initial);
    if (mode === 'create' && prefillCustomer) {
      base.customer_mob_no = prefillCustomer.mobile;
      if (prefillCustomer.found && prefillCustomer.customer) {
        base.customer_name = prefillCustomer.customer.customer_name || '';
        base.customer_email = prefillCustomer.customer.customer_email || '';
      }
      // If the customer has at least one existing address, pre-select
      // the first one as the default. The picker UI for switching to
      // a different address (or adding new) is implemented in a small
      // banner below the customer section.
      const first = prefillCustomer.addresses?.[0];
      if (first) {
        base.address = first.address || '';
        // Copy the FULL address, not just line/city/pin — building, landmark and
        // gps_location must ride along too, else the preselected address renders
        // with empty Building/Floor + Landmark fields and the map falls back to
        // its Delhi default (empty gps → no marker). Mirrors the Confirm-mode
        // saved-address handler which already copies all six.
        base.building = first.building || '';
        base.landmark = first.landmark || '';
        base.city_id = first.city_id != null ? String(first.city_id) : '';
        base.pin_code = first.pin_code || '';
        base.gps_location = first.gps_location || '';
      }
    }
    return base;
  });

  /*
   * BEST-SLOT ADVICE (Confirm & Schedule + Edit modes).
   * Asks the backend which of the four windows can actually be STAFFED on the
   * chosen date — it runs the real candidate-ranking engine, so these counts
   * agree with the Schedule & Assign list rather than being a second opinion.
   *
   * Gated to edit-shaped modes by passing a null jobId in create mode: the hook
   * is still called unconditionally (rules of hooks) and simply doesn't fetch
   * without a job to rank against. Fed the LIVE edited `f.requested_date_time`
   * so editing the Requested Date re-keys the fetch and the advisory re-runs
   * for the new day (the Reschedule dialog mounts the same hook for parity).
   */
  const slotRec = useSlotRecommendations(
    isEditShape ? Number(initial?.job_id) || null : null,
    f.requested_date_time,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Per-file upload status map (2026-05-28). Keyed by the same
   * `${name}|${size}|${lastModified}` triple used for picker dedupe so
   * the lookup from a preview tile is O(1). Values:
   *   - 'uploading' → spinner overlay
   *   - 'done'      → green check overlay (briefly visible before the
   *                    submit handler clears the staging array)
   *   - 'error'     → red X overlay; the X button on the tile still
   *                    lets the operator retry by deleting + reselecting
   *
   * Read-only here in the parent; mutators are inlined into the submit
   * flow + cleared on next picker change.
   */
  const [uploadStatuses, setUploadStatuses] = useState<Record<string, 'uploading' | 'done' | 'error'>>({});
  const fileKey = (file: File) => `${file.name}|${file.size}|${file.lastModified}`;
  const setUploadStatus = (file: File, status: 'uploading' | 'done' | 'error') => {
    setUploadStatuses((prev) => ({ ...prev, [fileKey(file)]: status }));
  };

  /*
   * Blob preview URLs cached per file identity (fileKey) so re-renders
   * (every form keystroke) reuse the same URL instead of allocating a
   * fresh one per render. All cached URLs are revoked when JobForm
   * unmounts — JobForm remounts per modal session, so lifetime is bounded.
   */
  const previewUrlCacheRef = useRef(new Map<string, string>());
  const getPreviewUrl = (file: File): string => {
    const k = fileKey(file);
    let u = previewUrlCacheRef.current.get(k);
    if (!u) {
      u = URL.createObjectURL(file);
      previewUrlCacheRef.current.set(k, u);
    }
    return u;
  };
  useEffect(() => {
    const cache = previewUrlCacheRef.current;
    return () => {
      cache.forEach((u) => URL.revokeObjectURL(u));
      cache.clear();
    };
  }, []);

  /*
   * Section-only image state (2026-05-28). Mirrors the canonical
   * `initial.images` array on mount and is mutated locally on
   * delete. The inline Confirm-mode Job Image section reads from
   * THIS state instead of `initial.images`, so:
   *   - the tile vanishes the instant the BE DELETE returns 200,
   *   - the rest of the modal (JOB SUMMARY, Client Details,
   *     Customer Details, Map, etc.) does NOT re-render — we don't
   *     fire the heavy `/admin/jobs/:id` refetch just for one
   *     thumbnail removal,
   *   - a double-click on the same tile is harmless because the
   *     second click sees the tile already gone.
   *
   * Lifecycle: JobForm remounts when the operator closes/reopens
   * the modal or switches between view/edit/confirm modes (the
   * outer JobModal conditionally renders different forms). At that
   * point useState's initializer reseeds from `initial.images` —
   * which by then has the canonical post-delete shape because the
   * parent fetched fresh. So divergence between localImages and
   * initial.images is a per-session UX optimisation, never a
   * correctness gap.
   *
   * Why this replaced the earlier hide-set + onRefresh combo:
   * refetching the full job for an image delete (a) flickered every
   * unrelated card while initial reset → re-applied, and (b) wasted
   * an 8-table-join SELECT that returns ~50KB just to drop one row.
   */
  const initialImages = Array.isArray((initial as Record<string, unknown>)?.images)
    ? ((initial as Record<string, unknown>).images as Array<Record<string, unknown>>)
    : [];
  const [localImages, setLocalImages] = useState<Array<Record<string, unknown>>>(initialImages);
  // Customer-shared videos from the WhatsApp conversational flow (tbl_job_media).
  // Read-only here — surface alongside the image strip in the Confirm view.
  const initialVideos: Array<{ media_id: number; s3_key?: string; content_type?: string | null; source?: string | null }>
    = Array.isArray((initial as Record<string, unknown>)?.videos)
      ? ((initial as Record<string, unknown>).videos as Array<{ media_id: number; s3_key?: string; content_type?: string | null; source?: string | null }>)
      : [];
  // "Collected via WhatsApp Chat" section hint — detected from the
  // customer-submitted payload's channel marker (the conversation finalize
  // stamps `channel: 'whatsapp_conversation'`). NOTE: presence of videos is NO
  // LONGER a sufficient signal — videos can now also arrive via the public web
  // FORM (source='customer_public_form'), so the per-tile source badge in
  // JobVideosStrip carries that distinction instead.
  const submittedPayload = (initial as Record<string, unknown> | null | undefined)?.customer_submitted_payload as Record<string, unknown> | null | undefined;
  const collectedViaWhatsapp = !!(submittedPayload && typeof submittedPayload === 'object'
    && (submittedPayload as Record<string, unknown>).channel === 'whatsapp_conversation');
  /*
   * Pending-delete IDs (2026-05-28) — image_ids the operator has X'd
   * but whose BE DELETE we haven't fired yet. The submit handler
   * (Save Draft / Book Call) iterates these and flushes them before
   * declaring success; the Cancel path simply discards the set,
   * leaving the BE untouched.
   *
   * Lifecycle matches `localImages` — both reset when the form
   * remounts for a different job. The two state shapes are kept in
   * sync: clicking X removes from `localImages` AND adds to
   * `pendingDeleteIds`.
   */
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  // Reseed when the modal swaps to a different job (job_id changes).
  // Image arrays themselves don't need to re-sync — they're owned by
  // this local state for the lifetime of the form.
  const initialJobId = (initial as Record<string, unknown>)?.job_id;
  useEffect(() => {
    setLocalImages(initialImages);
    setPendingDeleteIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJobId]);

  // ─── Services basket (create flow only) ───────────────────────────────
  // `clientServices` is the catalog for the currently-picked client (null = not
  // loaded yet, [] = loaded but empty). `serviceRows` is what the user has
  // picked so far — editable grid, live amount computed from total_amount × qty.
  const [clientServices, setClientServices] = useState<ClientService[] | null>(null);
  const [loadingServices, setLoadingServices] = useState(false);
  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([]);

  /*
   * Per-Job tab index for the create-flow services table. When the
   * operator picks N service categories, the modal will POST N create-
   * job requests (one per category), so the services table presents N
   * tabs labelled "Job 1 — <Cat A>", "Job 2 — <Cat B>", etc. The
   * active tab filters which service types + rows are shown. Default
   * 0 (first picked category); reset whenever the category set
   * changes so an out-of-range index never points at nothing.
   */
  const [activeJobTab, setActiveJobTab] = useState(0);

  /*
   * Per-tab field overrides (2026-05-19). When the operator picks
   * N service categories, each "Job K" tab carries its own values
   * for the fields that legacy spec'd as common-across-jobs:
   *   - Job Image (job_image_file)
   *   - Job Description (job_desc)         ← 2026-06-04: renamed from "Special Comments" (was bound to `remarks` — wrong column)
   *   - Anything Handyman should keep in mind (efr_special_notes)  ← label preserved; column unchanged
   *   - Helper Required (helper_req)
   *   - Material Required (material_req)
   *   - Collected By (collected_by)
   *
   * Storage shape: { [catId]: { ...override } }. Empty/missing slots
   * fall back to the top-level `f` values via `getJobField()` so
   * single-cat and edit flows behave unchanged.
   *
   * Reads/writes go through `getJobField()` / `setJobField()` —
   * which route to `perJobFields[activeCatId]` in multi-tab mode and
   * to plain `set()` on `f` for single-tab.
   */
  type PerJobOverride = {
    job_desc?: string;
    remarks?: string;
    efr_special_notes?: string;
    helper_req?: boolean;
    material_req?: boolean;
    collected_by?: string;
    job_image_file?: File | null;
    /* Multi-file companion to job_image_file (2026-05-25). When the
       operator picks multiple files we store them here; the post-create
       upload loop iterates this array, falling back to job_image_file
       for legacy single-file paths. */
    job_image_files?: File[];
  };
  const [perJobFields, setPerJobFields] = useState<Record<string, PerJobOverride>>({});

  /*
   * Returns the catId of the currently-active Job tab — or empty
   * string when there's only one (or zero) categories picked, in
   * which case the per-tab map is bypassed entirely and reads/writes
   * go straight to `f` as in single-cat / edit flows.
   */
  function getActiveCatId(): string {
    const ids = (f.fk_service_catg_ids || '').split(',').filter(Boolean);
    if (ids.length < 2) return '';
    const idx = Math.min(activeJobTab, ids.length - 1);
    return ids[idx] ?? '';
  }

  function getJobField<K extends keyof PerJobOverride>(key: K): PerJobOverride[K] {
    const catId = getActiveCatId();
    if (catId) {
      const o = perJobFields[catId];
      if (o && Object.prototype.hasOwnProperty.call(o, key)) return o[key];
    }
    // Fall back to the top-level form state — same value the single-
    // tab UX has read since day one.
    return (f as unknown as Record<string, unknown>)[key as string] as PerJobOverride[K];
  }

  function setJobField<K extends keyof PerJobOverride>(key: K, value: PerJobOverride[K]) {
    const catId = getActiveCatId();
    if (catId) {
      setPerJobFields((prev) => ({
        ...prev,
        [catId]: { ...(prev[catId] || {}), [key]: value },
      }));
    } else {
      // Single-tab / single-cat: write straight to `f` so the
      // existing submit + edit-mode code paths (which read f.remarks
      // etc.) keep working without change.
      set(key as keyof typeof f, value as never);
    }
  }

  /*
   * Client contacts — loaded when the Client dropdown changes. Drives
   * the "Reporting Contact" picker AND the SPOC auto-fill (mobile,
   * name, email). Mirrors legacy `getClientContacts(clientId)` which
   * the legacy addEditJob page fired on client change.
   *
   * Schema: tbl_client_contacts { id, client_id, contact_name,
   * contact_email, contact_no, contact_desgn, manager_id, status }.
   * Endpoint already exists at GET /admin/clients/:clientId/contacts.
   */
  type ClientContact = {
    id: number;
    client_id: number;
    contact_name: string | null;
    contact_email: string | null;
    contact_no: string | null;
    contact_desgn: string | null;
    status: number | null;
  };
  const [clientContacts, setClientContacts] = useState<ClientContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  /*
   * AddressEditDialog state — opened from the ✎ pencil button in the
   * saved-addresses picker. `address` is the row to edit; on save we
   * patch `prefillCustomer.addresses` in place + re-sync the form
   * fields if the edited address was the currently-selected one.
   */
  const [addressEdit, setAddressEdit] = useState<{ open: boolean; address: EditableAddress | null }>({
    open: false,
    address: null,
  });

  /*
   * Saved-address picker UI state. Previous design used a fuzzy
   * field-by-field equality check to compute `isSelected` on each
   * radio — fragile because trailing whitespace / null-vs-empty
   * normalisation in either side broke selection visibility.
   *
   * Now we track the picked address by its row id explicitly. The
   * radio's `checked` prop reads from `selectedAddressId`; clicking
   * the radio sets the id AND copies the row fields into the form.
   * Operator edits to the address fields after selection don't
   * deselect the radio — the id stays pinned until they explicitly
   * "Add a new address".
   *
   * `addressQuery` is the search-input value; `addressShowAll`
   * toggles "show latest 10" vs "view all". Both reset whenever the
   * dialog closes.
   */
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [addressQuery, setAddressQuery] = useState<string>('');
  const [addressShowAll, setAddressShowAll] = useState<boolean>(false);
  /*
   * Hydrate `selectedAddressId` whenever the prefillCustomer arrives
   * (create flow) or the form initialises with an existing
   * fk_address_id (edit/confirm). The first matching saved address —
   * matched first by address_id from the form's `fk_address_id`, then
   * by fuzzy field equality as a fallback — is the one already
   * populated in the form state, so the radio shows it as checked.
   * Reset on modal close so re-opens start clean.
   */
  useEffect(() => {
    if (!prefillCustomer?.found || !prefillCustomer.addresses?.length) {
      setSelectedAddressId(null);
      return;
    }
    // Prefer the first address (matches the auto-prefill in the form
    // initialiser above). Edit/confirm modes can override later via
    // an explicit click — id-based selection means the form's
    // separate edits to address/city/pin won't accidentally
    // deselect the row.
    const firstId = prefillCustomer.addresses[0]?.address_id ?? null;
    setSelectedAddressId(firstId);
    setAddressQuery('');
    setAddressShowAll(false);
  }, [prefillCustomer?.customer?.customer_id]);

  /*
   * Confirm/Edit mode — the customer's saved addresses (tbl_address), fetched
   * by the job's fk_customer_id via the existing GET /admin/customers/:id
   * (returns `{ ...customer, addresses }`). Bulk-uploaded jobs frequently
   * arrive with a thin/empty address, so we surface every address the customer
   * has on file and let the operator pick one to auto-fill the form in a click.
   * Create mode has its own richer prefillCustomer.addresses picker, so this is
   * gated to edit/confirm only.
   */
  type SavedCustomerAddress = {
    address_id: number;
    address: string | null;
    building?: string | null;
    landmark?: string | null;
    city_id?: number | null;
    pin_code?: string | null;
    gps_location?: string | null;
  };
  const [savedAddresses, setSavedAddresses] = useState<SavedCustomerAddress[]>([]);
  // Client-side filter for the Confirm & Schedule saved-address picker.
  const [confirmAddrQuery, setConfirmAddrQuery] = useState('');
  const confirmCustomerId = isEditShape
    ? ((initial as Record<string, unknown> | null)?.fk_customer_id as number | undefined)
    : undefined;
  useEffect(() => {
    if (!confirmCustomerId) { setSavedAddresses([]); return; }
    let cancelled = false;
    setConfirmAddrQuery('');
    api.get<{ addresses?: SavedCustomerAddress[] }>(`/admin/customers/${confirmCustomerId}`)
      .then((r) => { if (!cancelled) setSavedAddresses(Array.isArray(r?.addresses) ? r.addresses : []); })
      .catch(() => { if (!cancelled) setSavedAddresses([]); });
    return () => { cancelled = true; };
  }, [confirmCustomerId]);
  // city_id → name for the saved-address picker labels. The reused
  // /admin/customers/:id endpoint returns tbl_address via SELECT * (no city
  // join), so we resolve the name from the cities lookup (loads up to 1000
  // rows — the full master). Keyed on the stable raw `lk.cities` array.
  const cityNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of lk.cities) m.set(String(c.city_id), c.city_name);
    return m;
  }, [lk.cities]);

  /*
   * Customer History dialog — surfaces every prior job booked for the
   * same tbl_customer row. Available only when the mobile-gate matched
   * an existing customer (i.e. there's a customer_id to query against);
   * for fresh customers there's nothing to show so the button is hidden.
   */
  const [historyOpen, setHistoryOpen] = useState(false);

  /*
   * In edit/confirm modes the form re-seeds whenever `initial`
   * arrives or changes (loading the latest job snapshot). In create
   * mode we DELIBERATELY skip this reset: the useState initializer
   * above already merged `prefillCustomer` (customer name/mobile
   * from the mobile-gate lookup) into the form's first state, and
   * resetting via `toFormShape(null)` here would blow that away,
   * leaving Customer Name + Mobile fields blank for an existing
   * customer. Operators reported this regression as "Customer Name
   * and Mobile Number still not prefilled".
   */
  useEffect(() => {
    if (mode === 'create') return;
    const base = toFormShape(initial);
    /*
     * Magic-link customer submission prefill (2026-05-28).
     * When the customer self-submitted the magic-link form, the BE has
     * already COALESCE-merged the values onto tbl_job/tbl_address — so
     * toFormShape above already reflects them. But for fields the BE
     * does NOT mirror (e.g. customer_email lives on tbl_customer, address
     * sub-fields live nested in payload.address), we layer the raw
     * payload on top so ops sees the customer's intent as the default.
     * Ops can still override any field before submitting.
     */
    const rawPayload = (initial as Record<string, unknown> | null | undefined)?.customer_submitted_payload;
    let payload: Record<string, unknown> | null = null;
    if (rawPayload && typeof rawPayload === 'string') {
      try { payload = JSON.parse(rawPayload) as Record<string, unknown>; } catch { payload = null; }
    } else if (rawPayload && typeof rawPayload === 'object') {
      payload = rawPayload as Record<string, unknown>;
    }
    if (mode === 'confirm' && payload) {
      /*
       * Payload is FLAT (matches BE validator + magic-link-types.ts
       * `SubmitPayload`): `address` is the address-line string and the
       * remaining address fields (`building`, `landmark`, `city_id`,
       * `pin_code`, `gps_location`, `address_instruction`) are sibling
       * top-level keys, NOT nested under `address`. Earlier code here
       * destructured `payload.address` as an object — that silently
       * yielded `undefined` for every sub-field so the spread was a
       * no-op for address. Read flat keys directly.
       */
      const pickStr = (v: unknown) => (v == null || v === '' ? '' : String(v));
      const overlay: Partial<typeof base> & Record<string, unknown> = {};
      if (pickStr(payload.customer_name))      overlay.customer_name = pickStr(payload.customer_name);
      if (pickStr(payload.customer_email))     overlay.customer_email = pickStr(payload.customer_email);
      if (pickStr(payload.time_slot))          overlay.time_slot = pickStr(payload.time_slot);
      // INTENTIONAL: do NOT overlay `requested_date_time` from the payload.
      // The customer's submitted value is an ISO string with a `+05:30`
      // suffix (FE-anchored — see (public)/job-completion submit handler);
      // `<input type="datetime-local">` only accepts `YYYY-MM-DDTHH:mm` and
      // silently shows blank for anything else. The same value was already
      // written by `acceptSubmission` to `tbl_job.requested_date_time` as a
      // proper DATETIME, and `toFormShape(initial)` already produced the
      // datetime-local-friendly form for `base`. So `base.requested_date_time`
      // is the canonical, render-correct copy — overlaying the payload would
      // stomp it with an unrenderable string. Leave it alone.
      if (pickStr(payload.additional_name))    overlay.additional_name = pickStr(payload.additional_name);
      if (pickStr(payload.additional_number))  overlay.additional_number = pickStr(payload.additional_number);
      if (pickStr(payload.job_desc))           overlay.job_desc = pickStr(payload.job_desc);
      if (pickStr(payload.address))            overlay.address = pickStr(payload.address);
      if (pickStr(payload.building))           overlay.building = pickStr(payload.building);
      if (pickStr(payload.landmark))           overlay.landmark = pickStr(payload.landmark);
      if (payload.city_id != null && payload.city_id !== '') overlay.city_id = String(payload.city_id);
      if (pickStr(payload.pin_code))           overlay.pin_code = pickStr(payload.pin_code);
      if (pickStr(payload.gps_location))       overlay.gps_location = pickStr(payload.gps_location);
      if (pickStr(payload.address_instruction))overlay.address_instruction = pickStr(payload.address_instruction);
      setF({ ...base, ...(overlay as Partial<typeof base>) });
      return;
    }
    setF(base);
  }, [initial, mode]);

  /*
   * Confirm-flow saved-address conveniences, applied once per job (ref guard, so
   * a later operator edit is never stomped) as soon as the saved addresses land.
   * Declared AFTER the reseed effect above so its building override isn't clobbered.
   *   (a) Auto-check the preselected saved-address radio — for ALL confirm jobs
   *       (any source), mirroring the create-flow addresses[0] preselect rule.
   *   (b) BULK-UPLOAD ONLY: mirror the current Complete Address into the
   *       Building/Floor field — bulk rows arrive as one address blob with no
   *       structured building. Gated on source: the Source column shows/stores
   *       "Bulk Upload" (an older EasyFix path wrote the literal 'excel', per
   *       isBulkSentinel) — accept either, case-insensitively.
   */
  const confirmAddrAppliedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!isConfirm || !initial) return;
    const jobKey = Number(initial.job_id);
    if (confirmAddrAppliedRef.current === jobKey || savedAddresses.length === 0) return;
    confirmAddrAppliedRef.current = jobKey;
    // (a) preselect the saved-address radio — every source.
    setSelectedAddressId(savedAddresses[0].address_id);
    // (b) Complete Address → Building/Floor — Bulk Upload only.
    const src = String(initial.source_type ?? '').trim().toLowerCase();
    if (src === 'bulk upload' || src === 'excel') {
      setF((s) => ({ ...s, building: s.address }));
    }
  }, [isConfirm, initial, savedAddresses]);

  /*
   * Fire when the picked client changes. Loads the client's contact
   * list for the Reporting Contact dropdown and resets
   * reporting_contact_id if the old pick is no longer in the new list.
   *
   * Modes:
   *   - create  : always fetch — operator picks client + contact.
   *   - confirm : fetch — operator MUST pick a contact for an
   *               Unconfirmed order (bulk-uploaded rows arrive with no
   *               SPOC info; confirming needs one).
   *   - edit    : skip — the SPOC trio is editable inline via the
   *               existing job-level fields; no contact picker.
   *
   * Endpoint shared with Book New Call: `/admin/clients/:id/contacts`.
   */
  useEffect(() => {
    if (isEdit && !isConfirm) return;
    const clientId = Number(f.fk_client_id);
    if (!clientId) { setClientContacts([]); return; }
    let cancelled = false;
    setLoadingContacts(true);
    // `?unmasked=true` (2026-06-03): the mobile-masking middleware would
    // otherwise return `contact_no` as a masked string like "12••••••89".
    // When pickReportingContact auto-fills `f.client_spoc` from that
    // value, the submit-time `safeMobile()` strips the bullets and the
    // BE persists `client_spoc = NULL` → SPOC Phone displays "—" on
    // the saved job. Fetching unmasked here gives the auto-fill a real
    // number to copy through. The endpoint is staff-only (RBAC-gated)
    // and the operator about to save will also be authorized for the
    // unmasked view, so no new exposure.
    api.get<ClientContact[]>(`/admin/clients/${clientId}/contacts?unmasked=true`)
      .then((rows) => {
        if (cancelled) return;
        // Filter to active contacts (status=1). Legacy CRM only listed active rows.
        setClientContacts((rows || []).filter((r) => Number(r.status) === 1));
      })
      .catch(() => { if (!cancelled) setClientContacts([]); })
      .finally(() => { if (!cancelled) setLoadingContacts(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.fk_client_id, isEdit, isConfirm]);

  /*
   * Auto-fill Client SPOC fields when the operator picks a reporting
   * contact. Legacy CRM auto-filled SPOC name/email/mobile from the
   * selected contact row — we replicate that here. The fields remain
   * editable so a one-off can override.
   */
  function pickReportingContact(contactId: string) {
    set('reporting_contact_id', contactId);
    const c = clientContacts.find((x) => String(x.id) === String(contactId));
    if (c) {
      set('client_spoc_name' as keyof typeof f, (c.contact_name || '') as never);
      set('client_spoc' as keyof typeof f, (c.contact_no || '') as never);
      set('client_spoc_email' as keyof typeof f, (c.contact_email || '') as never);
    }
  }

  // Fetch rate-carded services whenever the picked client changes. Reset the
  // basket too — selections from the old client aren't valid against the new
  // client's rate card (different client_service_id namespace).
  // Create + Confirm both need the catalog. Plain Edit still skips it (we
  // don't expose services editing there today; Confirm is the purpose-built
  // mode for ops to add services to Unconfirmed orders).
  useEffect(() => {
    if (isEdit && !isConfirm) return;
    // Confirm mode uses the job's existing client (fk_client_id on the record);
    // create uses the form field. Either way we need a clientId to fetch.
    const clientId = Number(f.fk_client_id) || Number(initial?.fk_client_id);
    if (!clientId) { setClientServices(null); setServiceRows([]); return; }
    let cancelled = false;
    setLoadingServices(true);
    api.get<ClientService[]>('/shared/lookup/client-services', { clientId })
      .then((rows) => {
        if (cancelled) return;
        setClientServices(rows);
        // Prefill basket from the job's existing services when confirming —
        // ops see what's already there and can add/remove before promoting.
        if (isConfirm && Array.isArray(initial?.services)) {
          const existing = (initial!.services as Array<Record<string, unknown>>)
            // getById returns soft-deleted (job_service_status===0) rows too so
            // the view-mode "Show Inactive" toggle can surface them; the editable
            // draft basket must NOT resurrect them, so keep only active rows.
            .filter((s) => Number(s.job_service_status) !== 0)
            .map((s, i) => ({
              tempId: Date.now() + i,
              client_service_id: String(s.service_id ?? ''),
              quantity: String(s.quantity ?? 1),
            })).filter((r) => r.client_service_id);
          setServiceRows(existing);
        } else {
          setServiceRows([]);
        }
      })
      .catch(() => { if (!cancelled) { setClientServices([]); setServiceRows([]); } })
      .finally(() => { if (!cancelled) setLoadingServices(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.fk_client_id, isEdit, isConfirm, initial?.job_id]);

  /*
   * Create-flow only: prune any basket rows whose client_service_id no
   * longer matches the picked Service Types (operator deselected a
   * type, so the corresponding services should drop out of the basket
   * too). Adding is explicit — handled by the "+" buttons in
   * AutoServicesTable; this effect deliberately does NOT auto-add
   * matching candidates.
   *
   * NOTE on job_type filtering: there is NO database-level mapping
   * between `job_type` and the service row. Legacy `tbl_job.job_type`
   * is a free string; `tbl_client_service.charge_type` is an INTEGER
   * billing-model flag (1 = Fixed, 0 = Variable) — not a Job-Type
   * link. Job Type stays a top-level metadata tag on tbl_job and
   * intentionally does NOT narrow the services basket.
   */
  useEffect(() => {
    if (isEditShape) return;
    if (!Array.isArray(clientServices)) return;
    const picked = new Set((f.fk_service_type_ids || []).map(String));
    if (picked.size === 0) { setServiceRows([]); return; }
    const matchingIds = new Set(
      clientServices
        .filter((cs) => picked.has(String(cs.service_type_id)))
        .map((cs) => String(cs.client_service_id))
    );
    setServiceRows((prev) => prev.filter((r) => matchingIds.has(r.client_service_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.fk_service_type_ids, clientServices, isEditShape]);

  function set<K extends keyof typeof f>(k: K, v: (typeof f)[K]) {
    // Stamp the form as dirty on every user-initiated mutation so the
    // parent JobModal's Esc / X / overlay-close prompt fires. This is
    // intentionally generous — even a no-op edit (typing the same
    // value) flips the flag — because tracking real-vs-no-op diffs
    // here would add complexity for marginal UX gain. Clean close is
    // still one click because the prompt only appears after AT LEAST
    // one field has been touched in the session.
    onFormDirty?.(true);
    setF((s) => ({ ...s, [k]: v }));
  }

  /*
   * Auto-select the Booking Time Slot chip from the Requested Time on LOAD (and
   * any later programmatic time change) — edit/confirm mode only. `toFormShape`
   * seeds `time_slot` from the job row, which is frequently empty or a LEGACY
   * value ('Morning 9 to 2') that matches NO SLOTS chip, so a loaded job showed
   * no chip highlighted. Derive the chip from the time (out-of-window → 'After
   * Hours') whenever the current value isn't already a valid SLOTS chip — this
   * both fixes the highlight AND keeps the submitted time_slot coherent. Guards:
   *   - isEditShape only: create mode uses the legacy 'Morning 9 to 2' vocabulary
   *     (a different Booking Time Slot control) and must NOT be re-mapped.
   *   - skip when time_slot is already a valid SLOTS value → respects a manual
   *     chip pick (e.g. clicking 'After Hours' while the time is in-window).
   *   - setF (not set) so this load-time heal never flips the dirty flag.
   */
  React.useEffect(() => {
    if (!isEditShape) return;
    if (!f.requested_date_time) return;
    if (SLOTS.some((s) => s.value === f.time_slot)) return;
    const derived = inferSlotFromTime(f.requested_date_time);
    if (derived) setF((s) => ({ ...s, time_slot: derived }));
  }, [isEditShape, f.requested_date_time, f.time_slot]);

  /*
   * Client's "Collected By" preference. Read from the client profile
   * (tbl_client_custom_properties) via the BE endpoint added 2026-05-15.
   *   - null      → "Any" — operator picks freely from both options
   *   - 'Easyfix' → lock dropdown to "Easyfix"
   *   - 'Client'  → lock dropdown to "Client"
   * The Collected By <SearchSelect> below reads `collectedByPref` to
   * decide its options + disabled state.
   */
  const [collectedByPref, setCollectedByPref] = useState<string | null>(null);
  useEffect(() => {
    const clientId = Number(f.fk_client_id) || Number(initial?.fk_client_id);
    if (!clientId) { setCollectedByPref(null); return; }
    let cancelled = false;
    api.get<{ preferred: string | null }>(`/admin/clients/${clientId}/collected-by-preference`)
      .then((r) => { if (!cancelled) setCollectedByPref(r?.preferred ?? null); })
      .catch(() => { if (!cancelled) setCollectedByPref(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.fk_client_id, initial?.fk_client_id]);

  // When the client locks the preference, auto-populate the form field
  // so the operator can't save with a value that contradicts the lock.
  //
  // …and UNDO that fill when the client no longer pins one. Switching from a
  // pinned client to an "Any" client (collected_by = 0) unlocks the dropdown but
  // used to leave the previous client's value sitting there preselected — ops
  // could save it without ever choosing, which is the whole point of the field.
  //
  // `lastAppliedPrefRef` makes the clear SURGICAL: we only ever wipe a value we
  // auto-filled ourselves. A value seeded from the saved job (Confirm/Edit mode
  // re-hydrates collected_by) or picked by the operator is never touched — a
  // blind `else set('')` would silently blank the saved value of every job whose
  // client is "Any".
  const lastAppliedPrefRef = useRef<string | null>(null);
  useEffect(() => {
    if (collectedByPref) {
      set('collected_by', collectedByPref);
      lastAppliedPrefRef.current = collectedByPref;
    } else if (lastAppliedPrefRef.current) {
      set('collected_by', '');
      lastAppliedPrefRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectedByPref]);

  // Reset the per-Job tab index whenever the picked category set
  // changes — guarantees activeJobTab is always in range and the
  // operator always lands on Job 1 of the new set.
  useEffect(() => { setActiveJobTab(0); }, [f.fk_service_catg_ids]);

  // Build the services[] payload for the PATCH body — shared between confirm
  // and future edit flows. Silently drops partially-filled rows.
  function buildServicesPayload() {
    return serviceRows
      .filter((r) => r.client_service_id && Number(r.quantity) > 0)
      .map((r) => {
        const meta = (clientServices ?? []).find(
          (cs) => String(cs.client_service_id) === r.client_service_id
        );
        return {
          service_id: Number(r.client_service_id),
          quantity: Number(r.quantity) || 1,
          service_type_id: meta?.service_type_id,
          service_category_id: meta?.service_catg_id,
        };
      });
  }

  /*
   * Submit variants — mirrors the legacy addEditJob footer buttons:
   *   - 'book'        : create with status=0 (BOOKED, the default)
   *   - 'enquiry'     : create with status=7 (ENQUIRY) — info request,
   *                     not a real booking yet
   *   - 'unreachable' : create with status=9 (CALL_LATER) — customer
   *                     couldn't be reached; queued for follow-up
   *
   * For edit/confirm modes the variant has no effect — the existing
   * promote-to-BOOKED flow runs as before.
   */
  const [submitVariant, setSubmitVariant] = useState<'book' | 'enquiry' | 'unreachable' | 'draft'>('book');
  /*
   * Add Remarks dialog mounted inside JobForm so it's available from
   * BOTH footers (the confirm-mode three-button block at ~line 4673
   * AND the shared edit/create footer at ~line 6045). Disabled when
   * no `initial.job_id` exists — Add Remarks POSTs to
   * /admin/jobs/:id/comments and needs a real job. In create mode the
   * button is rendered as disabled-with-tooltip so the affordance is
   * discoverable but obviously not usable until save.
   */
  const [addRemarksFormOpen, setAddRemarksFormOpen] = useState(false);

  /*
   * Job-outcome dialog (Unreachable / Enquiry) — added 2026-05-18 to
   * match the legacy CRM popup that asks the operator WHY the job is
   * being routed to one of those statuses. Captures:
   *   - dueTo    : 'Customer' | 'Client' | 'EasyFix' | 'Technician'
   *   - reasonId : free-text label from a canonical reason list
   *   - remarks  : operator's notes
   * Submitting the popup runs the existing submit() with the
   * relevant `submitVariant` AND the popup data folded into
   * `f.remarks` as a structured prefix so the BE record carries
   * the context without needing new columns on tbl_job.
   */
  const [outcomeDialog, setOutcomeDialog] = useState<null | { mode: 'unreachable' | 'enquiry' }>(null);
  /*
   * Outcome submission payload — captured at dialog-submit time and
   * read by submit() once the status PATCH fires. The structured fields
   * (reasonId, comment) are needed AFTER setStatus to (a) stamp
   * enquiry_reason_id / enquiry_comment / enquiry_date_time on tbl_job
   * and (b) POST a tbl_job_comment row with comment_on=17 so the
   * Rescheduling/History sections on the Summary tab can render the
   * trail. Stays in state across the requestSubmit() defer so the
   * submit() function (which runs after the next render) can read it.
   */
  const [outcomePayload, setOutcomePayload] = useState<null | {
    mode: 'unreachable' | 'enquiry';
    dueTo: string;
    reason: string;
    reasonId: number | null;
    remarks: string;
    comment: string;     // the merged structured prefix (sent as enquiry_comment + tbl_job_comment.comments)
  }>(null);

  /*
   * Permission gate for Unreachable / Enquiry buttons.
   *
   * Originally gated by `isJobAddNew` — but that action key was never
   * seeded into `menu_action`, so the helper (which fails-closed and
   * has no Admin bypass — see src/lib/permissions.ts:23) returned
   * false for EVERY role, hiding the buttons platform-wide.
   *
   * Available Job-related action keys (verified 2026-05-18 against
   * menu_action): isJobAssign, isJobCancel, isJobConfirm, isJobReassign,
   * isJobStatusChange, isTransferJobOwnership. None of these
   * semantically match "create a job in alternate status".
   *
   * Since the Book Call submit itself has NO gate (anyone who opens
   * this modal can create a job in status BOOKED), Unreachable/Enquiry
   * — which are submit variants creating jobs in status 9 / 7 — should
   * follow the same posture. Upstream Navbar/Dashboard buttons that
   * open the modal already gate at the entry point.
   *
   * If ops later wants to restrict these flows, seed `isJobUnreachable`
   * / `isJobEnquiry` (or reuse `isJobStatusChange`) in `menu_action`
   * and re-gate here.
   */
  const canOutcomeButtons = true;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);

    /*
     * Pending-delete confirmation gate (2026-05-28). When the operator
     * has staged image removals via the Confirm-mode "mark for
     * deletion" affordance, the submit handler will flush a real BE
     * DELETE for each id. That's a permanent storage change; confirm
     * before proceeding so a routine Save-Draft / Book-Call doesn't
     * silently commit removals the operator may have forgotten
     * about. Outcome variants (Unreachable / Enquiry) skip the gate
     * because they don't run the pending-delete flush.
     *
     * Placed BEFORE the mandatory-fields gate so a confirm-cancel
     * doesn't leave half-validated state behind. `setSubmitting(true)`
     * happens first to immediately disable the submit buttons
     * (prevents double-clicks during the confirm dialog's await).
     */
    if (
      isConfirm
      && pendingDeleteIds.size > 0
      && (submitVariant === 'book' || submitVariant === 'draft')
    ) {
      const ok = await confirmDialog({
        title: 'Confirm Image Deletions',
        description: `${pendingDeleteIds.size} image${pendingDeleteIds.size === 1 ? '' : 's'} marked for deletion will be permanently removed from storage when this save completes. This cannot be undone after Save.`,
        confirmLabel: 'Delete and Save',
        cancelLabel: 'Review',
        variant: 'destructive',
      });
      if (!ok) {
        setSubmitting(false);
        return;
      }
    }

    setError(null);

    /*
     * Pre-submit mandatory-field guard for the BOOK variant of the
     * Confirm flow. Defence in depth — the Book Call button is
     * already `disabled` when `confirmSection2Complete` is false, but
     * Enter-key submits / programmatic requestSubmit() / any future
     * code path that bypasses the visible button would still reach
     * here. Reject loudly with an explicit list of missing fields so
     * the operator sees what to fix.
     *
     * Outcome variants (unreachable / enquiry) and non-confirm modes
     * (create / edit) are NOT subject to this gate — they have their
     * own minimal validation rules expressed elsewhere.
     */
    // Alt Number format gate (2026-06-03): if the operator typed an
    // alternate, it MUST be a valid Indian mobile. Applied to ALL
    // submitVariants (book / draft / outcome) — even Save Draft
    // shouldn't persist a junk number. Empty stays valid (alt is
    // optional). Runs BEFORE the mandatory-fields gate so a junk alt
    // shows up as a specific error rather than getting masked by
    // "missing required field" noise.
    if (f.additional_number && !isValidIndianMobile(String(f.additional_number))) {
      setError(`Customer Alternate Number — ${INDIAN_MOBILE_ERROR}`);
      setSubmitting(false);
      return;
    }
    // Save Draft (submitVariant === 'draft') intentionally bypasses this
    // mandatory-fields gate — the whole point of draft is to persist
    // partial progress. Only the 'book' variant is gated.
    if (isConfirm && submitVariant === 'book' && (!confirmSection2Complete || !hasAtLeastOneService)) {
      const missing: string[] = [];
      if (!f.client_ref_id || !String(f.client_ref_id).trim()) missing.push('Client Reference ID');
      if (!f.reporting_contact_id) missing.push('Reporting Contact');
      if (!f.customer_name) missing.push('Customer Name');
      if (!f.address) missing.push('Address');
      if (!String(f.city_id || '').trim()) missing.push('City');
      if (!/^[0-9]{6}$/.test(String(f.pin_code || ''))) missing.push('PIN (6 digits)');
      if (!f.requested_date_time) missing.push('Requested Date & Time');
      if (!f.time_slot) missing.push('Time Slot');
      // Collected By is mandatory. Left unset it reached tbl_job as 0 ("Any"),
      // which the checkout flow refuses — the job then couldn't be closed. When
      // the client profile pins a preference the effect above pre-fills this
      // field, so the check passes for free; it only bites when the client is
      // "Any" and ops genuinely has to choose.
      if (!f.collected_by) missing.push('Collected By');
      // Services check — added 2026-05-28 after Job #482453 was booked
      // with zero services. The BE Joi schema now also rejects this so
      // a future FE bug can't repeat the silent-empty-create.
      if (!hasAtLeastOneService) missing.push('At least one Service in Products');
      setError(`Missing required field(s): ${missing.join(', ')}`);
      setSubmitting(false);
      return;
    }

    // Create-mode (Book New Call) mandatory-fields gate — the counterpart of the
    // confirm-mode gate above (2026-06-30). Without it, an INCOMPLETE create form
    // skipped straight to the "Confirm Booking" popup; after the operator
    // confirmed, every per-category POST /admin/jobs failed Joi and they saw
    // "No jobs were created" AFTER the popup. Validate up-front so missing fields
    // show INLINE and the confirm popup only ever appears for a valid form.
    // (section1Complete/section2Complete/GPS_RX are declared later in the create
    // render scope, so we inline the same f.* predicates here.)
    if (!isConfirm && mode === 'create' && submitVariant === 'book') {
      const missing: string[] = [];
      if (!f.fk_client_id) missing.push('Client');
      if (!f.client_ref_id || !String(f.client_ref_id).trim()) missing.push('Client Reference ID');
      if (!f.reporting_contact_id) missing.push('Reporting Contact');
      if (branchProp?.mandatory && !String(f.branch_details || '').trim()) missing.push(branchProp.label || 'Branch Details');
      if (buildingProp?.mandatory && !String(f.building_name || '').trim()) missing.push(buildingProp.label || 'Property / Building Name');
      if (productProp?.mandatory && !String(f.product_code || '').trim()) missing.push(productProp.label || 'Product Code');
      if (!f.customer_name) missing.push('Customer Name');
      if (!/^[0-9]{10}$/.test(String(f.customer_mob_no || ''))) missing.push('Customer Mobile (10 digits)');
      if (!f.address) missing.push('Address');
      if (!String(f.city_id || '').trim()) missing.push('City');
      if (!/^[0-9]{6}$/.test(String(f.pin_code || ''))) missing.push('PIN (6 digits)');
      if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(String(f.gps_location || '').trim())) missing.push('GPS Location (pick on the map)');
      if (!f.requested_date_time) missing.push('Requested Date & Time');
      // Section 3 (Select Products) starred fields — these are the ones the
      // previous gate missed, so an incomplete form (e.g. no Job Type) sailed
      // past validation into the confirm popup + a failed create.
      if (!String(f.fk_service_catg_ids || f.fk_service_catg_id || '').trim()) missing.push('Service Categories');
      if (!(f.fk_service_type_ids && f.fk_service_type_ids.length)) missing.push('Service Type');
      if (!String(f.job_type || '').trim()) missing.push('Job Type');
      // Mandatory here for the same reason as the confirm gate above: unset →
      // tbl_job.collected_by = 0 → the job can never check out.
      if (!f.collected_by) missing.push('Collected By');
      if (!hasAtLeastOneService) missing.push('At least one Service in Products');
      if (missing.length) {
        setError(`Missing required field(s): ${missing.join(', ')}`);
        setSubmitting(false);
        return;
      }
    }

    /*
     * Outcome-only flows (Unreachable / Enquiry) display a global toast
     * for in-flight feedback:
     *   - Loading toast appears immediately so the operator sees the
     *     submission is in progress (previously the modal sat silent
     *     for the 2-3s the PATCH + PATCH /status round-trip took).
     *   - On success → loading toast dismissed, success toast shown.
     *     Modal closes via the closeAfter path.
     *   - On error → loading toast dismissed, error toast shown.
     *     Modal stays open so the operator can retry without losing
     *     their dialog inputs.
     *
     * Book / Confirm flows keep their existing inline feedback (the
     * modal stays open and refreshes); no toast spam there.
     */
    const isOutcomeSubmit = isEditShape
      && (submitVariant === 'unreachable' || submitVariant === 'enquiry');
    const outcomeLabel = submitVariant === 'unreachable' ? 'Unreachable' : 'Enquiry';
    let loadingToastId: number | null = null;
    if (isOutcomeSubmit) {
      loadingToastId = showToast({
        variant: 'loading',
        message: `Marking as ${outcomeLabel}…`,
      });
    }

    try {
      if (isEditShape && initial) {
        const patch: Record<string, unknown> = {};

        /*
         * Single source-of-truth for "should this field be in the patch?":
         *
         *   - `null` / `undefined`     → omit (BE treats as "no change")
         *   - empty string `""`        → omit (BE Joi rejects empty strings
         *                                with "X is not allowed to be empty")
         *   - everything else          → include verbatim (numbers, booleans
         *                                including `false`, non-empty strings,
         *                                arrays, nested objects)
         *
         * Centralising the rule prevents the silent-bug class where one
         * field uses `!== undefined` (sends "") and another uses truthy
         * (omits ""). All edit-mode field inclusions now route through
         * this helper.
         */
        const setIf = (key: string, value: unknown) => {
          if (value === undefined || value === null || value === '') return;
          patch[key] = value;
        };
        /*
         * Sub-object variant — builds an object containing ONLY the
         * non-empty entries. Used for `address` and `customer` sub-payloads
         * where every empty field would otherwise hit the same Joi-empty
         * rejection. Returns null if nothing survives so the caller can
         * conditionally include the sub-object at all.
         */
        const pickIf = (obj: Record<string, unknown>): Record<string, unknown> | null => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined || v === null || v === '') continue;
            out[k] = v;
          }
          return Object.keys(out).length > 0 ? out : null;
        };

        /*
         * Outcome-only variants ('unreachable' / 'enquiry') deliberately
         * SKIP the address/customer/services payload that the full
         * Confirm flow sends. Reason: an Unconfirmed order typically
         * hasn't had address/services filled in yet — sending empty
         * pin_code (or any other partial field) trips the BE Joi
         * validator even though the operator isn't trying to actually
         * book the order. They're just logging the outcome of a call
         * attempt.
         *
         * For these variants we only patch:
         *   - remarks   (carries the structured prefix
         *               `[Unreachable · Due To: X · Reason: Y] free text`)
         *   - efr_special_notes (if the operator added any)
         * Then the status transition fires below (→ 7 Enquiry / → 9
         * Unconfirmed). Address/customer stay untouched.
         */
        const isOutcomeOnly = submitVariant === 'unreachable' || submitVariant === 'enquiry';

        if (!isOutcomeOnly) {
          setIf('job_type', f.job_type);
          setIf('source_type', f.source_type);
          setIf('requested_date_time', f.requested_date_time ? new Date(f.requested_date_time).toISOString() : null);
          setIf('time_slot', f.time_slot);
          setIf('job_desc', f.job_desc);
          setIf('client_ref_id', f.client_ref_id);
          /*
           * Confirm-mode PATCH parity (2026-05-25 fix). These were
           * collected in the form but NEVER sent in the PATCH
           * payload, so the persisted row would lose them after the
           * operator confirmed an order. Each lands on a real tbl_job
           * column with a corresponding key on updateBody:
           *   collected_by                 (per-job preference enum)
           *   booking_cut_off_time_slot    (free-text slot label)
           *   job_client_owner             (internal CRM user — separate
           *                                  from `job_owner`)
           *   additional_name / number     (alternate customer contact)
           *   original_appointment_*       (snapshot of the original
           *                                  promise; BE also derives
           *                                  from requested_date_time
           *                                  on create if absent)
           */
          setIf('collected_by', collectedByCode(f.collected_by));
          setIf('booking_cut_off_time_slot', f.time_slot); // legacy populated same value here
          setIf('additional_name',   f.additional_name);
          setIf('additional_number', f.additional_number);
          /*
           * original_appointment_* on C&S PATCH (2026-06-05). The job
           * came from a no-promise source (bulk upload / legacy
           * dashboard) where original_appointment_* was never stamped
           * at create time. Confirm & Schedule IS the moment ops
           * commits the first promise, so we snapshot the requested
           * date/time into the "original" columns at the same instant.
           * Mirrors the create()-flow default which derives these from
           * requested_date_time when the caller doesn't pass them
           * explicitly. BE update() applies the same IST formatter as
           * create() (see services/job.service.js).
           */
          if (f.requested_date_time) {
            setIf('original_appointment_date_time',
              new Date(f.requested_date_time).toISOString());
            // The legacy companion time column stores "HH:MM". Send the
            // already-derived IST clock time rather than a full ISO datetime:
            // it's exactly what the column persists (no server projection
            // needed) and it can't trip the validator's length cap. The
            // datetime-local value is naive IST wall-clock, so toIstClockTime
            // extracts HH:MM verbatim — correct regardless of browser tz.
            setIf('original_appointment_time',
              toIstClockTime(f.requested_date_time));
          }
        }

        // Confirm flow always sends services (even empty array == "no services"),
        // since ops may have removed rows they'd previously picked. Plain edit
        // skips services to preserve historical rows untouched. Outcome-only
        // also skips services — the operator hasn't built a basket yet.
        if (isConfirm && !isOutcomeOnly) {
          patch.services = buildServicesPayload();
          // Customer name is written to tbl_job.job_customer_name
          // (the per-job copy) — NOT the master tbl_customer row.
          // This lets the same mobile carry a different per-job
          // display name without mutating the customer master.
          // Email still updates the master record because it's a
          // contact channel, not a per-job alias.
          setIf('job_customer_name', f.customer_name);
          const customer = pickIf({ customer_email: f.customer_email });
          if (customer) patch.customer = customer;
          const address = pickIf({
            address:             f.address,
            building:            f.building,
            landmark:            f.landmark,
            city_id:             Number(f.city_id) || undefined,
            pin_code:            f.pin_code,
            gps_location:        f.gps_location,
          });
          // address_instruction is force-included separately so both
          // (a) a typed-then-cleared value propagates as a blank to the BE
          //     (pickIf drops `''` so it would otherwise be silently
          //     omitted — which on Save Draft meant a cleared note kept
          //     the stale value), and
          // (b) a non-empty value sent during Save Draft can't be
          //     silently dropped by future tweaks to pickIf's filter.
          // The BE validator (validators/job.validator.js#address_instruction)
          // explicitly `.allow('', null)` so an empty string round-trips
          // correctly through Joi.
          const ai = (f as Record<string, unknown>).address_instruction;
          if (ai !== undefined) {
            const aiStr = ai == null ? '' : String(ai);
            if (address) {
              (address as Record<string, unknown>).address_instruction = aiStr;
            } else {
              // No other address fields changed but the operator did
              // touch the instruction — still send a tiny address patch
              // so the standalone note edit persists.
              patch.address = { address_instruction: aiStr };
            }
          }
          if (address) patch.address = address;
          // Products-section fields from legacy addEditJob. Label/column
          // mapping (post-2026-06-04 fix):
          //   "Job Description" textarea                          → patch.job_desc         → tbl_job.job_desc
          //   "Anything Handyman should keep in mind?" textarea   → patch.efr_special_notes → tbl_job.efr_special_notes
          // `remarks` is still PATCH-able (legacy free-text notes column,
          // used by the JobOutcomeDialog prefix path below) but no longer
          // bound to a textarea on Confirm mode, so f.remarks is typically
          // empty here and setIf drops it. `fk_service_type_id` /
          // `fk_service_catg_id` carry the active filter selection.
          /*
           * Per-category description support (2026-06-04). The C&S
           * multi-category flow's first category (the one the PATCH'd
           * parent retains) should consult its OWN per-tab override
           * for job_desc, so each category — including the parent's
           * — can carry a distinct description. Falls back to the
           * top-level `f.job_desc` when the operator didn't touch
           * the per-tab description input. Mirrors the sibling-loop
           * pattern at ~line 4992.
           */
          const parentCatId = (f.fk_service_catg_ids || '')
            .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)[0];
          const parentOverride: PerJobOverride | undefined = parentCatId
            ? (perJobFields[String(parentCatId)] as PerJobOverride | undefined)
            : undefined;
          setIf('job_desc', (parentOverride?.job_desc ?? f.job_desc) || undefined);
          setIf('efr_special_notes', f.efr_special_notes);
          setIf('remarks', f.remarks);
          /*
           * job_customer_name on the parent PATCH (2026-06-04). When
           * the job was originally created via the legacy Client
           * Dashboard or an integration, tbl_job.job_customer_name
           * was often NULL (the column is a per-job override of the
           * customer master name and integrations didn't populate it).
           * Confirm & Schedule is the moment ops promotes the order to
           * BOOKED — also a natural moment to ensure the per-job name
           * matches what the operator sees in the form. Send it on
           * the PATCH so the parent row gets backfilled in lock-step
           * with the siblings (which already receive it via the
           * top-level job_customer_name on their POST payload).
           */
          setIf('job_customer_name', f.customer_name);
          // helper_req is a boolean — `false` is a meaningful value the BE
          // must accept, so setIf (which omits `null`/`undefined`/`""` but
          // keeps `false`) handles it correctly. Type-check still here for
          // legacy state shapes where the field might transiently be a string.
          if (typeof f.helper_req === 'boolean') patch.helper_req = f.helper_req;
          if (f.fk_service_catg_id) patch.fk_service_catg_id = Number(f.fk_service_catg_id);
          if (f.fk_service_type_id) patch.fk_service_type_id = Number(f.fk_service_type_id);
          /*
           * service_type_ids CSV (2026-06-05). The PATCH was sending
           * only the singular fk_service_type_id, so tbl_job.service_type_ids
           * stayed stale (often NULL on legacy bulk-upload rows) even
           * after a multi-type C&S confirm. Send the full multi-pick
           * CSV alongside the primary so both columns stay in sync.
           * BE update() now lists `service_type_ids` in MUTABLE_COLUMNS
           * and normalises array/CSV input the same way create() does.
           */
          if (Array.isArray(f.fk_service_type_ids) && f.fk_service_type_ids.length > 0) {
            patch.service_type_ids = f.fk_service_type_ids
              .map(Number)
              .filter((n) => Number.isFinite(n) && n > 0)
              .join(',');
          }
        }

        // Outcome-only path: just the remarks (structured prefix from the
        // JobOutcomeDialog) + any free-text notes the operator added.
        // setIf drops empty strings so the BE Joi "not allowed to be empty"
        // validators don't fire on fields the operator didn't touch.
        if (isOutcomeOnly) {
          setIf('remarks', f.remarks);
          setIf('efr_special_notes', f.efr_special_notes);
        }

        const saved = await api.patch<Job>(`/admin/jobs/${initial.job_id}`, patch);
        // Confirm flow → status promotion depends on which footer
        // variant the operator picked (revised 2026-05-19):
        //   'book'        → 0 (BOOKED) — the happy "Confirm & Schedule" path
        //   'enquiry'     → 7 (ENQUIRY)
        //   'unreachable' → 9 (CALL_LATER) — already 9; re-stamp is a no-op
        //                   but ensures consistency if the row was edited
        //                   to a different status in between.
        //   'draft'       → NO STATUS CHANGE. Save Draft path (added
        //                   2026-05-28) writes the field PATCH above but
        //                   skips the status transition entirely. The
        //                   job stays in its current bucket (typically
        //                   status 9 / Unconfirmed) and reopening the
        //                   modal next time prefills from the saved row.
        // For non-'book' variants we intentionally do NOT re-trigger
        // the BE's "auto status bumps on first assign" path; ops wants
        // the order to STAY in its bucket until they explicitly book it.
        if (isConfirm && submitVariant !== 'draft') {
          const targetStatus =
            submitVariant === 'enquiry' ? 7
              : submitVariant === 'unreachable' ? 9
              : 0;
          // Pass reasonId + structured comment when transitioning into
          // an outcome status. BE setStatus stamps these into:
          //   - tbl_job.enquiry_reason_id / enquiry_comment /
          //     enquiry_date_time / cancel_by  (when status=7)
          //   - tbl_job.cancel_reason_id / cancel_comment /
          //     cancel_date_time / cancel_by  (when status=6, untouched
          //     here; kept for parity reference)
          const statusBody: Record<string, unknown> = { status: targetStatus };
          if (isOutcomeOnly && outcomePayload) {
            if (outcomePayload.reasonId) statusBody.reasonId = outcomePayload.reasonId;
            if (outcomePayload.comment)   statusBody.comment   = outcomePayload.comment;
          }
          await api.patch(`/admin/jobs/${initial.job_id}/status`, statusBody);
          // After the status PATCH, drop a tbl_job_comment row so the
          // Rescheduling/Calling-style trail on the Summary tab can
          // surface the outcome alongside everything else the operator
          // has done on the job. Legacy comment_on codes (verified
          // 2026-05-26):
          //   16 = call_later (Unreachable)
          //   17 = enquiry    (Enquiry)
          // `job_stage` is the human label, persisted alongside the
          // numeric code on deploys that carry the column.
          if (isOutcomeOnly && outcomePayload) {
            const commentOnCode = outcomePayload.mode === 'unreachable' ? 16 : 17;
            const jobStageLabel = outcomePayload.mode === 'unreachable' ? 'call_later' : 'enquiry';
            try {
              await api.post(`/admin/jobs/${initial.job_id}/comments`, {
                comments:        outcomePayload.comment,
                comment_on:      commentOnCode,
                enum_reason_id:  outcomePayload.reasonId || undefined,
                job_stage:       jobStageLabel,
              });
            } catch (commentErr) {
              // Non-fatal: the status transition already landed. Surface
              // a soft warning in the console; the operator's success
              // toast for the outcome itself remains.
              // eslint-disable-next-line no-console
              console.warn('Failed to write outcome comment row', commentErr);
            }
            // Customer "Unreachable" SMS (legacy parity with
            // sendSmsToNotReachableCustomer). Only the Unreachable outcome
            // notifies the customer; Enquiry does not. Fire-and-forget /
            // non-fatal — a provider hiccup must not block the outcome.
            if (outcomePayload.mode === 'unreachable') {
              try {
                await api.post(`/admin/jobs/${initial.job_id}/notify-unreachable`, {});
              } catch (smsErr) {
                // eslint-disable-next-line no-console
                console.warn('Failed to send unreachable SMS', smsErr);
              }
            }
          }
        }
        /*
         * Confirm-mode image upload (2026-05-28). Save Draft AND Book Call
         * both upload any staged Job Images to /admin/jobs/:id/images.
         * Outcome-only paths (Unreachable / Enquiry) skip the upload — the
         * operator hasn't filled service/product detail yet, so there are
         * typically no relevant images. Drafts WILL upload so reopening
         * the modal shows the previously-staged images via the existing
         * Images tab in view mode.
         *
         * Failure semantics: each upload is independent + wrapped in its
         * own try/catch. A failed upload logs a warn and continues with
         * the rest. The overall flow's success toast still fires — partial
         * upload is preferable to losing the entire save.
         */
        if (!isOutcomeOnly && initial?.job_id) {
          /*
           * Flush pending IMAGE DELETIONS first (2026-05-28). These
           * are tiles the operator X'd in the inline Job Image
           * section — the X gesture stages them, this loop commits.
           * Done BEFORE the uploads so a same-session sequence of
           * "delete old, upload new" stays in order on the server's
           * audit log. Each DELETE is independent + soft-fails so a
           * stale id (already gone) doesn't block the rest of the
           * save.
           */
          if (pendingDeleteIds.size > 0) {
            for (const id of pendingDeleteIds) {
              try {
                await api.delete(`/admin/jobs/images/${id}`);
              } catch (delErr) {
                // eslint-disable-next-line no-console
                console.warn(`Image delete failed during ${submitVariant} for image ${id}:`, delErr);
              }
            }
            setPendingDeleteIds(new Set());
          }

          const staged = ((f as unknown as { job_image_files?: File[] }).job_image_files ?? [])
            .filter((x) => x instanceof File);
          if (staged.length > 0) {
            for (const file of staged) {
              // Mark BEFORE the POST so the tile shows the spinner
              // overlay immediately. The tile reads `uploadStatuses` by
              // file dedupe-key (see preview render block).
              setUploadStatus(file, 'uploading');
              try {
                const fd = new FormData();
                fd.append('file', file);
                await api.post(`/admin/jobs/${initial.job_id}/images`, fd);
                setUploadStatus(file, 'done');
              } catch (upErr) {
                setUploadStatus(file, 'error');
                // eslint-disable-next-line no-console
                console.warn(`Image upload failed during ${submitVariant} for job ${initial.job_id}:`, upErr);
              }
            }
            // Clear the staging array after the loop ends so a second
            // click (e.g. an extra Save Draft after one already landed)
            // doesn't re-upload the same files. Errored files are
            // ALSO cleared — operator can re-pick them if needed; we
            // don't want to leave half-failed state on the modal.
            //
            // Also clear the per-file status map — next picker cycle
            // starts fresh; no stale 'done'/'error' chrome leaks across.
            setF((s) => ({ ...s, job_image_files: [] as never, job_image_file: null as never }));
            setUploadStatuses({});
          }
        }
        /*
         * Multi-category fan-out for Confirm & Schedule (2026-06-03 per ops).
         *
         * Bug it fixes: when the operator picked 2+ Service Categories
         * on an Unconfirmed order (e.g. Carpentry + Electrician), the
         * original PATCH at line ~4688 only updated the existing
         * tbl_job row with the FIRST category. Sibling categories were
         * silently dropped — no second job was created.
         *
         * Fix: after the PATCH + status promotion succeed, fan out one
         * POST /admin/jobs per ADDITIONAL category. Each new job:
         *   - copies customer + address + schedule fields from the form
         *   - reuses the EXISTING job's `client_ref_id` (from the PATCH
         *     response) so the family of jobs is discoverable together
         *   - filters `servicesPayload` to rows whose service_category_id
         *     matches that category — same per-category filter the
         *     CREATE path uses (line ~5023)
         *   - inherits any per-tab override (job_image_files, helper_req,
         *     etc.) from `perJobFields[String(catId)]` — same mechanism
         *     as the CREATE multi-category loop
         *
         * The original job's category stays whatever the PATCH set
         * (typically the first picked). Failures on sibling creates are
         * logged but non-fatal — the original job is already in BOOKED
         * and the operator can pick up the missed category(ies) from a
         * subsequent Confirm pass.
         *
         * Fans out for BOTH Confirm & Schedule (book) AND Save Draft
         * (draft) so a multi-category DRAFT persists every picked category
         * as a sibling job instead of silently collapsing to the first.
         * Outcome paths (Enquiry / Unreachable) still don't fan out. Draft
         * siblings are created Unconfirmed (status 9) to match the drafted
         * parent; book siblings BOOKED (0). See initial_status below.
         */
        if (isConfirm && (submitVariant === 'book' || submitVariant === 'draft')) {
          const allCatIds = (f.fk_service_catg_ids || '')
            .split(',').filter(Boolean).map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
          // catIds[0] is the existing job's category (PATCH already handled).
          // Any extras become new sibling jobs.
          const siblingCats = allCatIds.slice(1);
          if (siblingCats.length > 0) {
            // Build a base payload once, mirroring the CREATE-flow
            // basePayload at ~line 4922. We capture customer + address
            // + schedule etc. so each sibling looks identical to a
            // brand-new Book-New-Call job for that category.
            const clientRefId = saved.client_ref_id || f.client_ref_id || undefined;
            /*
             * C&S sibling fan-out address reuse (2026-06-04). Before this
             * fix the FE shipped the FULL inline address on every sibling
             * POST, which caused the BE `create()` to call `insertAddress`
             * and create N duplicate rows in tbl_address for the same
             * physical location. The BE already supports the
             * `address.address_id` short-circuit (see job.service.js
             * ~line 1279: `if (!addressId) insertAddress(...)`). So we
             * pass ONLY the parent's address_id and let the BE reuse the
             * existing row. `saved.fk_address_id` (PATCH response) is the
             * source of truth; falls back to `initial.fk_address_id`
             * (form prefill) and then to inline if neither is present
             * (defensive — should never trigger in confirm mode).
             */
            // C&S sibling fan-out address reuse — see
            // src/lib/job-address.ts for the full rationale + dev-time
            // canary. Source priority: PATCH response (freshest), then
            // form prefill. Fallback to inline only if both lack
            // fk_address_id (defensive; should never trigger in confirm
            // mode since the parent already has an address row).
            const parentAddressId = resolveParentAddressId(saved, initial);
            const siblingBase = {
              fk_client_id: Number(f.fk_client_id),
              job_type: f.job_type,
              source_type: f.source_type || 'CRM - New',
              // Draft bypasses validation, so a draft may have no date yet;
              // guard the ISO conversion so an empty value can't throw and
              // abort the whole save. (A dateless draft sibling is rejected by
              // create() — date is required — and caught non-fatally below,
              // same as any other sibling failure.)
              requested_date_time: f.requested_date_time
                ? new Date(f.requested_date_time).toISOString()
                : undefined,
              time_slot: f.time_slot || undefined,
              client_ref_id: clientRefId,
              // Explicit top-level job_customer_name (2026-06-04).
              // The BE accepts both shapes (top-level OR nested under
              // customer.customer_name) and prefers the top-level
              // value when both are present. Sending it explicitly
              // here defends against the C&S form-state edge case
              // where `f.customer_name` was observed landing as the
              // empty string for siblings — keeping tbl_job's per-job
              // override populated independently of the customer
              // master record.
              job_customer_name: f.customer_name || undefined,
              customer: {
                customer_name: f.customer_name,
                customer_mob_no: f.customer_mob_no,
                customer_email: f.customer_email || undefined,
              },
              address: buildJobAddressPayload(
                parentAddressId,
                {
                  address: f.address,
                  building: f.building || undefined,
                  landmark: f.landmark || undefined,
                  city_id: Number(f.city_id),
                  pin_code: f.pin_code,
                  gps_location: f.gps_location || undefined,
                  address_instruction: ((f as Record<string, unknown>).address_instruction as string | undefined) || undefined,
                },
                { expectingReuse: true }, // C&S sibling — log a canary if we fall through
              ),
              // Match the parent's post-save status: Save Draft keeps the job
              // Unconfirmed (9); Confirm & Schedule promotes to BOOKED (0).
              initial_status: submitVariant === 'draft' ? 9 : 0,
              branch_details:    f.branch_details || undefined,
              product_code:      f.product_code || undefined,
              building_name:     f.building_name || undefined,
              reporting_contact_id: f.reporting_contact_id ? Number(f.reporting_contact_id) : undefined,
              client_spoc:       safeMobile(f.client_spoc),
              client_spoc_name:  f.client_spoc_name || undefined,
              client_spoc_email: f.client_spoc_email || undefined,
              additional_name:   f.additional_name   || undefined,
              additional_number: safeMobile(f.additional_number),
              collected_by:      collectedByCode(f.collected_by),
            };
            // buildServicesPayload() is called once here — its output is
            // the full picked-services basket across ALL categories, the
            // same array we pass to the PATCH above. We filter per
            // sibling catId so each new job carries only its own rate-
            // card rows (matches the CREATE-flow filter at ~line 5023).
            const allServices = buildServicesPayload() as Array<Record<string, unknown>>;
            const servicesForCat = (catId: number) =>
              allServices.filter((s) => Number(s.service_category_id) === catId);
            for (const catId of siblingCats) {
              const override = (perJobFields[String(catId)] || {}) as PerJobOverride;
              const filtered = servicesForCat(catId);
              /*
               * fk_service_type_id per sibling (2026-06-04). The
               * BE's create() binds `input.fk_service_type_id || null`
               * for tbl_job.fk_service_type_id — without this we'd
               * write NULL for every sibling. Resolution:
               *   1. Per-tab override `perJobFields[catId].fk_service_type_id`
               *      (operator explicitly chose a primary type for
               *      this category's tab).
               *   2. First service_type_id from `filtered` (services
               *      belonging to this category). Establishes a
               *      sensible default when ops doesn't pick one.
               *   3. NULL if the category has no services attached.
               */
              const siblingTypeIdRaw =
                (override as { fk_service_type_id?: number | string | null }).fk_service_type_id
                ?? (filtered[0]?.fk_service_type_id ?? filtered[0]?.service_type_id);
              const siblingTypeId = (siblingTypeIdRaw != null && siblingTypeIdRaw !== '')
                ? Number(siblingTypeIdRaw)
                : undefined;
              /*
               * service_type_ids per sibling (2026-06-05): CSV of every
               * service_type_id present in this sibling's filtered
               * services basket. Mirrors the singular fk_service_type_id
               * derivation above but covers EVERY picked type rather
               * than just the primary. De-duplicated via Set so a
               * category with two services of the same type doesn't
               * write "12,12". Empty when the sibling has no services
               * — the BE writes NULL.
               */
              const siblingTypeIdsCsv = (() => {
                const ids = filtered
                  .map((s) => {
                    const raw = (s as { fk_service_type_id?: number | string; service_type_id?: number | string }).fk_service_type_id
                      ?? (s as { service_type_id?: number | string }).service_type_id;
                    const n = Number(raw);
                    return Number.isFinite(n) && n > 0 ? n : null;
                  })
                  .filter((n): n is number => n !== null);
                if (ids.length === 0) return undefined;
                return Array.from(new Set(ids)).join(',');
              })();
              const siblingPayload = {
                ...siblingBase,
                fk_service_catg_id: catId,
                fk_service_type_id: Number.isFinite(siblingTypeId) ? siblingTypeId : undefined,
                service_type_ids: siblingTypeIdsCsv,
                job_desc:          (override.job_desc ?? f.job_desc) || undefined,
                remarks:           (override.remarks ?? f.remarks) || undefined,
                efr_special_notes: (override.efr_special_notes ?? f.efr_special_notes) || undefined,
                helper_req:        override.helper_req ?? Boolean(f.helper_req),
                material_req:      override.material_req ?? Boolean(f.material_req),
                services:          filtered.length > 0 ? filtered : undefined,
              };
              try {
                const newJob = await api.post<Job>('/admin/jobs', siblingPayload);
                // Upload tab-specific images, if any. Falls back to the
                // operator's general staged files only when this tab
                // hasn't been touched separately — keeps each sibling
                // job's image set distinct.
                const tabFiles: File[] = (
                  (override.job_image_files as File[] | undefined) ?? []
                ).filter((x) => x instanceof File);
                if (newJob?.job_id && tabFiles.length > 0) {
                  for (const file of tabFiles) {
                    try {
                      const fd = new FormData();
                      fd.append('file', file);
                      await api.post(`/admin/jobs/${newJob.job_id}/images`, fd);
                    } catch (upErr) {
                      // eslint-disable-next-line no-console
                      console.warn(`Sibling-job image upload failed for category ${catId}, job ${newJob.job_id}:`, upErr);
                    }
                  }
                }
              } catch (e) {
                // Non-fatal — original is already BOOKED. Surface a
                // console warning so the operator can manually re-confirm
                // the missing category later.
                // eslint-disable-next-line no-console
                console.warn(`Failed to create sibling job for category ${catId} during Confirm fan-out:`, e);
              }
            }
          }
        }

        // Success-path toast for outcome-only flows. Transition the
        // loading toast to a green success toast at the same bottom-
        // centre slot. The toast component auto-dismisses success
        // after 4s.
        if (isOutcomeOnly) {
          if (loadingToastId != null) dismissToast(loadingToastId);
          loadingToastId = null;
          showToast({
            variant: 'success',
            message: `Marked as ${outcomeLabel} successfully`,
          });
        }
        // Save Draft path — same loading→success transition. The
        // operator gets explicit confirmation that the in-progress fields
        // are persisted on tbl_job and will prefill on next reopen, plus
        // a hint that status hasn't changed.
        if (submitVariant === 'draft') {
          if (loadingToastId != null) dismissToast(loadingToastId);
          loadingToastId = null;
          showToast({
            variant: 'success',
            message: 'Draft Saved',
          });
        }
        // Tell the parent how to behave after this save. Outcome-only
        // flows (Unreachable / Enquiry) AND Save Draft want the modal
        // closed immediately — no flash of "loading…" while the modal
        // refetches into view mode. Book stays open so the operator can
        // see the updated booking.
        onSaved(saved, { closeAfter: isOutcomeOnly || submitVariant === 'draft', variant: submitVariant });
      } else {
        // Create flow — full payload including customer + address + services.
        const servicesPayload = buildServicesPayload();

        /*
         * Job Image: uploaded as a SECOND step AFTER the job is
         * created, against POST /admin/jobs/:id/images. That endpoint
         * routes the binary to S3 at Job_Images/<jobId>_<seq> (per ops
         * spec 2026-05-14) with the local filesystem as fallback when
         * S3 is disabled / unreachable. The jobId is needed in the key
         * so the upload necessarily happens after job creation.
         *
         * Trade-off vs. uploading first: if the image upload fails,
         * the job still exists without an image. We surface a
         * non-fatal warning rather than rolling back the job — the
         * operator can re-attach the image from the View screen
         * later, and the booking itself is the higher-stakes record.
         */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imageFile = (f as unknown as { job_image_file?: File }).job_image_file;

        /*
         * Service Category multi-select (2026-05-15): if the operator
         * picked N categories, we POST N create-job requests in a
         * loop, each with a single `fk_service_catg_id`. All N jobs
         * share the same `client_ref_id` so they're discoverable as
         * a group. If only one category is picked, behaviour is
         * identical to the legacy single-category flow.
         *
         * Failure semantics: failures are surfaced per-row in the
         * console; the form's `error` state shows a summary. We do
         * NOT auto-rollback already-created jobs — partial success
         * is preferable to silently throwing away successfully-
         * created bookings.
         */
        /*
         * Book-Call confirmation popup (extended 2026-05-26). The
         * operator confirms before we fan-out N create POSTs across
         * multi-category — AND before promoting an Unconfirmed job to
         * BOOKED via the Confirm & Schedule modal. Cancellation short-
         * circuits the entire submit with `setSubmitting(false)`.
         */
        if (submitVariant === 'book' && (mode === 'create' || mode === 'confirm')) {
          const previewCount = (f.fk_service_catg_ids || '').split(',').filter(Boolean).length || 1;
          const isConfirmMode = mode === 'confirm';
          const okToBook = await confirmDialog({
            title: isConfirmMode ? 'Confirm & Schedule?' : 'Confirm Booking',
            description: isConfirmMode
              ? `Promote this enquiry to a BOOKED job for "${f.customer_name}" on ${new Date(f.requested_date_time).toLocaleString()}? The technician will be assignable after this step.`
              : previewCount > 1
                ? `Create ${previewCount} jobs (one per selected service category) for "${f.customer_name}"?`
                : `Create a new job for "${f.customer_name}" on ${new Date(f.requested_date_time).toLocaleString()}?`,
            confirmLabel: isConfirmMode ? 'Book Call' : (previewCount > 1 ? `Book ${previewCount} Calls` : 'Book Call'),
            cancelLabel: 'Review',
            variant: 'default',
          });
          if (!okToBook) {
            setSubmitting(false);
            return;
          }
        }

        const categoryIds = (f.fk_service_catg_ids || '')
          .split(',')
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0);
        // Always at least one category in the payload — either the
        // multi list, or fall back to the single-select state.
        const catsToCreate = categoryIds.length > 0
          ? categoryIds
          : (f.fk_service_catg_id ? [Number(f.fk_service_catg_id)] : [0]);

        const basePayload = {
          fk_client_id: Number(f.fk_client_id),
          job_type: f.job_type,
          // Source defaults to 'CRM - New' for any new-CRM booking so the
          // legacy 'CRM' bucket continues to denote legacy-CRM bookings
          // unambiguously. Existing convention is mixed-case with spaces
          // (Dashboard / Bulk Upload / Decathlon API / etc) so 'CRM - New'
          // fits naturally. The picker is intentionally hidden — operators
          // shouldn't override the source.
          source_type: f.source_type || 'CRM - New',
          requested_date_time: new Date(f.requested_date_time).toISOString(),
          time_slot: f.time_slot || undefined,
          job_desc: f.job_desc || undefined,
          client_ref_id: f.client_ref_id || undefined,
          customer: {
            customer_name: f.customer_name,
            customer_mob_no: f.customer_mob_no,
            customer_email: f.customer_email || undefined,
          },
          address: {
            address: f.address,
            building: f.building || undefined,
            landmark: f.landmark || undefined,
            city_id: Number(f.city_id),
            pin_code: f.pin_code,
            gps_location: f.gps_location || undefined,
            // Persisted to tbl_address.address_instruction by the BE.
            address_instruction: ((f as Record<string, unknown>).address_instruction as string | undefined) || undefined,
          },
          services: servicesPayload.length > 0 ? servicesPayload : undefined,
          // Legacy parity: book (default), enquiry, or unreachable.
          // Backend accepts `initial_status` and routes the new row to
          // the matching tbl_job.job_status code.
          initial_status:
            submitVariant === 'enquiry' ? 7
            : submitVariant === 'unreachable' ? 9
            : undefined,  // default is 0 = BOOKED
          // Legacy Book-New-Call extras. Backend composeRemarks() folds
          // these into the remarks column with named prefixes.
          branch_details: f.branch_details || undefined,
          product_code: f.product_code || undefined,
          building_name: f.building_name || undefined,
          /*
           * efr_special_notes (2026-06-05): explicit basePayload fallback.
           * The per-category loop below ALSO sets this from
           * `(override.efr_special_notes ?? f.efr_special_notes)`, but
           * in zero-categories-picked single-shot Book-New-Call the
           * loop runs with catId=0 and perJobFields[0] is empty, so
           * the override branch returns undefined and the fallback
           * `f.efr_special_notes` is the only source. Carrying it on
           * basePayload too defends against the per-category branch
           * being optimised away in future and makes the contract
           * explicit ("BE always receives the field, even if blank").
           * The loop's spread happens AFTER basePayload so per-tab
           * overrides still win on multi-category jobs.
           */
          efr_special_notes: f.efr_special_notes || undefined,
          // SPOC tags. Backend already accepts these directly on
          // tbl_job (verified in MUTABLE_COLUMNS + the INSERT column list).
          // safeMobile() strips any value that still contains a bullet —
          // defends against round-tripping the masked display string into
          // the DB if the source fetch wasn't `?unmasked=true`. The BE
          // also enforces this via middleware/reject-masked-mobile.js, so
          // it's belt-and-braces.
          reporting_contact_id: f.reporting_contact_id ? Number(f.reporting_contact_id) : undefined,
          client_spoc:       safeMobile(f.client_spoc),
          client_spoc_name:  f.client_spoc_name || undefined,
          client_spoc_email: f.client_spoc_email || undefined,
          /*
           * Customer-alternate contact — captured via the new inputs
           * in the Customer Details section. Maps to tbl_job columns
           * additional_name / additional_number.
           */
          additional_name:   f.additional_name   || undefined,
          additional_number: safeMobile(f.additional_number),
          /*
           * Per-job commercial fields previously dropped on the floor:
           *   - collected_by    : preference (1=Easyfixer/2=Easyfix/3=Client).
           *                        Form default is "Easyfix" → coerced to 2.
           *   - job_owner       : already supported, mapped from f.job_owner if present.
           *   - service_type_ids: CSV passed through for multi-pick.
           * The BE service derives `requested_time`,
           * `original_appointment_date_time`, and
           * `original_appointment_time` from `requested_date_time` if
           * the FE doesn't pass them explicitly.
           */
          collected_by: collectedByCode(f.collected_by),
          /*
           * Service-type FKs (2026-06-05): persist BOTH columns on the
           * new tbl_job row.
           *   - fk_service_type_id  : the single PRIMARY type
           *     (first selected — matches the C&S sibling derivation
           *     at the loop below)
           *   - service_type_ids    : comma-separated CSV of every
           *     picked type id (multi-pick). BE create() accepts
           *     either `service_type_ids` or `fk_service_type_ids`
           *     (alias) and normalises arrays → CSV via Array.join
           *     before the INSERT.
           * The per-category loop below spreads basePayload then
           * overrides `fk_service_type_id` per sibling — basePayload's
           * value here serves the zero-or-single-category case.
           */
          fk_service_type_id: (Array.isArray(f.fk_service_type_ids) && f.fk_service_type_ids.length > 0)
            ? Number(f.fk_service_type_ids[0])
            : (f.fk_service_type_id ? Number(f.fk_service_type_id) : undefined),
          service_type_ids: (Array.isArray(f.fk_service_type_ids) && f.fk_service_type_ids.length > 0)
            ? f.fk_service_type_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0).join(',')
            : undefined,
          // Questionnaire FK (tbl_questionaire.c_questionaire_id). The
          // backend create() can stash this on tbl_job's reporting
          // metadata if a column exists; otherwise it surfaces in the
          // job_data audit trail. Left as a passive payload field so
          // we don't break callers that ignore it.
          c_questionaire_id: f.c_questionaire_id ? Number(f.c_questionaire_id) : undefined,
        };

        /*
         * Multi-category create loop. For each picked category we
         * POST one job sharing the same payload + client_ref_id.
         * The image upload (if any) is attached only to the FIRST
         * created job — duplicating a single uploaded image across
         * N S3 keys would waste storage; the operator can re-attach
         * the image to siblings from the detail view if needed.
         */
        const created: Job[] = [];
        const failures: string[] = [];
        for (const catId of catsToCreate) {
          /*
           * Per-category services filter. When the operator picked N
           * categories, the global `servicesPayload` carries rows
           * across all of them. For each job we POST only the rows
           * whose `service_category_id` matches this iteration's
           * category — matches the per-Job tab UX so each created
           * job carries only the services the operator put under
           * its tab. With 0 picked categories the filter is a
           * passthrough (single-job legacy behaviour).
           */
          const filteredServices = catId > 0
            ? servicesPayload.filter((s) => Number(s.service_category_id) === catId)
            : servicesPayload;
          /*
           * Per-tab field overrides — when 2+ categories are picked,
           * each Job tab has its own values for Job Image / Special
           * Comments / EFR Notes / Helper / Material / Collected By.
           * The override map is keyed by stringified catId. Missing
           * slots fall back to the top-level `f` values (so a tab
           * the operator never touched still inherits the form's
           * default values rather than going blank).
           */
          const override = (perJobFields[String(catId)] || {}) as PerJobOverride;
          const payload = {
            ...basePayload,
            // Per-tab overrides take precedence over basePayload's
            // common values. `??` falls back to f-derived values.
            remarks:           (override.remarks ?? f.remarks) || undefined,
            efr_special_notes: (override.efr_special_notes ?? f.efr_special_notes) || undefined,
            helper_req:        override.helper_req ?? Boolean(f.helper_req),
            material_req:      override.material_req ?? Boolean(f.material_req),
            // MUST re-code to the numeric enum. `basePayload` already sends
            // collectedByCode(f.collected_by), but this per-tab override clobbers
            // it — and both `override.collected_by` and `f.collected_by` hold the
            // LABEL ('Easyfix'/'Easyfixer'), not the code. Sending the raw label
            // made the BE's Number('Easyfix')=NaN fall through and MySQL coerce
            // the string into the INT column as 0 — so a client pinned to
            // Collected By = Easyfix (2) had its jobs saved as 0 (Any), which
            // then blocks checkout. collectedByCode is a no-op on a number, so
            // wrapping is safe whichever shape the field holds.
            collected_by:      collectedByCode(override.collected_by ?? f.collected_by),
            services: filteredServices.length > 0 ? filteredServices : undefined,
            ...(catId > 0 ? { fk_service_catg_id: catId } : {}),
          };
          try {
            const saved = await api.post<Job>('/admin/jobs', payload);
            created.push(saved);
            /*
             * Per-tab Job Image upload — each tab's image is uploaded
             * to its own job. Falls back to the top-level `imageFile`
             * for the FIRST job (legacy single-tab behaviour) when
             * the override slot has no image.
             */
            /*
             * Multi-file upload (2026-05-25): take all picked files
             * from `job_image_files` (array). Falls back to the legacy
             * single `job_image_file` field for backwards-compat. Each
             * file POSTs sequentially so the BE generates distinct
             * `_<seq>` keys; parallel would race on the seq counter.
             */
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tabImageFiles: File[] = (
              (override.job_image_files as File[] | undefined)
              ?? ((f as unknown as { job_image_files?: File[] }).job_image_files)
              ?? []
            ).filter((x) => x instanceof File);
            const tabSingleFallback = override.job_image_file ?? (created.length === 1 ? imageFile : null);
            const filesToUpload: File[] =
              tabImageFiles.length > 0
                ? tabImageFiles
                : (tabSingleFallback instanceof File ? [tabSingleFallback] : []);
            if (saved?.job_id && filesToUpload.length > 0) {
              for (const f of filesToUpload) {
                try {
                  const fd = new FormData();
                  fd.append('file', f);
                  await api.post(`/admin/jobs/${saved.job_id}/images`, fd);
                } catch (upErr) {
                  // eslint-disable-next-line no-console
                  console.warn(`Image upload failed for job ${saved.job_id}:`, upErr);
                }
              }
            }
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : 'create failed';
            failures.push(`category ${catId}: ${msg}`);
          }
        }

        if (created.length === 0) {
          setError(`No jobs were created. ${failures.join(' · ')}`);
          return;
        }

        // Per-tab image uploads happened inside the loop above —
        // each created job got its tab's image (or the top-level
        // `imageFile` for single-tab / first-tab fallback). No
        // additional upload needed here.
        const firstSaved = created[0];
        const uploadedImage = created.length > 0 && (
          imageFile instanceof File ||
          Object.values(perJobFields).some((o) => o?.job_image_file instanceof File)
        );

        // Surface any partial-failure to the operator without
        // discarding the successful jobs. Common cause: one category
        // is inactive at the BE while others are fine.
        if (failures.length > 0) {
          setError(
            `${created.length} job(s) created; ${failures.length} failed: ${failures.join(' · ')}`,
          );
        }

        // If an image was uploaded AFTER the create POST, re-fetch the
        // job detail so the post-submit view-mode modal renders the
        // image instead of showing `Images (0)`. The POST /admin/jobs
        // response was captured BEFORE the image upload, so its
        // `images` array is empty even though the row is now in
        // `tbl_job_image`. Re-fetch is best-effort: on failure we fall
        // back to the stale payload — the image is safely saved, the
        // operator will see it on the next modal open.
        let toSave: Job = firstSaved;
        if (uploadedImage && firstSaved?.job_id) {
          try {
            const fresh = await api.get<Job>(`/admin/jobs/${firstSaved.job_id}`);
            if (fresh) toSave = fresh;
          } catch {
            // ignore — fall back to the stale `firstSaved`
          }
        }
        onSaved(toSave);
      }
    } catch (err) {
      const msg = err instanceof ApiError
        ? err.message + (err.details ? ` — ${JSON.stringify(err.details)}` : '')
        : 'Failed to save';
      setError(msg);
      // Outcome-only failure feedback: the modal stays open (operator
      // can retry with the same dialog inputs) AND we surface a sticky
      // error toast so the failure is impossible to miss. Without the
      // toast, the error was only visible inside the JobForm — which
      // the operator might have stopped looking at after the outcome
      // dialog closed.
      if (isOutcomeSubmit) {
        if (loadingToastId != null) dismissToast(loadingToastId);
        loadingToastId = null;
        showToast({
          variant: 'error',
          message: `Failed to mark as ${outcomeLabel}: ${msg}`,
        });
      }
    } finally { setSubmitting(false); }
  }

  /*
   * Confirm-mode UX: top summary strip + 3 accordion sections replicating
   * the legacy `addEditJob?loc=home` modal structure. Rendered as a
   * separate branch from the edit/create flow so each layout stays
   * readable.
   *
   * Accordion state (added 2026-05-19): mirrors the create-flow gating
   * — Customer Details and Select Products start collapsed; each
   * unlocks only when the prior section's mandatory fields are filled.
   * `confirmOpenSection` lives ABOVE the early-return so React's
   * Rules of Hooks are satisfied regardless of which branch renders.
   */
  const [confirmOpenSection, setConfirmOpenSection] = React.useState<1 | 2 | 3>(1);
  // Confirm & Schedule: same "scroll the just-expanded section header to the top
  // of the modal body (no focus)" behaviour as the create flow. These refs + the
  // effect MUST live above the `if (isConfirm && initial) return (…)` early-
  // return so React's Rules of Hooks hold. Double rAF for the collapse-above shift.
  const confirmSection2Ref = React.useRef<HTMLElement | null>(null);
  const confirmSection3Ref = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const el = confirmOpenSection === 3 ? confirmSection3Ref.current
      : confirmOpenSection === 2 ? confirmSection2Ref.current
      : null;
    if (!el) return undefined;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => scrollSectionToTop(el)));
    return () => cancelAnimationFrame(raf);
  }, [confirmOpenSection]);

  // Confirm & Schedule reschedule pre-fill: when the job has a PENDING customer
  // reschedule request, seed Requested Date/Time with the customer's requested
  // NEW time (the same preferred_datetime the "New:" list badge shows) and keep
  // the ORIGINAL appointment (initial.requested_date_time) to show under the
  // field. Fetches only in confirm mode; applied once via the ref guard so it
  // never clobbers an operator edit. Lives above the early-return (Rules of Hooks).
  const rescheduleReqJobId = isConfirm && initial ? Number(initial.job_id) : null;
  const { data: custReqData } = useFetch<CustomerRequest[] | { items?: CustomerRequest[] }>(
    rescheduleReqJobId ? `/admin/jobs/${rescheduleReqJobId}/customer-requests` : null,
  );
  const pendingReschedule = React.useMemo(() => {
    const rows = Array.isArray(custReqData) ? custReqData : (custReqData?.items ?? []);
    return rows.find((r) => r.request_status === 'pending' && r.request_type === 'reschedule' && r.preferred_datetime) ?? null;
  }, [custReqData]);
  const reschedulePrefillRef = React.useRef(false);
  React.useEffect(() => {
    if (!pendingReschedule || reschedulePrefillRef.current) return;
    reschedulePrefillRef.current = true;
    // preferred_datetime is 'YYYY-MM-DD HH:mm:ss' → datetime-local 'YYYY-MM-DDTHH:mm'.
    const pref = String(pendingReschedule.preferred_datetime).slice(0, 16).replace(' ', 'T');
    setF((s) => ({ ...s, requested_date_time: pref, time_slot: inferSlotFromTime(pref) ?? s.time_slot }));
  }, [pendingReschedule]);

  /*
   * Client custom-properties (loaded when a client is picked).
   * Map of `propertyName → { mandatory: boolean }`. Drives:
   *   - Visibility of "Branch Details", "Property / Building Name",
   *     "Product Code" inputs in Section 1. A field shows ONLY when
   *     its property name appears in this map. If the client has no
   *     row for `building_name`, the input is hidden.
   *   - Required state + visual `*` on each field, driven by the
   *     property's `mandatory` flag in the DB.
   *
   * Property name conventions (must match the FE labels below):
   *   - `branch_details` (or `branch`) → Branch Details
   *   - `building_name`  (or `property_name` / `building`) → Property / Building Name
   *   - `product_code`   (or `sku`) → Product Code
   *
   * Anything else in the response is captured but currently unused.
   *
   * Declared here (above the confirm-mode early-return) so both the
   * Book New Call flow and the Confirm & Schedule flow can read the
   * same derived flags — Confirm gates Section 1 on the same
   * mandatory custom props the Book flow already enforces.
   */
  type CustomProp = { name: string; mandatory: boolean; label: string | null; value: string | null };
  const [clientCustomProps, setClientCustomProps] = useState<Map<string, CustomProp>>(new Map());
  useEffect(() => {
    const clientId = Number(f.fk_client_id) || Number(initial?.fk_client_id);
    if (!clientId) { setClientCustomProps(new Map()); return; }
    let cancelled = false;
    api.get<CustomProp[]>(`/admin/clients/${clientId}/custom-properties`)
      .then((rows) => {
        if (cancelled) return;
        const map = new Map<string, CustomProp>();
        for (const p of (rows || [])) {
          // Normalise common name variants to canonical FE keys.
          const n = String(p.name || '').toLowerCase().trim();
          const canonical = (() => {
            if (n === 'branch' || n === 'branch_details') return 'branch_details';
            if (n === 'building' || n === 'building_name' || n === 'property_name' || n === 'property') return 'building_name';
            if (n === 'sku' || n === 'product_code') return 'product_code';
            return n;
          })();
          map.set(canonical, { ...p, name: canonical });
        }
        setClientCustomProps(map);
      })
      .catch(() => { if (!cancelled) setClientCustomProps(new Map()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.fk_client_id, initial?.fk_client_id]);

  // Convenience flags — present + mandatory derived from the map.
  const branchProp     = clientCustomProps.get('branch_details');
  const buildingProp   = clientCustomProps.get('building_name');
  const productProp    = clientCustomProps.get('product_code');
  const branchIsMandatory = !!branchProp?.mandatory;

  // Section 1 (Client Details) is complete once BOTH Client Reference
  // ID is non-empty AND a Reporting Contact has been picked. Client
  // itself is read-only in confirm; SPOC trio auto-fills from the
  // contact. Bulk-uploaded orders arrive with no SPOC info, so the
  // Reporting Contact pick is the only way ops attaches a SPOC
  // before booking — making it mandatory matches that intent.
  // ALSO gates on the 3 canonical client custom properties when the
  // client has them marked mandatory — mirrors `section1Complete` in
  // the Book New Call flow so a confirmed order can't bypass the
  // branch/building/product-code requirement.
  const confirmSection1Complete = !!(
    f.client_ref_id && String(f.client_ref_id).trim()
    && f.reporting_contact_id && String(f.reporting_contact_id).trim()
  ) &&
    (!branchProp   || !branchProp.mandatory   || !!(f.branch_details && String(f.branch_details).trim())) &&
    (!buildingProp || !buildingProp.mandatory || !!(f.building_name  && String(f.building_name).trim())) &&
    (!productProp  || !productProp.mandatory  || !!(f.product_code   && String(f.product_code).trim()));
  // Section 2 (Customer Details) requires the full set of legacy
  // mandatory fields: name + slot + datetime + address + city + 6-digit
  // pincode. Customer mobile is read-only in confirm so it's not gated.
  /*
   * GPS coords mandatory on Confirm & Schedule too (2026-06-06).
   * Same regex as Book-New-Call section2Complete. C&S parent jobs
   * often arrive from bulk-upload / legacy Client Dashboard with a
   * NULL or empty `gps_location`, and the legacy schedule modal can't
   * dispatch without it (`getRoadDistance` returns blank distances).
   * Gating the "Next →" button here forces ops to use the
   * AddressPickerWithMap (or paste valid coords) before booking.
   */
  const CONFIRM_GPS_RX = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
  const confirmSection2Complete =
    confirmSection1Complete &&
    !!f.customer_name &&
    !!f.time_slot &&
    !!f.requested_date_time &&
    !!f.address &&
    !!String(f.city_id || '').trim() &&
    /^[0-9]{6}$/.test(String(f.pin_code || '')) &&
    CONFIRM_GPS_RX.test(String(f.gps_location || '').trim());

  /*
   * Section 3 (Products / Services) — at least one row with both a
   * client_service_id selected AND quantity > 0. Mirrors
   * buildServicesPayload()'s filter so the gate matches what would
   * actually be sent on submit. Added 2026-05-28 after Job #482453 was
   * booked with zero services — the FE Book-Call button only checked
   * Section 2 completeness, so an empty services basket slipped through.
   * The BE Joi validator now also enforces this (see services/
   * job.service.js create flow) so a future FE bug can't repeat the
   * silent-empty-create.
   */
  const hasAtLeastOneService = serviceRows.some(
    (r) => r.client_service_id && Number(r.quantity) > 0,
  );

  // Composite gate the Book Call button reads. Both sections must be
  // complete AND services must be non-empty. Outcome variants
  // (Unreachable / Enquiry) and Save Draft intentionally bypass this.
  const confirmBookReady = confirmSection2Complete && hasAtLeastOneService;

  if (isConfirm && initial) {
    return (
      // `noValidate` flips ON when the operator is submitting an
      // Unreachable / Enquiry outcome — those flows are pure outcome
      // logging and must NOT block on required-field gates that only
      // apply to the happy Book Call path (e.g. service rows, slot,
      // address completeness). HTML5 required attributes stay on the
      // inputs so the Book path still validates; noValidate only
      // suppresses the browser-level submit-time check when the
      // outcome path fired requestSubmit().
      <form onSubmit={submit} noValidate={outcomePayload !== null || submitVariant === 'draft'} className="space-y-4">
        {/* Customer magic-link submission banner — shown above Section 1
            only when the customer self-submitted the form. Read-only;
            ops can expand to inspect the raw submitted payload. */}
        {(initial as Record<string, unknown>)?.customer_submitted_at ? (
          <CustomerSubmissionPanel
            submittedAt={(initial as Record<string, unknown>).customer_submitted_at as string}
            payload={(initial as Record<string, unknown>).customer_submitted_payload as Parameters<typeof CustomerSubmissionPanel>[0]['payload']}
          />
        ) : null}
        {/*
          * Job Summary strip — legacy parity. Four fields: Handyman Notes
          * (efr_special_notes), Job Description (job_desc), Product Quantity,
          * Job Type. Mobile is a prominent
          * click-to-call link so the ops agent can dial while reading details
          * off the same strip. Kept visually minimal (2-column grid) so it
          * doesn't dominate the modal.
          */}
        <div className="rounded-lg border bg-sky-50/60 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-xs font-semibold text-sky-900 uppercase tracking-wide">Job Summary</div>
            {/* Click-to-call via Kaleyra rather than the OS dialer:
                the `tel:` href used to feed the dialer the raw digits,
                but with BE-side masking those digits arrive as
                "9310••••••" — the dialer can't parse that. CallableMobile
                resolves the unmasked number server-side from jobId and
                routes through the audited bridge flow. */}
            {/* The `initial` payload has loose typing (unknown) on most
                fields because it covers create/edit/view modes uniformly.
                Cast the mobile to a string-or-nullish at the call site
                rather than widening CallableMobile's prop. */}
            <CallableMobile
              jobId={Number(initial.job_id)}
              /*
               * Mask the displayed digits client-side (2026-05-28).
               * Confirm-mode fetches `?unmasked=true` so the FORM
               * can edit the mobile without bullet corruption, but
               * the Job Summary top-right is a READ-ONLY display
               * surface — it should still respect the standard
               * mask. CallableMobile still routes the click-to-call
               * through Kaleyra using jobId, so the bridge dial
               * works on the unmasked value server-side; only the
               * visible label is bulleted here.
               */
              mobile={customerNumberVisible
                ? ((initial.customer_mob_no as string | null | undefined) ?? null)
                : maskMobile((initial.customer_mob_no as string | null | undefined) ?? null)}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
            <div><span className="text-xs text-muted-foreground mr-2">Handyman Notes:</span>{String(initial.efr_special_notes ?? '—')}</div>
            <div><span className="text-xs text-muted-foreground mr-2">Job Description:</span>{String(initial.job_desc ?? '—')}</div>
            <div><span className="text-xs text-muted-foreground mr-2">Product Quantity:</span>{Array.isArray(initial.services) ? initial.services.length : 0}</div>
            <div><span className="text-xs text-muted-foreground mr-2">Job Type:</span><strong>{String(initial.job_type ?? '—')}</strong></div>
          </div>
        </div>

        {/* ── 1 · Client Details ─────────────────────────────────────────── */}
        <Section
          title="1 · Client Details"
          expanded={confirmOpenSection === 1}
          onToggle={() => setConfirmOpenSection(1)}
          badge={confirmSection1Complete ? <span className="text-emerald-600 text-xs">✓</span> : null}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Client">
              <Input value={String(initial.client_name ?? '')} readOnly disabled />
            </Field>
            <Field label="Client Reference ID *">
              <Input required value={f.client_ref_id} onChange={(e) => set('client_ref_id', e.target.value)} placeholder="Ticket or order ID" />
            </Field>
            {/* Reporting Contact — same dropdown the Book New Call
                flow exposes. Lets ops pick a contact from
                tbl_client_contacts for the job's client; picking
                auto-fills the SPOC trio below. Empty-state messaging
                mirrors create-mode. The bulk-uploaded order arrives
                with NO SPOC info, so this is the only way for ops to
                attach a contact before booking. */}
            <Field label={`Reporting Contact *${f.fk_client_id && loadingContacts ? ' (loading…)' : ''}`}>
              <SearchSelect
                value={f.reporting_contact_id || ''}
                onChange={(v) => pickReportingContact(String(v))}
                placeholder={
                  loadingContacts ? 'Loading…'
                    : clientContacts.length
                      ? '— Select contact —'
                      : 'No active contacts for this client'
                }
                disabled={!f.fk_client_id || !clientContacts.length}
                options={clientContacts.map((c) => ({
                  value: String(c.id),
                  label: `${c.contact_name || '(no name)'} · ${c.contact_desgn || 'contact'}`,
                }))}
              />
            </Field>
            {/* SPOC trio — readonly but bound to `f.*` (not `initial.*`)
                so picking a Reporting Contact above immediately fills
                them. Falls back to initial values when no contact has
                been picked yet (i.e. the BE already had SPOC info on
                the row). */}
            <Field label="Client SPOC Phone">
              {/*
                * Clickable mobile as the entire field (2026-06-05 per
                * ops). The masked digits ARE the click target — same
                * affordance pattern used in job-list cells, customer
                * rows, etc. No separate icon button; the whole pill is
                * the dial action. Visual styling fills the same
                * footprint as the sibling SPOC Name / SPOC Email
                * disabled Inputs so the field row reads as a
                * homogeneous trio.
                *
                * pickTargetKey() requires EXACTLY ONE receiver-id —
                * prefer reportingContactId when the operator has
                * picked a Reporting Contact, otherwise fall back to
                * jobId so the BE resolves the job's SPOC-of-record.
                *
                * `hideWhenUnauthorized` is intentionally OMITTED so
                * unauthorized roles still see the masked digits
                * (CallableMobile's static-span fallback) instead of
                * an empty field. Authorized roles get the same digits
                * with hover-underline + dial action.
                */}
              {(() => {
                const spocReportingId = f.reporting_contact_id ? Number(f.reporting_contact_id) : undefined;
                const spocJobId = !spocReportingId && initial?.job_id ? Number(initial.job_id) : undefined;
                const maskedSpoc = maskMobile(f.client_spoc || initial.client_spoc);
                return (
                  <CallableMobile
                    mobile={maskedSpoc}
                    reportingContactId={spocReportingId}
                    jobId={spocJobId}
                    jobContextId={initial?.job_id ? Number(initial.job_id) : undefined}
                    /*
                     * Input-pill styling — w-full + h-9 + px-3 +
                     * rounded-md + border-input matches the visual
                     * weight of the sibling <Input disabled> fields.
                     * `bg-muted/40` mimics the disabled-Input fill.
                     * `text-sm tabular-nums` overrides CallableMobile's
                     * default text-xs so the digits are legible
                     * alongside the other field values. `justify-start`
                     * left-aligns the icon+digits inside the pill so
                     * the layout reads like text-in-an-input rather
                     * than a centered button label.
                     */
                    className="w-full h-9 px-3 rounded-md border border-input bg-muted/40 text-sm tabular-nums justify-start"
                  />
                );
              })()}
            </Field>
            <Field label="Client SPOC Name">
              <Input
                value={String(f.client_spoc_name || initial.client_spoc_name || '')}
                readOnly disabled
              />
            </Field>
            <Field label="Client SPOC Email">
              <Input
                value={String(f.client_spoc_email || initial.client_spoc_email || '')}
                readOnly disabled
              />
            </Field>
            {/*
              * Client custom-property trio — mirrors the Book New Call
              * Section 1. A field renders ONLY when the client has a
              * matching row in tbl_client_custom_properties; the `*`
              * + required attribute track the row's `mandatory` flag.
              * Gating is wired through `confirmSection1Complete`.
              */}
            {branchProp && (
              <Field label={branchProp.mandatory ? 'Branch Details *' : 'Branch Details'}>
                <Input
                  required={branchProp.mandatory}
                  value={f.branch_details || ''}
                  onChange={(e) => set('branch_details', e.target.value)}
                  placeholder={branchProp.mandatory ? 'Required for this client' : 'e.g. Bengaluru — Indiranagar'}
                />
              </Field>
            )}
            {buildingProp && (
              <Field label={buildingProp.mandatory ? 'Property / Building Name *' : 'Property / Building Name'}>
                <Input
                  required={buildingProp.mandatory}
                  value={f.building_name || ''}
                  onChange={(e) => set('building_name', e.target.value)}
                />
              </Field>
            )}
            {productProp && (
              <Field label={productProp.mandatory ? 'Product Code *' : 'Product Code'}>
                <Input
                  required={productProp.mandatory}
                  value={f.product_code || ''}
                  onChange={(e) => set('product_code', e.target.value)}
                />
              </Field>
            )}
            {/* Customer-submitted custom properties — decoded from
                tbl_job.custom_property (the flat "Label:Value|…" string the
                client booking apps write) by the BE getByIdCore decoder and
                exposed as `custom_properties`. Read-only: these are the exact
                values the customer submitted at booking, surfaced here in
                Client Details so ops can see/copy them. Distinct from the
                editable branch/building/product trio above (those map to
                `remarks`), so no overlap for arbitrary client properties. */}
            {Array.isArray((initial as Record<string, unknown>).custom_properties) &&
              ((initial as Record<string, unknown>).custom_properties as Array<{ name?: string; label?: string; value?: unknown }>)
                .map((p, i) => (
                  <Field key={`cp-${i}`} label={String(p.label || p.name || 'Custom Property')}>
                    <Input value={p.value == null ? '' : String(p.value)} readOnly disabled />
                  </Field>
                ))}
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              onClick={() => setConfirmOpenSection(2)}
              disabled={!confirmSection1Complete}
              title={confirmSection1Complete ? '' : 'Fill Client Reference ID, Reporting Contact, and any required custom properties to proceed'}
            >
              Next →
            </Button>
          </div>
        </Section>

        {/* ── 2 · Customer Details ───────────────────────────────────────── */}
        <Section
          title="2 · Customer Details"
          sectionRef={confirmSection2Ref}
          expanded={confirmOpenSection === 2}
          onToggle={() => { if (confirmSection1Complete) setConfirmOpenSection(2); }}
          disabled={!confirmSection1Complete}
          badge={confirmSection2Complete ? <span className="text-emerald-600 text-xs">✓</span> : null}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Customer Name *">
              <Input required value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} />
            </Field>
            <Field label="Mobile Number">
              {/* Mobile Number RESTORED but rendered through CallableMobile
                  so the bulk of the digits is masked (only last 4 visible).
                  Operators can still click-to-call without seeing the
                  cleartext mobile — same UX as the Summary tab.
                  Mask wrap (2026-05-28): the confirm-mode fetch uses
                  `?unmasked=true` so the FORM can submit without bullet
                  corruption, but this READ-ONLY display surface should
                  still mask. Click-to-call resolves the unmasked
                  number server-side from jobId, so the bridge dial
                  still works. */}
              <div className="h-10 px-2 flex items-center border rounded bg-muted/30">
                <CallableMobile
                  jobId={Number(initial.job_id)}
                  mobile={customerNumberVisible
                    ? (f.customer_mob_no as string | null)
                    : maskMobile(f.customer_mob_no as string | null)}
                />
              </div>
            </Field>
            <Field label="Customer Email">
              <Input type="email" value={f.customer_email} onChange={(e) => set('customer_email', e.target.value)} />
            </Field>
            {/*
              * Alternate customer contact — stored on tbl_job columns
              * `additional_name` + `additional_number`. Used by the
              * technician when the primary customer is unreachable.
              * Both optional; phone validated as a 10-digit string.
              */}
            <Field label="Customer Alternate Name">
              <Input
                value={f.additional_name || ''}
                onChange={(e) => set('additional_name', e.target.value)}
                maxLength={200}
                placeholder="Alternate contact name"
              />
            </Field>
            <Field label="Customer Alternate Number">
              {/* Editable input ONLY (2026-06-05 per ops). The
                  click-to-call icon previously rendered alongside this
                  field was removed — alt-number is captured for
                  reference / fallback context, not as a primary dial
                  surface, so the icon was visual noise. The dial
                  affordance remains available from the Customer
                  Submission panel / Job detail view where it belongs.
                  Validation: shared INDIAN_MOBILE_REGEX (10 digits
                  starting with 6/7/8/9); empty stays quiet,
                  aria-invalid triggers the red focus ring on bad
                  input. */}
              {(() => {
                const raw = String(f.additional_number || '');
                const isValid = isValidIndianMobile(raw);
                return (
                  <>
                    <Input
                      value={raw}
                      onChange={(e) => set('additional_number', e.target.value.replace(/\D/g, '').slice(0, 10))}
                      inputMode="numeric"
                      placeholder="10 digits"
                      className={`tabular-nums w-full ${!isValid ? 'border-red-400 focus-visible:ring-red-300' : ''}`}
                      aria-invalid={!isValid}
                    />
                    {!isValid && (
                      <p className="text-[11px] text-red-600 mt-1">{INDIAN_MOBILE_ERROR}</p>
                    )}
                  </>
                );
              })()}
            </Field>
            {/*
              * Layout: Booking Time Slot on LEFT, Requested Date/Time on
              * RIGHT — same row (legacy parity). Wrapped in a nested 2-col
              * grid that spans all 3 columns of the outer grid. Changing the
              * time auto-updates the slot; clicking a slot chip nudges the
              * picker hour to the slot's start. "After Hours" doesn't nudge.
              */}
            <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Booking Time Slot *</Label>
                <div className="flex flex-wrap gap-2">
                  {SLOTS.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => {
                        set('time_slot', s.value);
                        if (s.fromH >= 0 && f.requested_date_time) {
                          const [date] = f.requested_date_time.split('T');
                          const startHH = String(s.fromH).padStart(2, '0');
                          set('requested_date_time', `${date}T${startHH}:00`);
                        }
                      }}
                      className={`px-3 py-1.5 rounded-full border text-xs transition-colors ${
                        f.time_slot === s.value
                          ? 'bg-sky-700 text-white border-sky-700'
                          : 'bg-white hover:bg-muted/60'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <SlotAdvisory
                  best={slotRec.best}
                  attendanceKnown={slotRec.attendanceKnown}
                  candidatePool={slotRec.candidatePool}
                  loading={slotRec.loading}
                  failed={slotRec.failed}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Requested Date/Time *</Label>
                <DateTimeSlotPicker
                  required
                  min={nowLocalIso()}
                  value={f.requested_date_time}
                  onChange={(v) => {
                    set('requested_date_time', v);
                    const slot = inferSlotFromTime(v);
                    if (slot) set('time_slot', slot);
                  }}
                />
                {/* Surfaces the date the operator entered on the upload
                    sheet (which had no time component). Pre-fill is
                    intentionally blank so they must explicitly pick a
                    time slot — see toFormShape's isBulkSentinel branch. */}
                {f.upload_date_hint && !f.requested_date_time && (
                  <p className="text-[11px] text-amber-700">
                    From upload: <strong>{f.upload_date_hint}</strong> — pick a time slot to proceed.
                  </p>
                )}
                {/* When a pending customer reschedule pre-filled the field above
                    with the requested NEW time, show the ORIGINAL appointment
                    (from the job) underneath for context. */}
                {pendingReschedule && initial?.requested_date_time ? (
                  <p className="text-[11px] text-muted-foreground">
                    Original Date/Time: {formatDate(initial.requested_date_time as string)}
                  </p>
                ) : null}
              </div>
            </div>
            {/* Address section — uses the shared AddressPickerWithMap
                (split-pane form left, draggable Google Map right). The
                map's reverse-geocode keeps PIN + city + GPS in sync
                with the marker; the autocomplete pre-fills them on
                suggestion pick. Same component on the create-flow so
                Confirm & Schedule and Book New Call are byte-identical
                in behaviour. */}
            {/* Address Entered By Client (read-only) — the original address the
                client booked with, snapshotted before the CRM first edits it,
                so ops can see what the client actually entered vs the edited
                Complete Address below. Only shows once a snapshot exists. */}
            {(() => {
              const clientAddr = (initial as Record<string, unknown> | null)?.client_entered_address as string | undefined;
              return clientAddr ? (
                <div className="col-span-1 md:col-span-3 mb-3">
                  <Label className="text-xs text-muted-foreground">Address Entered By Client</Label>
                  <textarea
                    readOnly
                    disabled
                    value={clientAddr}
                    rows={2}
                    className="mt-1 w-full rounded-md border border-input bg-slate-100 px-3 py-1.5 text-sm text-slate-700 resize-none"
                  />
                </div>
              ) : null;
            })()}
            {/* Saved-addresses picker (Confirm & Schedule / Edit). Bulk-
                uploaded jobs often have a thin address; the same customer
                usually has fuller addresses on prior jobs. Pick one to
                auto-fill every field below in a click. Only shows when the
                customer actually has saved addresses. */}
            {savedAddresses.length > 0 && (
              <div className="col-span-1 md:col-span-3 mb-3 rounded-md border bg-muted/30 p-3 text-sm">
                <div className="font-medium mb-2">Saved Addresses for This Customer</div>
                <Input
                  value={confirmAddrQuery}
                  onChange={(e) => setConfirmAddrQuery(e.target.value)}
                  placeholder="Search saved addresses (text, city or PIN)…"
                  className="mb-2 h-8"
                />
                <div className="space-y-1.5 max-h-52 overflow-y-auto">
                  {(() => {
                    const q = confirmAddrQuery.trim().toLowerCase();
                    const filtered = q
                      ? savedAddresses.filter((a) => {
                          const city = a.city_id != null ? (cityNameById.get(String(a.city_id)) ?? '') : '';
                          return [a.address, a.building, a.landmark, city, a.pin_code]
                            .some((p) => p != null && String(p).toLowerCase().includes(q));
                        })
                      : savedAddresses;
                    if (filtered.length === 0) {
                      return (
                        <div className="text-[11px] text-muted-foreground py-1">
                          No saved addresses match “{confirmAddrQuery}”.
                        </div>
                      );
                    }
                    return filtered.map((a) => (
                      <label key={a.address_id} className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="confirm-saved-address"
                          checked={selectedAddressId === a.address_id}
                          onChange={() => {
                            setSelectedAddressId(a.address_id);
                            setF((s) => ({
                              ...s,
                              address: a.address || '',
                              building: a.building || '',
                              landmark: a.landmark || '',
                              city_id: a.city_id != null ? String(a.city_id) : '',
                              pin_code: a.pin_code || '',
                              gps_location: a.gps_location || '',
                            }));
                          }}
                          className="mt-0.5"
                        />
                        <span className="flex-1">
                          {formatServiceAddress({
                            building: a.building,
                            address: a.address,
                            landmark: a.landmark,
                            city_name: a.city_id != null ? cityNameById.get(String(a.city_id)) : null,
                            pin_code: a.pin_code,
                          }, { fallback: '(No Address)' })}
                        </span>
                      </label>
                    ));
                  })()}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Pick an address to auto-fill the form below. You can still edit it.
                </p>
              </div>
            )}
            {/* Service Address (read-only) — the actual booking address
                (tbl_address.address). Non-editable here: the operator sets GPS
                via the "Search Location On Map" (building) field in the picker
                below, which never changes this address. */}
            <div className="col-span-1 md:col-span-3 mb-3">
              <Label className="text-xs text-muted-foreground">Service Address</Label>
              <textarea
                readOnly
                disabled
                value={formatServiceAddress({
                  building: f.building,
                  address: f.address,
                  landmark: f.landmark,
                  city_name: f.city_id ? cityNameById.get(String(f.city_id)) : null,
                  pin_code: f.pin_code,
                }, { fallback: '—' })}
                rows={2}
                className="mt-1 w-full rounded-md border border-input bg-slate-100 px-3 py-1.5 text-sm text-slate-700 resize-none"
              />
            </div>
            <div className="col-span-1 md:col-span-3">
              <AddressPickerWithMap
                value={{
                  address: f.address || '',
                  building: f.building || '',
                  landmark: f.landmark || '',
                  city_id: f.city_id || '',
                  pin_code: f.pin_code || '',
                  gps_location: f.gps_location || '',
                  address_instruction: ((f as Record<string, unknown>).address_instruction as string) || '',
                }}
                onChange={(next: AddressValue) => {
                  set('address', next.address);
                  set('building', next.building || '');
                  set('landmark', next.landmark || '');
                  set('city_id', String(next.city_id || ''));
                  set('pin_code', next.pin_code);
                  set('gps_location', next.gps_location);
                  set('address_instruction' as keyof typeof f, (next.address_instruction || '') as never);
                }}
                cities={lk.toOpts.cities.map((o) => ({ value: String(o.value), label: String(o.label) }))}
                autoCreatePincode
                /* Confirm & Schedule: `address` is the non-editable Service
                   Address (shown read-only above); the Google search moves to
                   the `building` field and only sets GPS. */
                serviceAddressReadOnly
              />
            </div>
          </div>
          <div className="mt-4 flex justify-between">
            <Button type="button" variant="outline" onClick={() => setConfirmOpenSection(1)}>← Back</Button>
            <Button
              type="button"
              onClick={() => setConfirmOpenSection(3)}
              disabled={!confirmSection2Complete}
              title={confirmSection2Complete ? '' : 'Fill customer name + date/slot + address + city + 6-digit pincode to proceed'}
            >
              Next →
            </Button>
          </div>
        </Section>

        {/*
          * ── 3 · Select Products ─────────────────────────────────────────
          * Legacy addEditJob field set, in order:
          *   Service Category / Service Type / Job Type filters
          *   Rate-card product basket (ServicesBasket component)
          *   Job Image upload
          *   Helper Required / Material Required toggles
          *   Special Comments (remarks) — required
          *   Anything Handyman should keep in mind (efr_special_notes)
          *   Collected By dropdown
          * Category/Type are informational filters that scope the rate-card
          * options shown below (full list stays available — we don't hide
          * rows, just highlight).
          */}
        <Section
          title="3 · Select Products"
          sectionRef={confirmSection3Ref}
          expanded={confirmOpenSection === 3}
          onToggle={() => { if (confirmSection2Complete) setConfirmOpenSection(3); }}
          disabled={!confirmSection2Complete}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            {/*
              * Service Category — MULTI-SELECT (2026-05-15).
              * Selecting multiple categories causes the submit handler
              * below to POST N create-job requests, one per category,
              * all sharing the same `client_ref_id`. The result is N
              * distinct `job_id`s under a single operator-visible
              * reference. State key: `fk_service_catg_ids` (CSV
              * string of category IDs). The legacy single-select
              * field `fk_service_catg_id` is still derived for
              * compat with downstream rate-card filtering until that
              * UI is migrated; first selected category drives the
              * basket filter.
              */}
            <Field label="Service Categories *">
              <SearchMultiSelect
                value={(f.fk_service_catg_ids || '').split(',').filter(Boolean)}
                onChange={(next) => {
                  /*
                   * Service Category add/remove handling (2026-05-19):
                   *   - ADD a category → leave existing selections alone.
                   *     Previously we cleared `fk_service_type_id*`,
                   *     which wiped the basket the operator had already
                   *     built. Now we only diff for removals.
                   *   - REMOVE a category → prune service types whose
                   *     catg matches the removed one, AND drop that
                   *     cat's per-tab override slot. Basket rows are
                   *     pruned downstream by the existing useEffect on
                   *     `fk_service_type_ids`.
                   */
                  const oldIds = (f.fk_service_catg_ids || '')
                    .split(',').filter(Boolean);
                  const newIds = (next as Array<string | number>).map(String);
                  const removedIds = new Set(oldIds.filter((id) => !newIds.includes(id)));
                  set('fk_service_catg_ids' as keyof typeof f, newIds.join(',') as never);
                  set('fk_service_catg_id', newIds[0] || '');
                  if (removedIds.size > 0) {
                    // Prune types belonging to removed cats only.
                    const catOfType = new Map(
                      (lk.serviceTypes || []).map((t) => [String(t.service_type_id), String(t.service_catg_id)] as const),
                    );
                    const filteredTypeIds = (f.fk_service_type_ids || [])
                      .filter((tid) => !removedIds.has(catOfType.get(String(tid)) || ''));
                    set('fk_service_type_ids' as keyof typeof f, filteredTypeIds as never);
                    set('fk_service_type_id', filteredTypeIds[0] ? String(filteredTypeIds[0]) : '');
                    // Drop per-tab field slots for the removed cats so
                    // re-adding starts fresh (rather than resurrecting
                    // stale values).
                    setPerJobFields((prev) => {
                      const out = { ...prev };
                      removedIds.forEach((id) => delete out[id]);
                      return out;
                    });
                  }
                  // Seed per-tab field slots for any NEWLY-added cats —
                  // copy the most-recently-edited tab's values so the
                  // new tab opens with sensible defaults instead of
                  // blank inputs.
                  const newlyAdded = newIds.filter((id) => !oldIds.includes(id));
                  if (newlyAdded.length > 0) {
                    setPerJobFields((prev) => {
                      const out = { ...prev };
                      // Pick a donor: prefer the currently-active tab's
                      // slot, else any non-empty slot, else top-level f.
                      const activeId = oldIds[Math.min(activeJobTab, oldIds.length - 1)] || '';
                      const donor: PerJobOverride = (activeId && prev[activeId])
                        || Object.values(prev).find((o) => o && Object.keys(o).length > 0)
                        || {
                          remarks: f.remarks,
                          efr_special_notes: f.efr_special_notes,
                          helper_req: Boolean(f.helper_req),
                          material_req: Boolean(f.material_req),
                          collected_by: f.collected_by,
                          // Image is intentionally NOT carried over —
                          // each job should have its own image, not a
                          // shared copy.
                        };
                      newlyAdded.forEach((id) => {
                        if (!out[id]) out[id] = { ...donor, job_image_file: undefined };
                      });
                      return out;
                    });
                  }
                }}
                placeholder="— Select one or more —"
                selectedLabel="categories"
                options={(() => {
                  // Restrict to categories that appear in THIS client's
                  // rate card (same rule as create-mode). When the rate
                  // card is still loading, fall back to all categories.
                  const allowed = new Set(
                    (clientServices || []).map((cs) => String(cs.service_catg_id)),
                  );
                  return (lk.serviceCategories || [])
                    .filter((c) => allowed.size === 0 || allowed.has(String(c.service_catg_id)))
                    .map((c) => ({ value: c.service_catg_id, label: c.service_catg_name }));
                })()}
              />
            </Field>
            <Field label="Service Type *">
              {/* Service Type list reacts to picked categories AND
                  the client's rate card — same logic as create
                  mode. Earlier this was a flat single-select pulling
                  every type in the system; switching to the
                  category-aware multi unbreaks the Confirm mode
                  filter for bulk-uploaded jobs (where the operator
                  has just picked a category in the multi above). */}
              <SearchMultiSelect
                value={f.fk_service_type_ids || []}
                onChange={(next) => {
                  const ids = (next as Array<string | number>).map(String);
                  set('fk_service_type_ids' as keyof typeof f, ids as never);
                  // Keep the legacy single field in sync (first pick
                  // wins) so any downstream consumer that still reads
                  // fk_service_type_id gets a non-empty value.
                  set('fk_service_type_id', ids[0] || '');
                }}
                placeholder={(f.fk_service_catg_ids || f.fk_service_catg_id) ? '— Select service type(s) —' : 'Pick a category first'}
                disabled={!(f.fk_service_catg_ids || f.fk_service_catg_id)}
                options={(() => {
                  const inRateCard = new Set(
                    (clientServices || []).map((cs) => String(cs.service_type_id))
                  );
                  const pickedCats = new Set(
                    (f.fk_service_catg_ids || '').split(',').filter(Boolean),
                  );
                  if (pickedCats.size === 0 && f.fk_service_catg_id) {
                    pickedCats.add(String(f.fk_service_catg_id));
                  }
                  // Lookup catId → catName for group headers.
                  const catNameById = new Map(
                    (lk.serviceCategories || []).map((c) => [String(c.service_catg_id), c.service_catg_name]),
                  );
                  return (lk.serviceTypes || [])
                    .filter((t) => pickedCats.size === 0 || pickedCats.has(String(t.service_catg_id)))
                    .filter((t) => inRateCard.size === 0 || inRateCard.has(String(t.service_type_id)))
                    // Group-sort: types within the same category cluster
                    // together so the SearchMultiSelect can render
                    // "Service Category — X" headers between groups.
                    .slice()
                    .sort((a, b) => {
                      const an = catNameById.get(String(a.service_catg_id)) || '';
                      const bn = catNameById.get(String(b.service_catg_id)) || '';
                      return an.localeCompare(bn) || a.service_type_name.localeCompare(b.service_type_name);
                    })
                    .map((t) => ({
                      value: String(t.service_type_id),
                      label: t.service_type_name,
                      // Header text shows only when 2+ categories are
                      // picked (single-cat groups have no visible
                      // separator). Multi-cat → header carries the
                      // category name; single-cat → omit `group`.
                      group: pickedCats.size > 1
                        ? (catNameById.get(String(t.service_catg_id)) || `Category ${t.service_catg_id}`)
                        : undefined,
                    }));
                })()}
              />
            </Field>
            {/*
              * Job Type — MULTI-SELECT (2026-05-15). Stored as a
              * comma-separated string in the existing `job_type`
              * varchar(100) column. A single job row carries the
              * CSV; downstream consumers (reports, webhooks) that
              * read `job_type` for display will see the CSV. Legacy
              * parity is preserved when only one value is picked
              * (CSV with one element equals the original string).
              */}
            <Field label="Job Type *">
              <SearchMultiSelect
                value={(f.job_type || '').split(',').filter(Boolean)}
                onChange={(next) => {
                  const csv = (next as Array<string | number>).map(String).join(',');
                  set('job_type', csv);
                }}
                placeholder="— Select job type(s) —"
                selectedLabel="types"
                options={[
                  // Job Type vocabulary trimmed to the 3 ops-supported
                  // values (2026-05-19). Removed Maintenance/Demo/
                  // Inspection — historical placeholders, never used
                  // by ops + not wired into rate-card pricing.
                  { value: 'Installation',   label: 'Installation' },
                  { value: 'Repair',         label: 'Repair' },
                  { value: 'Uninstallation', label: 'Uninstallation' },
                ]}
              />
            </Field>
          </div>

          {/* Per-Job tab bar — appears whenever the operator picks
              2+ Service Categories. Each tab carries its own
              services + Job Image + Special Comments + EFR notes +
              Helper/Material toggles + Collected By (the six fields
              now backed by `perJobFields`). With 0 or 1 category
              picked the bar is hidden and reads/writes pass through
              to the top-level `f` state as before. */}
          {(() => {
            const pickedCatIds = (f.fk_service_catg_ids || '').split(',').filter(Boolean);
            if (pickedCatIds.length < 2) return null;
            const tabIdx = Math.min(activeJobTab, pickedCatIds.length - 1);
            return (
              <div className="flex gap-1 mb-3 border-b">
                {pickedCatIds.map((cid, i) => {
                  const cat = (lk.serviceCategories || []).find(
                    (c) => String(c.service_catg_id) === String(cid),
                  );
                  const label = cat?.service_catg_name || `Category ${cid}`;
                  const active = i === tabIdx;
                  return (
                    <button
                      key={cid}
                      type="button"
                      onClick={() => setActiveJobTab(i)}
                      className={
                        'px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors ' +
                        (active
                          ? 'border-sky-600 text-sky-700 font-medium'
                          : 'border-transparent text-muted-foreground hover:text-foreground')
                      }
                    >
                      Job {i + 1} — {label}
                    </button>
                  );
                })}
              </div>
            );
          })()}
          <div className="mb-4">
            <Label className="mb-2 block">Products from client rate card</Label>
            {/* Confirm mode now uses AutoServicesTable (same as create
                mode) — the legacy per-row "Select service" dropdown
                wasn't what ops wanted. Picking Service Type(s) above
                renders the matching rate-card rows here with + / ×
                toggles + an above-table search. */}
            <AutoServicesTable
              services={clientServices}
              loading={loadingServices}
              serviceTypeIds={f.fk_service_type_ids || []}
              rows={serviceRows}
              setRows={setServiceRows}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t">
            <Field label="Job Image">
              {/*
                * Stashes the selected File on `f.job_image_file`. The
                * post-create handler (see submit() above) picks it up
                * and POSTs to /admin/jobs/:id/images, which uploads to
                * s3://<bucket>/JobSupportings/Booking_<jobId>_<seq>
                * per the 2026-05-15 ops convention (extension is not
                * part of the key; MIME is preserved on the S3 object's
                * Content-Type). Failure to upload is non-fatal — the
                * job is already saved, operator can retry from the
                * detail view.
                */}
              {/*
                * Multi-file Job Image upload (2026-05-25). Each picked
                * file uploads sequentially after the job is created;
                * legacy single-file callers still work because the post-
                * create handler accepts BOTH `job_image_file` (single)
                * AND `job_image_files` (File[]).
                *
                * Per-tab DOM remount (2026-05-26): when 2+ service
                * categories are selected, each "Job K" tab owns its own
                * `perJobFields[catId].job_image_files`. The browser's
                * native file input keeps the LAST-CHOSEN file list in
                * its DOM state across React re-renders, which made
                * switching tabs visually leak the wrong files. Keying
                * the input by the active catId forces a remount when
                * the tab changes, clearing the native input back to "No
                * file chosen" while the underlying per-tab state
                * remains intact. The small helper line below the input
                * surfaces the count that's actually stored for the
                * active tab so the operator can confirm at a glance.
                */}
              {(() => {
                const stashed = (getJobField('job_image_files') as File[] | undefined) || [];
                const tabKey = getActiveCatId() || 'single';
                /*
                 * Accumulating multi-select (2026-05-28). The previous
                 * handler did `setJobField('job_image_files', files)` which
                 * REPLACED the array — so picking 2 from folder A then 1
                 * from folder B left only the second pick. Now we MERGE
                 * new picks into the existing stash with a name+size+
                 * lastModified dedupe key. After write, we clear the
                 * native input's `value` so re-picking the SAME folder
                 * (a) doesn't trigger duplicate-detect noise and (b)
                 * lets the operator pick again from the same source
                 * without first picking elsewhere.
                 *
                 * Persistence: the stash lives on `f` (form state) via
                 * setJobField, so section navigation doesn't drop it.
                 * The input's `key` only causes a remount when the
                 * active CATEGORY TAB changes (multi-category mode);
                 * within a tab the data persists across re-renders.
                 */
                const appendFiles = (newly: File[]) => {
                  if (newly.length === 0) return;
                  const seen = new Set(stashed.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
                  const merged: File[] = [...stashed];
                  for (const file of newly) {
                    const key = `${file.name}|${file.size}|${file.lastModified}`;
                    if (!seen.has(key)) {
                      merged.push(file);
                      seen.add(key);
                    }
                  }
                  setJobField('job_image_files', merged as never);
                  setJobField('job_image_file', (merged[0] ?? null) as never);
                };
                const removeAt = (idx: number) => {
                  const next = stashed.filter((_, i) => i !== idx);
                  setJobField('job_image_files', next as never);
                  setJobField('job_image_file', (next[0] ?? null) as never);
                };
                /*
                 * Already-uploaded images (2026-05-28). After "Save Draft"
                 * uploads files and closes the modal, reopening the same
                 * Unconfirmed job lands back in Confirm & Schedule. The
                 * legacy view showed only the empty file picker, so ops
                 * thought their drafts had vanished. Surface the rows
                 * persisted on tbl_job_image as compact preview tiles
                 * above the picker — same component as the Images tab
                 * in view mode (X delete handler hits
                 * DELETE /admin/jobs/images/:id, then refreshes the
                 * modal). Falls back to `[]` when initial.images is
                 * missing (legacy callers, freshly-created jobs).
                 */
                /*
                 * Read from local section state — NOT initial.images.
                 * Tiles stay rendered even after the operator X's
                 * them (2026-05-28); they receive a strikethrough +
                 * undo-arrow treatment so the operator can recover
                 * individual mistakes without cancelling the whole
                 * modal. The submit handler flushes the BE DELETE for
                 * every id still in `pendingDeleteIds` at submit time.
                 */
                return (
                  <div>
                    {/* "Collected via WhatsApp Chat" hint — tells ops at a
                        glance that the media (and other Confirm-mode prefill)
                        came from the conversational order-confirmation flow
                        on this job, not from an operator. Doubles as the
                        cue to look at the customer-submission diff panel
                        above. Driven by customer_submitted_payload.channel
                        OR the presence of any tbl_job_media (videos are
                        currently chat-only). */}
                    {collectedViaWhatsapp && (
                      <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-800">
                        <span aria-hidden>💬</span>
                        Collected via WhatsApp Chat
                      </div>
                    )}
                    {initialVideos.length > 0 && (
                      <div className="mb-3">
                        <p className="text-[11px] text-muted-foreground mb-1">
                          {initialVideos.length} video{initialVideos.length === 1 ? '' : 's'} shared by the customer:
                        </p>
                        <JobVideosStrip videos={initialVideos} compact />
                      </div>
                    )}
                    {localImages.length > 0 && (
                      <div className="mb-3">
                        <p className="text-[11px] text-muted-foreground mb-1">
                          {localImages.length} image{localImages.length === 1 ? '' : 's'} already uploaded
                          {pendingDeleteIds.size > 0 ? ` (${pendingDeleteIds.size} marked for deletion)` : ''}:
                        </p>
                        <JobImagesTab
                          images={localImages}
                          compact
                          deferDelete
                          // The X visibility check in JobImagesTab
                          // gates on `onChanged` truthiness; we pass a
                          // no-op so the X renders. State mutation
                          // happens inside onImageDeleted.
                          onChanged={() => { /* deferred — flush on submit */ }}
                          // Drive the strikethrough/undo visual on
                          // marked tiles. The set is owned by JobForm
                          // and toggled below.
                          pendingDeleteIds={pendingDeleteIds}
                          onImageDeleted={(id) => {
                            /*
                             * Toggle membership in the pending-delete
                             * set. Click an unmarked tile → adds id
                             * (tile renders with strikethrough +
                             * undo button). Click the SAME tile again
                             * → removes id (tile returns to normal).
                             * localImages stays untouched so the
                             * thumbnail never disappears; the visual
                             * treatment is the only signal.
                             */
                            setPendingDeleteIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(id)) next.delete(id);
                              else              next.add(id);
                              return next;
                            });
                          }}
                        />
                      </div>
                    )}
                    {/*
                     * Pending-delete hint (2026-05-28, refined). Now
                     * mentions the undo affordance so operators
                     * understand the strikethrough is reversible
                     * tile-by-tile, not all-or-nothing.
                     */}
                    {pendingDeleteIds.size > 0 && (
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2 inline-block">
                        {pendingDeleteIds.size} image{pendingDeleteIds.size === 1 ? '' : 's'} marked for deletion. Click the ↺ on a tile to undo, Cancel to discard all, or Save Draft / Book Call to confirm.
                      </p>
                    )}
                    <Input
                      key={`job-img-${tabKey}`}
                      type="file"
                      accept="image/*,.pdf"
                      multiple
                      onChange={(e) => {
                        const newly = e.target.files ? Array.from(e.target.files) : [];
                        appendFiles(newly);
                        // Clear native input so re-picking from the same
                        // folder works on the next click.
                        e.target.value = '';
                      }}
                    />
                    {stashed.length > 0 && (
                      <>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          {stashed.length} file{stashed.length === 1 ? '' : 's'} staged. Will upload on Save Draft / Book Call.
                        </p>
                        {/*
                         * Preview tiles with X delete. Image files render
                         * as thumbnails via URL.createObjectURL; non-image
                         * (PDF) files render as a generic file icon block.
                         * The X removes the file from the stash; if it
                         * was already uploaded (Save Draft fired earlier
                         * this session), it's still staged for re-upload
                         * — we don't DELETE from S3 since the operator
                         * may still Book the call with it. To remove a
                         * already-uploaded image, use the post-save
                         * Images tab in view mode.
                         */}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {stashed.map((file, i) => {
                            const isImg = (file.type || '').startsWith('image/');
                            const url = isImg ? getPreviewUrl(file) : null;
                            /*
                             * Per-tile upload status overlay (2026-05-28).
                             * Reads from the parent's uploadStatuses map;
                             * 'uploading' renders a centred spinner,
                             * 'done' a green check, 'error' a red X. The
                             * regular X delete button is hidden while
                             * 'uploading' so the operator can't pull a
                             * file out from under the in-flight POST.
                             */
                            const status = uploadStatuses[fileKey(file)];
                            return (
                              <div
                                key={`${file.name}-${file.size}-${i}`}
                                className="relative border rounded-md bg-muted/40 overflow-hidden"
                                style={{ width: 72, height: 72 }}
                                title={file.name}
                              >
                                {url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={url}
                                    alt={file.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full flex flex-col items-center justify-center text-[9px] text-muted-foreground text-center p-1 break-all">
                                    <span className="font-bold text-xs">PDF</span>
                                    <span className="line-clamp-2">{file.name}</span>
                                  </div>
                                )}
                                {/* Status overlay: covers the whole tile
                                    so the per-state visual is unmissable
                                    even on dark thumbnails. */}
                                {status === 'uploading' && (
                                  <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
                                    {/* Inline SVG spinner — avoids pulling
                                        in a new icon dep for one tile. */}
                                    <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24" fill="none">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                    </svg>
                                  </div>
                                )}
                                {status === 'done' && (
                                  <div className="absolute inset-0 bg-emerald-500/70 flex items-center justify-center text-white text-2xl font-bold">
                                    ✓
                                  </div>
                                )}
                                {status === 'error' && (
                                  <div className="absolute inset-0 bg-rose-600/75 flex items-center justify-center text-white text-2xl font-bold">
                                    !
                                  </div>
                                )}
                                {status !== 'uploading' && (
                                  <button
                                    type="button"
                                    aria-label={`Remove ${file.name}`}
                                    onClick={() => removeAt(i)}
                                    className="absolute top-0 right-0 bg-black/65 hover:bg-black/90 text-white rounded-bl-md w-5 h-5 flex items-center justify-center text-xs font-bold leading-none"
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </Field>
            <Field label="Helper Required">
              {/* Reverted from checkbox → toggle (Switch) on 2026-05-19
                  to match the create-mode pattern + the legacy CRM
                  visual. Ops preferred the toggle affordance. */}
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <Switch
                  checked={Boolean(getJobField('helper_req'))}
                  onCheckedChange={(v: boolean) => setJobField('helper_req', v)}
                  ariaLabel="Helper required"
                />
                <span>{getJobField('helper_req') ? 'Yes' : 'No'}</span>
              </label>
            </Field>
            <Field label="Material Required">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <Switch
                  checked={Boolean(getJobField('material_req'))}
                  onCheckedChange={(v: boolean) => setJobField('material_req', v)}
                  ariaLabel="Material required"
                />
                <span>{getJobField('material_req') ? 'Yes' : 'No'}</span>
              </label>
            </Field>
            {/* Job Description + Anything Handyman should keep in mind — half-half row.
                LABEL/COLUMN RECONCILIATION (2026-06-04):
                  - "Job Description" stores to tbl_job.job_desc (the ops-facing
                    description of what work is required). Previously mislabelled
                    "Special Comments" but the underlying intent has always been
                    a job description — now the label matches.
                  - "Anything Handyman should keep in mind?" stores to
                    tbl_job.efr_special_notes (the technician-facing pre-visit
                    notes). Label kept verbatim; column unchanged.
                resize-y locks horizontal growth so the modal width stays
                predictable. */}
            <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Job Description *">
                <textarea
                  required
                  rows={3}
                  value={getJobField('job_desc') ?? ''}
                  onChange={(e) => setJobField('job_desc', e.target.value)}
                  className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-y"
                  placeholder="Describe the work required"
                />
              </Field>
              <Field label="Anything Handyman should keep in mind? *">
                <textarea
                  required
                  rows={3}
                  value={getJobField('efr_special_notes') ?? ''}
                  onChange={(e) => setJobField('efr_special_notes', e.target.value)}
                  className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-y"
                  placeholder="Notes for the technician"
                />
              </Field>
            </div>
            {/*
              * Collected By — gated by the client's profile preference
              * (tbl_client_custom_properties; see BE endpoint
              * /admin/clients/:clientId/collected-by-preference).
              *   - collectedByPref === null     → "Any": dropdown
              *       enabled, both options visible.
              *   - collectedByPref === 'Easyfix' → locked to "Easyfix"
              *       (operator can see the value but can't change it).
              *   - collectedByPref === 'Client'  → locked to "Client".
              * A small hint below explains the lock to the operator
              * so it doesn't look like the dropdown is broken.
              */}
            <Field label="Collected By *">
              <SearchSelect
                value={collectedByPref ?? (getJobField('collected_by') ?? '')}
                onChange={(v) => { if (!collectedByPref) setJobField('collected_by', v); }}
                disabled={!!collectedByPref}
                placeholder="Select"
                options={
                  collectedByPref
                    ? [{ value: collectedByPref, label: collectedByDisplay(collectedByPref) }]
                    : COLLECTED_BY_JOB_OPTIONS
                }
              />
              {collectedByPref && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Locked by client profile (Collected By = {collectedByDisplay(collectedByPref)}).
                </p>
              )}
            </Field>
          </div>
          <div className="mt-4 flex justify-start">
            <Button type="button" variant="outline" onClick={() => setConfirmOpenSection(2)}>← Back</Button>
          </div>
        </Section>

        {/* Read-only remarks / comments history at the bottom of the confirm form. */}
        <JobRemarksView jobId={initial?.job_id ?? null} />

        {error && <div className="text-sm text-destructive">{error}</div>}
        {/* Confirm-mode footer — three-button layout matching the legacy
            CRM "Add Job (Bulk Upload)" confirm screen (ref screenshots
            2026-05-19). All three submit the same form; the difference
            is which `submitVariant` lands in the status promotion at
            the end of submit(). Unreachable/Enquiry open the reason
            popup first to capture Pending Due To + Reason + Remarks
            and fold them into the remarks column as a structured
            prefix. See JobOutcomeDialog block below. */}
        <div className="flex justify-between gap-2 pt-2 flex-wrap items-center">
          {/* LEFT cluster — Add Remarks (mirrors view-mode footer layout
              per ops 2026-05-21). Disabled when there's no initial.job_id
              (create flow) since the dialog POSTs to /admin/jobs/:id/comments.
              In confirm/edit modes the button opens AddRemarksDialog
              which we mount inside JobForm. */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="bg-teal-500 hover:bg-teal-600 text-white border-teal-500 hover:text-white"
              onClick={() => setAddRemarksFormOpen(true)}
              disabled={!initial?.job_id}
              title={initial?.job_id ? 'Add a remark / note to this job' : 'Save the job first, then add remarks'}
            >
              Add Remarks
            </Button>
          </div>
          {/* RIGHT cluster — Cancel + outcome/book buttons. Same order
              and styling as before; only the wrapping flex direction
              changed from justify-end to justify-between. */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* "Close" (not "Cancel") — this button just dismisses the modal
              without rolling back the booking, since the job already exists
              in Confirm & Schedule mode. "Cancel" would imply aborting the
              booking, which this never does. */}
          <CancelButton onCancel={onCancel} label="Close" />
          {canOutcomeButtons && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setOutcomeDialog({ mode: 'unreachable' })}
              title="Customer couldn't be reached — keep status Unconfirmed with reason"
            >
              Unreachable
            </Button>
          )}
          {canOutcomeButtons && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setOutcomeDialog({ mode: 'enquiry' })}
              title="Information request only — move status to Enquiry"
            >
              Enquiry
            </Button>
          )}
          {/*
            Save Draft (added 2026-05-28). Saves all currently-filled fields
            to tbl_job via the same PATCH the Book Call button uses, but
            SKIPS the status transition — job stays in its current bucket
            (typically Unconfirmed/9). Reopening the modal prefills the
            saved values via the normal GET /admin/jobs/:id fetch (no
            separate draft table needed — the field PATCH lands directly
            on the live row).

            Click pattern mirrors the outcome buttons: type="button" +
            setSubmitVariant('draft') + setTimeout(form.requestSubmit, 0).
            The setTimeout is critical — React state batching means a
            type="submit" click would let submit() run with the OLD
            submitVariant value, triggering the status PATCH path we want
            to skip. Deferring one tick guarantees the new variant value
            is in scope when submit() reads it.

            Validation gate: the mandatory-fields check at the top of
            submit() and the HTML5 form-level required attributes are
            both bypassed for the 'draft' variant — partial saves are
            the whole point of this button.
          */}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSubmitVariant('draft');
              setTimeout(() => {
                const form = document.querySelector('form');
                if (form) form.requestSubmit();
              }, 0);
            }}
            disabled={submitting}
            title="Save current details to DB without changing status. Reopen this job later to continue."
            className="border-amber-400 text-amber-700 hover:bg-amber-50"
          >
            {submitting && submitVariant === 'draft' ? 'Saving Draft…' : 'Save Draft'}
          </Button>
          <LoadBtn
            type="submit"
            loading={submitting && submitVariant === 'book'}
            onClick={() => setSubmitVariant('book')}
            // Book Call is now gated on the same completeness rule that
            // gates Section 3's expand (confirmSection2Complete). Without
            // this, the button was clickable even with Client Reference
            // ID / Reporting Contact / customer name / address / city /
            // PIN / date-time / time-slot missing — the BE would reject
            // with a Joi 400 per-field, but the FE should refuse to
            // submit upfront. Unreachable + Enquiry remain enabled (they
            // skip the full payload — see the outcome-only submit path).
            disabled={!confirmBookReady}
            title={
              !confirmSection2Complete
                ? 'Fill all mandatory fields (Client Ref ID, Reporting Contact, Customer Name, Address, City, PIN, Date & Time) before booking.'
                : !hasAtLeastOneService
                  ? 'Add at least one service in the Products section before booking.'
                  : ''
            }
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            Book Call
          </LoadBtn>
          </div>
        </div>
        {/* AddRemarksDialog — same situation as JobOutcomeDialog below:
            confirm-mode early-returns at this if-block, so the mount at
            ~line 7433 (inside the create/edit form's render block) is
            never reached. Inlining here mirrors the JobOutcomeDialog
            pattern. Without this, the "Add Remarks" button in the
            Confirm & Schedule footer (~line 6015) flips state but
            nothing renders — fixed 2026-06-04. Guard on initial?.job_id
            matches the create/edit-side mount. */}
        {initial?.job_id && (
          <AddRemarksDialog
            open={addRemarksFormOpen}
            jobId={initial.job_id}
            onClose={() => setAddRemarksFormOpen(false)}
            onSaved={() => { setAddRemarksFormOpen(false); }}
          />
        )}
        {/* Outcome popup — identical to the one wired on the create
            form below. Inlined here because confirm-mode early-returns
            before reaching the create form's render block, so the
            shared dialog would otherwise never mount in confirm mode. */}
        <JobOutcomeDialog
          open={outcomeDialog !== null}
          mode={outcomeDialog?.mode ?? 'unreachable'}
          onClose={() => setOutcomeDialog(null)}
          onSubmit={({ dueTo, reason, reasonId, remarks }) => {
            const mode = outcomeDialog?.mode ?? 'unreachable';
            // Comment text now carries only the operator's typed remark
            // (2026-06-04 — dropped the legacy "[Unreachable/Enquiry · X ·
            // Reason: Y]" structured prefix). The structured fields
            // (dueTo, reasonId) are still stashed in outcomePayload below
            // so submit() can stamp the canonical columns on tbl_job
            // (enquiry_reason_id, cancel_by) + write a clean tbl_job_comment
            // row (comment_on=16/17). The Comments tab joins back to
            // tbl_enum_reason for the label on render — no info lost.
            const merged = remarks || '';
            setF((s) => ({ ...s, remarks: merged }));
            // Stash the structured payload for submit() to use AFTER
            // the status PATCH lands — see the Enquiry persistence
            // path in submit().
            setOutcomePayload({ mode, dueTo, reason, reasonId, remarks, comment: merged });
            setSubmitVariant(mode);
            setOutcomeDialog(null);
            // requestSubmit on the closest form ancestor — defer one
            // tick so the state updates above land before submit reads
            // them.
            setTimeout(() => {
              const form = document.querySelector('form');
              if (form) form.requestSubmit();
            }, 0);
          }}
        />
      </form>
    );
  }

  /*
   * Accordion state for the create-flow form. Matches the legacy
   * addEditJob.vm three-section wizard: only one section is expanded at
   * a time; later sections are locked until the prior section's
   * mandatory fields are filled.
   *
   * Section completion rules (mandatory-field sets verified against
   * the legacy form):
   *   1. Client Details  : fk_client_id + client_ref_id (both required
   *                        before moving on — legacy treated Client Ref
   *                        ID as mandatory; the new app surfaces it
   *                        with a * marker and gates Section 2 on it).
   *   2. Customer Details: customer_name + customer_mob_no (10 digits)
   *                        + address + city_id + pin_code (6 digits)
   *   3. Select Products : requested_date_time + services basket
   *                        (services optional; the date gate is the
   *                        real blocker on the final Book Call button).
   */
  const [openSection, setOpenSection] = React.useState<1 | 2 | 3>(1);
  /*
   * Book New Call: when the operator advances a section, scroll that section's
   * HEADER to the TOP of the modal's scroll body (no field focus) so the
   * viewport doesn't stay parked at the bottom. Covers BOTH the 1→2 and 2→3
   * Next transitions. Double rAF so the just-collapsed prior section has settled
   * its layout before we measure + scroll (scrollSectionToTop uses an absolute
   * target, immune to that shift). Scoped to create mode (this accordion only
   * renders when !isEditShape).
   */
  const section2Ref = React.useRef<HTMLElement | null>(null);
  const selectProductsRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const el = openSection === 3 ? selectProductsRef.current
      : openSection === 2 ? section2Ref.current
      : null;
    if (!el) return undefined;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => scrollSectionToTop(el)));
    return () => cancelAnimationFrame(raf);
  }, [openSection]);
  /*
   * Clients for which Branch Details is MANDATORY (not optional).
   * Sourced from product config:
   *   252 → Lenskart
   *   395 → Lenskart (Crop and Camera Work)
   * Both clients run multi-store retail networks where the operator
   * MUST tell the technician which branch the job is for; an empty
   * Branch row is unworkable downstream. Extend this list when more
   * branch-strict clients are onboarded.
   *
   * UPDATE 2026-05-18: this hardcoded list is no longer used. The
   * mandatory + visibility flags now come from
   * `tbl_client_custom_properties` via the BE endpoint
   * `/admin/clients/:clientId/custom-properties`. See
   * `clientCustomProps` declared above the confirm-mode early-return
   * (both Book and Confirm flows read the same derived flags).
   */

  const section1Complete =
    !!f.fk_client_id &&
    !!(f.client_ref_id && String(f.client_ref_id).trim()) &&
    !!f.reporting_contact_id &&
    (!branchProp || !branchProp.mandatory || !!(f.branch_details && String(f.branch_details).trim())) &&
    (!buildingProp || !buildingProp.mandatory || !!(f.building_name && String(f.building_name).trim())) &&
    (!productProp || !productProp.mandatory || !!(f.product_code && String(f.product_code).trim()));

  /*
   * Date + Time helpers for the "Requested Date / Time / Booking Slot"
   * fields in Section 2.
   *
   * Rules (verified against legacy addEditJob.vm):
   *   - Date input must reject anything before today (no past dates).
   *   - Time picker is HOURLY only — operators pick whole hours like
   *     "10:00", "11:00". 24h dropdown of "HH:00" options.
   *   - For TODAY, the minimum selectable hour is the NEXT hour after
   *     the current hour (no past times). For future dates, all 24
   *     hours are available.
   *   - Booking Time Slot auto-derives from the picked hour:
   *       09–12 → "9 AM - 12 PM"
   *       12–15 → "12 PM - 3 PM"
   *       15–19 → "3 PM - 7 PM"
   *       else  → "After Hours"
   *     Mirrors the four-pill legacy chooser in the screenshot.
   */
  const todayIso = React.useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);
  const requestedDate: string = String(f.requested_date || '');
  const requestedTime: string = String(f.requested_time || '');
  const isToday = requestedDate === todayIso;
  const nowClock = new Date();
  // Floor for today's 30-min time options — the next slot at/after the current
  // wall-clock minute; TimeSelect hides earlier slots. (Was a whole-next-hour
  // gate; 30-min slots make that too coarse.)
  const minTimeToday = `${String(nowClock.getHours()).padStart(2, '0')}:${String(nowClock.getMinutes()).padStart(2, '0')}`;
  function bookingSlotFor(timeHHMM: string): string {
    const h = Number(timeHHMM.split(':')[0]);
    if (Number.isNaN(h)) return '';
    if (h >= 9  && h < 12) return 'Morning 9 to 2';   // (legacy slot label, ~9-12)
    if (h >= 12 && h < 15) return 'Afternoon 12 to 5'; // 12-3
    if (h >= 15 && h < 19) return 'Evening 2 to 7';    // 3-7
    return 'After Hours';
  }
  /*
   * Whenever the operator changes Requested Time, auto-update the
   * Booking Time Slot. They can still override the slot manually
   * (the dropdown remains interactive), but the default tracks the
   * picked hour.
   */
  React.useEffect(() => {
    if (!requestedTime) return;
    const slot = bookingSlotFor(requestedTime);
    if (slot && f.time_slot !== slot) set('time_slot', slot);
    // Combine date + time into requested_date_time (ISO) which the
    // backend already consumes. Existing edit/confirm modes don't
    // use this combined field — only create flow.
    if (requestedDate) {
      set('requested_date_time', `${requestedDate}T${requestedTime}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTime, requestedDate]);
  /*
   * GPS coords mandatory (2026-06-06). Matches the BE validator's
   * `lat,lng` Joi pattern and the legacy CRM's `isCoordinateBlank()`
   * write-time check in addEditCustAddress.vm. Without this gate,
   * operators could submit Book-New-Call jobs whose
   * `tbl_address.gps_location` lands NULL, which silently breaks the
   * legacy Schedule modal (renders "GPS Location: Not Found" + cascades
   * a blank `getRoadDistance(custGps, …)` for every technician row).
   * Investigation report dated 2026-06-06; AddressPickerWithMap
   * populates the coords whenever auto-geocode succeeds, so the only
   * way to fail this gate is to type an address and skip the map pick.
   */
  const GPS_RX = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
  const section2Complete =
    section1Complete &&
    !!f.customer_name && /^[0-9]{10}$/.test(String(f.customer_mob_no || '')) &&
    !!f.address && !!f.city_id && /^[0-9]{6}$/.test(String(f.pin_code || '')) &&
    GPS_RX.test(String(f.gps_location || '').trim()) &&
    // Schedule moved from Section 3 → Section 2: date + time both
    // required before moving to Products.
    !!f.requested_date_time;

  /*
   * Per-client questionnaires (shown in Section 1 once a client is
   * picked). Sourced from /admin/questionnaires; we filter to the
   * picked client_id locally because the list endpoint doesn't
   * accept a clientId query param. The "Questionnaire" picker is
   * hidden entirely when the client has zero questionnaires — legacy
   * addEditJob behaved the same way.
   */
  type Questionnaire = { c_questionaire_id: number; client_id: number; c_questionaire_name: string; status: number };
  const [clientQuestionnaires, setClientQuestionnaires] = React.useState<Questionnaire[]>([]);
  React.useEffect(() => {
    if (isEditShape) return;
    const clientId = Number(f.fk_client_id);
    if (!clientId) { setClientQuestionnaires([]); return; }
    let cancelled = false;
    api.get<Questionnaire[]>('/admin/questionnaires')
      .then((rows) => {
        if (cancelled) return;
        setClientQuestionnaires((rows || []).filter((q) => Number(q.client_id) === clientId && Number(q.status) === 1));
      })
      .catch(() => { if (!cancelled) setClientQuestionnaires([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.fk_client_id, isEditShape]);

  return (
    // Same noValidate gate as the confirm-mode form above — see comment
    // there for rationale. Outcome paths (Unreachable / Enquiry) need
    // to bypass HTML5 required-field gates on the Book Call form so the
    // operator can log an outcome on an incomplete booking.
    <form onSubmit={submit} noValidate={outcomePayload !== null || submitVariant === 'draft'} className="space-y-5">
      {/* Form-level header bar — shows the customer the operator is
          booking for and (when matched) a View History shortcut to a
          modal listing every prior job for that customer_id. Lives
          inside JobForm rather than the outer modal header because
          the customer context only exists once the mobile-gate
          completes. */}
      {!isEditShape && prefillCustomer && (
        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-sm">
            <span className="text-xs text-muted-foreground mr-2">Booking for:</span>
            <strong>
              {prefillCustomer.found && prefillCustomer.customer?.customer_name
                ? prefillCustomer.customer.customer_name
                : 'New customer'}
            </strong>
            <span className="text-muted-foreground ml-2">· {prefillCustomer.mobile}</span>
          </div>
          {prefillCustomer.found && prefillCustomer.customer?.customer_id ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setHistoryOpen(true)}
            >
              <History className="h-4 w-4 mr-1.5" />
              View History
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground italic">No prior history (new customer)</span>
          )}
        </div>
      )}
      {!isEditShape && (
        <Section
          title="1. Client Details"
          expanded={openSection === 1}
          onToggle={() => setOpenSection(1)}
          badge={section1Complete ? <span className="text-emerald-600 text-xs">✓</span> : null}
        >
          {/*
            * Section 1 — Client Details (legacy "Book New Call" parity).
            *
            * Initial reveal (before client picked):
            *   Client *, Branch Details, Client Reference ID, Reporting Contact (disabled)
            *
            * After client picked:
            *   + Questionnaire (filtered from /admin/questionnaires?clientId=…)
            *   + Property / Building Name (free text)
            *   + Product Code (free text)
            *   + Reporting Contact (now enabled, filtered by client)
            *
            * After Reporting Contact picked:
            *   + Client SPOC (Mobile) — DISABLED, prefilled from contact
            *   + Client SPOC Name    — DISABLED, prefilled
            *   + Client SPOC Email   — DISABLED, prefilled
            *
            * Source dropdown is HIDDEN — defaults to "manual" (Manual/CRM).
            * Legacy CRM only ever showed Source if a client was mapped to
            * multiple sources; for the new app we keep the value on the
            * payload but don't ask operators to pick it.
            *
            * Schedule (Requested Date/Time, Time Slot), Job Type, and
            * Description moved to Section 3 — they belong with the
            * "Select Products" wizard step per the legacy addEditJob
            * layout, not with Client Details.
            */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Client *">
              <SearchSelect
                required
                value={f.fk_client_id}
                onChange={(v) => {
                  // Switching clients invalidates everything that was
                  // filled in for the previous client. Per operator
                  // request: clear reporting_contact_id (so the SPOC
                  // trio collapses), wipe the SPOC values themselves,
                  // and reset the questionnaire pick + Branch / Product
                  // / Property fields (they're per-client too). Client
                  // Reference ID is also client-specific so it goes.
                  // The customer + address (section 2) and schedule
                  // (section 3) are unrelated to the client switch and
                  // remain intact.
                  setF((s) => ({
                    ...s,
                    fk_client_id: v,
                    reporting_contact_id: '',
                    client_spoc: '',
                    client_spoc_name: '',
                    client_spoc_email: '',
                    c_questionaire_id: '',
                    branch_details: '',
                    product_code: '',
                    building_name: '',
                    client_ref_id: '',
                    // Section 3 (Select Products) is rate-card-scoped to
                    // the client too — clear all picker state so we
                    // don't carry one client's service basket onto the
                    // next. The clientServices fetch effect (keyed off
                    // fk_client_id) re-loads the catalog automatically.
                    fk_service_catg_id: '',
                    fk_service_catg_ids: '',
                    fk_service_type_id: '',
                    fk_service_type_ids: [],
                    job_type: '',
                  }));
                  // Hard-reset the rate-card cache + derived rows.
                  // The derive-rows effect will re-fan once the new
                  // client's clientServices arrives + the operator
                  // picks types again.
                  setServiceRows([]);
                }}
                placeholder="— Select client —"
                options={lk.toOpts.clients.map((o) => ({ value: o.value, label: String(o.label) }))}
              />
            </Field>
            {/*
              * Branch Details — renders ONLY when the client has a
              * `branch_details` row in tbl_client_custom_properties.
              * Mandatory flag from the same row drives required + the
              * trailing "*" on the label.
              */}
            {branchProp && (
              <Field label={branchProp.mandatory ? 'Branch Details *' : 'Branch Details'}>
                <Input
                  required={branchProp.mandatory}
                  value={f.branch_details || ''}
                  onChange={(e) => set('branch_details', e.target.value)}
                  placeholder={branchProp.mandatory ? 'Required for this client' : 'e.g. Bengaluru — Indiranagar'}
                />
              </Field>
            )}
            <Field label="Client Reference ID *">
              {/*
                * Strict input filter: alphanumeric + hyphen + underscore
                * only (per ops 2026-05-18). Spaces, slashes, pipes,
                * accented chars etc. are silently stripped as the
                * operator types. This avoids downstream issues with
                * external systems that consume `client_ref_id` as a
                * file-system-safe / URL-safe identifier.
                *
                * pattern= attribute mirrors the filter for browser
                * form-submission validation as a belt-and-suspenders.
                */}
              <Input
                required
                value={f.client_ref_id || ''}
                onChange={(e) => set('client_ref_id', e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
                pattern="[A-Za-z0-9_-]+"
                title="Only letters, numbers, hyphens, and underscores are allowed"
                placeholder="Client's internal reference (a-z, 0-9, -, _)"
              />
            </Field>
            <Field label={`Reporting Contact *${f.fk_client_id && loadingContacts ? ' (loading…)' : ''}`}>
              <SearchSelect
                required
                value={f.reporting_contact_id || ''}
                onChange={(v) => pickReportingContact(v)}
                placeholder={
                  !f.fk_client_id
                    ? 'Pick a client first'
                    : clientContacts.length
                      ? '— Select contact —'
                      : 'No contacts on file for this client'
                }
                disabled={!f.fk_client_id || !clientContacts.length}
                options={clientContacts.map((c) => ({
                  value: c.id,
                  label: c.contact_name + (c.contact_desgn ? ` · ${c.contact_desgn}` : ''),
                }))}
              />
            </Field>

            {/* The four blocks below appear ONLY after a client is
                picked. Together they replicate the legacy addEditJob's
                "after the operator chooses a client, show these extra
                fields" pattern. */}
            {f.fk_client_id && (
              <>
                {/* Questionnaire — fetched from
                    /admin/questionnaires?clientId=… via the
                    clientQuestionnaires state. Hidden if the client
                    has no questionnaires (legacy didn't show an empty
                    picker either — it just suppressed the field). */}
                {clientQuestionnaires.length > 0 && (
                  <Field label="Questionnaire">
                    <SearchSelect
                      value={f.c_questionaire_id || ''}
                      onChange={(v) => set('c_questionaire_id', v)}
                      placeholder="— Select questionnaire —"
                      options={clientQuestionnaires.map((q) => ({
                        value: q.c_questionaire_id,
                        label: q.c_questionaire_name,
                      }))}
                    />
                  </Field>
                )}
                {/*
                  * Property / Building Name + Product Code — render
                  * ONLY when the client has the corresponding row in
                  * tbl_client_custom_properties (per ops 2026-05-18).
                  * Mandatory flag from each row drives required + "*".
                  */}
                {buildingProp && (
                  <Field label={buildingProp.mandatory ? 'Property / Building Name *' : 'Property / Building Name'}>
                    <Input
                      required={buildingProp.mandatory}
                      value={f.building_name || ''}
                      onChange={(e) => set('building_name', e.target.value)}
                      placeholder="Ask the customer for the building / property name"
                    />
                  </Field>
                )}
                {productProp && (
                  <Field label={productProp.mandatory ? 'Product Code *' : 'Product Code'}>
                    <Input
                      required={productProp.mandatory}
                      value={f.product_code || ''}
                      onChange={(e) => set('product_code', e.target.value)}
                      placeholder="Client-specific product / SKU identifier"
                    />
                  </Field>
                )}
              </>
            )}

            {/* Client SPOC trio appears once a Reporting Contact is
                picked. Disabled (read-only) because the values are
                authoritative on the tbl_client_contacts row — if the
                operator needs to correct them, they edit the contact
                in Manage Clients → Contacts, not here. The grey
                appearance comes from the global Input `disabled:`
                styling (slate-200 bg) — no per-field override needed. */}
            {f.reporting_contact_id && (
              <>
                <Field label="Client SPOC (Mobile)">
                  {/* SPOC mobile is read-only; mask for PII consistent
                      with customer mobile. The contact row itself is
                      edited via Manage Clients → Contacts. */}
                  <Input value={maskMobile(f.client_spoc)} disabled className="font-mono tabular-nums" />
                </Field>
                <Field label="Client SPOC Name">
                  <Input value={f.client_spoc_name || ''} disabled />
                </Field>
                <Field label="Client SPOC Email">
                  <Input type="email" value={f.client_spoc_email || ''} disabled />
                </Field>
              </>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              onClick={() => setOpenSection(2)}
              disabled={!section1Complete}
              title={section1Complete ? '' : 'Fill required fields (Client + Date/Time) to proceed'}
            >
              Next →
            </Button>
          </div>
        </Section>
      )}

      {/* Edit/confirm mode keeps the legacy non-accordion Schedule
          section. Only create mode uses the 3-step wizard. */}
      {isEditShape && (
        <Section title={isEditShape ? 'Schedule & Type' : 'Schedule'}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Requested Date/Time *">
              <DateTimeSlotPicker required min={nowLocalIso()} value={f.requested_date_time} onChange={(v) => set('requested_date_time', v)} />
              <SlotAdvisory
                best={slotRec.best}
                attendanceKnown={slotRec.attendanceKnown}
                candidatePool={slotRec.candidatePool}
                loading={slotRec.loading}
                failed={slotRec.failed}
              />
            </Field>
            <Field label="Time Slot"><SearchSelect value={f.time_slot} onChange={(v) => set('time_slot', v)} placeholder="— Select slot —" options={[
              { value: 'Morning 9 to 2', label: 'Morning 9 to 2' },
              { value: 'Afternoon 12 to 5', label: 'Afternoon 12 to 5' },
              { value: 'Evening 2 to 7', label: 'Evening 2 to 7' },
              { value: 'Anytime', label: 'Anytime' },
            ]} /></Field>
            <Field label="Client Ref ID"><Input value={f.client_ref_id} onChange={(e) => set('client_ref_id', e.target.value)} /></Field>
            <Field label="Job Type"><SearchSelect value={f.job_type} onChange={(v) => set('job_type', v)} placeholder="— Select job type —" options={[
              { value: 'Installation', label: 'Installation' }, { value: 'Repair', label: 'Repair' },
              { value: 'Uninstallation', label: 'Uninstallation' },
            ]} /></Field>
            <Field label="Description" full><Input value={f.job_desc} onChange={(e) => set('job_desc', e.target.value)} placeholder="Scope of work" /></Field>
          </div>
        </Section>
      )}

      {!isEditShape && (
        <>
          <Section
            title="2. Customer Details"
            sectionRef={section2Ref}
            expanded={openSection === 2}
            onToggle={() => { if (section1Complete) setOpenSection(2); }}
            disabled={!section1Complete}
            badge={section2Complete ? <span className="text-emerald-600 text-xs">✓</span> : null}
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Customer Name *"><Input required value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></Field>
              <Field label="Mobile Number *">
                {/* Disabled: the operator already typed this mobile
                    in the gate's mobile-number prompt, which is
                    what bootstrapped this whole flow. Editing it
                    here would invalidate the customer lookup the
                    gate just did. To change, the operator clicks
                    "Change mobile" on the gate banner. */}
                <Input
                  required
                  disabled
                  value={f.customer_mob_no}
                  className="font-mono"
                />
                {/* Calling (2026-06-30): click-to-call dials by a server-resolvable
                    customer id, so it works only for an EXISTING customer already
                    on file. For a brand-new customer there is no record to dial yet
                    → show a note instead of a dead call control. */}
                {prefillCustomer?.found && prefillCustomer.customer?.customer_id ? (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Call:</span>
                    <CallableMobile
                      customerId={prefillCustomer.customer.customer_id}
                      mobile={customerNumberVisible
                        ? (f.customer_mob_no || null)
                        : maskMobile(f.customer_mob_no || null)}
                    />
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-amber-700">
                    Calling becomes available after the call is booked — this is a new customer not yet on file.
                  </p>
                )}
              </Field>
              <Field label="Email"><Input type="email" value={f.customer_email} onChange={(e) => set('customer_email', e.target.value)} /></Field>
              {/*
                * Alternate customer contact — captured at Book Call so
                * the technician has a fallback when the primary is
                * unreachable. Stored on tbl_job.additional_name /
                * additional_number. Wrapped in a 2-col sub-grid so each
                * field reads at 50% width (more breathing room than 33%).
                */}
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Customer Alternate Name">
                  <Input
                    value={f.additional_name || ''}
                    onChange={(e) => set('additional_name', e.target.value)}
                    maxLength={200}
                    placeholder="Alternate contact name"
                  />
                </Field>
                <Field label="Customer Alternate Number">
                  {/* Indian-mobile validation: shared INDIAN_MOBILE_REGEX.
                      Empty stays valid (alt is optional). Inline error
                      + red ring only when the operator has typed
                      something that fails the regex. Mirrors the
                      Confirm modal's Alt Number input. */}
                  {(() => {
                    const raw = String(f.additional_number || '');
                    const isValid = isValidIndianMobile(raw);
                    return (
                      <>
                        <Input
                          value={raw}
                          onChange={(e) => set('additional_number', e.target.value.replace(/\D/g, '').slice(0, 10))}
                          inputMode="numeric"
                          placeholder="10 digits"
                          className={`font-mono ${!isValid ? 'border-red-400 focus-visible:ring-red-300' : ''}`}
                          aria-invalid={!isValid}
                        />
                        {!isValid && (
                          <p className="text-[11px] text-red-600 mt-1">{INDIAN_MOBILE_ERROR}</p>
                        )}
                      </>
                    );
                  })()}
                </Field>
              </div>
              {/* Schedule sub-block — Date / Time / Booking Slot.
                  Legacy layout placed these inside Customer Details
                  (the screenshot shows "Requested Date / Requested
                  Time / Booking Time Slot" as separate rows). Time
                  picker is hourly with min-time-for-today gating;
                  Booking Slot auto-derives from the picked hour but
                  remains operator-editable. */}
              {/*
                * Requested Date + Requested Time live on the SAME row
                * (per ops 2026-05-25). Wrapped in a 2-col sub-grid
                * spanning the full 3-col parent so they pair cleanly
                * regardless of where Alt Name/Number landed before.
                */}
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Requested Date *">
                  <Input
                    required
                    type="date"
                    min={todayIso}
                    value={requestedDate}
                    onChange={(e) => {
                      set('requested_date', e.target.value);
                      // If the new date is in the future, allow any
                      // previously-picked time (no past-today gate);
                      // if it's today and the existing time is now past,
                      // clear so the operator must re-pick a valid one.
                      if (e.target.value === todayIso && requestedTime && requestedTime < minTimeToday) {
                        set('requested_time', '');
                      }
                    }}
                  />
                </Field>
                <Field label="Requested Time *">
                  <TimeSelect
                    required
                    value={requestedTime}
                    onChange={(v) => set('requested_time', v)}
                    placeholder={requestedDate ? '— Pick Time —' : 'Pick A Date First'}
                    disabled={!requestedDate}
                    minTime={isToday ? minTimeToday : undefined}
                  />
                </Field>
              </div>
              {/* Booking Slot chip row moved out of the 3-col grid —
                  rendered as its own full-width row below the date+
                  time pickers per operator request. See block after
                  this </div> closing. */}
            </div>
            {/* Booking Time Slot — full-width row sitting BELOW the
                Date + Time pickers. Title on a label row, chips on
                a single horizontal line below. Until the operator
                picks a Requested Time the chips render in their
                "all unselected" state (none highlighted) — auto-
                highlight kicks in only after the time is set. */}
            <div className="mt-3">
              <label className="text-sm font-medium block mb-1.5">Booking Time Slot</label>
              <div className="flex gap-2 items-center">
                {[
                  { value: 'Morning 9 to 2',    label: '9 AM - 12 PM' },
                  { value: 'Afternoon 12 to 5', label: '12 PM - 3 PM' },
                  { value: 'Evening 2 to 7',    label: '3 PM - 7 PM' },
                  { value: 'After Hours',       label: 'After Hours' },
                ].map((opt) => {
                  const active = !!requestedTime && f.time_slot === opt.value;
                  return (
                    <span
                      key={opt.value}
                      className={`inline-flex items-center px-4 h-8 rounded-full text-xs font-medium select-none cursor-not-allowed whitespace-nowrap ${
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'bg-muted text-muted-foreground'
                      }`}
                      title={requestedTime ? 'Auto-selected from Requested Time' : 'Pick a Requested Time to highlight a slot'}
                    >
                      {opt.label}
                    </span>
                  );
                })}
              </div>
            </div>
            {/* Address sub-block nested inside section 2. Matches the
                legacy addEditJob layout where Customer Details + Address
                were a single wizard step. */}
            <div className="mt-4 pt-4 border-t">
              <div className="text-sm font-medium mb-2">Job address</div>
            {/* Existing-address picker. Visible only when the create
                flow opened with a customer who has saved addresses
                (i.e. prefillCustomer.addresses non-empty AND we're not
                in "add new" mode). Selecting a different existing
                address re-seeds the address fields below. Clicking ×
                deletes via DELETE /admin/customers/:id/addresses/:addrId
                (FK-guarded by the backend). */}
            {prefillCustomer?.found && (prefillCustomer.addresses?.length ?? 0) > 0 && (() => {
              /*
               * Search + latest-10 paging over the saved addresses.
               *   - `addressQuery` filters across address / city /
               *     pin_code (all the operator-visible columns).
               *   - When the query is empty we sort by address_id
               *     DESC (latest first) and show the first 10;
               *     "View all" toggles the full set.
               *   - When the query is non-empty we ALWAYS show every
               *     match (search is for finding, not browsing).
               */
              const all = prefillCustomer.addresses!;
              const q = addressQuery.trim().toLowerCase();
              const matches = q
                ? all.filter((a) =>
                    String(a.address || '').toLowerCase().includes(q) ||
                    String(a.city_name || '').toLowerCase().includes(q) ||
                    String(a.pin_code || '').toLowerCase().includes(q))
                : [...all].sort((x, y) => (y.address_id - x.address_id));
              const sliced = q || addressShowAll ? matches : matches.slice(0, 10);
              const hiddenCount = q ? 0 : Math.max(0, matches.length - sliced.length);
              return (
              <div className="mb-4 rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium">Saved addresses for this customer</div>
                  <div className="text-xs text-muted-foreground">
                    {q
                      ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
                      : `${all.length} total`}
                  </div>
                </div>
                <Input
                  className="mb-2"
                  placeholder="Search saved addresses (text, city or PIN)…"
                  value={addressQuery}
                  onChange={(e) => setAddressQuery(e.target.value)}
                />
                <div className="space-y-1.5">
                  {sliced.map((a) => {
                    const isSelected = selectedAddressId === a.address_id;
                    return (
                      <div key={a.address_id} className="flex items-start gap-2">
                        <label className="flex items-start gap-2 cursor-pointer flex-1">
                          <input
                            type="radio"
                            name="prefill-address"
                            checked={isSelected}
                            onChange={() => {
                              setSelectedAddressId(a.address_id);
                              // Copy all six address fields (not just line/city/pin)
                              // so switching saved addresses also fills Building/
                              // Floor + Landmark and re-centres the map from
                              // gps_location — same as the preselect initializer.
                              setF((s) => ({
                                ...s,
                                address: a.address || '',
                                building: a.building || '',
                                landmark: a.landmark || '',
                                city_id: a.city_id != null ? String(a.city_id) : '',
                                pin_code: a.pin_code || '',
                                gps_location: a.gps_location || '',
                              }));
                            }}
                            className="mt-0.5"
                          />
                          <span className="flex-1">
                            {formatServiceAddress(a)}
                          </span>
                        </label>
                        {/* Edit pencil — opens the AddressEditDialog
                            with the address pre-filled. On save the
                            row patches in place via PATCH
                            /admin/customers/:id/addresses/:addrId. */}
                        <button
                          type="button"
                          title="Edit this saved address"
                          className="text-sky-600 hover:text-sky-800 px-1"
                          onClick={(e) => {
                            e.preventDefault();
                            setAddressEdit({ open: true, address: a });
                          }}
                        >
                          ✎
                        </button>
                        {/* Delete address. Backend FK-guards so a job-
                            linked address cannot be removed. */}
                        <button
                          type="button"
                          title="Delete this saved address"
                          className="text-rose-600 hover:text-rose-800 disabled:opacity-30 px-1"
                          disabled={(prefillCustomer.addresses?.length ?? 0) <= 1}
                          onClick={async (e) => {
                            e.preventDefault();
                            if (!prefillCustomer.customer?.customer_id) return;
                            // Migrated from native confirm + alert to the
                            // shared useConfirm + showToast pattern (UX
                            // consistency rule).
                            const okDelete = await confirmDialog({
                              title: 'Delete Saved Address?',
                              description: 'Backend FK-guards so a job-linked address cannot be removed.',
                              confirmLabel: 'Delete',
                              variant: 'destructive',
                            });
                            if (!okDelete) return;
                            try {
                              await api.delete(`/admin/customers/${prefillCustomer.customer.customer_id}/addresses/${a.address_id}`);
                              // Mutating the prefill prop isn't ideal,
                              // but the prefill object lives on the
                              // gate one level up and we just need to
                              // visually drop the row; the form's
                              // current address fields stay untouched
                              // unless this WAS the selected one (then
                              // we clear them).
                              if (isSelected) {
                                setSelectedAddressId(null);
                                setF((s) => ({ ...s, address: '', city_id: '', pin_code: '' }));
                              }
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              (prefillCustomer.addresses as any) =
                                (prefillCustomer.addresses || []).filter((x) => x.address_id !== a.address_id);
                              // Force a re-render by setting a benign field on itself.
                              setF((s) => ({ ...s }));
                              showToast({ variant: 'success', message: 'Address Deleted' });
                            } catch (err) {
                              showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Delete failed' });
                            }
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  {/* No-results hint when the search returns nothing. */}
                  {sliced.length === 0 && (
                    <div className="text-xs text-muted-foreground italic py-2">
                      No saved addresses match &quot;{addressQuery}&quot;.
                    </div>
                  )}
                  {/* "View all" toggle — only when we're hiding rows
                      (default 10-row slice has more behind it AND no
                      active search). */}
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      className="text-xs text-sky-700 hover:text-sky-900 hover:underline pt-1"
                      onClick={() => setAddressShowAll(true)}
                    >
                      View all {matches.length} addresses ({hiddenCount} more)
                    </button>
                  )}
                  {addressShowAll && !q && all.length > 10 && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:underline pt-1 ml-3"
                      onClick={() => setAddressShowAll(false)}
                    >
                      Collapse to latest 10
                    </button>
                  )}
                  <div className="border-t mt-2 pt-2">
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => {
                        setSelectedAddressId(null);
                        setF((s) => ({ ...s, address: '', city_id: '', pin_code: '', building: '', gps_location: '' }));
                      }}
                    >
                      + Add a new address (clears fields below)
                    </button>
                  </div>
                </div>
              </div>
              );
            })()}
            {/* Address section — uses the shared AddressPickerWithMap
                (split-pane: form left, draggable Google Map right).
                Identical component to the one used in Confirm &
                Schedule below, so both flows behave the same way:
                autocomplete pick repositions the marker, marker drag
                reverse-geocodes back to PIN + city + address. */}
            {/* Service Address (read-only) — live-assembled Building · Address ·
                Landmark · City · Pincode preview, shown just above the editable
                Complete Address so the operator can copy/paste or cross-check it
                as the address fields are filled. Same field as Confirm & Schedule. */}
            <div className="mb-3">
              <Label className="text-xs text-muted-foreground">Service Address</Label>
              <textarea
                readOnly
                disabled
                value={formatServiceAddress({
                  building: f.building,
                  address: f.address,
                  landmark: f.landmark,
                  city_name: f.city_id ? cityNameById.get(String(f.city_id)) : null,
                  pin_code: f.pin_code,
                }, { fallback: '—' })}
                rows={2}
                className="mt-1 w-full rounded-md border border-input bg-slate-100 px-3 py-1.5 text-sm text-slate-700 resize-none"
              />
            </div>
            <AddressPickerWithMap
              value={{
                address: f.address || '',
                building: f.building || '',
                landmark: f.landmark || '',
                city_id: f.city_id || '',
                pin_code: f.pin_code || '',
                gps_location: f.gps_location || '',
                address_instruction: ((f as Record<string, unknown>).address_instruction as string) || '',
              }}
              onChange={(next: AddressValue) => {
                setF((s) => ({
                  ...s,
                  address: next.address,
                  building: next.building || '',
                  landmark: next.landmark || '',
                  city_id: String(next.city_id || ''),
                  pin_code: next.pin_code,
                  gps_location: next.gps_location,
                  address_instruction: next.address_instruction || '',
                }));
              }}
              cities={lk.toOpts.cities.map((o) => ({ value: String(o.value), label: String(o.label) }))}
              autoCreatePincode
            />
            </div>
            <div className="mt-4 flex justify-between">
              <Button type="button" variant="outline" onClick={() => setOpenSection(1)}>← Back</Button>
              <Button
                type="button"
                onClick={() => setOpenSection(3)}
                disabled={!section2Complete}
                title={section2Complete ? '' : 'Fill customer name + mobile + address + city + PIN to proceed'}
              >
                Next →
              </Button>
            </div>
          </Section>

          <Section
            title="3. Select Products"
            sectionRef={selectProductsRef}
            expanded={openSection === 3}
            onToggle={() => { if (section2Complete) setOpenSection(3); }}
            disabled={!section2Complete}
          >
            {/* Three mandatory pickers up top: Service Category, Service
                Type (multi-select, filtered by Category), Job Type.
                Legacy parity — operator must classify the job before the
                rate-card auto-fans services into the table below.
                Picking a Service Type immediately appends a row for
                every matching rate-carded service (qty fixed at 1);
                deselecting removes those rows. Manual quantity / amount
                editing is intentionally suppressed — the rate card is
                the source of truth and ops asked us to stop letting
                operators tweak it inline. */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              {/*
                * Service Category — MULTI-SELECT (2026-05-15).
                * Picking N categories causes the submit handler to POST
                * N create-job requests sharing one `client_ref_id`.
                * State key: `fk_service_catg_ids` (CSV of category IDs).
                * The legacy single-select `fk_service_catg_id` is kept
                * in sync with the FIRST selected category so the
                * downstream Service-Type filter + rate-card basket
                * (which still use the single field) have something
                * sensible to show.
                */}
              {/*
                * Service Categories — restricted to categories that
                * actually appear in THIS client's rate card. Otherwise
                * the operator could pick a category that has no priced
                * services and end up with an empty services table.
                * The set is derived from `clientServices` (loaded from
                * `/shared/lookup/client-services?clientId=`). While
                * the rate card is loading, fall back to ALL active
                * categories so the dropdown isn't empty during the
                * 100–300ms BE round-trip.
                */}
              <Field label="Service Categories *">
                <SearchMultiSelect
                  value={(f.fk_service_catg_ids || '').split(',').filter(Boolean)}
                  onChange={(next) => {
                    /* Same add-preserves / remove-prunes handling as
                       Confirm-mode Section 3 above. See that block for
                       the rationale. */
                    const oldIds = (f.fk_service_catg_ids || '')
                      .split(',').filter(Boolean);
                    const newIds = (next as Array<string | number>).map(String);
                    const removedIds = new Set(oldIds.filter((id) => !newIds.includes(id)));
                    set('fk_service_catg_ids' as keyof typeof f, newIds.join(',') as never);
                    set('fk_service_catg_id', newIds[0] || '');
                    if (removedIds.size > 0) {
                      const catOfType = new Map(
                        (lk.serviceTypes || []).map((t) => [String(t.service_type_id), String(t.service_catg_id)] as const),
                      );
                      const filteredTypeIds = (f.fk_service_type_ids || [])
                        .filter((tid) => !removedIds.has(catOfType.get(String(tid)) || ''));
                      set('fk_service_type_ids' as keyof typeof f, filteredTypeIds as never);
                      set('fk_service_type_id', filteredTypeIds[0] ? String(filteredTypeIds[0]) : '');
                      setPerJobFields((prev) => {
                        const out = { ...prev };
                        removedIds.forEach((id) => delete out[id]);
                        return out;
                      });
                    }
                    const newlyAdded = newIds.filter((id) => !oldIds.includes(id));
                    if (newlyAdded.length > 0) {
                      setPerJobFields((prev) => {
                        const out = { ...prev };
                        const activeId = oldIds[Math.min(activeJobTab, oldIds.length - 1)] || '';
                        const donor: PerJobOverride = (activeId && prev[activeId])
                          || Object.values(prev).find((o) => o && Object.keys(o).length > 0)
                          || {
                            remarks: f.remarks,
                            efr_special_notes: f.efr_special_notes,
                            helper_req: Boolean(f.helper_req),
                            material_req: Boolean(f.material_req),
                            collected_by: f.collected_by,
                          };
                        newlyAdded.forEach((id) => {
                          if (!out[id]) out[id] = { ...donor, job_image_file: undefined };
                        });
                        return out;
                      });
                    }
                  }}
                  placeholder="— Select one or more —"
                  selectedLabel="categories"
                  options={(() => {
                    // Build the allowed category set from the client's
                    // rate card. If the card hasn't loaded yet
                    // (clientServices === null) or is empty, show all
                    // categories — the dependent Service Type picker
                    // will still gate against the empty card.
                    const allowed = new Set(
                      (clientServices || []).map((cs) => String(cs.service_catg_id)),
                    );
                    return (lk.serviceCategories || [])
                      .filter((c) => allowed.size === 0 || allowed.has(String(c.service_catg_id)))
                      .map((c) => ({ value: c.service_catg_id, label: c.service_catg_name }));
                  })()}
                />
              </Field>
              <Field label="Service Type *">
                {/* Service Type list now reacts to ALL picked categories,
                    not just the first. When the operator selects N
                    categories, the dropdown surfaces service types
                    matching any of them, still filtered to types that
                    appear on THIS client's rate card (otherwise the
                    operator could pick a type with no priced row and
                    end up with an empty services table + unbookable
                    job). When no category is selected the dropdown is
                    disabled with a clear hint. */}
                <SearchMultiSelect
                  value={f.fk_service_type_ids || []}
                  onChange={(next) => set('fk_service_type_ids' as keyof typeof f, next.map(String) as never)}
                  placeholder={(f.fk_service_catg_ids || f.fk_service_catg_id) ? '— Select service type(s) —' : 'Pick a category first'}
                  disabled={!(f.fk_service_catg_ids || f.fk_service_catg_id)}
                  options={(() => {
                    const inRateCard = new Set(
                      (clientServices || []).map((cs) => String(cs.service_type_id))
                    );
                    const pickedCats = new Set(
                      (f.fk_service_catg_ids || '').split(',').filter(Boolean),
                    );
                    if (pickedCats.size === 0 && f.fk_service_catg_id) {
                      pickedCats.add(String(f.fk_service_catg_id));
                    }
                    const catNameById = new Map(
                      (lk.serviceCategories || []).map((c) => [String(c.service_catg_id), c.service_catg_name]),
                    );
                    return (lk.serviceTypes || [])
                      .filter((t) => pickedCats.size === 0 || pickedCats.has(String(t.service_catg_id)))
                      .filter((t) => inRateCard.has(String(t.service_type_id)))
                      // Group-sort so SearchMultiSelect can render
                      // "Service Category — X" headers between groups
                      // when 2+ categories are picked.
                      .slice()
                      .sort((a, b) => {
                        const an = catNameById.get(String(a.service_catg_id)) || '';
                        const bn = catNameById.get(String(b.service_catg_id)) || '';
                        return an.localeCompare(bn) || a.service_type_name.localeCompare(b.service_type_name);
                      })
                      .map((t) => ({
                        value: String(t.service_type_id),
                        label: t.service_type_name,
                        group: pickedCats.size > 1
                          ? (catNameById.get(String(t.service_catg_id)) || `Category ${t.service_catg_id}`)
                          : undefined,
                      }));
                  })()}
                />
              </Field>
              {/*
                * Job Type — MULTI-SELECT (2026-05-15). CSV-stored in
                * `f.job_type`; a single pick produces a CSV of length 1
                * which equals the original single-value string, so
                * backward compatibility is preserved.
                */}
              <Field label="Job Type *">
                <SearchMultiSelect
                  value={(f.job_type || '').split(',').filter(Boolean)}
                  onChange={(next) => {
                    const csv = (next as Array<string | number>).map(String).join(',');
                    set('job_type', csv);
                  }}
                  placeholder="— Select job type(s) —"
                  selectedLabel="types"
                  options={[
                    { value: 'Installation', label: 'Installation' },
                    { value: 'Repair', label: 'Repair' },
                    { value: 'Uninstallation', label: 'Uninstallation' },
                  ]}
                />
              </Field>
            </div>
            {/*
              * Per-Job tab bar (2026-05-18). When the operator picked
              * N categories, the submit will create N jobs — one per
              * category. The tab bar lets them flip between "what
              * goes into Job K" with a click. Each tab is filtered to
              * service types + basket rows whose category matches the
              * active tab. With 0 or 1 category picked the tabs are
              * hidden (legacy single-job UX).
              */}
            {(() => {
              const pickedCatIds = (f.fk_service_catg_ids || '')
                .split(',')
                .filter(Boolean);
              if (pickedCatIds.length < 2) return null;
              // Defensive: clamp activeJobTab if categories shrunk.
              const tabIdx = Math.min(activeJobTab, pickedCatIds.length - 1);
              return (
                <div className="flex gap-1 mb-3 border-b">
                  {pickedCatIds.map((cid, i) => {
                    const cat = (lk.serviceCategories || []).find(
                      (c) => String(c.service_catg_id) === String(cid),
                    );
                    const label = cat?.service_catg_name || `Category ${cid}`;
                    const active = i === tabIdx;
                    return (
                      <button
                        key={cid}
                        type="button"
                        onClick={() => setActiveJobTab(i)}
                        className={
                          'px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors ' +
                          (active
                            ? 'border-sky-600 text-sky-700 font-medium'
                            : 'border-transparent text-muted-foreground hover:text-foreground')
                        }
                      >
                        Job {i + 1} — {label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            {/*
              * Auto-populated services table — now filtered to the
              * active Job-tab's category (when there is one). Each
              * selected Service Type belonging to that category
              * contributes every matching client_service row at qty 1
              * with the rate card's price. Rate card is canonical —
              * no inline editing. The full `serviceRows` state is
              * still passed down so the table can update it; rendering
              * filters per-category at display time.
              */}
            {(() => {
              const pickedCatIds = (f.fk_service_catg_ids || '')
                .split(',')
                .filter(Boolean);
              // Single-category (or 0): show all picked types — legacy behaviour.
              if (pickedCatIds.length < 2) {
                return (
                  <AutoServicesTable
                    services={clientServices}
                    loading={loadingServices}
                    serviceTypeIds={f.fk_service_type_ids || []}
                    rows={serviceRows}
                    setRows={setServiceRows}
                  />
                );
              }
              // Multi-category: narrow service types to the active tab's
              // category so each tab shows only its own services.
              const tabIdx = Math.min(activeJobTab, pickedCatIds.length - 1);
              const activeCatId = pickedCatIds[tabIdx];
              const typesInActiveCat = new Set(
                (lk.serviceTypes || [])
                  .filter((t) => String(t.service_catg_id) === String(activeCatId))
                  .map((t) => String(t.service_type_id)),
              );
              const filteredTypeIds = (f.fk_service_type_ids || [])
                .filter((id) => typesInActiveCat.has(String(id)));
              return (
                <AutoServicesTable
                  services={clientServices}
                  loading={loadingServices}
                  serviceTypeIds={filteredTypeIds}
                  rows={serviceRows}
                  setRows={setServiceRows}
                />
              );
            })()}
            {/* Job metadata fields below the services table. Special
                Comments + Anything Handyman sit half-half on a single
                row (per ops request — paired textareas read together
                better than stacked). resize-y allows vertical-only drag,
                so the form doesn't grow horizontally and bust the modal. */}
            <div className="mt-5 pt-4 border-t space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Job Image">
                  {/* Per-tab DOM remount — see the longer comment on the
                      Confirm-mode mirror of this input (~line 3520) for
                      why the native input has to be keyed by catId. */}
                  {(() => {
                    const stashed = (getJobField('job_image_files') as File[] | undefined) || [];
                    const tabKey = getActiveCatId() || 'single';
                    return (
                      <div>
                        <Input
                          key={`job-img-${tabKey}`}
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => {
                            const files = e.target.files ? Array.from(e.target.files) : [];
                            setJobField('job_image_files', files as never);
                            setJobField('job_image_file', (files[0] ?? null) as never);
                          }}
                        />
                        {stashed.length > 0 && (
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {stashed.length} file{stashed.length === 1 ? '' : 's'} ready for this job tab.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </Field>
                <div className="flex items-center gap-6 pt-6">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={!!getJobField('helper_req')}
                      onCheckedChange={(v: boolean) => setJobField('helper_req', v)}
                      ariaLabel="Helper required"
                    />
                    Helper Required
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={!!getJobField('material_req')}
                      onCheckedChange={(v: boolean) => setJobField('material_req', v)}
                      ariaLabel="Material required"
                    />
                    Material Required
                  </label>
                </div>
              </div>
              {/* Side-by-side textareas. Labels + bindings match the
                  Create-mode block (see ~line 5917) — "Job Description"
                  stores to tbl_job.job_desc, "Anything Handyman should keep
                  in mind?" stores to tbl_job.efr_special_notes. The 2026-06-04
                  fix renamed "Special Comments" (which had been mislabelled
                  and writing to `remarks`) to "Job Description" and rebound
                  it to job_desc; the Handyman label + column stayed put.
                  resize-y locks horizontal resize. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Job Description *">
                  <textarea
                    required
                    rows={3}
                    value={getJobField('job_desc') ?? ''}
                    onChange={(e) => setJobField('job_desc', e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm bg-white resize-y"
                    placeholder="Describe the work required"
                  />
                </Field>
                <Field label="Anything Handyman should keep in mind? *">
                  <textarea
                    required
                    rows={3}
                    value={getJobField('efr_special_notes') ?? ''}
                    onChange={(e) => setJobField('efr_special_notes', e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm bg-white resize-y"
                    placeholder="Notes for the technician"
                  />
                </Field>
              </div>
              {/*
                * Collected By — gated by the client's profile
                * preference (tbl_client_custom_properties; BE endpoint
                * /admin/clients/:clientId/collected-by-preference).
                *   - collectedByPref === null     → "Any": both options.
                *   - collectedByPref === 'Easyfix' → locked to "Easyfix".
                *   - collectedByPref === 'Client'  → locked to "Client".
                * Locked dropdown shows a single option and a small hint
                * line so the operator knows it's not a UI bug.
                */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Collected By *">
                  {/*
                    * Canonical options come from `tbl_client.collected_by`
                    * code values 1/2/3 (Easyfixer/Easyfix/Client) per
                    * ops 2026-05-18. Code 0 = "any" (no lock) and falls
                    * through to the three-option dropdown.
                    */}
                  <SearchSelect
                    required
                    // No 'Easyfix' fallback: an invisible default is what let ops
                    // submit without choosing. Empty → the "Select" placeholder,
                    // and the submit gate blocks until they pick.
                    value={collectedByPref ?? (getJobField('collected_by') || '')}
                    onChange={(v) => { if (!collectedByPref) setJobField('collected_by', v); }}
                    disabled={!!collectedByPref}
                    placeholder="Select"
                    options={
                      collectedByPref
                        ? [{ value: collectedByPref, label: collectedByDisplay(collectedByPref) }]
                        : COLLECTED_BY_JOB_OPTIONS
                    }
                  />
                  {collectedByPref && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Locked by client profile (Collected By = {collectedByDisplay(collectedByPref)}).
                    </p>
                  )}
                </Field>
              </div>
            </div>
            <div className="mt-4 flex justify-start">
              <Button type="button" variant="outline" onClick={() => setOpenSection(2)}>← Back</Button>
            </div>
          </Section>
        </>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}
      {/* Footer — placement of Unreachable / Enquiry buttons (revised
          2026-05-19 per ops): the outcome buttons belong on the
          Unconfirmed → Confirm modal (mode === 'confirm'), NOT on the
          CRM-create Book New Call modal. Rationale: external sources
          create orders in Unconfirmed (status 9); when ops opens the
          row to confirm, they may discover the customer is unreachable
          or the request is just an enquiry, and need to re-route the
          order without leaving the modal. CRM-create skips Unconfirmed
          entirely (status BOOKED on insert), so Unreachable/Enquiry
          have no use there.
          - create mode : Book Call only
          - confirm mode: Unreachable / Enquiry / Confirm & Schedule
          - edit mode   : Save changes (unchanged) */}
      <div className="flex justify-between gap-2 pt-2 flex-wrap items-center">
        {/* LEFT cluster — Add Remarks. Rendered ONLY when there's a
            real job_id to attach the remark to — i.e. edit/confirm
            modes. Create mode (Book New Call) hides this entirely
            per ops 2026-05-28 ask: a "disabled with tooltip" state was
            still drawing the operator's eye for an action they cannot
            take pre-save. The button reappears the next time the same
            job is opened in view/confirm/edit mode. */}
        <div className="flex items-center gap-2">
          {initial?.job_id ? (
            <Button
              type="button"
              variant="outline"
              className="bg-teal-500 hover:bg-teal-600 text-white border-teal-500 hover:text-white"
              onClick={() => setAddRemarksFormOpen(true)}
              title="Add a remark / note to this job"
            >
              Add Remarks
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
        {/* This footer is reached only in create / edit modes — confirm mode
            early-returns at line 5024 with its own footer (see line 6023,
            which uses label="Close" because the button doesn't roll back
            the booking). Here in create mode, Cancel really does abort an
            in-flight booking, so the default label is correct. */}
        <CancelButton onCancel={onCancel} />
        {isConfirm ? (
          <>
            {canOutcomeButtons && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setOutcomeDialog({ mode: 'unreachable' })}
                title="Customer couldn't be reached — keep status Unconfirmed with reason"
              >
                Unreachable
              </Button>
            )}
            {canOutcomeButtons && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setOutcomeDialog({ mode: 'enquiry' })}
                title="Information request only — move status to Enquiry"
              >
                Enquiry
              </Button>
            )}
            <LoadBtn
              type="submit"
              loading={submitting && submitVariant === 'book'}
              onClick={() => setSubmitVariant('book')}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              Book Call
            </LoadBtn>
          </>
        ) : isEdit ? (
          <LoadBtn type="submit" loading={submitting}>
            Save changes
          </LoadBtn>
        ) : (
          <LoadBtn
            type="submit"
            loading={submitting && submitVariant === 'book'}
            onClick={() => setSubmitVariant('book')}
          >
            Book Call
          </LoadBtn>
        )}
        </div>
      </div>
      {/* Add Remarks dialog — wired to the same /admin/jobs/:id/comments
          endpoint as the view-mode footer's button. Only renders the
          dialog itself when there's a real job_id (defence-in-depth on
          top of the button's disabled state). */}
      {initial?.job_id && (
        <AddRemarksDialog
          open={addRemarksFormOpen}
          jobId={initial.job_id}
          onClose={() => setAddRemarksFormOpen(false)}
          onSaved={() => { setAddRemarksFormOpen(false); }}
        />
      )}
      {/*
        * JobOutcomeDialog — legacy "Job Unreachable" / "Job Enquiry"
        * popup that gathers Pending Due To + Reason + Remarks before
        * the actual create POST fires. On Submit:
        *   1. Fold the popup data into the form's `remarks` field as
        *      a structured prefix `[Unreachable · By Client · Reason:
        *      Product return] <operator notes>`. BE doesn't need new
        *      columns this way — the context is preserved in the
        *      existing remarks column for audit + future parsing.
        *   2. Set submitVariant to 'unreachable' / 'enquiry'.
        *   3. Trigger the form's submit programmatically.
        */}
      <JobOutcomeDialog
        open={outcomeDialog !== null}
        mode={outcomeDialog?.mode ?? 'unreachable'}
        onClose={() => setOutcomeDialog(null)}
        onSubmit={({ dueTo, reason, reasonId, remarks }) => {
          const mode = outcomeDialog?.mode ?? 'unreachable';
          const tag = mode === 'unreachable' ? 'Unreachable' : 'Enquiry';
          // Comment text now carries only the operator's typed remark
          // (2026-06-04 — dropped the legacy "[Unreachable/Enquiry · X ·
          // Reason: Y]" prefix). dueTo + reasonId stay in outcomePayload
          // so submit() can stamp the canonical tbl_job columns separately;
          // the Comments tab joins back to tbl_enum_reason for the label.
          const merged = remarks || '';
          setF((s) => ({ ...s, remarks: merged }));
          // Stash the structured payload so submit() can stamp
          // enquiry_reason_id / enquiry_comment / cancel_by + post a
          // tbl_job_comment row (comment_on=17) after the status PATCH.
          setOutcomePayload({ mode, dueTo, reason, reasonId, remarks, comment: merged });
          setSubmitVariant(mode);
          setOutcomeDialog(null);
          // Programmatic submit — defer one tick so the state updates
          // above land in the form before submit reads them.
          setTimeout(() => {
            const form = document.querySelector('form');
            if (form) form.requestSubmit();
          }, 0);
        }}
      />
      {/* Address edit dialog — opens from the ✎ pencil per saved
          address. The dialog handles its own PATCH; on success the
          callback below patches the address into prefillCustomer's
          local list and re-syncs the form fields if the edited
          address was the currently-selected one. */}
      <AddressEditDialog
        open={addressEdit.open}
        onClose={() => setAddressEdit({ open: false, address: null })}
        customerId={prefillCustomer?.customer?.customer_id ?? 0}
        address={addressEdit.address}
        onSaved={(updated) => {
          // Mutate prefillCustomer.addresses in place (same pattern
          // the delete handler uses — the prop object lives one
          // level up, and we want the visual list to reflect the
          // change without forcing a parent refetch).
          if (prefillCustomer?.addresses && addressEdit.address) {
            const idx = prefillCustomer.addresses.findIndex(
              (x) => x.address_id === addressEdit.address!.address_id
            );
            if (idx !== -1) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (prefillCustomer.addresses as any)[idx] = {
                ...prefillCustomer.addresses[idx],
                ...updated,
              };
            }
          }
          // If the edited address was the one currently populating
          // the form fields, re-sync so the operator sees the new
          // values immediately.
          if (
            addressEdit.address &&
            String(f.address) === String(addressEdit.address.address || '') &&
            String(f.city_id) === String(addressEdit.address.city_id ?? '') &&
            String(f.pin_code) === String(addressEdit.address.pin_code || '')
          ) {
            setF((s) => ({
              ...s,
              address: updated.address || '',
              building: updated.building || '',
              city_id: updated.city_id != null ? String(updated.city_id) : '',
              pin_code: updated.pin_code || '',
              gps_location: updated.gps_location || '',
            }));
          } else {
            // Force a re-render so the new label shows in the picker.
            setF((s) => ({ ...s }));
          }
        }}
      />
      {/* Customer History dialog — only meaningful in create mode after
          the mobile-gate matched an existing customer (we need a
          customer_id to query against). The dialog drops back to a
          plain "no history" message if the customer hasn't booked
          before. */}
      {!isEditShape && prefillCustomer?.found && prefillCustomer.customer?.customer_id ? (
        <CustomerHistoryDialog
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          customerId={prefillCustomer.customer.customer_id}
          customerName={prefillCustomer.customer.customer_name || ''}
          mobile={prefillCustomer.mobile}
        />
      ) : null}
    </form>
  );
}

// ─── Services basket (Add Job) ───────────────────────────────────────────────
/*
 * Multi-row service picker for the Create Job flow.
 *
 * Each row: service dropdown (scoped to the client's rate-carded services)
 *         + quantity input + live computed amount (rate × qty) + remove button.
 *
 * A live subtotal + grand total sits at the bottom so ops can sanity-check
 * the invoice amount before submitting. Amount is NEVER sent to the backend
 * (the backend re-computes from the rate card at invoicing time) — it's
 * purely a pre-submission UX check against the currently-mapped rate card.
 *
 * Empty states:
 *   - No client picked yet → tell the user to pick a client first.
 *   - Client picked but no rate-carded services → explain where to map them.
 *   - Loading → skeleton-ish muted text.
 */
function ServicesBasket({
  clientPicked, services, loading, rows, setRows,
}: {
  clientPicked: boolean;
  services: ClientService[] | null;
  loading: boolean;
  rows: ServiceRow[];
  setRows: React.Dispatch<React.SetStateAction<ServiceRow[]>>;
}) {
  /*
   * Above-table search — narrows the catalog visible inside the
   * per-row SearchSelect. The per-row SearchSelect already has its
   * own typeahead, but operators looking for a service first want to
   * see the available set BEFORE clicking a dropdown. The query
   * filters `options` against type / category / rate-card name
   * (everything the operator sees in the option label).
   */
  const [serviceQuery, setServiceQuery] = useState<string>('');
  const q = serviceQuery.trim().toLowerCase();
  // SearchSelect options — label packs type + category + rate so ops can
  // disambiguate when the same service type appears on multiple rate cards.
  const options = (services ?? [])
    .filter((s) => {
      if (!q) return true;
      const hay = [s.service_catg_name, s.service_type_name, s.crc_ratecard_name]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    })
    .map((s) => {
      const rate = toRate(s.total_amount);
      const rateStr = rate === null ? 'no rate' : `₹${rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
      const catType = [s.service_catg_name, s.service_type_name].filter(Boolean).join(' › ') || 'Service';
      return {
        value: String(s.client_service_id),
        label: `${catType} · ${rateStr}${s.crc_ratecard_name ? ` · ${s.crc_ratecard_name}` : ''}`,
      };
    });

  /*
   * Progressive disclosure — always keep exactly ONE trailing empty row so
   * ops never have to click "Add Service". The moment they pick a service or
   * touch the quantity on the ghost row, a fresh ghost row auto-appends.
   *
   * Guardrails:
   *   - Fires only when services catalog is loaded (so we don't append before
   *     the user can actually pick anything).
   *   - A row counts as "touched" if `client_service_id` is set. Quantity
   *     alone (which defaults to '1') doesn't count, otherwise the very first
   *     render would promote-and-append in an infinite loop.
   */
  useEffect(() => {
    if (services === null) return;              // catalog still loading
    if (rows.length === 0) {
      setRows([{ tempId: Date.now() + Math.random(), client_service_id: '', quantity: '1' }]);
      return;
    }
    const last = rows[rows.length - 1];
    if (last.client_service_id) {
      setRows((prev) => [...prev, { tempId: Date.now() + Math.random(), client_service_id: '', quantity: '1' }]);
    }
  }, [rows, services, setRows]);

  // Totals — recomputed every render from `rows`. Cheap since rows are small.
  // Ghost row (empty client_service_id) contributes 0 to the total, naturally.
  const lineAmounts = rows.map((r) => {
    const meta = (services ?? []).find((s) => String(s.client_service_id) === r.client_service_id);
    const rate = toRate(meta?.total_amount);
    const qty = Number(r.quantity) || 0;
    return rate !== null ? rate * qty : null;
  });
  const grandTotal = lineAmounts.reduce<number>((acc, n) => acc + (n ?? 0), 0);
  const anyMissingRate = lineAmounts.some((n) => n === null) && rows.some((r) => !!r.client_service_id);

  if (!clientPicked) {
    return <div className="text-sm text-muted-foreground">Pick a client first — the service list is scoped to that client&apos;s rate card.</div>;
  }
  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading rate-carded services…</div>;
  }
  if (services !== null && services.length === 0) {
    return (
      <div className="text-sm text-amber-900 rounded border border-amber-200 bg-amber-50 px-3 py-2">
        This client has no active rate-carded services. Map them under <em>Settings → Manage Services</em> (or ask the BD owner) before picking services here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Above-table service search. Filters the available options
          in each row's SearchSelect by category / type / rate-card
          name. Empty query = full catalog. The match count below the
          input helps operators see whether their search is too
          narrow before opening a row's picker. */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Input
            placeholder="Search services (type, category, rate card)…"
            value={serviceQuery}
            onChange={(e) => setServiceQuery(e.target.value)}
          />
        </div>
        <div className="text-xs text-muted-foreground whitespace-nowrap">
          {q
            ? `${options.length} of ${(services ?? []).length} services`
            : `${(services ?? []).length} services`}
        </div>
      </div>
      {rows.map((row, idx) => {
        const isGhost = !row.client_service_id;
        const isLast = idx === rows.length - 1;
        const meta = (services ?? []).find((s) => String(s.client_service_id) === row.client_service_id);
        const rate = toRate(meta?.total_amount);
        const qty = Number(row.quantity) || 0;
        const lineAmount = rate !== null ? rate * qty : null;
        // Keep already-picked ids out of other rows' dropdowns so ops can't
        // accidentally add the same service twice (backend would accept it,
        // but it's almost always a bug — for "2 units of X" you bump quantity).
        const pickedElsewhere = new Set(
          rows.filter((_, i) => i !== idx).map((r) => r.client_service_id).filter(Boolean)
        );
        // Filter exposes the search-narrowed catalog AND keeps the
        // currently-selected option visible (so the operator's existing
        // pick isn't accidentally hidden by an unrelated search filter).
        const selectedMeta = (services ?? []).find((s) => String(s.client_service_id) === row.client_service_id);
        let filteredOptions = options.filter((o) => !pickedElsewhere.has(o.value) || o.value === row.client_service_id);
        if (row.client_service_id && !filteredOptions.some((o) => o.value === row.client_service_id) && selectedMeta) {
          // Search query has hidden the row's currently-picked
          // option — append it back so the operator's selection
          // doesn't disappear on them mid-search.
          const rate2 = toRate(selectedMeta.total_amount);
          const rateStr2 = rate2 === null ? 'no rate' : `₹${rate2.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
          const catType2 = [selectedMeta.service_catg_name, selectedMeta.service_type_name].filter(Boolean).join(' › ') || 'Service';
          filteredOptions = [
            ...filteredOptions,
            { value: String(selectedMeta.client_service_id), label: `${catType2} · ${rateStr2}${selectedMeta.crc_ratecard_name ? ` · ${selectedMeta.crc_ratecard_name}` : ''}` },
          ];
        }
        return (
          <div key={row.tempId} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-12 md:col-span-6">
              <Label className="text-xs">Service</Label>
              <SearchSelect
                value={row.client_service_id}
                onChange={(v) => setRows((prev) => prev.map((r, i) => i === idx ? { ...r, client_service_id: v } : r))}
                placeholder="— Select service —"
                options={filteredOptions}
              />
            </div>
            <div className="col-span-4 md:col-span-2">
              <Label className="text-xs">Qty</Label>
              <Input
                type="number" min={1} step={1}
                value={row.quantity}
                onChange={(e) => setRows((prev) => prev.map((r, i) => i === idx ? { ...r, quantity: e.target.value.replace(/\D/g, '') } : r))}
              />
            </div>
            <div className="col-span-6 md:col-span-3">
              <Label className="text-xs">Amount</Label>
              <div className="h-9 rounded-md border border-input bg-muted/40 px-3 py-1.5 text-sm tabular-nums">
                {lineAmount === null
                  ? <span className="text-muted-foreground">—</span>
                  : <>₹{lineAmount.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</>}
                {rate !== null && qty > 0 && (
                  <span className="text-[10px] text-muted-foreground ml-1.5">
                    ({qty} × ₹{rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })})
                  </span>
                )}
              </div>
            </div>
            <div className="col-span-2 md:col-span-1 flex">
              {/*
                * Hide the remove button on the trailing ghost row — there's
                * nothing meaningful to remove, and clicking it would trigger
                * the auto-append to recreate it. Reserving the column slot
                * (invisible div) keeps the grid alignment stable across rows.
                */}
              {isGhost && isLast ? (
                <div className="w-full" aria-hidden="true" />
              ) : (
                <Button
                  type="button" variant="outline" size="sm" className="w-full"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
                  title="Remove service"
                >
                  ✕
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {/* Footer — total only. No "Add Service" button; rows self-propagate. */}
      <div className="flex items-center justify-end pt-2 border-t">
        <div className="text-sm tabular-nums">
          <span className="text-muted-foreground mr-2">Total:</span>
          <strong>₹{grandTotal.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</strong>
          {anyMissingRate && (
            <span className="text-[10px] text-amber-700 ml-2">(some services have no rate — total excludes them)</span>
          )}
        </div>
      </div>
    </div>
  );
}

/*
 * MySQL DECIMAL arrives as a string from mysql2 (to avoid float precision loss
 * on large values). Normalise to Number for arithmetic; null-safe for rows
 * where the client doesn't have a configured rate.
 */
function toRate(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/*
 * AutoServicesTable — read-only services table for the create-flow
 * Section 3. Replaces the manual ServicesBasket: operator picks one
 * or more Service Types in the multi-select above, and every matching
 * rate-carded client_service row appears here at qty=1 with its rate
 * card price. The rate card is canonical, so there's no manual edit
 * surface — to drop a service, the operator deselects its Service Type.
 *
 * The matching parent component derives the actual serviceRows that
 * are POSTed; this is purely a presentational summary so the operator
 * can confirm what's about to be booked + see the running total.
 */
function AutoServicesTable({
  services, loading, serviceTypeIds, rows, setRows,
}: {
  services: ClientService[] | null;
  loading: boolean;
  serviceTypeIds: string[];
  /** Authoritative basket rows (same shape that gets POSTed). Quantity
   *  here is editable; the parent's reconciler effect adds/removes
   *  rows on type changes while preserving these quantities. */
  rows: ServiceRow[];
  setRows: React.Dispatch<React.SetStateAction<ServiceRow[]>>;
}) {
  /*
   * Above-table service search — narrows the candidate list by
   * rate-card / category / type substring. Visible ONLY when the
   * candidate table is being rendered (gated by the early-returns
   * below — "search appears once the list appears" per ops spec).
   * Hooks ALWAYS run at the top of the function, before any early
   * return, so this state is declared up here even though it's only
   * read inside the table render block.
   */
  const [serviceSearch, setServiceSearch] = useState<string>('');

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading rate-carded services…</div>;
  }
  if (services === null) {
    return <div className="text-sm text-muted-foreground">Pick a client in Section 1 to load its rate card.</div>;
  }
  if (services.length === 0) {
    return (
      <div className="text-sm text-amber-900 rounded border border-amber-200 bg-amber-50 px-3 py-2">
        This client has no active rate-carded services. Map them under <em>Settings → Manage Services</em> before booking.
      </div>
    );
  }
  if (!serviceTypeIds || serviceTypeIds.length === 0) {
    return (
      <div className="text-sm text-muted-foreground rounded border border-dashed px-3 py-3 text-center">
        Pick one or more Service Types above — services will auto-populate here from the client&apos;s rate card.
      </div>
    );
  }

  // Lookup needed by the search filter (to keep already-added rows
  // visible regardless of the query). Declared early so the filter
  // logic below can read it without forward references.
  const rowByCsIdEarly = new Map(rows.map((r) => [r.client_service_id, r] as const));

  /*
   * Two-tier display: every client_service matching the picked Service
   * Types is shown as a CANDIDATE row. The leading column carries a
   * "+" button when the candidate is NOT yet in the basket, or a qty
   * input + ✕ remove when it IS. Rate column is always populated; the
   * Amount column is only populated for added rows (since qty is the
   * second input to the line amount and unadded rows have no qty).
   * The footer Total sums ONLY added rows — matches operator
   * expectation: until I click +, this row doesn't count.
   */
  const picked = new Set(serviceTypeIds.map(String));
  const candidates = (services || []).filter((s) => picked.has(String(s.service_type_id)));

  if (candidates.length === 0) {
    return (
      <div className="text-sm text-amber-900 rounded border border-amber-200 bg-amber-50 px-3 py-2">
        The selected Service Type(s) aren&apos;t mapped on this client&apos;s rate card. Pick a different type or map the service under <em>Settings → Manage Services</em>.
      </div>
    );
  }

  // Above-table search — narrows the candidate set by service /
  // category / type / rate-card name. The search bar only shows
  // when there's actually a list to filter (gated by the
  // `candidates.length === 0` early-return above), matching the
  // operator's expectation: "the search appears once the list
  // appears". Already-added rows always stay visible regardless of
  // the search so the operator's basket doesn't disappear on them.
  const q = serviceSearch.trim().toLowerCase();
  const filteredCandidates = q
    ? candidates.filter((s) => {
        const hay = [s.crc_ratecard_name, s.service_catg_name, s.service_type_name]
          .filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(q)) return true;
        // Always keep added rows visible — see comment above.
        return rowByCsIdEarly.has(String(s.client_service_id));
      })
    : candidates;

  // Reuse the early-declared lookup (same Map, just an alias).
  const rowByCsId = rowByCsIdEarly;

  /*
   * Rate resolution per row — legacy-parity rewrite (2026-05-28).
   *
   * Legacy CRM renders the stored `total_amount` column verbatim
   * regardless of `charge_type`. A service with `total_amount = 0`
   * shows "₹0.00", not a "Variable" badge. Ops configure 0
   * deliberately for free / negotiated / collected-on-site services
   * and expect to see ₹0.00.
   *
   * The earlier branches were a new-app addition that diverged from
   * legacy:
   *   - `charge_type === 0` was treated as "Variable" (badge, excluded
   *     from total). But `charge_type` is an opaque legacy enum whose
   *     0/1 semantics aren't documented per-deploy — using it as a
   *     "show numeric value vs not" gate produced false positives
   *     like Travel allowance (charge_type=0, total_amount=0) being
   *     flagged Variable when the admin page showed ₹0.
   *   - `total_amount === 0` was treated as "missing". That collapsed
   *     legitimate "free" rates into the misconfigured bucket.
   *
   * New semantics:
   *   - `total_amount` is a finite number (incl. 0) → kind 'fixed',
   *     rate counts toward grandTotal (qty × rate).
   *   - `total_amount` is null/undefined/NaN → kind 'missing',
   *     rate is "Not set", excluded from grandTotal. Genuinely
   *     misconfigured rows still surface.
   *
   * `charge_type` is no longer read here. If we ever need to revive
   * a real "Variable" flag (per-booking-quote services), it should be
   * a dedicated explicit column, not the overloaded `charge_type`.
   */
  function resolveRate(s: ClientService): { rate: number | null; kind: 'fixed' | 'missing' } {
    const r = toRate(s.total_amount);
    if (r === null) return { rate: null, kind: 'missing' };
    return { rate: r, kind: 'fixed' };
  }

  const lineAmounts = candidates.map((s) => {
    const row = rowByCsId.get(String(s.client_service_id));
    if (!row) return 0;                       // unadded → 0 contribution
    const { rate, kind } = resolveRate(s);
    if (kind !== 'fixed' || rate === null) return null;
    const qty = Number(row.quantity) || 0;
    return rate * qty;
  });
  const grandTotal = lineAmounts.reduce<number>((acc, n) => acc + (n ?? 0), 0);
  const anyAddedMissingRate = candidates.some((s, i) => {
    const row = rowByCsId.get(String(s.client_service_id));
    if (!row) return false;                   // not added → not relevant
    return lineAmounts[i] === null;
  });

  function addService(cs: ClientService) {
    setRows((prev) => {
      // Guard against double-add (e.g. fast double-click on +).
      if (prev.some((r) => r.client_service_id === String(cs.client_service_id))) return prev;
      return [...prev, {
        tempId: Date.now() + Math.random(),
        client_service_id: String(cs.client_service_id),
        quantity: '1',
      }];
    });
  }
  function removeService(csId: string) {
    setRows((prev) => prev.filter((r) => r.client_service_id !== csId));
  }
  function setRowQty(csId: string, qty: string) {
    setRows((prev) => prev.map((r) =>
      r.client_service_id === csId ? { ...r, quantity: qty } : r
    ));
  }

  return (
    <div className="space-y-2">
      {/* Above-table search — visible whenever the candidate list is
          rendered (early-returns above gate on no-client / no-rate-card
          / no-type-picked). Filters by service / category / type /
          rate-card name. Already-added rows stay visible regardless
          of the query so the operator's basket never disappears. */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search services (name, category, type)…"
          value={serviceSearch}
          onChange={(e) => setServiceSearch(e.target.value)}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {q
            ? `${filteredCandidates.length} of ${candidates.length} matches`
            : `${candidates.length} available`}
        </span>
      </div>
      <div className="rounded-md border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs">
          <tr>
            <th className="text-center px-2 py-2 font-medium w-10"> </th>
            <th className="text-left px-3 py-2 font-medium">Service</th>
            <th className="text-left px-3 py-2 font-medium">Category</th>
            <th className="text-left px-3 py-2 font-medium">Type</th>
            <th className="text-right px-3 py-2 font-medium w-24">Qty</th>
            <th className="text-right px-3 py-2 font-medium w-32">Rate</th>
            <th className="text-right px-3 py-2 font-medium w-32">Amount</th>
          </tr>
        </thead>
        <tbody>
          {filteredCandidates.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-center text-xs text-muted-foreground italic">
                No services match &quot;{serviceSearch}&quot;.
              </td>
            </tr>
          )}
          {filteredCandidates.map((s) => {
            const csId = String(s.client_service_id);
            const row = rowByCsId.get(csId);
            const added = !!row;
            const { rate, kind } = resolveRate(s);
            const qty = added && row ? (Number(row.quantity) || 0) : 0;
            const lineAmount = added && kind === 'fixed' && rate !== null ? rate * qty : null;
            return (
              <tr key={csId} className={`border-t transition-colors ${added ? 'bg-sky-50/40' : 'hover:bg-muted/30'}`}>
                <td className="px-2 py-2 text-center">
                  {/* Cleaner inline toggle — flat icon button, no
                      coloured chip. The row's own background tint is
                      the visual "added" cue; the trailing icon just
                      swaps + → ✕ so the action stays obvious. Uses
                      lucide-react icons to match the rest of the app. */}
                  {added ? (
                    <button
                      type="button"
                      onClick={() => removeService(csId)}
                      title="Remove from booking"
                      aria-label="Remove from booking"
                      className="inline-flex items-center justify-center h-7 w-7 rounded text-rose-600 hover:bg-rose-50 hover:text-rose-700 transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => addService(s)}
                      title="Add to booking"
                      aria-label="Add to booking"
                      className="inline-flex items-center justify-center h-7 w-7 rounded text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  )}
                </td>
                <td className="px-3 py-2">{s.crc_ratecard_name || '—'}</td>
                <td className="px-3 py-2">{s.service_catg_name || '—'}</td>
                <td className="px-3 py-2">{s.service_type_name || '—'}</td>
                <td className="px-3 py-2">
                  {added && row ? (
                    /* Qty: scroll-wheel blurs to prevent silent
                       bumps; spinner arrows hidden via Tailwind
                       arbitrary selectors; native Up/Down keys still
                       work since type stays "number". On blur, snap
                       empty/zero back to 1 (a 0-qty row would silently
                       drop out of buildServicesPayload). */
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={row.quantity}
                      onChange={(e) => setRowQty(csId, e.target.value.replace(/\D/g, ''))}
                      onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                      onBlur={() => {
                        if (!row.quantity || Number(row.quantity) < 1) setRowQty(csId, '1');
                      }}
                      className="h-8 text-right tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {/* Rate display (legacy-parity rewrite 2026-05-28):
                        fixed   → ₹X.XX (including ₹0.00 for free /
                                  negotiated services — matches what
                                  the Manage Client Services admin page
                                  shows for the same row).
                        missing → "Not set" in amber (total_amount
                                  literally NULL/undefined on the BE —
                                  ops needs to configure a value).
                      The previous "Variable" badge branch was dropped:
                      the FE no longer interprets `charge_type === 0`
                      as "variable" — see `resolveRate` docblock. */}
                  {kind === 'fixed' && rate !== null
                    ? `₹${rate.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
                    : <span className="text-[11px] text-amber-700" title="Rate not configured on this client's rate card">Not set</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {!added ? <span className="text-muted-foreground">—</span>
                    : lineAmount === null
                      ? <span className="text-[11px] text-amber-700">—</span>
                      : `₹${lineAmount.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-muted/30 text-sm">
          <tr className="border-t">
            <td colSpan={6} className="px-3 py-2 text-right font-medium">
              Total
              <span className="text-xs text-muted-foreground ml-2">
                ({rows.length} added of {candidates.length} available)
              </span>
            </td>
            <td className="px-3 py-2 text-right tabular-nums font-semibold">
              ₹{grandTotal.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
              {anyAddedMissingRate && (
                <div className="text-[10px] text-amber-700 font-normal">
                  (some services have no rate configured — excluded from total)
                </div>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  );
}

/*
 * CustomerHistoryDialog — paginated list of every prior job booked
 * for the supplied customer_id. Renders inside its own Dialog so the
 * Book-New-Call form behind stays open + scrollable underneath.
 *
 * Data source: GET /admin/jobs?customerId=X&limit=100. Backend already
 * RBAC-scopes the result (manage_clients × manage_cities), so an
 * operator only sees jobs they're allowed to view even when the
 * customer's history spans clients outside their permission set.
 *
 * Row click opens the existing /jobs/{id} detail page in a NEW TAB so
 * the booking flow isn't lost. (We considered an inline drill-down,
 * but the JobModal is already mounted for the current booking — a
 * second JobModal on top would confuse the operator.)
 */
function CustomerHistoryDialog({
  open, onClose, customerId, customerName, mobile,
}: {
  open: boolean;
  onClose: () => void;
  customerId: number;
  customerName: string;
  mobile: string;
}) {
  const [rows, setRows] = useState<Job[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /*
   * Inline view-job state. When the operator clicks the Eye on a
   * history row we open ANOTHER JobModal stacked on top of the history
   * dialog (which itself is stacked on top of the Book-New-Call
   * modal). Native Radix Dialog z-index handles the stacking; closing
   * the view-modal returns the operator to the history list without
   * losing booking context.
   */
  const [viewJobId, setViewJobId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setErr(null); setRows(null);
    api.get<{ items: Job[]; total?: number }>('/admin/jobs', { customerId, limit: 100 })
      .then((resp) => { if (!cancelled) setRows(resp.items || []); })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : 'Failed to load history'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, customerId]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden flex flex-col p-0">
        <DialogHeader className="!mx-0 !mt-0 px-6 pt-6 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Job History
            <span className="text-sm font-normal text-muted-foreground">
              · {customerName || 'Customer'} · {mobile}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
          )}
          {err && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">{err}</div>
          )}
          {!loading && !err && rows && rows.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No prior jobs found for this customer.
            </div>
          )}
          {!loading && !err && rows && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm data-table">
                <thead>
                  <tr className="bg-muted/50 text-xs">
                    <th className="text-left px-3 py-2 font-medium">Job ID</th>
                    <th className="text-left px-3 py-2 font-medium">Requested</th>
                    <th className="text-left px-3 py-2 font-medium">Client</th>
                    <th className="text-left px-3 py-2 font-medium">Job Type</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">Easyfixer</th>
                    <th className="text-left px-3 py-2 font-medium">City</th>
                    <th className="text-left px-3 py-2 font-medium">Address</th>
                    <th className="text-left px-3 py-2 font-medium w-24"> </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((j) => (
                    <tr key={String(j.job_id)} className="border-t hover:bg-muted/40">
                      <td className="px-3 py-2 font-mono text-xs">#{String(j.job_id ?? '—')}</td>
                      <td className="px-3 py-2">{formatDate(j.requested_date_time as string | undefined)}</td>
                      <td className="px-3 py-2">{String(j.client_name ?? '—')}</td>
                      <td className="px-3 py-2">{String(j.job_type ?? '—')}</td>
                      <td className="px-3 py-2">
                        <StatusChip tone={statusTone(Number(j.job_status))}>
                          {statusLabel(Number(j.job_status), { assigned: j.fk_easyfixter_id != null })}
                        </StatusChip>
                      </td>
                      <td className="px-3 py-2">{String(j.easyfixer_name ?? '—')}</td>
                      <td className="px-3 py-2">{String(j.city_name ?? '—')}</td>
                      <td className="px-3 py-2 max-w-[280px] truncate" title={String(j.address ?? '')}>
                        {String(j.address ?? '—')}
                      </td>
                      <td className="px-3 py-2">
                        {/* Eye icon opens the job details in a stacked
                            JobModal (view mode) without leaving the
                            history list / booking flow. Replaces the
                            old "Open ↗" new-tab link per ops feedback —
                            operators want to peek a past job and come
                            back without losing booking context. */}
                        <button
                          type="button"
                          onClick={() => setViewJobId(Number(j.job_id))}
                          className="inline-flex items-center justify-center h-7 w-7 rounded border hover:bg-muted"
                          title="View job details"
                          aria-label="View job details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-xs text-muted-foreground mt-3 text-right">
                {rows.length} job{rows.length === 1 ? '' : 's'} · click the <Eye className="inline h-3 w-3 align-text-bottom" /> icon for full details.
              </div>
            </div>
          )}
        </div>
        {/* Plain <div> footer — DialogFooter's built-in `-mx-6 -mb-6`
            negative margins assume a p-6 DialogContent, but this
            dialog uses p-0 (inner sections own their padding), so
            the negatives would push the footer outside the modal
            box. Matches the EscalatedJobsModal pattern. */}
        <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
      {/* Stacked view-job modal — opens INSIDE the history dialog so
          closing it returns to the history list, not all the way out
          to the Book-New-Call flow. JobModal handles its own loader,
          status badge, and action bar in view mode. */}
      <JobModal
        open={viewJobId != null}
        mode="view"
        jobId={viewJobId ?? undefined}
        onClose={() => setViewJobId(null)}
      />
    </Dialog>
  );
}

// ─── Dialog helpers (Assign + Change Owner) ──────────────────────────────────

function AssignDialog({ open, onClose, currentTech, onSubmit }: {
  open: boolean; onClose: () => void; currentTech: number | null;
  onSubmit: (efrId: number) => Promise<void>;
}) {
  const lk = useLookup();
  const [efrId, setEfrId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = /^\d+$/.test(efrId) && Number(efrId) > 0;

  useEffect(() => { if (open) { setEfrId(''); setErr(null); } }, [open]);

  async function submit() {
    if (!valid) return;
    setLoading(true); setErr(null);
    try { await onSubmit(Number(efrId)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Assign failed'); }
    finally { setLoading(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose>
        <DialogHeader><DialogTitle>{currentTech ? 'Reassign Technician' : 'Assign Technician'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Label>Easyfixer</Label>
          {/*
            * Searchable dropdown over the full active-easyfixer list. Label is
            * "Name · Mobile · City" so any of those strings matches while the
            * user types. Underlying value is the numeric efr_id (what
            * /api/admin/jobs/:id/assign expects).
            */}
          <SearchSelect
            value={efrId}
            onChange={(v) => setEfrId(v)}
            options={lk.toOpts.easyfixers.map((o) => ({ value: o.value, label: String(o.label) }))}
            placeholder="— Select easyfixer —"
          />
          <p className="text-xs text-muted-foreground">
            Tip: to auto-pick the best-matched technician by distance, workload, rating and completion, use the Auto-assignment page.
          </p>
          {err && <div className="text-sm text-destructive">{err}</div>}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <LoadBtn onClick={submit} loading={loading} disabled={!valid}>{currentTech ? 'Reassign' : 'Assign'}</LoadBtn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Engine-ranked picker — fetches the top-10 technicians from the 3-layer
 * pipeline (zone eligibility → availability → weighted score) in REAL TIME
 * each time the dialog opens, so reassigns reflect the latest workload /
 * rating / completion stats. Used for both initial assign and reassign:
 * the title + button copy adapts via `currentTech`.
 *
 * Each row has its own "Pick" button — ops can take the recommendation OR
 * any other ranked technician, with one click. The fallback "Manual pick"
 * button on the parent toolbar still opens the searchable full-list picker
 * for the rare cases when ops want someone outside the engine's view.
 */
type AutoCandidate = {
  efr_id: number; efr_name: string; efr_no: string;
  active_jobs: number; avg_rating: number;
  completion_ratio: number; score: number;
};
type CandidatesResp = {
  l1Count: number; rejectedCount: number;
  candidates: AutoCandidate[];
  notes?: string[];
};

function AutoAssignDialog({ open, onClose, jobId, currentTech, onAssigned }: {
  open: boolean; onClose: () => void; jobId: number;
  currentTech: number | null; onAssigned: () => void;
}) {
  const [data, setData] = useState<CandidatesResp | null>(null);
  const [loading, setLoading] = useState(false);
  // `picking` tracks per-row in-flight assigns so each row's button can show its
  // own spinner without disabling the entire dialog. `null` = nothing in flight.
  const [picking, setPicking] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setData(null); setErr(null); setPicking(null); return; }
    (async () => {
      setLoading(true); setErr(null);
      try { setData(await api.get<CandidatesResp>(`/admin/auto-assign/${jobId}/candidates`, { limit: 10 })); }
      catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to fetch technicians'); }
      finally { setLoading(false); }
    })();
  }, [open, jobId]);

  async function pick(efrId: number) {
    setPicking(efrId); setErr(null);
    try {
      // Use the same manual-assign endpoint that the dropdown picker uses —
      // it handles status bump, scheduling_history, webhook + FCM identically
      // whether the choice was engine-ranked or hand-picked.
      await api.patch(`/admin/jobs/${jobId}/assign`, { easyfixerId: efrId });
      onAssigned();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Assignment failed');
    } finally { setPicking(null); }
  }

  const isReassign = !!currentTech;
  const top = data?.candidates?.[0];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isReassign ? 'Reassign — Suggested Technicians' : 'Auto-assign — Suggested Technicians'}</DialogTitle>
          <DialogDescription>
            Top 10 technicians ranked by the engine in real time: zone eligibility → availability → composite score
            (workload + rating + completion). Pick any row, or use <em>Manual pick</em> from the toolbar to
            search the full list.
          </DialogDescription>
        </DialogHeader>

        {loading && <div className="text-sm text-muted-foreground py-6 text-center">Scoring technicians…</div>}
        {err && <div className="text-sm text-destructive">{err}</div>}

        {data && !loading && data.candidates.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center space-y-2">
            <div>
              No eligible technicians (L1 eligible: <strong>{data.l1Count ?? 0}</strong>, L2 rejected:{' '}
              <strong>{data.rejectedCount ?? 0}</strong>).
            </div>
            {data.notes?.length ? <div className="text-xs">{data.notes.join(' · ')}</div> : null}
            <div>Use <em>Manual pick</em> from the toolbar to assign anyone outside the engine&apos;s view.</div>
          </div>
        )}

        {data && !loading && data.candidates.length > 0 && (
          <div className="space-y-3">
            <div className="rounded-lg border p-3 bg-emerald-50/50">
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs uppercase tracking-wider text-emerald-700 font-semibold">Recommended</div>
                <div className="flex items-center gap-3">
                  <div className="text-xs text-muted-foreground">Match score: {top!.score}</div>
                  <LoadBtn size="sm" onClick={() => pick(top!.efr_id)} loading={picking === top!.efr_id} disabled={picking !== null}>
                    {isReassign ? 'Reassign to this tech' : 'Assign to this tech'}
                  </LoadBtn>
                </div>
              </div>
              <div className="font-medium">{top!.efr_name} · {top!.efr_no}</div>
              <div className="mt-1 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>{top!.active_jobs} active jobs</span>
                <span>★ {Number(top!.avg_rating).toFixed(1)} avg rating</span>
                <span>{(top!.completion_ratio * 100).toFixed(0)}% completion</span>
              </div>
            </div>

            {data.candidates.length > 1 && (
              <details className="text-sm" open>
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
                  Other technicians ({data.candidates.length - 1})
                </summary>
                <table className="data-table mt-2">
                  <thead>
                    <tr>
                      <th>#</th><th>Name</th><th>Mobile</th>
                      <th>Active</th><th>Rating</th><th>Completion</th><th>Score</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.slice(1).map((c, i) => (
                      <tr key={c.efr_id}>
                        <td className="text-xs text-muted-foreground">{i + 2}</td>
                        <td>{c.efr_name}</td>
                        <td className="text-xs text-muted-foreground">{c.efr_no}</td>
                        <td className="text-xs">{c.active_jobs}</td>
                        <td className="text-xs">{Number(c.avg_rating).toFixed(1)}</td>
                        <td className="text-xs">{(c.completion_ratio * 100).toFixed(0)}%</td>
                        <td className="font-medium">{c.score}</td>
                        <td>
                          <LoadBtn size="sm" variant="outline"
                            onClick={() => pick(c.efr_id)}
                            loading={picking === c.efr_id}
                            disabled={picking !== null}>
                            Pick
                          </LoadBtn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            <div className="text-xs text-muted-foreground">
              L1 eligible: {data.l1Count} · L2 rejected: {data.rejectedCount}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChangeOwnerDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void;
  onSubmit: (newOwnerId: number, reason: string) => Promise<void>;
}) {
  const lk = useLookup();
  const [newOwnerId, setNewOwnerId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = /^\d+$/.test(newOwnerId) && Number(newOwnerId) > 0 && reason.trim().length >= 3;

  useEffect(() => { if (open) { setNewOwnerId(''); setReason(''); setErr(null); } }, [open]);

  async function submit() {
    if (!valid) return;
    setLoading(true); setErr(null);
    try { await onSubmit(Number(newOwnerId), reason.trim()); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Change owner failed'); }
    finally { setLoading(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose>
        <DialogHeader><DialogTitle>Change Job Owner</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>New Staff Owner</Label>
            {/* Searchable dropdown over admin-group users (Name · Role label).
                Ensures the user picks a real staff ID instead of typing a wrong
                number — previously a typo'd ID silently 404'd on the backend. */}
            <SearchSelect
              value={newOwnerId}
              onChange={(v) => setNewOwnerId(v)}
              options={lk.toOpts.adminUsers.map((o) => ({ value: o.value, label: String(o.label) }))}
              placeholder="— Select staff —"
            />
          </div>
          <div>
            <Label>Reason (at least 3 characters)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the owner changing?" />
          </div>
          {err && <div className="text-sm text-destructive">{err}</div>}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <LoadBtn onClick={submit} loading={loading} disabled={!valid}>Update</LoadBtn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tiny presentational helpers ─────────────────────────────────────────────

/*
 * Today's local date-time in the "YYYY-MM-DDTHH:MM" format an
 * <input type="datetime-local" min=…> expects. Using toISOString() would give
 * UTC and the picker would show a future time as "already past" for anyone in
 * IST (UTC+5:30). We format from the local Date directly.
 */
function nowLocalIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toFormShape(j: Job | null) {
  const pick = (k: string) => (j?.[k] == null ? '' : String(j[k]));
  const dt = (k: string) => {
    const v = j?.[k]; if (!v) return '';
    try {
      const d = new Date(String(v)); if (isNaN(+d)) return '';
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  };

  // Bulk-upload sentinel: when the row arrived from an Excel upload
  // (source_type='excel') AND the time portion is exactly 00:00, the
  // operator did NOT pick a time on the spreadsheet — the parser
  // defaulted to midnight as a "needs ops to pick" marker. Blank both
  // `requested_date_time` and `time_slot` so the Confirm form's
  // Section 2 gate forces an explicit choice before unlocking.
  // The original upload date is still surfaced as a hint in the
  // Confirm form via `upload_date_hint` below.
  const isBulkSentinel = (() => {
    const src = String(j?.source_type ?? '').toLowerCase();
    if (src !== 'excel') return false;
    const v = j?.requested_date_time;
    if (!v) return false;
    const d = new Date(String(v));
    return !isNaN(+d) && d.getHours() === 0 && d.getMinutes() === 0;
  })();
  const uploadDateHint = isBulkSentinel
    ? (() => {
        const d = new Date(String(j?.requested_date_time));
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      })()
    : '';

  return {
    fk_client_id: pick('fk_client_id'),
    // job_type seed rules (2026-06-03, second pass per ops):
    //   • Fresh create (j === null = Book New Call) → 'Installation' default.
    //   • Seeded form (Edit / Confirm) → use the job's value ONLY when
    //     the job has at least one active service row. Otherwise the
    //     stamp is the BE's create-time default and the Confirm modal
    //     should show an empty Job Type multi-select so the operator
    //     picks intentionally (mirrors the same "no services → no
    //     preselection" rule we apply to Service Categories below).
    job_type: (() => {
      if (!j) return 'Installation';
      const hasAnyService = Array.isArray((j as Record<string, unknown>).services)
        && ((j as { services?: unknown[] }).services?.length ?? 0) > 0;
      return hasAnyService ? pick('job_type') : '';
    })(),
    // source_type default: 'CRM - New' so newly-created jobs are
    // attributed to the new-CRM origin. Was 'manual' before — that
    // value is truthy so the submit-time `f.source_type || 'CRM - New'`
    // fallback never fired and the BE persisted 'manual' for every new
    // booking, masking new-CRM traffic in reports. For seeded forms
    // (Edit / Confirm) pick('source_type') returns the row's existing
    // value (e.g. 'CRM - Bulk' from a bulk upload) so the default
    // only matters for fresh Book New Call.
    source_type: pick('source_type') || 'CRM - New',
    requested_date_time: isBulkSentinel ? '' : dt('requested_date_time'),
    time_slot: isBulkSentinel ? '' : (pick('time_slot') || 'Morning 9 to 2'),
    upload_date_hint: uploadDateHint,
    job_desc: pick('job_desc'),
    client_ref_id: pick('client_ref_id'),
    // Prefer the job-row copy `job_customer_name` when present (set by
    // the bulk-upload flow + any prior Confirm-mode edit) so the
    // operator sees the order's specific name. Fall back to the master
    // tbl_customer.customer_name when the job-row copy is blank — the
    // typical case for jobs created directly via Book New Call.
    customer_name: pick('job_customer_name') || pick('customer_name'),
    customer_mob_no: pick('customer_mob_no'), customer_email: pick('customer_email'),
    // Alternate customer contact — stored on tbl_job.additional_name /
    // .additional_number. Captured at Book Call time so the technician
    // can reach a fallback person if the primary is unreachable.
    additional_name: pick('additional_name'),
    additional_number: pick('additional_number'),
    // Split form fields for the Section 2 Schedule sub-block.
    // `requested_date_time` (ISO) is what the backend ultimately
    // consumes; we maintain it via a useEffect when either of these
    // two changes.
    requested_date: '',
    requested_time: '',
    address: pick('address'), building: pick('building'), landmark: pick('landmark'),
    city_id: pick('city_id'), pin_code: pick('pin_code'), gps_location: pick('gps_location'),
    address_instruction: pick('address_instruction'),
    // Client SPOC + Reporting Contact — section 1 dynamic fields.
    // Auto-filled from tbl_client_contacts when the operator picks
    // a Reporting Contact in the create-flow modal (pickReportingContact).
    reporting_contact_id: pick('reporting_contact_id'),
    client_spoc_name: pick('client_spoc_name'),
    client_spoc: pick('client_spoc'),
    client_spoc_email: pick('client_spoc_email'),
    // Legacy Book-New-Call fields.
    // branch_details — dedicated tbl_job column (verified).
    // product_code + building_name — folded into `remarks` with
    // named prefixes by composeRemarks() until columns are verified.
    branch_details: pick('branch_details'),
    product_code: pick('product_code'),
    building_name: pick('building_name'),
    // Questionnaire FK — picker visible after a client is selected.
    c_questionaire_id: pick('c_questionaire_id'),
    // Section-3 / Products metadata — matches legacy addEditJob fields.
    remarks: pick('remarks'),
    efr_special_notes: pick('efr_special_notes'),
    helper_req: Boolean(j?.helper_req),
    material_req: Boolean(j?.material_req),
    // Stored as an INTEGER enum (1/2/3) on tbl_job — map back to the label the
    // Collected By dropdown options use, else the saved value shows blank.
    collected_by: collectedByLabel(pick('collected_by')) || 'Easyfix',
    fk_service_catg_id: pick('fk_service_catg_id'),
    // CSV of category IDs. In CREATE flow, multi-pick fans out into
    // N jobs at submit. In EDIT/CONFIRM flow, seed from the row's
    // existing single category ONLY when the job actually has at
    // least one attached service — otherwise the Confirm modal's
    // multi-selects would render "1 categories selected" + "1 types
    // selected" purely from the job's default fk_service_catg_id /
    // fk_service_type_id stamps (which the BE sets at create time
    // even for Unconfirmed orders with no service rows yet).
    //
    // 2026-06-03 per ops: a freshly-opened Confirm & Schedule modal
    // for an Unconfirmed order with no `tbl_job_services` rows must
    // show empty pickers so the operator picks intentionally rather
    // than committing whatever default the row inherited.
    fk_service_catg_ids: (() => {
      const hasAnyService = Array.isArray((j as Record<string, unknown> | null)?.services)
        && ((j as { services?: unknown[] } | null)?.services?.length ?? 0) > 0;
      const v = pick('fk_service_catg_id');
      return hasAnyService && v ? String(v) : '';
    })(),
    fk_service_type_id: pick('fk_service_type_id'),
    // Multi-select used in the create flow's "Select Products" section AND
    // re-hydrated on EDIT/CONFIRM reload so a saved draft's Service Type(s)
    // reappear (previously hardcoded [] → the picker always looked empty,
    // the "Service Type not saved" symptom). Gated on the job actually
    // having active service rows — same rule as fk_service_catg_ids above —
    // so a fresh Unconfirmed order with no services still shows empty pickers.
    // Prefer the stored tbl_job.service_type_ids CSV; fall back to deriving
    // from the active service rows. Create mode (j === null) stays [].
    fk_service_type_ids: (() => {
      if (!j) return [] as string[];
      const svcs = (j as { services?: Array<Record<string, unknown>> }).services;
      const active = Array.isArray(svcs)
        ? svcs.filter((s) => Number(s.job_service_status) === 1)
        : [];
      if (active.length === 0) return [] as string[];
      const csv = String((j as Record<string, unknown>).service_type_ids ?? '').trim();
      const ids = csv
        ? csv.split(',').map((s) => s.trim()).filter(Boolean)
        : active.map((s) => String(s.service_type_id ?? '').trim()).filter(Boolean);
      return Array.from(new Set(ids));
    })(),
  };
}

/*
 * Working-hour slot bands (matching legacy EasyFix_CRM Booking Time Slot UI):
 *   9 AM – 12 PM  →  in-window
 *   12 PM – 3 PM  →  in-window
 *   3 PM – 7 PM   →  in-window
 *   After Hours   →  escape hatch for out-of-band times (early mornings,
 *                    late evenings) — ops picks this manually when the
 *                    customer can only accept a visit outside 9–19.
 *
 * The time picker enforces no date limit but the chosen slot is auto-inferred
 * from the hour field; out-of-band hours fall into "After Hours".
 */
export const SLOTS = [
  { value: '9 AM – 12 PM', label: '9 AM – 12 PM', fromH: 9,  toH: 12 },
  { value: '12 PM – 3 PM', label: '12 PM – 3 PM', fromH: 12, toH: 15 },
  { value: '3 PM – 7 PM',  label: '3 PM – 7 PM',  fromH: 15, toH: 19 },
  { value: 'After Hours',  label: 'After Hours',  fromH: -1, toH: -1 },
] as const;

export function inferSlotFromTime(dtLocal: string): string | null {
  if (!dtLocal) return null;
  const m = dtLocal.match(/T(\d{2}):/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h >= 9 && h < 12)  return '9 AM – 12 PM';
  if (h >= 12 && h < 15) return '12 PM – 3 PM';
  if (h >= 15 && h < 19) return '3 PM – 7 PM';
  return 'After Hours';
}

/*
 * Return {min, max} strings for an <input type="datetime-local"> so the
 * picker physically can't land outside working hours on any given day.
 * `min` is today 09:00 (no back-dated bookings) unless the job is already
 * dated further in the future — in that case use the stored date.
 */
export function slotBoundsForPicker(currentIso: string): { min: string; max: string } {
  const now = new Date();
  const baseDate = currentIso ? currentIso.slice(0, 10) : `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const minDate = now > new Date(`${baseDate}T09:00`) ? now : new Date(`${baseDate}T09:00`);
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // `max` stays 30 days out at 18:59 as a soft ceiling. The inner day-picker
  // still accepts whichever date the user clicks; the real slot enforcement is
  // in inferSlotFromTime which blocks out-of-range hours at submit time.
  const max = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  max.setHours(18, 59, 0, 0);
  return { min: fmt(minDate), max: fmt(max) };
}

/*
 * Section — collapsible accordion section for the Create-job form.
 *
 * Behaviour:
 *   - `expanded` (controlled) — when set by the parent, drives open/closed
 *     state. The parent enforces the legacy "1 open at a time" rule.
 *   - `onToggle` — fired on header click. Disabled clicks if `disabled`.
 *   - `disabled` — header click is suppressed (used when prior section's
 *     mandatory fields aren't filled yet — matches legacy addEditJob's
 *     "Next button" gating).
 *   - Falls back to a non-collapsible block when neither `expanded` nor
 *     `onToggle` is supplied — preserves the existing Confirm/Edit
 *     mode layout that wasn't accordion-shaped.
 */
/*
 * Scroll the given section element so its HEADER pins to the TOP of the modal's
 * scroll container. Walks up to the nearest scrollable ancestor and sets an
 * ABSOLUTE scrollTop (delta from current) — idempotent and immune to the layout
 * shift from the previously-open section collapsing above it. A plain
 * scrollIntoView({block:'start'}) fights browser scroll-anchoring and clamps a
 * trailing section to max scrollTop, landing it low. Moves no focus.
 */
function scrollSectionToTop(sectionEl: HTMLElement | null) {
  if (!sectionEl) return;
  let sc: HTMLElement | null = sectionEl.parentElement;
  while (sc) {
    const oy = getComputedStyle(sc).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && sc.scrollHeight > sc.clientHeight) break;
    sc = sc.parentElement;
  }
  if (!sc) return;
  const delta = sectionEl.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  sc.scrollTo({ top: sc.scrollTop + delta, behavior: 'smooth' });
}

function Section({
  title,
  children,
  expanded,
  onToggle,
  disabled,
  badge,
  sectionRef,
}: {
  title: string;
  children: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  badge?: React.ReactNode;
  // Optional scroll target — lets a caller scroll this section's <section>
  // element into view (Book New Call scrolls to "3. Select Products" when the
  // operator advances). Unused by every other Section usage.
  sectionRef?: React.Ref<HTMLElement>;
}) {
  const collapsible = onToggle !== undefined;
  const isOpen = !collapsible || expanded;
  return (
    <section ref={sectionRef} className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => { if (collapsible && !disabled) onToggle?.(); }}
        className={`w-full px-5 py-3 border-b bg-muted/30 flex items-center justify-between gap-3 text-left ${collapsible && !disabled ? 'hover:bg-muted/50 cursor-pointer' : ''} ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        disabled={!collapsible || disabled}
        aria-expanded={isOpen}
      >
        <h3 className="text-sm font-semibold flex items-center gap-2">
          {title}
          {badge}
        </h3>
        {collapsible && (
          <span className="text-muted-foreground text-xs">
            {isOpen ? '▲' : '▼'}
          </span>
        )}
      </button>
      {isOpen && <div className="p-5">{children}</div>}
    </section>
  );
}

/*
 * Numbered section — matches the legacy addEditJob modal's "1 Client Details,
 * 2 Customer Details, 3 Select Products" layout. The leading badge gives ops
 * a familiar visual anchor when confirming unconfirmed orders.
 */
/*
 * JobOutcomeDialog — the "Job Unreachable" / "Job Enquiry" confirm
 * popup from the legacy CRM. Both modes share the same shape:
 *   - "Pending Due To" / "Open Due To" radio (Customer / Client /
 *     EasyFix / Technician)
 *   - Reason dropdown (fetched live from BE)
 *   - Remarks textarea
 *   - Submit / Cancel
 *
 * Reasons are sourced from `GET /admin/jobs/action-reasons?type=…`
 * which reads `action_taken_reason` joined to `action_type` (confirmed
 * by ops 2026-05-18). Falls back to an empty list if the endpoint
 * errors so the popup remains operable.
 *
 * The component is fully controlled — open/close + submit-payload
 * shape stays in the parent's hands. On Submit, parent gets
 * `{ dueTo, reason, remarks }` and decides what to do with it.
 */
const DUE_TO_OPTIONS: Array<'Customer' | 'Client' | 'EasyFix' | 'Technician'> = [
  'Customer',
  'Client',
  'EasyFix',
  'Technician',
];

function JobOutcomeDialog({
  open,
  mode,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'unreachable' | 'enquiry';
  onClose: () => void;
  // `reasonId` exposed so the parent can persist the canonical
  // action_taken_reason.id into tbl_job.enquiry_reason_id / cancel_reason_id
  // (the BE setStatus stamp path). Falls back to `null` when the picked
  // label couldn't be matched back to an id (defensive — shouldn't
  // happen with the controlled dropdown but keeps the contract safe).
  onSubmit: (payload: { dueTo: string; reason: string; reasonId: number | null; remarks: string }) => void;
}) {
  const [dueTo, setDueTo] = useState<string>('Customer');
  const [reason, setReason] = useState<string>('');
  const [remarks, setRemarks] = useState<string>('');
  // BE-sourced reasons (action_taken_reason joined to action_type).
  const [reasons, setReasons] = useState<Array<{ id: number | null; label: string }>>([]);
  const [reasonsLoading, setReasonsLoading] = useState(false);

  // Reset fields whenever the dialog opens / mode flips.
  useEffect(() => {
    if (open) {
      setDueTo('Customer');
      setReason('');
      setRemarks('');
    }
  }, [open, mode]);

  // Fetch reasons for the active mode + selected "Due To" radio.
  // Refetches whenever the dialog opens, the mode flips, OR the
  // operator switches the radio — the BE narrows the list to
  // (action_type = 25 for Unreachable / 24 for Enquiry) AND
  // (user_type = the radio's mapped int — Customer=1, Client=2,
  // EasyFix=3, Technician=4). Mirrors the AddRemarksDialog refetch
  // pattern. Also resets the picked reason when dueTo changes so
  // a stale label from the previous bucket doesn't render as an
  // opaque value in the dropdown.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReasonsLoading(true);
    setReason('');
    // Module-level 60s cache (see fetchReasonsCached above) means
    // switching radios back to a previously-picked bucket within the
    // minute is instant — no BE round-trip.
    fetchReasonsCached('/admin/jobs/action-reasons', {
      type: mode,
      dueTo: dueTo.toLowerCase(),
    })
      .then((rows) => { if (!cancelled) setReasons(rows); })
      .finally(() => { if (!cancelled) setReasonsLoading(false); });
    return () => { cancelled = true; };
  }, [open, mode, dueTo]);

  const title = mode === 'unreachable' ? 'Job Unreachable' : 'Job Enquiry';
  const dueLabel = mode === 'unreachable' ? 'Pending Due To' : 'Open Due To';
  const reasonLabel = mode === 'unreachable' ? 'Unreachable Reason' : 'Enquiry Reason';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason || !remarks.trim()) return; // required-field guard
    // Re-resolve the picked label back to its id. Dialog state stores
    // the label as the SearchSelect value (legacy storage shape for
    // tbl_job.remarks prefix), so the lookup here is just for the
    // structured persistence path on the parent.
    const matched = reasons.find((r) => r.label === reason);
    onSubmit({
      dueTo,
      reason,
      reasonId: matched ? Number(matched.id) || null : null,
      remarks: remarks.trim(),
    });
  }

  // SearchSelect needs unique string values; reasons are sourced by label
  // (since FE persists the label into `tbl_job.remarks` as a structured
  // prefix — id is not needed downstream). Dedupe by label so duplicate
  // free-text entries from `action_taken_reason` don't trigger React's
  // duplicate-key warning.
  const reasonOptions = React.useMemo(
    () => reasons.map((r) => ({ value: r.label, label: r.label })),
    [reasons],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="!max-w-xl p-0 gap-0 overflow-hidden">
        {/* Dark-slate gradient header band with sky accent underline —
            matches the global modal-header look. Plain <div> wrapper
            (NOT DialogHeader) because DialogHeader's `-mx-6 -mt-6`
            assumes the parent has p-6 padding, but we use `!p-0` to
            let the band sit edge-to-edge. DialogTitle alone satisfies
            Radix's a11y check. */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900 text-white flex items-center gap-2.5 shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-sky-500/20 ring-1 ring-sky-400/40">
            <Pencil className="h-3.5 w-3.5 text-sky-300" />
          </span>
          <DialogTitle className="text-[15px] font-semibold tracking-tight">{title}</DialogTitle>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-[150px_1fr] items-center gap-3">
            <label className="text-sm font-medium text-right">
              {dueLabel}<span className="text-rose-600">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-4">
              {DUE_TO_OPTIONS.map((opt) => (
                <label key={opt} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="due-to"
                    value={opt}
                    checked={dueTo === opt}
                    onChange={() => setDueTo(opt)}
                    className="accent-purple-600"
                  />
                  {opt === 'Customer' ? 'By Customer' : opt}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[150px_1fr] items-center gap-3">
            <label className="text-sm font-medium text-right">
              {reasonLabel}<span className="text-rose-600">*</span>
            </label>
            <SearchSelect
              value={reason}
              onChange={setReason}
              options={reasonOptions}
              placeholder={reasonsLoading ? 'Loading reasons…' : `Select ${reasonLabel}`}
              disabled={reasonsLoading}
              required
            />
          </div>
          <div className="grid grid-cols-[150px_1fr] items-start gap-3">
            <label className="text-sm font-medium text-right pt-2">
              Remarks<span className="text-rose-600">*</span>
            </label>
            <textarea
              required
              rows={3}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Write Comment…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40 resize-y"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button
              type="submit"
              className="bg-teal-500 hover:bg-teal-600 text-white"
              disabled={!reason || !remarks.trim()}
            >
              Submit
            </Button>
            <Button
              type="button"
              variant="outline"
              className="bg-rose-500 hover:bg-rose-600 text-white border-rose-500 hover:text-white"
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NumberedSection({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 px-5 py-3 border-b bg-sky-700 text-white rounded-t-lg">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-sky-800 text-sm font-semibold">{num}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`space-y-1.5 ${full ? 'md:col-span-full' : ''}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// ─── Reschedule dialog ──────────────────────────────────────────────
// The local inline RescheduleDialog (generic PATCH /:id, no offer-expiry /
// scheduling_history) was removed 2026-07-13. ActionBar now reschedules
// through the AUDITED RescheduleDialog.tsx (imported as ApptRescheduleDialog
// near the top of this file) → PATCH /admin/jobs/:id/reschedule.

// ─── Change Description dialog ──────────────────────────────────────
// Legacy `changeJobDesc.vm`. PATCH /admin/jobs/:id { job_desc }.
function ChangeDescriptionDialog({ open, onClose, initialDesc, onSubmit }: {
  open: boolean; onClose: () => void;
  initialDesc: string;
  onSubmit: (desc: string) => Promise<void>;
}) {
  const [desc, setDesc] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setDesc(initialDesc); setErr(null); }
  }, [open, initialDesc]);
  async function go() {
    setLoading(true); setErr(null);
    try { await onSubmit(desc.trim()); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Save failed'); }
    finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Job Description</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[140px]"
            placeholder="Describe the work to be done…"
            maxLength={2000}
          />
          <div className="text-[10px] text-muted-foreground text-right">{desc.length} / 2000</div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={loading} />
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/*
 * AddRemarksDialog + the shared reason-dropdown cache (fetchReasonsCached)
 * were extracted to ./AddRemarksDialog and ./jobActionReasons on 2026-06-22
 * so the Schedule & Assign modal can reuse the same dialog. AddRemarksDialog
 * is imported at the top of this file; JobOutcomeDialog imports
 * fetchReasonsCached directly from ./jobActionReasons.
 */

// ─── Cancel With Reason dialog ──────────────────────────────────────
// Extracted to ./CancelWithReasonDialog on 2026-06-22 so the Schedule &
// Assign modal can reuse it. Imported at the top of this file.

// ─── Feedback dialog ────────────────────────────────────────────────
// Legacy `feedback.vm`. Backend GET/PUT /admin/jobs/:id/feedback writes
// to tbl_customer_feedback. Upserts a single row per job (job_id is the
// natural key).
//
// VERIFIED schema 2026-05-12 against legacy tbl_customer_feedback:
//   easyfixer_rating  → handyman/technician rating (1–5)
//   easyfix_rating    → overall EasyFix-service rating (1–5)
//   happy_with_service→ tinyint 0/1 — "was the customer happy?"
//
// `customer_rating` lives in a separate table (tbl_easyfixer_rating_by_customer)
// and is NOT writable here. Earlier UI assumed `overall_rating`,
// `feedback_text`, `customer_name` columns — they DO NOT EXIST.
type FeedbackData = {
  id?: number;
  job_id?: number;
  easyfixer_rating?: number | null;
  easyfix_rating?: number | null;
  happy_with_service?: number | null;
};

function FeedbackDialog({ open, onClose, jobId, onSaved }: {
  open: boolean; onClose: () => void; jobId: number; onSaved: () => void;
}) {
  const [efrRating, setEfrRating] = useState('');
  const [efxRating, setEfxRating] = useState('');
  const [happy, setHappy] = useState<'' | '0' | '1'>('');
  const [loading, setLoading] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setLoadingExisting(true);
    (async () => {
      try {
        const data = await api.get<FeedbackData | null>(`/admin/jobs/${jobId}/feedback`);
        setEfrRating(data?.easyfixer_rating != null ? String(data.easyfixer_rating) : '');
        setEfxRating(data?.easyfix_rating != null ? String(data.easyfix_rating) : '');
        setHappy(
          data?.happy_with_service === 1 ? '1' :
          data?.happy_with_service === 0 ? '0' : ''
        );
      } catch {
        setEfrRating(''); setEfxRating(''); setHappy('');
      } finally {
        setLoadingExisting(false);
      }
    })();
  }, [open, jobId]);

  async function go() {
    const er = efrRating ? Number(efrRating) : undefined;
    const ex = efxRating ? Number(efxRating) : undefined;
    if (er != null && (er < 1 || er > 5)) { setErr('Easyfixer rating must be 1–5'); return; }
    if (ex != null && (ex < 1 || ex > 5)) { setErr('EasyFix service rating must be 1–5'); return; }
    if (er == null && ex == null && happy === '') {
      setErr('Enter at least one feedback field'); return;
    }
    setLoading(true); setErr(null);
    try {
      await api.put(`/admin/jobs/${jobId}/feedback`, {
        easyfixerRating: er,
        easyfixRating: ex,
        happyWithService: happy === '' ? undefined : Number(happy),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setLoading(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Customer Feedback</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {loadingExisting && <div className="text-xs text-muted-foreground">Loading existing feedback…</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-sm font-medium block mb-1">Easyfixer Rating (1–5)</Label>
              <Input
                type="number" min={1} max={5}
                value={efrRating}
                onChange={(e) => setEfrRating(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">Rates the technician.</p>
            </div>
            <div>
              <Label className="text-sm font-medium block mb-1">EasyFix Service Rating (1–5)</Label>
              <Input
                type="number" min={1} max={5}
                value={efxRating}
                onChange={(e) => setEfxRating(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">Rates overall EasyFix experience.</p>
            </div>
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Happy with Service?</Label>
            <select
              value={happy}
              onChange={(e) => setHappy(e.target.value as '' | '0' | '1')}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value="">—</option>
              <option value="1">Yes</option>
              <option value="0">No</option>
            </select>
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={loading} />
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : 'Save Feedback'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoadBtn({ loading, children, ...rest }: React.ComponentProps<typeof Button> & { loading?: boolean }) {
  return (
    <Button {...rest} disabled={rest.disabled || loading}>
      {loading ? <span className="inline-flex items-center gap-2"><Spinner /> Working…</span> : children}
    </Button>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

/*
 * Reached-location technician selfie — "proof of arrival". tbl_job.tx_selfie_id
 * is an int FK to document.id; GET /admin/jobs/:id/selfie-url resolves it to a
 * short-TTL presigned S3 URL (public — a plain <img src> loads it, same as the
 * deep-skill image-url pattern; no auth header / blob needed). Gated on the
 * tx_selfie_id the job detail already carries, so the resolver is hit ONLY when a
 * selfie exists; renders nothing otherwise (older jobs, no reached step).
 */
function TechnicianSelfieTile({ jobId, selfieId }: { jobId: number; selfieId: unknown }) {
  const has = selfieId != null && selfieId !== '' && Number(selfieId) > 0;
  const { data, loading, error } = useFetch<{ url: string | null }>(
    has ? `/admin/jobs/${jobId}/selfie-url` : null,
  );
  if (!has) return null;
  // Resolved but no image (unresolvable doc row, or S3 disabled in local/QA where
  // the resolver returns url=null) → hide entirely, per the endpoint's documented
  // "render the tile unconditionally and hide it on null" contract. Otherwise every
  // reached job in a non-S3 environment would show an empty selfie card. Loading and
  // genuine-error states still render (an error means a selfie exists but failed).
  const url = data?.url ?? null;
  if (!loading && !error && !url) return null;
  return (
    <div className="rounded-lg border bg-card mt-5 max-w-md">
      <div className="px-5 py-3 border-b bg-muted/30"><h3 className="text-sm font-semibold">Technician Selfie</h3></div>
      <div className="p-5">
        <p className="text-xs text-muted-foreground mb-3">Reached-location proof of arrival</p>
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="text-xs text-destructive">Could not load selfie</div>
        ) : url ? (
          <img
            src={url}
            alt="Technician arrival selfie"
            className="rounded-md border max-h-64 object-contain"
          />
        ) : null}
      </div>
    </div>
  );
}

function DlCard({ title, rows }: { title: string; rows: [string, unknown][] }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-5 py-3 border-b bg-muted/30"><h3 className="text-sm font-semibold">{title}</h3></div>
      <div className="p-5">
        <dl className="text-sm space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b last:border-0 pb-1.5 last:pb-0">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium text-right break-all max-w-[60%]">
                {renderDlValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/*
 * Render helper for DlCard values. The legacy implementation always
 * called String(v) which collapses React elements to "[object Object]".
 * Three cases now:
 *   1. null / undefined / empty string → em-dash placeholder.
 *   2. React element (object with $$typeof) → render verbatim so
 *      composite cells like <CallableMobile/> work.
 *   3. Everything else (primitives) → String() it.
 */
function renderDlValue(v: unknown): React.ReactNode {
  if (v == null || v === '') return '—';
  if (typeof v === 'object' && v !== null && '$$typeof' in (v as Record<string, unknown>)) {
    return v as React.ReactElement;
  }
  return String(v);
}
