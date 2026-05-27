'use client';

import * as React from 'react';
import { useEffect, useMemo, useState, Fragment } from 'react';
import { useFetch } from '@/lib/hooks';
import { Sparkles, Search, CalendarCheck, History, Eye, Plus, X, Pencil, CalendarPlus, CheckCircle2, BarChart3, Trash2, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Switch } from '@/components/ui/switch';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { AddressPickerWithMap, type AddressValue } from '@/components/ui/address-picker-with-map';
import { AddressEditDialog, type EditableAddress } from './AddressEditDialog';
import { JobTransactionView } from './JobTransactionView';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName, statusColorClass, statusLabel } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { CallableMobile } from '@/components/calls/CallButton';
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

const ST = { BOOKED: 0, SCHEDULED: 1, IN_PROGRESS: 2, COMPLETED: 3, COMPLETED_ALT: 5, CANCELLED: 6, ENQUIRY: 7, CALL_LATER: 9, REVISIT: 10 } as const;

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
};

export function JobModal({
  open, onClose, mode: initialMode, jobId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: JobModalMode;
  jobId?: number;
  onSaved?: () => void;
}) {
  const [mode, setMode] = useState<JobModalMode>(initialMode);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Add-Remarks popup for the Unconfirmed view-mode footer. Lives at
  // the modal root so it can dismiss without unmounting JobForm/View.
  const [addRemarksOpen, setAddRemarksOpen] = useState(false);
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
  const title = mode === 'create'  ? 'Book New Call'
             : mode === 'edit'    ? `Edit Job #${jobId}`
             : mode === 'confirm' ? `Confirm & Schedule · Job #${jobId}`
             : job                ? `Job #${job.job_id}`
             :                       'Job';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
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
                {mode === 'create'  ? <CalendarPlus className="h-4 w-4 text-sky-300" />
                 : mode === 'edit'  ? <Pencil className="h-4 w-4 text-sky-300" />
                 : mode === 'confirm' ? <CheckCircle2 className="h-4 w-4 text-sky-300" />
                 : <Eye className="h-4 w-4 text-sky-300" />}
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate">{title}</DialogTitle>
                {/* Status badge + job-type sub-line only show once we have
                    the fresh `job` payload — gated on `!loading` so the
                    previous job's badge can't flash on re-open. */}
                {mode === 'view' && !loading && job && (
                  <DialogDescription className="mt-1 flex items-center gap-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(Number(job.job_status))}`}>
                      {statusLabel(Number(job.job_status), { assigned: job.fk_easyfixter_id != null })}
                    </span>
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
          {!loading && mode === 'view' && job && (
            // Unconfirmed (status=9) gets the legacy "Job Transaction"
            // single-page read-only layout — no tabs, no edits. Every
            // other status keeps the tabbed Summary/Services/Schedule/
            // Images/etc. view that ops uses for active jobs.
            Number(job.job_status) === 9
              ? <JobTransactionView jobId={Number(job.job_id)} />
              : <ViewBody job={job} onRefresh={refresh} />
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
                  onSaved={(saved) => {
                    if (saved?.job_id) { setJob(saved); setMode('view'); onSaved?.(); }
                  }}
                />
              )}
            />
          )}
          {!loading && (mode === 'edit' || mode === 'confirm') && (
            <JobForm
              mode={mode}
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
            />
          )}
        </div>

        {mode === 'view' && (
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
              <Button variant="outline" onClick={onClose}>Close</Button>
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
          tbl_job_comment alongside any prior follow-up notes. */}
      {jobId && (
        <AddRemarksDialog
          open={addRemarksOpen}
          jobId={Number(jobId)}
          onClose={() => setAddRemarksOpen(false)}
          onSaved={() => { setAddRemarksOpen(false); refresh(); onSaved?.(); }}
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
      {canAssign(s) && canPickTech && (
        <Button size="sm" onClick={() => setAutoAssignOpen(true)}>
          <Sparkles className="h-3.5 w-3.5 mr-1" />
          {isReassign ? 'Auto-reassign' : 'Auto-assign'}
        </Button>
      )}
      {canAssign(s) && canPickTech && (
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
      <RescheduleDialog
        open={rescheduleOpen} onClose={() => setRescheduleOpen(false)}
        initialDate={String(job.requested_date_time ?? '')}
        initialSlot={String(job.time_slot ?? '')}
        onSubmit={async (date, slot) => {
          // Two writes per reschedule:
          //   1. PATCH the job's scheduled date + slot.
          //   2. POST a tbl_job_comment row with appointment_on=new
          //      date and comment_on=2 (the "Reschedule" code; same
          //      shape the legacy CRM used). The Summary tab's
          //      JobRescheduleHistory component filters tbl_job_comment
          //      rows where appointment_on IS NOT NULL — without this
          //      POST the rescheduling trail stays empty even though
          //      the requested_date_time updates.
          await api.patch(`/admin/jobs/${jobId}`, {
            requested_date_time: date,
            time_slot: slot || null,
          });
          try {
            await api.post(`/admin/jobs/${jobId}/comments`, {
              comments: `Rescheduled to ${date}${slot ? ` (${slot})` : ''}`,
              comment_on: 2,                 // legacy "reschedule" comment code
              appointment_on: date,          // anchors the trail row
            });
          } catch (e) {
            // Non-fatal — the PATCH already succeeded. Surface a soft
            // warning so the operator knows the history won't show
            // this entry, but don't roll back the reschedule itself.
            showToast({
              variant: 'error',
              message: e instanceof Error
                ? `Rescheduled, but history entry failed: ${e.message}`
                : 'Rescheduled, but history entry failed',
            });
          }
          setRescheduleOpen(false); onChanged();
        }}
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

function ViewBody({ job, onRefresh }: { job: Job; onRefresh?: () => void }) {
  const images = Array.isArray((job as Record<string, unknown>).images)
    ? ((job as Record<string, unknown>).images as Array<Record<string, unknown>>)
    : [];
  return (
    <Tabs defaultValue="summary">
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
            ['Alt Number', (job as Record<string, unknown>).additional_number as string],
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
                  mobile={job.client_spoc as string | null}
                />
              : (job.client_spoc as string | null)],
          ]}/>
          <DlCard title="Job Meta" rows={[
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
        <ServicesTabBody job={job} onMutated={onRefresh} />
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
                  mobile={job.easyfixer_mobile as string | null}
                />
              : (job.easyfixer_mobile as string | null)],
            ['Helper req',   job.helper_req ? 'Yes' : 'No'],
            ['Time slot',    job.time_slot],
          ]}/>
        </div>
      </TabsContent>

      {/*
        * Images tab — legacy `jobImg.vm` + `jobImageList.vm`. Data already
        * lives on `job.images` (returned by services/job.service.js::getById
        * line 217). Each row has `image` (filename) which is served by
        * Nginx under `/easydoc/upload_jobs/<filename>` per CLAUDE.md's
        * file-storage table.
        */}
      <TabsContent value="images">
        <JobImagesTab images={images} />
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
        <JobCommentsTab jobId={job.job_id as number} />
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
          <DlRow label="Address" value={job.address} />
          <DlRow label="Building" value={job.building} />
          <DlRow label="Landmark" value={job.landmark} />
          <DlRow label="City" value={job.city_name} />
          <DlRow label="PIN" value={job.pin_code} />
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
 * JobCallHistory — Kaleyra call log scoped to this job. Uses the
 * existing /admin/calls/preview endpoint with `jobId=` filter. Empty
 * list when no calls; gracefully falls back if the operator lacks
 * click-to-call permission (the endpoint 403s and we just hide).
 */
function JobCallHistory({ jobId }: { jobId: number }) {
  type CallRow = Record<string, unknown> & {
    id?: number;
    call_date?: string | null;
    call_status?: string | null;
    call_duration?: number | null;
    call_from?: string | null;
    call_to?: string | null;
    initiated_by_name?: string | null;
  };
  const { data, error } = useFetch<CallRow[] | { items?: CallRow[] }>(`/admin/calls/preview?jobId=${jobId}&limit=50`);
  if (error) return null; // operator without isClickToCall permission — hide section
  const rows: CallRow[] = Array.isArray(data) ? data : (data?.items ?? []);
  return (
    <div className="mt-5">
      <div className="font-medium text-sm mb-1">Calling History</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground rounded border border-dashed px-3 py-2">
          No calls recorded for this job.
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">When</th>
                <th className="!text-left">By</th>
                <th className="!text-left">From → To</th>
                <th className="!text-center">Duration</th>
                <th className="!text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td className="text-xs">{formatDate(r.call_date as string)}</td>
                  <td className="text-xs">{r.initiated_by_name ?? '—'}</td>
                  <td className="text-xs font-mono">
                    {String(r.call_from ?? '—')} → {String(r.call_to ?? '—')}
                  </td>
                  <td className="text-xs !text-center">
                    {r.call_duration != null ? `${r.call_duration}s` : '—'}
                  </td>
                  <td className="text-xs !text-center">{r.call_status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

function ServicesTabBody({ job, onMutated }: { job: Job; onMutated?: () => void }) {
  const services = Array.isArray(job.services) ? job.services : [];
  // Active vs. inactive split — operators get a "Show Inactive" toggle
  // so the soft-deleted rows can be inspected (and restored when we
  // add that affordance).
  const [showInactive, setShowInactive] = useState(false);
  const visible = useMemo(() => {
    const arr = (services as Array<Record<string, unknown>>);
    return showInactive ? arr : arr.filter((s) => Number(s.job_service_status) !== 0);
  }, [services, showInactive]);

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

  const inactiveCount = (services as Array<Record<string, unknown>>).filter((s) => Number(s.job_service_status) === 0).length;
  const canEdit = !isJobClosed(Number(job.job_status));
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        {/* Show Inactive toggle stays on the right; Add Service sits
            beside it. Both only render when the job is still editable
            (status ∉ {COMPLETED, COMPLETED_ALT}). */}
        <div>
          {canEdit && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-3.5 mr-1" /> Add Service
            </Button>
          )}
        </div>
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
              <th>#</th>
              <th>Service Type</th>
              <th>Category</th>
              <th>Qty</th>
              <th>Status</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={6} className="text-center text-muted-foreground py-8">No services on this job</td></tr>
            )}
            {visible.map((s, i) => {
              const sr = s as Record<string, unknown>;
              const id = Number(sr.job_service_id);
              const isActive = Number(sr.job_service_status) !== 0;
              const isOpen = openLineId === id;
              const line = breakdownFor(id);
              const busy = busyId === id;
              return (
                <Fragment key={i}>
                  <tr className={isActive ? '' : 'opacity-60'}>
                    <td className="text-xs text-muted-foreground">{String(sr.job_service_id ?? '')}</td>
                    <td>{String(sr.service_type_name ?? '—')}</td>
                    <td>{String(sr.service_catg_name ?? '—')}</td>
                    <td>{String(sr.quantity ?? '')}</td>
                    <td>{isActive ? 'Active' : 'Inactive'}</td>
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
      <AddJobServiceDialog
        open={addOpen}
        job={job}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          invalidateBreakdownCache(Number(job.job_id));
          setBreakdown(null);
          onMutated?.();
        }}
      />
    </div>
  );
}

/*
 * AddJobServiceDialog — Service Category → Service Type → Services
 * cascade (mirrors the "Select Products" panel in Book New Call). The
 * operator picks ONE Category to narrow the catalog (since N×M would
 * blow the picker out), then 1+ Service Types within it, then adds each
 * matching service row to the basket with a quantity, then submits the
 * whole basket as N parallel POSTs to /admin/jobs/:id/services.
 *
 * Catalog source: /shared/lookup/client-services?clientId=X — same
 * endpoint Book New Call hits. The response is { items: [ClientServiceLite] }
 * carrying service_type_name + service_catg_name + total_amount, which we
 * group on the fly into a Category list and Type list.
 *
 * BE side: POST /admin/jobs/:id/services reactivates a soft-deleted row
 * for the same {job_id, service_id} instead of inserting a duplicate,
 * so adding back a previously-removed service is a no-cost retry.
 */
type ClientServiceLite = {
  client_service_id: number;
  service_type_id: number | null;
  service_catg_id: number | null;
  service_type_name: string | null;
  service_catg_name: string | null;
  total_amount?: number | null;
  // Rate-card name lets us disambiguate when a single Service Type is
  // mapped to multiple rate-card variants (different SKUs / pricing
  // tiers). Without it the picker shows "Modular Packed Furniture"
  // five times with no visible difference between rows.
  crc_ratecard_name?: string | null;
  charge_type?: string | null;
};
type BasketRow = { client_service_id: number; quantity: number };
function AddJobServiceDialog({ open, job, onClose, onSaved }: {
  open: boolean; job: Job; onClose: () => void; onSaved: () => void;
}) {
  const clientId = Number((job as Record<string, unknown>).fk_client_id);
  const url = open && clientId > 0
    ? `/shared/lookup/client-services?clientId=${clientId}`
    : null;
  const { data: catalogRaw } = useFetch<ClientServiceLite[] | { items?: ClientServiceLite[] }>(url);
  const catalog: ClientServiceLite[] = useMemo(() => (
    Array.isArray(catalogRaw) ? catalogRaw : ((catalogRaw as { items?: ClientServiceLite[] } | null)?.items ?? [])
  ), [catalogRaw]);

  // Cascade state — picked category narrows the type picker; picked
  // types narrow the visible service list. Basket holds the rows the
  // operator has ticked, keyed by client_service_id for stable qty edits.
  // Job Type is a separate multi-select that mirrors the per-job
  // job_type CSV; if the operator changes it we PATCH the job along
  // with the service inserts.
  const [pickedCatgId, setPickedCatgId] = useState<string>('');
  const [pickedTypeIds, setPickedTypeIds] = useState<string[]>([]);
  const [pickedJobTypes, setPickedJobTypes] = useState<string[]>([]);
  const initialJobTypesRef = useMemo(() => {
    const csv = String((job as Record<string, unknown>).job_type ?? '');
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
  }, [job]);
  const [basket, setBasket] = useState<Map<number, BasketRow>>(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPickedCatgId('');
      setPickedTypeIds([]);
      setPickedJobTypes(initialJobTypesRef);
      setBasket(new Map());
    }
  }, [open, initialJobTypesRef]);
  // When the category changes, clear the dependent picks so stale
  // Service Type selections from another category don't bleed through.
  useEffect(() => { setPickedTypeIds([]); }, [pickedCatgId]);

  // Distinct categories present in the client's rate card.
  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of catalog) {
      if (c.service_catg_id != null && c.service_catg_name) {
        m.set(String(c.service_catg_id), c.service_catg_name);
      }
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [catalog]);

  // Distinct types under the picked category.
  const types = useMemo(() => {
    if (!pickedCatgId) return [];
    const m = new Map<string, string>();
    for (const c of catalog) {
      if (String(c.service_catg_id) === pickedCatgId && c.service_type_id != null && c.service_type_name) {
        m.set(String(c.service_type_id), c.service_type_name);
      }
    }
    return Array.from(m.entries()).map(([value, label]) => ({ value, label }));
  }, [catalog, pickedCatgId]);

  // Visible service rows for the picked types within the picked category.
  const visible = useMemo(() => {
    if (!pickedCatgId || pickedTypeIds.length === 0) return [];
    const typeSet = new Set(pickedTypeIds.map(String));
    return catalog.filter((c) => (
      String(c.service_catg_id) === pickedCatgId
      && c.service_type_id != null
      && typeSet.has(String(c.service_type_id))
    ));
  }, [catalog, pickedCatgId, pickedTypeIds]);

  function toggleService(c: ClientServiceLite) {
    setBasket((prev) => {
      const next = new Map(prev);
      const id = c.client_service_id;
      if (next.has(id)) next.delete(id);
      else next.set(id, { client_service_id: id, quantity: 1 });
      return next;
    });
  }
  function setQty(clientServiceId: number, qty: number) {
    setBasket((prev) => {
      const next = new Map(prev);
      const existing = next.get(clientServiceId);
      if (existing) next.set(clientServiceId, { ...existing, quantity: Math.max(1, qty || 1) });
      return next;
    });
  }

  async function submit() {
    if (basket.size === 0) {
      showToast({ variant: 'error', message: 'Tick at least one service to add' });
      return;
    }
    setBusy(true);
    try {
      // Sequential POSTs (Promise.allSettled) so a single 4xx on one
      // row doesn't abort the rest. We surface a single toast at the
      // end summarising successes + failures.
      const results = await Promise.allSettled(
        Array.from(basket.values()).map((row) => {
          const meta = catalog.find((c) => c.client_service_id === row.client_service_id);
          return api.post(`/admin/jobs/${job.job_id}/services`, {
            service_id: row.client_service_id,
            service_type_id: meta?.service_type_id ?? null,
            service_category_id: meta?.service_catg_id ?? null,
            quantity: row.quantity,
          });
        }),
      );
      // If Job Type changed, PATCH the job alongside (job_type lives on
      // tbl_job as a CSV — same column the create flow writes). We skip
      // the PATCH when the selection is identical to the initial set.
      const newJobTypeCsv = pickedJobTypes.join(',');
      const initialJobTypeCsv = initialJobTypesRef.join(',');
      if (newJobTypeCsv !== initialJobTypeCsv) {
        try {
          await api.patch(`/admin/jobs/${job.job_id}`, { job_type: newJobTypeCsv });
        } catch (e) {
          showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to update job type' });
        }
      }
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (fail === 0) {
        showToast({ variant: 'success', message: `${ok} Service${ok === 1 ? '' : 's'} Added` });
      } else {
        showToast({
          variant: 'error',
          message: `${ok} added, ${fail} failed`,
        });
      }
      onSaved();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed to add services' });
    } finally { setBusy(false); }
  }

  // Basket grand-total — sum of (rate × qty) for every ticked row.
  // Re-computes whenever basket / catalog mutate.
  const basketTotal = useMemo(() => {
    let sum = 0;
    for (const row of basket.values()) {
      const meta = catalog.find((c) => c.client_service_id === row.client_service_id);
      sum += (Number(meta?.total_amount || 0)) * row.quantity;
    }
    return sum;
  }, [basket, catalog]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* Full-screen dialog: max-w widened to 5xl so the services table
          fits on a single horizontal line (Service Type / Rate Card /
          Rate / Qty / Amount). DialogHeader uses the standard `!mx-0
          !mt-0 !mb-0` overrides per the dialog.tsx call-site contract
          when DialogContent has `!p-0`. */}
      <DialogContent className="!max-w-5xl !max-h-[calc(100vh-48px)] !h-[calc(100vh-48px)] flex flex-col !p-0 gap-0 overflow-hidden">
        <DialogHeader className="!mx-0 !mt-0 !mb-0 px-6 py-4 shrink-0">
          <DialogTitle>Add Service To Job #{job.job_id}</DialogTitle>
        </DialogHeader>
        <div className="p-4 space-y-3 flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label>Service Category *</Label>
              <SearchSelect
                value={pickedCatgId}
                onChange={(v) => setPickedCatgId(String(v))}
                options={categories}
                placeholder={categories.length ? '— Select a category —' : 'No categories on rate card'}
              />
            </div>
            <div>
              <Label>Service Type(s) *</Label>
              <SearchMultiSelect
                value={pickedTypeIds}
                onChange={(next) => setPickedTypeIds((next as Array<string | number>).map(String))}
                options={types}
                placeholder={pickedCatgId ? (types.length ? '— Select service type(s) —' : 'No types in this category') : 'Pick a category first'}
                selectedLabel="types"
              />
            </div>
            <div>
              {/* Job Type mirrors the per-job CSV (tbl_job.job_type).
                  Editing here PATCHes the job alongside the service
                  inserts so the operator can correct it without a
                  separate dialog. Vocabulary trimmed to the 3 ops-
                  supported values (matches Book New Call). */}
              <Label>Job Type</Label>
              <SearchMultiSelect
                value={pickedJobTypes}
                onChange={(next) => setPickedJobTypes((next as Array<string | number>).map(String))}
                placeholder="— Select job type(s) —"
                selectedLabel="types"
                options={[
                  { value: 'Installation',   label: 'Installation' },
                  { value: 'Repair',         label: 'Repair' },
                  { value: 'Uninstallation', label: 'Uninstallation' },
                ]}
              />
            </div>
          </div>
          <div>
            <Label>Services</Label>
            {visible.length === 0 ? (
              <div className="text-sm text-muted-foreground rounded border border-dashed px-3 py-3 text-center">
                {pickedCatgId && pickedTypeIds.length > 0
                  ? 'No services on this client\'s rate card for the picked Service Type(s).'
                  : 'Pick Service Category + Service Type(s) above to see matching services.'}
              </div>
            ) : (
              // Columns:
              //   - Service / Product = crc_ratecard_name (the SKU
              //     label — what the operator actually picks). This is
              //     the differentiating column when one Service Type
              //     is mapped to multiple rate-card variants. The BE
              //     already filters service_status=0 (inactive) rows.
              //   - Service Type = service_type_name (parent category).
              //   - Rate / Qty / Amount as before.
              <div className="rounded-lg border bg-card overflow-hidden">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th className="!text-center w-10"></th>
                      <th className="!text-left">Service / Product</th>
                      <th className="!text-left">Service Type</th>
                      <th className="!text-right">Rate ₹</th>
                      <th className="!text-right w-24">Qty</th>
                      <th className="!text-right">Amount ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => {
                      const added = basket.get(c.client_service_id);
                      const rate = Number(c.total_amount || 0);
                      const amount = added ? rate * added.quantity : 0;
                      return (
                        <tr key={c.client_service_id} className={added ? 'bg-emerald-50/40' : ''}>
                          <td className="!text-center">
                            <button
                              type="button"
                              className={
                                'inline-flex items-center justify-center w-7 h-7 rounded border ' +
                                (added
                                  ? 'bg-rose-50 border-rose-200 text-rose-600'
                                  : 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100')
                              }
                              onClick={() => toggleService(c)}
                              title={added ? 'Remove from basket' : 'Add to basket'}
                            >
                              {added ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                            </button>
                          </td>
                          {/* Primary label: rate-card name (the SKU).
                              `charge_type` (e.g. fixed/variable) shown
                              inline so the operator knows the pricing
                              model at a glance. */}
                          <td className="font-medium">
                            {c.crc_ratecard_name ?? c.service_type_name ?? '—'}
                            {c.charge_type ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">({c.charge_type})</span>
                            ) : null}
                          </td>
                          {/* Secondary label: the parent Service Type. */}
                          <td className="text-xs text-muted-foreground">
                            {c.service_type_name ?? '—'}
                          </td>
                          <td className="!text-right font-mono">{rate.toFixed(2)}</td>
                          <td className="!text-right">
                            {added ? (
                              <Input
                                type="number"
                                min="1"
                                value={String(added.quantity)}
                                onChange={(e) => setQty(c.client_service_id, Number(e.target.value))}
                                className="font-mono h-8 text-right"
                              />
                            ) : <span className="text-muted-foreground text-xs">—</span>}
                          </td>
                          <td className="!text-right font-mono">{added ? amount.toFixed(2) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {basket.size > 0 && (
            <div className="flex items-center justify-between rounded border bg-emerald-50/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {basket.size} service{basket.size === 1 ? '' : 's'} in basket
              </span>
              <span className="font-medium text-emerald-800">
                Total · ₹{basketTotal.toFixed(2)}
              </span>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy || basket.size === 0}>
              {busy ? 'Adding…' : basket.size > 1 ? `Add ${basket.size} Services` : 'Add Service'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
type JobComment = {
  id: number;
  job_id: number;
  comments: string;
  comment_on: number;
  stage: string;
  created_on: string;
  appointment_on: string | null;
  commented_by: number | null;
  user_name: string | null;
  efr_id: number | null;
  enum_reason_id: number | null;
  enum_desc: string | null;
};

const COMMENT_STAGE_LABEL: Record<number, string> = {
  1: 'On Creation',
  2: 'On Check-In',
  3: 'On Check-Out',
  4: 'In Progress',
};

function JobCommentsTab({ jobId }: { jobId: number }) {
  const [comments, setComments] = useState<JobComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [stage, setStage] = useState<number>(4);
  const [posting, setPosting] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await api.get<JobComment[]>(`/admin/jobs/${jobId}/comments`);
      setComments(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load comments');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [jobId]);

  async function postComment() {
    const text = draft.trim();
    if (!text) return;
    setPosting(true); setError(null);
    try {
      await api.post(`/admin/jobs/${jobId}/comments`, { comments: text, comment_on: stage });
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to post comment');
    } finally { setPosting(false); }
  }

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

      {/* List */}
      {loading && <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>}
      {!loading && comments.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          No comments on this job yet.
        </div>
      )}
      {!loading && comments.length > 0 && (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border bg-card p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>
                  <span className="font-medium text-foreground">{c.user_name ?? 'Unknown user'}</span>
                  {' · '}
                  <span className="inline-block bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">
                    {COMMENT_STAGE_LABEL[c.comment_on] ?? c.stage}
                  </span>
                </span>
                <span>{formatDate(c.created_on)}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap">{c.comments}</div>
            </li>
          ))}
        </ul>
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
function JobImageTile({ id, url, label, tooltip }: { id: string; url: string; label: string; tooltip: string }) {
  const [broken, setBroken] = useState(false);

  const authedUrl = React.useMemo(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
    if (!token) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }, [url]);

  return (
    <a
      key={id}
      href={authedUrl}
      target="_blank"
      rel="noopener noreferrer"
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
  );
}

function JobImagesTab({ images }: { images: Array<Record<string, unknown>> }) {
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

  if (images.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No images uploaded for this job.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
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
          />
        );
      })}
    </div>
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
    if (mobile.length !== 10) { setErr('Mobile must be exactly 10 digits.'); return; }
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
        <Button onClick={lookup} disabled={busy || mobile.length !== 10}>
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
type JobFormSavedOpts = { closeAfter?: boolean; variant?: 'book' | 'enquiry' | 'unreachable' };
function JobForm({ mode, initial, onCancel, onSaved, prefillCustomer }: {
  mode: 'create' | 'edit' | 'confirm';
  initial: Job | null;
  onCancel: () => void;
  onSaved: (saved: Job, opts?: JobFormSavedOpts) => void;
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
        base.city_id = first.city_id != null ? String(first.city_id) : '';
        base.pin_code = first.pin_code || '';
      }
    }
    return base;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
   * for the six fields that legacy spec'd as common-across-jobs:
   *   - Job Image (job_image_file)
   *   - Special Comments (remarks)
   *   - Anything Handyman should keep in mind (efr_special_notes)
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
    setF(toFormShape(initial));
  }, [initial, mode]);

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
    api.get<ClientContact[]>(`/admin/clients/${clientId}/contacts`)
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
          const existing = (initial!.services as Array<Record<string, unknown>>).map((s, i) => ({
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

  function set<K extends keyof typeof f>(k: K, v: (typeof f)[K]) { setF((s) => ({ ...s, [k]: v })); }

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
  useEffect(() => {
    if (collectedByPref) set('collected_by', collectedByPref);
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
  const [submitVariant, setSubmitVariant] = useState<'book' | 'enquiry' | 'unreachable'>('book');

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
    setError(null); setSubmitting(true);

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
    if (isConfirm && submitVariant === 'book' && !confirmSection2Complete) {
      const missing: string[] = [];
      if (!f.client_ref_id || !String(f.client_ref_id).trim()) missing.push('Client Reference ID');
      if (!f.reporting_contact_id) missing.push('Reporting Contact');
      if (!f.customer_name) missing.push('Customer Name');
      if (!f.address) missing.push('Address');
      if (!String(f.city_id || '').trim()) missing.push('City');
      if (!/^[0-9]{6}$/.test(String(f.pin_code || ''))) missing.push('PIN (6 digits)');
      if (!f.requested_date_time) missing.push('Requested Date & Time');
      if (!f.time_slot) missing.push('Time Slot');
      setError(`Missing required field(s): ${missing.join(', ')}`);
      setSubmitting(false);
      return;
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
            // Free-text landing notes for the technician — persists on
            // tbl_address.address_instruction.
            address_instruction: (f as Record<string, unknown>).address_instruction as string | undefined,
          });
          if (address) patch.address = address;
          // Products-section fields from legacy addEditJob. We reuse `remarks`
          // for Special Comments and `efr_special_notes` for the
          // "Anything Handyman should keep in mind?" prompt (both are already
          // in MUTABLE_COLUMNS). `fk_service_type_id` / `fk_service_catg_id`
          // carry the active filter selection.
          setIf('remarks', f.remarks);
          setIf('efr_special_notes', f.efr_special_notes);
          // helper_req is a boolean — `false` is a meaningful value the BE
          // must accept, so setIf (which omits `null`/`undefined`/`""` but
          // keeps `false`) handles it correctly. Type-check still here for
          // legacy state shapes where the field might transiently be a string.
          if (typeof f.helper_req === 'boolean') patch.helper_req = f.helper_req;
          if (f.fk_service_catg_id) patch.fk_service_catg_id = Number(f.fk_service_catg_id);
          if (f.fk_service_type_id) patch.fk_service_type_id = Number(f.fk_service_type_id);
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
        // For non-'book' variants we intentionally do NOT re-trigger
        // the BE's "auto status bumps on first assign" path; ops wants
        // the order to STAY in its bucket until they explicitly book it.
        if (isConfirm) {
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
        // Tell the parent how to behave after this save. Outcome-only
        // flows (Unreachable / Enquiry) want the modal closed
        // immediately — no flash of "loading…" while the modal refetches
        // into view mode. Book stays open so the operator can see the
        // updated booking.
        onSaved(saved, { closeAfter: isOutcomeOnly, variant: submitVariant });
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
          // Source defaults to "manual" — the legacy UI only ever set
          // this for Client Dashboard / Excel / API automation flows.
          // CRM operators always go via "manual", and the new app
          // hides the picker since it confused operators.
          source_type: f.source_type || 'manual',
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
          // SPOC tags. Backend already accepts these directly on
          // tbl_job (verified in MUTABLE_COLUMNS + the INSERT column list).
          reporting_contact_id: f.reporting_contact_id ? Number(f.reporting_contact_id) : undefined,
          client_spoc: f.client_spoc || undefined,
          client_spoc_name: f.client_spoc_name || undefined,
          client_spoc_email: f.client_spoc_email || undefined,
          /*
           * Customer-alternate contact — captured via the new inputs
           * in the Customer Details section. Maps to tbl_job columns
           * additional_name / additional_number.
           */
          additional_name:   f.additional_name   || undefined,
          additional_number: f.additional_number || undefined,
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
            collected_by:      override.collected_by ?? f.collected_by,
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
  // Section 1 (Client Details) is complete once BOTH Client Reference
  // ID is non-empty AND a Reporting Contact has been picked. Client
  // itself is read-only in confirm; SPOC trio auto-fills from the
  // contact. Bulk-uploaded orders arrive with no SPOC info, so the
  // Reporting Contact pick is the only way ops attaches a SPOC
  // before booking — making it mandatory matches that intent.
  const confirmSection1Complete = !!(
    f.client_ref_id && String(f.client_ref_id).trim()
    && f.reporting_contact_id && String(f.reporting_contact_id).trim()
  );
  // Section 2 (Customer Details) requires the full set of legacy
  // mandatory fields: name + slot + datetime + address + city + 6-digit
  // pincode. Customer mobile is read-only in confirm so it's not gated.
  const confirmSection2Complete =
    confirmSection1Complete &&
    !!f.customer_name &&
    !!f.time_slot &&
    !!f.requested_date_time &&
    !!f.address &&
    !!String(f.city_id || '').trim() &&
    /^[0-9]{6}$/.test(String(f.pin_code || ''));

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
      <form onSubmit={submit} noValidate={outcomePayload !== null} className="space-y-4">
        {/*
          * Job Summary strip — legacy parity. Four fields: Special Comments,
          * Job Description, Product Quantity, Job Type. Mobile is a prominent
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
              mobile={(initial.customer_mob_no as string | null | undefined) ?? null}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
            <div><span className="text-xs text-muted-foreground mr-2">Special Comments:</span>{String(initial.remarks ?? '—')}</div>
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
              <Input
                value={maskMobile(f.client_spoc || initial.client_spoc)}
                readOnly disabled
                className="tabular-nums"
              />
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
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              onClick={() => setConfirmOpenSection(2)}
              disabled={!confirmSection1Complete}
              title={confirmSection1Complete ? '' : 'Fill Client Reference ID and pick a Reporting Contact to proceed'}
            >
              Next →
            </Button>
          </div>
        </Section>

        {/* ── 2 · Customer Details ───────────────────────────────────────── */}
        <Section
          title="2 · Customer Details"
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
                  cleartext mobile — same UX as the Summary tab. */}
              <div className="h-10 px-2 flex items-center border rounded bg-muted/30">
                <CallableMobile
                  jobId={Number(initial.job_id)}
                  mobile={f.customer_mob_no as string | null}
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
              <Input
                value={f.additional_number || ''}
                onChange={(e) => set('additional_number', e.target.value.replace(/\D/g, '').slice(0, 10))}
                inputMode="numeric"
                placeholder="10 digits"
                className="tabular-nums"
              />
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
              </div>
              <div className="space-y-1.5">
                <Label>Requested Date/Time *</Label>
                <Input
                  required type="datetime-local"
                  value={f.requested_date_time}
                  onChange={(e) => {
                    set('requested_date_time', e.target.value);
                    const slot = inferSlotFromTime(e.target.value);
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
              </div>
            </div>
            {/* Address section — uses the shared AddressPickerWithMap
                (split-pane form left, draggable Google Map right). The
                map's reverse-geocode keeps PIN + city + GPS in sync
                with the marker; the autocomplete pre-fills them on
                suggestion pick. Same component on the create-flow so
                Confirm & Schedule and Book New Call are byte-identical
                in behaviour. */}
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
                return (
                  <div>
                    <Input
                      key={`job-img-${tabKey}`}
                      type="file"
                      accept="image/*,.pdf"
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
            {/* Special Comments + Anything Handyman — placed in a nested
                2-col grid spanning all 3 outer columns. Ops asked for these
                two textareas to sit half-half on the same row (2026-05-26),
                matching the create-mode visual. resize-y locks horizontal
                growth so the modal width stays predictable. */}
            <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Special Comments *">
                <textarea
                  required
                  rows={3}
                  value={getJobField('remarks') ?? ''}
                  onChange={(e) => setJobField('remarks', e.target.value)}
                  className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-y"
                  placeholder="Any special notes visible to ops"
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
                options={
                  collectedByPref
                    ? [{ value: collectedByPref, label: collectedByPref }]
                    : [
                        { value: 'Easyfix',   label: 'Easyfix' },
                        { value: 'Easyfixer', label: 'Easyfixer' },
                        { value: 'Client',    label: 'Client' },
                      ]
                }
              />
              {collectedByPref && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Locked by client profile (Collected By = {collectedByPref}).
                </p>
              )}
            </Field>
          </div>
          <div className="mt-4 flex justify-start">
            <Button type="button" variant="outline" onClick={() => setConfirmOpenSection(2)}>← Back</Button>
          </div>
        </Section>

        {error && <div className="text-sm text-destructive">{error}</div>}
        {/* Confirm-mode footer — three-button layout matching the legacy
            CRM "Add Job (Bulk Upload)" confirm screen (ref screenshots
            2026-05-19). All three submit the same form; the difference
            is which `submitVariant` lands in the status promotion at
            the end of submit(). Unreachable/Enquiry open the reason
            popup first to capture Pending Due To + Reason + Remarks
            and fold them into the remarks column as a structured
            prefix. See JobOutcomeDialog block below. */}
        <div className="flex justify-end gap-2 pt-2 flex-wrap">
          <CancelButton onCancel={onCancel} />
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
            // Book Call is now gated on the same completeness rule that
            // gates Section 3's expand (confirmSection2Complete). Without
            // this, the button was clickable even with Client Reference
            // ID / Reporting Contact / customer name / address / city /
            // PIN / date-time / time-slot missing — the BE would reject
            // with a Joi 400 per-field, but the FE should refuse to
            // submit upfront. Unreachable + Enquiry remain enabled (they
            // skip the full payload — see the outcome-only submit path).
            disabled={!confirmSection2Complete}
            title={confirmSection2Complete
              ? ''
              : 'Fill all mandatory fields (Client Ref ID, Reporting Contact, Customer Name, Address, City, PIN, Date & Time) before booking.'}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            Book Call
          </LoadBtn>
        </div>
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
            const tag = mode === 'unreachable' ? 'Unreachable' : 'Enquiry';
            const dueLabel = mode === 'unreachable' ? 'Pending Due To' : 'Open Due To';
            const prefix = `[${tag} · ${dueLabel}: ${dueTo} · Reason: ${reason}]`;
            const merged = remarks ? `${prefix} ${remarks}` : prefix;
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
   * `clientCustomProps` below.
   */

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
  const currentHour = new Date().getHours();
  const minHourToday = currentHour + 1; // strictly future for today
  const hourOptions = React.useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let h = 0; h < 24; h++) {
      if (isToday && h < minHourToday) continue;
      const hh = String(h).padStart(2, '0');
      const label = h === 0 ? '12:00 AM'
                  : h < 12  ? `${h}:00 AM`
                  : h === 12 ? '12:00 PM'
                  :            `${h - 12}:00 PM`;
      opts.push({ value: `${hh}:00`, label });
    }
    return opts;
  }, [isToday, minHourToday]);
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
  const section2Complete =
    section1Complete &&
    !!f.customer_name && /^[0-9]{10}$/.test(String(f.customer_mob_no || '')) &&
    !!f.address && !!f.city_id && /^[0-9]{6}$/.test(String(f.pin_code || '')) &&
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
    <form onSubmit={submit} noValidate={outcomePayload !== null} className="space-y-5">
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
            <Field label="Requested Date/Time *"><Input required type="datetime-local" min={nowLocalIso()} value={f.requested_date_time} onChange={(e) => set('requested_date_time', e.target.value)} /></Field>
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
                  <Input
                    value={f.additional_number || ''}
                    onChange={(e) => set('additional_number', e.target.value.replace(/\D/g, '').slice(0, 10))}
                    inputMode="numeric"
                    placeholder="10 digits"
                    className="font-mono"
                  />
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
                      if (e.target.value === todayIso && requestedTime) {
                        const h = Number(requestedTime.split(':')[0]);
                        if (Number.isFinite(h) && h < minHourToday) {
                          set('requested_time', '');
                        }
                      }
                    }}
                  />
                </Field>
                <Field label="Requested Time *">
                  <SearchSelect
                    required
                    value={requestedTime}
                    onChange={(v) => set('requested_time', v)}
                    placeholder={requestedDate ? '— Pick an hour —' : 'Pick a date first'}
                    disabled={!requestedDate}
                    options={hourOptions}
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
                              setF((s) => ({
                                ...s,
                                address: a.address || '',
                                city_id: a.city_id != null ? String(a.city_id) : '',
                                pin_code: a.pin_code || '',
                              }));
                            }}
                            className="mt-0.5"
                          />
                          <span className="flex-1">
                            {a.address}
                            {a.city_name ? <span className="text-muted-foreground"> · {a.city_name}</span> : null}
                            {a.pin_code ? <span className="text-muted-foreground"> · {a.pin_code}</span> : null}
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
              {/* Side-by-side textareas. NOT `full` (would col-span-2 and
                  push them onto separate rows); the 2-col outer grid
                  already gives each its half. resize-y locks horizontal
                  resize so the operator can't bust the modal width. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Special Comments *">
                  <textarea
                    required
                    rows={3}
                    value={getJobField('remarks') ?? ''}
                    onChange={(e) => setJobField('remarks', e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm bg-white resize-y"
                    placeholder="Internal notes for ops"
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
                    value={collectedByPref ?? (getJobField('collected_by') || 'Easyfix')}
                    onChange={(v) => { if (!collectedByPref) setJobField('collected_by', v); }}
                    disabled={!!collectedByPref}
                    options={
                      collectedByPref
                        ? [{ value: collectedByPref, label: collectedByPref }]
                        : [
                            { value: 'Easyfix',   label: 'Easyfix' },
                            { value: 'Easyfixer', label: 'Easyfixer' },
                            { value: 'Client',    label: 'Client' },
                          ]
                    }
                  />
                  {collectedByPref && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Locked by client profile (Collected By = {collectedByPref}).
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
      <div className="flex justify-end gap-2 pt-2 flex-wrap">
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
          const dueLabel = mode === 'unreachable' ? 'Pending Due To' : 'Open Due To';
          const prefix = `[${tag} · ${dueLabel}: ${dueTo} · Reason: ${reason}]`;
          // Preserve any existing remarks the operator typed below
          // the structured prefix.
          const merged = remarks ? `${prefix} ${remarks}` : prefix;
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
   * Rate resolution per row. Legacy semantics:
   *   - charge_type === 1 (Fixed)    → total_amount is the bookable
   *     rate. Fall back to "—" if total_amount is 0/null (misconfigured).
   *   - charge_type === 0 (Variable) → computed at invoice time. The
   *     basket can't show a number; display "Variable" and exclude
   *     from grandTotal (legacy behaviour).
   *
   * `resolveRate` returns `{ rate, kind }`:
   *   - kind 'fixed'    → rate is a number > 0; counts toward total
   *   - kind 'variable' → no rate to show; doesn't count toward total
   *   - kind 'missing'  → looks fixed but no price configured;
   *                       flagged but doesn't count.
   */
  function resolveRate(s: ClientService): { rate: number | null; kind: 'fixed' | 'variable' | 'missing' } {
    const ct = Number(s.charge_type);
    if (ct === 0) return { rate: null, kind: 'variable' };
    const r = toRate(s.total_amount);
    if (r === null || r === 0) return { rate: null, kind: 'missing' };
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
                  {/* Rate display per charge_type:
                        fixed    → ₹X.XX
                        variable → "Variable" pill (invoice-time price)
                        missing  → "Not set" in amber (misconfigured rate card)
                      This replaces the previous ₹0.00 display that was
                      misleading operators into thinking the booking
                      would invoice at zero. */}
                  {kind === 'fixed' && rate !== null
                    ? `₹${rate.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
                    : kind === 'variable'
                      ? <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-sky-50 text-sky-700 border border-sky-200">Variable</span>
                      : <span className="text-[11px] text-amber-700" title="Rate not configured on this client's rate card">Not set</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {!added ? <span className="text-muted-foreground">—</span>
                    : kind === 'variable'
                      ? <span className="text-[11px] text-sky-700">Computed</span>
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
                  (some services are Variable or missing a rate — excluded from total)
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
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(Number(j.job_status))}`}>
                          {statusLabel(Number(j.job_status), { assigned: j.fk_easyfixter_id != null })}
                        </span>
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
    job_type: pick('job_type') || 'Installation',
    source_type: pick('source_type') || 'manual',
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
    collected_by: pick('collected_by') || 'Easyfix',
    fk_service_catg_id: pick('fk_service_catg_id'),
    // CSV of category IDs. In CREATE flow, multi-pick fans out into
    // N jobs at submit. In EDIT/CONFIRM flow, seed from the row's
    // existing single category so the Confirm modal's Service Type
    // picker (which keys its allowed-options off this CSV) actually
    // filters correctly. Without this seed, Section 3 saw an empty
    // multi CSV + bulk-uploaded jobs with no `fk_service_catg_id`
    // → Service Type dropdown stayed unfiltered.
    fk_service_catg_ids: pick('fk_service_catg_id') ? String(pick('fk_service_catg_id')) : '',
    fk_service_type_id: pick('fk_service_type_id'),
    // Multi-select used in create flow's "Select Products" section.
    // Picking one or more Service Types auto-fans them out into the
    // rate-card services table below (qty=1 each). Confirm/Edit
    // still use the singular `fk_service_type_id` above so existing
    // rows don't unintentionally get rewritten.
    fk_service_type_ids: [] as string[],
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
function Section({
  title,
  children,
  expanded,
  onToggle,
  disabled,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  badge?: React.ReactNode;
}) {
  const collapsible = onToggle !== undefined;
  const isOpen = !collapsible || expanded;
  return (
    <section className="rounded-lg border bg-card">
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

  // Fetch reasons for the active mode whenever the dialog opens or
  // mode flips. Empty result is acceptable — the dropdown will show
  // the placeholder option only, and Submit stays disabled until a
  // reason is picked.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReasonsLoading(true);
    api.get<Array<{ id: number | null; label: string }>>('/admin/jobs/action-reasons', { type: mode })
      .then((rows) => { if (!cancelled) setReasons(rows || []); })
      .catch(() => { if (!cancelled) setReasons([]); })
      .finally(() => { if (!cancelled) setReasonsLoading(false); });
    return () => { cancelled = true; };
  }, [open, mode]);

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
// Mirrors legacy `jobReshedule.vm` — change requested_date_time +
// time_slot. Doesn't re-stamp scheduled_date_time (that's the assign
// flow's job). Backend support: PATCH /admin/jobs/:id with both fields
// in MUTABLE_COLUMNS.
function RescheduleDialog({ open, onClose, initialDate, initialSlot, onSubmit }: {
  open: boolean; onClose: () => void;
  initialDate: string; initialSlot: string;
  onSubmit: (date: string, slot: string) => Promise<void>;
}) {
  const [date, setDate] = useState('');
  const [slot, setSlot] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      // Convert MySQL DATETIME to <input type="datetime-local"> value.
      // Slice to YYYY-MM-DDTHH:mm; the input ignores seconds + TZ.
      setDate(initialDate ? initialDate.replace(' ', 'T').slice(0, 16) : '');
      setSlot(initialSlot || '');
      setErr(null);
    }
  }, [open, initialDate, initialSlot]);
  async function go() {
    if (!date) { setErr('Date is required'); return; }
    setLoading(true); setErr(null);
    try {
      // Convert back to MySQL DATETIME shape for the backend.
      await onSubmit(date.replace('T', ' ') + ':00', slot);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reschedule Job</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium block mb-1">Requested Date / Time *</Label>
            <Input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Time Slot</Label>
            <Input value={slot} onChange={(e) => setSlot(e.target.value)} placeholder='e.g. "10am-12pm"' />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={loading} />
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : 'Reschedule'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
 * AddRemarksDialog — legacy "Job CheckOut Remarks" layout (refreshed
 * 2026-05-19). Mirrors the JobOutcomeDialog structure pixel-for-pixel:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Job CheckOut Remarks                                 │  ← dark band
 *   ├──────────────────────────────────────────────────────┤
 *   │ Open Due To *  ◉ By Customer  ○ Client …             │
 *   │ Reason *       [SearchSelect dropdown ▾]             │
 *   │ Remarks *      [textarea…]                           │
 *   │                       [Submit]      [Cancel]         │
 *   └──────────────────────────────────────────────────────┘
 *
 * Submit POSTs to /admin/jobs/:id/comments with:
 *   {
 *     comments:        "[Open Due To: Client · Reason: <label>] <ops remark>",
 *     comment_on:      1,    // legacy "created" stage code
 *     enum_reason_id:  <id>  // picked from the reason dropdown
 *   }
 *
 * Reason list comes from GET /admin/jobs/comment-reasons which
 * returns `tbl_enum_reason` rows for the legacy "Others" pool
 * (enum_type=4 default). Operators see the same dropdown legacy
 * surfaces; new and old apps remain readable from each other.
 */
const REMARK_DUE_TO_OPTIONS: Array<'Customer' | 'Client' | 'EasyFix' | 'Technician'> = [
  'Customer', 'Client', 'EasyFix', 'Technician',
];
function AddRemarksDialog({ open, jobId, onClose, onSaved }: {
  open: boolean; jobId: number;
  onClose: () => void; onSaved: () => void;
}) {
  const [dueTo, setDueTo] = useState<string>('Customer');
  const [reasonId, setReasonId] = useState<string>('');
  const [text, setText] = useState('');
  const [reasons, setReasons] = useState<Array<{ id: number; label: string }>>([]);
  const [reasonsLoading, setReasonsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset on each open.
  useEffect(() => {
    if (open) { setDueTo('Customer'); setReasonId(''); setText(''); setErr(null); }
  }, [open]);

  // Fetch the reason list filtered by Open-Due-To. Legacy CRM's
  // dropdown narrows dynamically as the operator switches the radio
  // (verified against the screenshot's exact labels — those rows
  // live under user_type=2 / "Client" in action_taken_reason). The
  // refetch resets the picked reason since a stale id from a
  // different bucket would render as an opaque number.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReasonsLoading(true);
    setReasonId('');
    api.get<Array<{ id: number; label: string }>>('/admin/jobs/comment-reasons', {
      dueTo: dueTo.toLowerCase(),
    })
      .then((rows) => { if (!cancelled) setReasons(rows || []); })
      .catch(() => { if (!cancelled) setReasons([]); })
      .finally(() => { if (!cancelled) setReasonsLoading(false); });
    return () => { cancelled = true; };
  }, [open, dueTo]);

  const reasonOptions = React.useMemo(
    () => reasons.map((r) => ({ value: String(r.id), label: r.label })),
    [reasons],
  );

  async function go() {
    const remark = text.trim();
    if (!reasonId) { setErr('Please pick a reason.'); return; }
    if (!remark) { setErr('Please enter a remark before saving.'); return; }
    setLoading(true); setErr(null);
    try {
      const reasonLabel = reasons.find((r) => String(r.id) === reasonId)?.label || '';
      // Structured prefix is the same shape as JobOutcomeDialog so
      // ops can grep / parse remarks the same way regardless of which
      // popup created the row.
      const prefix = `[Open Due To: ${dueTo} · Reason: ${reasonLabel}]`;
      const payload = {
        comments: `${prefix} ${remark}`,
        comment_on: 1, // legacy "created" stage code — see commentBody Joi schema
        enum_reason_id: Number(reasonId),
      };
      await api.post(`/admin/jobs/${jobId}/comments`, payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to save remark');
    } finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-xl p-0 gap-0 overflow-hidden">
        {/* Dark-slate band header matching JobOutcomeDialog. */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900 text-white flex items-center gap-2.5 shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-sky-500/20 ring-1 ring-sky-400/40">
            <Pencil className="h-3.5 w-3.5 text-sky-300" />
          </span>
          <DialogTitle className="text-[15px] font-semibold tracking-tight">Job CheckOut Remarks</DialogTitle>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-[150px_1fr] items-center gap-3">
            <label className="text-sm font-medium text-right">
              Open Due To<span className="text-rose-600">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-4">
              {REMARK_DUE_TO_OPTIONS.map((opt) => (
                <label key={opt} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="add-remarks-due-to"
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
              Reason<span className="text-rose-600">*</span>
            </label>
            <SearchSelect
              value={reasonId}
              onChange={setReasonId}
              options={reasonOptions}
              placeholder={reasonsLoading ? 'Loading reasons…' : 'Select Reason'}
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
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write Comment…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40 resize-y"
              maxLength={2000}
            />
          </div>
          {err && <div className="text-sm text-red-600 text-right">{err}</div>}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button
              onClick={go}
              disabled={loading || !reasonId || !text.trim()}
              className="bg-teal-500 hover:bg-teal-600 text-white"
            >
              {loading ? 'Saving…' : 'Submit'}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Cancel With Reason dialog ──────────────────────────────────────
// Legacy `jobCancel.vm`. Reason picker comes from /api/shared/lookup/cancel-reasons
// (tbl_cancel_reason / job_cancel_reason_by_easyfixer_app per CLAUDE.md).
// PATCH /:id/status with status=6 + reasonId + comment.
function CancelWithReasonDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void;
  onSubmit: (reasonId: number, comment: string) => Promise<void>;
}) {
  const lk = useLookup();
  const [reasonId, setReasonId] = useState('');
  const [customReason, setCustomReason] = useState('');
  /*
   * `customMode` swaps the SearchSelect for a free-text input when the
   * operator can't find a matching DB reason. The cancel-reasons list
   * IS DB-sourced (tbl_cancel_reason / job_cancel_reason_by_easyfixer_app
   * — see CLAUDE.md table-name notes), so we don't pollute it with
   * ad-hoc entries. Instead, custom reasons are submitted with the
   * smallest valid reason_id as the FK (accounting buckets all "other"
   * cancellations under the same code) and the typed string is prepended
   * to the comment as `[Custom] <reason> — <operator comment>`, so the
   * audit trail still captures the operator's intent.
   */
  const [customMode, setCustomMode] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReasonId(''); setCustomReason(''); setCustomMode(false);
      setComment(''); setErr(null);
    }
  }, [open]);
  async function go() {
    let resolvedId: number;
    let resolvedComment = comment.trim();
    if (customMode) {
      if (!customReason.trim()) { setErr('Enter a custom reason'); return; }
      // Use the smallest reason id as the FK fallback. Audit detail
      // lives in the comment column, prefixed [Custom] for filtering.
      const fallback = (lk.cancelReasons[0]?.id) ?? 0;
      if (!fallback) { setErr('No cancel-reason rows seeded — ask ops to add one'); return; }
      resolvedId = fallback;
      resolvedComment = `[Custom] ${customReason.trim()}${resolvedComment ? ' — ' + resolvedComment : ''}`;
    } else {
      resolvedId = Number(reasonId);
      if (!resolvedId) { setErr('Cancel reason is required'); return; }
    }
    setLoading(true); setErr(null);
    try { await onSubmit(resolvedId, resolvedComment); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Cancel failed'); }
    finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel Job</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-sm font-medium">Cancellation Reason *</Label>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => { setCustomMode((m) => !m); setReasonId(''); setCustomReason(''); }}
              >
                {customMode ? 'Pick from list instead' : 'Reason not in list? Add custom'}
              </button>
            </div>
            {customMode ? (
              <Input
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Describe the cancellation reason…"
                maxLength={200}
              />
            ) : (
              /* SearchSelect — already searchable. Operator types to
                 filter; arrow keys + Enter to pick. */
              <SearchSelect
                value={reasonId}
                onChange={(v) => setReasonId(v)}
                options={lk.cancelReasons.map((r) => ({ value: r.id, label: r.reason }))}
                placeholder="Select a reason…"
              />
            )}
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Comment (optional)</Label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              placeholder="Additional context for the cancellation…"
              maxLength={500}
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={loading}>Back</Button>
            <Button variant="destructive" onClick={go} disabled={loading}>
              {loading ? 'Cancelling…' : 'Cancel Job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
