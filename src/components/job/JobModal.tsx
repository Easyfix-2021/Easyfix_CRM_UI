'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { Sparkles, Search, CalendarCheck, History, Eye, Plus, X, Pencil, CalendarPlus, CheckCircle2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Switch } from '@/components/ui/switch';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { AddressEditDialog, type EditableAddress } from './AddressEditDialog';
import { JobTransactionView } from './JobTransactionView';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName, statusColorClass, statusLabel } from '@/lib/utils';
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
function maskMobile(mob: unknown): string {
  if (mob == null || mob === '') return '—';
  const digits = String(mob).replace(/\D/g, '');
  if (!digits) return '—';
  return digits.slice(0, 4) + '•'.repeat(Math.max(0, digits.length - 4));
}
// Unconfirmed (CALL_LATER = 9) is intentionally excluded from canAssign
// and canCancel: ops should drive those orders through the dedicated
// Confirm-and-Schedule flow (purple CalendarCheck on the row), not
// directly assign/cancel from the View modal. Legacy CRM behaviour.
const canAssign         = (s: number) => [ST.BOOKED, ST.SCHEDULED, ST.ENQUIRY, ST.REVISIT].includes(s as never);
const canChangeOwner    = (s: number) => ![ST.COMPLETED, ST.COMPLETED_ALT, ST.CANCELLED].includes(s as never);
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
  useEffect(() => {
    if (!open) return;
    if (!jobId) { setJob(null); return; }
    setJob(null);            // hide stale header immediately
    setError(null);
    setLoading(true);
    (async () => {
      try { setJob(await api.get<Job>(`/admin/jobs/${jobId}`)); }
      catch { setError('Could not load job details'); }
      finally { setLoading(false); }
    })();
  }, [open, jobId]);

  async function refresh() {
    if (!jobId) return;
    try { setJob(await api.get<Job>(`/admin/jobs/${jobId}`)); }
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
            {/* ActionBar's buttons depend on the loaded job (status drives
                which actions are valid), so we wait until loading clears
                and `job` is populated. */}
            {mode === 'view' && !loading && job && (
              <ActionBar
                job={job}
                jobId={Number(jobId)}
                onChanged={() => { refresh(); onSaved?.(); }}
                onEdit={() => setMode('edit')}
              />
            )}
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
              : <ViewBody job={job} />
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
              onCancel={onClose}
              onSaved={(saved) => {
                setJob(saved); setMode('view'); onSaved?.();
              }}
            />
          )}
        </div>

        {mode === 'view' && (
          <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-between gap-2">
            {/* Left side: "Add Remarks" for Unconfirmed (status=9) jobs.
                Mirrors the legacy "Job Transaction → Add Remarks"
                affordance ops uses to log follow-up notes on orders
                that aren't yet booked. Writes to tbl_job_comment (the
                same store legacy uses) via POST /admin/jobs/:id/comments
                with comment_on=1 (the "created" stage code from the
                Joi schema). Rendered only when we have a job loaded so
                it doesn't flash during the initial fetch. */}
            <div>
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
            <Button variant="outline" onClick={onClose}>Close</Button>
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
      {can.isJobEdit && <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>}
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
      {can.isJobEdit && <Button size="sm" variant="outline" onClick={() => setRescheduleOpen(true)}>Reschedule</Button>}
      {can.isJobEdit && <Button size="sm" variant="outline" onClick={() => setDescOpen(true)}>Edit Description</Button>}
      {can.isJobEdit && <Button size="sm" variant="outline" onClick={() => setFeedbackOpen(true)}>Feedback</Button>}
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
          await api.patch(`/admin/jobs/${jobId}`, {
            requested_date_time: date,
            time_slot: slot || null,
          });
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

function ViewBody({ job }: { job: Job }) {
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
        <div className="grid md:grid-cols-2 gap-5">
          <DlCard title="Customer" rows={[
            ['Name', job.customer_name], ['Mobile', maskMobile(job.customer_mob_no)], ['Email', job.customer_email],
          ]}/>
          <DlCard title="Address" rows={[
            ['Address', job.address], ['Building', job.building], ['Landmark', job.landmark],
            ['City', job.city_name], ['PIN', job.pin_code], ['GPS', job.gps_location],
          ]}/>
          <DlCard title="Client" rows={[
            ['Client', job.client_name], ['Ref ID', job.client_ref_id], ['SPOC', job.client_spoc_name],
            ['SPOC email', job.client_spoc_email], ['SPOC phone', job.client_spoc],
          ]}/>
          <DlCard title="Job meta" rows={[
            ['Job ID', job.job_id], ['Reference', job.job_reference_id],
            ['Type', job.job_type], ['Source', job.source_type],
            ['Owner', job.owner_name], ['Created by', job.created_by_name],
            ['Description', job.job_desc],
          ]}/>
        </div>
      </TabsContent>

      <TabsContent value="services">
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="data-table">
            <thead><tr><th>#</th><th>Service type</th><th>Category</th><th>Qty</th><th>Status</th></tr></thead>
            <tbody>
              {(Array.isArray(job.services) ? job.services : []).length === 0 && (
                <tr><td colSpan={5} className="text-center text-muted-foreground py-8">No services on this job</td></tr>
              )}
              {(Array.isArray(job.services) ? job.services : []).map((s, i) => {
                const sr = s as Record<string, unknown>;
                return (
                  <tr key={i}>
                    <td className="text-xs text-muted-foreground">{String(sr.job_service_id ?? '')}</td>
                    <td>{String(sr.service_type_name ?? '—')}</td>
                    <td>{String(sr.service_catg_name ?? '—')}</td>
                    <td>{String(sr.quantity ?? '')}</td>
                    <td>{sr.job_service_status ? 'Active' : 'Inactive'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
            ['Tech mobile',  job.easyfixer_mobile],
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
        <JobMaterialsTab jobId={job.job_id as number} />
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
  total_price?: number | string | null;
  status?: string | null;
  insert_date?: string | null;
};

function JobQuotationsTab({ jobId }: { jobId: number }) {
  const [rows, setRows] = useState<QuotationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const data = await api.get<QuotationRow[]>(`/admin/quotations?jobId=${jobId}`);
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load quotations');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

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
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const type = String(r.quotation_type ?? '—');
              const name = String(r.product_name ?? r.material_name ?? '—');
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
                  <td className="!text-center text-xs">{String(r.status ?? '—')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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

function JobMaterialsTab({ jobId }: { jobId: number }) {
  const [items, setItems] = useState<JobMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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
    if (!window.confirm('Remove this material line item?')) return;
    try {
      await api.delete(`/admin/aux/materials/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed');
    }
  }

  const totalCost = items.reduce((sum, it) => sum + (Number(it.total_price) || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {items.length} line item{items.length === 1 ? '' : 's'} · Total: ₹{totalCost.toFixed(2)}
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>Add Material</Button>
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
                    <button onClick={() => deleteItem(m.id)} className="text-xs text-red-600 hover:underline">Delete</button>
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

function JobForm({ mode, initial, onCancel, onSaved, prefillCustomer }: {
  mode: 'create' | 'edit' | 'confirm';
  initial: Job | null;
  onCancel: () => void;
  onSaved: (saved: Job) => void;
  prefillCustomer?: PrefillCustomer;
}) {
  const lk = useLookup();
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
    try {
      if (isEditShape && initial) {
        const patch: Record<string, unknown> = {};
        if (f.job_type)             patch.job_type = f.job_type;
        if (f.source_type)          patch.source_type = f.source_type;
        if (f.requested_date_time)  patch.requested_date_time = new Date(f.requested_date_time).toISOString();
        if (f.time_slot)            patch.time_slot = f.time_slot;
        if (f.job_desc !== undefined) patch.job_desc = f.job_desc;
        if (f.client_ref_id !== undefined) patch.client_ref_id = f.client_ref_id;
        // Confirm flow always sends services (even empty array == "no services"),
        // since ops may have removed rows they'd previously picked. Plain edit
        // skips services to preserve historical rows untouched.
        if (isConfirm) {
          patch.services = buildServicesPayload();
          // Customer name is written to tbl_job.job_customer_name
          // (the per-job copy) — NOT the master tbl_customer row.
          // This lets the same mobile carry a different per-job
          // display name without mutating the customer master.
          // Email still updates the master record because it's a
          // contact channel, not a per-job alias.
          patch.job_customer_name = f.customer_name;
          patch.customer = {
            customer_email: f.customer_email,
          };
          patch.address = {
            address:      f.address,
            building:     f.building,
            landmark:     f.landmark,
            city_id:      Number(f.city_id) || undefined,
            pin_code:     f.pin_code,
            gps_location: f.gps_location,
          };
          // Products-section fields from legacy addEditJob. We reuse `remarks`
          // for Special Comments and `efr_special_notes` for the
          // "Anything Handyman should keep in mind?" prompt (both are already
          // in MUTABLE_COLUMNS). `fk_service_type_id` / `fk_service_catg_id`
          // carry the active filter selection.
          if (f.remarks !== undefined) patch.remarks = f.remarks;
          if (f.efr_special_notes !== undefined) patch.efr_special_notes = f.efr_special_notes;
          if (typeof f.helper_req === 'boolean') patch.helper_req = f.helper_req;
          if (f.fk_service_catg_id) patch.fk_service_catg_id = Number(f.fk_service_catg_id);
          if (f.fk_service_type_id) patch.fk_service_type_id = Number(f.fk_service_type_id);
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
          await api.patch(`/admin/jobs/${initial.job_id}/status`, { status: targetStatus });
        }
        onSaved(saved);
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
            city_id: Number(f.city_id),
            pin_code: f.pin_code,
            gps_location: f.gps_location || undefined,
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
            const tabImage = override.job_image_file ?? (created.length === 1 ? imageFile : null);
            if (tabImage instanceof File && saved?.job_id) {
              try {
                const fd = new FormData();
                fd.append('file', tabImage);
                await api.post(`/admin/jobs/${saved.job_id}/images`, fd);
              } catch (upErr) {
                // eslint-disable-next-line no-console
                console.warn(`Image upload failed for job ${saved.job_id}:`, upErr);
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
      setError(err instanceof ApiError
        ? err.message + (err.details ? ` — ${JSON.stringify(err.details)}` : '')
        : 'Failed to save');
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
      <form onSubmit={submit} className="space-y-4">
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
            {/* Mobile is masked (first-4 + bullets) for PII — the
                `tel:` href still uses the full number so click-to-call
                works seamlessly. */}
            <a href={`tel:${initial.customer_mob_no}`} className="text-sky-800 hover:underline font-semibold tabular-nums">
              ☎ {maskMobile(initial.customer_mob_no)}
            </a>
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
              {/* Read-only in confirm — operators can't edit the
                  customer's mobile after the order was created. Masked
                  for PII. */}
              <Input value={maskMobile(f.customer_mob_no)} readOnly disabled className="tabular-nums" />
            </Field>
            <Field label="Customer Email">
              <Input type="email" value={f.customer_email} onChange={(e) => set('customer_email', e.target.value)} />
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
            <Field label="Complete Address *" full>
              <Input required value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="House/flat, street, area" />
            </Field>
            <Field label="Landmark">
              <Input value={f.landmark} onChange={(e) => set('landmark', e.target.value)} />
            </Field>
            <Field label="Pincode *">
              <Input required pattern="[0-9]{6}" value={f.pin_code} onChange={(e) => set('pin_code', e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="City *">
              <SearchSelect required value={f.city_id} onChange={(v) => set('city_id', v)} placeholder="— Select city —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} />
            </Field>
            <Field label="GPS Coordinates">
              <Input value={f.gps_location} onChange={(e) => set('gps_location', e.target.value)} placeholder="28.6139,77.2090" />
            </Field>
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
              <Input
                type="file"
                accept="image/*,.pdf"
                onChange={(e) => setJobField('job_image_file', e.target.files?.[0] || null)}
              />
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
            <Field label="Special Comments *" full>
              <textarea
                required
                rows={2}
                value={getJobField('remarks') ?? ''}
                onChange={(e) => setJobField('remarks', e.target.value)}
                className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                placeholder="Any special notes visible to ops"
              />
            </Field>
            <Field label="Anything Handyman should keep in mind? *" full>
              <textarea
                required
                rows={2}
                value={getJobField('efr_special_notes') ?? ''}
                onChange={(e) => setJobField('efr_special_notes', e.target.value)}
                className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                placeholder="Notes for the technician"
              />
            </Field>
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
          onSubmit={({ dueTo, reason, remarks }) => {
            const mode = outcomeDialog?.mode ?? 'unreachable';
            const tag = mode === 'unreachable' ? 'Unreachable' : 'Enquiry';
            const dueLabel = mode === 'unreachable' ? 'Pending Due To' : 'Open Due To';
            const prefix = `[${tag} · ${dueLabel}: ${dueTo} · Reason: ${reason}]`;
            const merged = remarks ? `${prefix} ${remarks}` : prefix;
            setF((s) => ({ ...s, remarks: merged }));
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
    <form onSubmit={submit} className="space-y-5">
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
              {/* Schedule sub-block — Date / Time / Booking Slot.
                  Legacy layout placed these inside Customer Details
                  (the screenshot shows "Requested Date / Requested
                  Time / Booking Time Slot" as separate rows). Time
                  picker is hourly with min-time-for-today gating;
                  Booking Slot auto-derives from the picked hour but
                  remains operator-editable. */}
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
                            if (!confirm('Delete this saved address?')) return;
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
                            } catch (err) {
                              alert(err instanceof ApiError ? err.message : 'Delete failed');
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Google Places-backed autosuggest. Operator types →
                  debounced backend proxy hits Google → suggestions
                  drop. Picking a suggestion auto-fills GPS + tries
                  to match City + PIN from the geocoded components.
                  Free-typing a custom address still works (no
                  Google match → just persists the typed string). */}
              <Field label="Address *" full>
                <AddressAutocomplete
                  required
                  value={f.address}
                  onChange={(v) => set('address', v)}
                  onPick={(p) => {
                    setF((s) => ({
                      ...s,
                      address: p.description,
                      // GPS is "<lat>,<lng>" — matches the legacy
                      // tbl_address.gps_location format.
                      gps_location: p.lat != null && p.lng != null
                        ? `${p.lat},${p.lng}`
                        : s.gps_location,
                      // Auto-fill PIN if Google returned one.
                      pin_code: p.components.postal_code || s.pin_code,
                      // City matching: look up the picked city name in
                      // the lookup options and snap to its city_id.
                      // If no match, leave the operator to pick
                      // manually (won't blank a previous selection).
                      city_id: (() => {
                        const wanted = (p.components.city || '').toLowerCase();
                        if (!wanted) return s.city_id;
                        const hit = lk.toOpts.cities.find(
                          (o) => String(o.label).toLowerCase() === wanted
                        );
                        return hit ? String(hit.value) : s.city_id;
                      })(),
                    }));
                  }}
                  placeholder="Start typing — Google will suggest matches"
                />
              </Field>
              <Field label="Building"><Input value={f.building} onChange={(e) => set('building', e.target.value)} /></Field>
              <Field label="City *"><SearchSelect required value={f.city_id} onChange={(v) => set('city_id', v)} placeholder="— Select city —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} /></Field>
              <Field label="PIN *"><Input required pattern="[0-9]{6}" value={f.pin_code} onChange={(e) => set('pin_code', e.target.value.replace(/\D/g, ''))} /></Field>
              {/* GPS field: auto-populated by the address autosuggest
                  pick. Disabled — operators don't hand-edit lat/lng;
                  if it's wrong, picking a different address fixes
                  it (or re-geocoding via the address edit flow). */}
              <Field label="GPS (auto-detected)">
                <Input
                  value={f.gps_location}
                  readOnly
                  disabled
                  placeholder="Auto-filled from address selection"
                />
              </Field>
            </div>
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
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setJobField('job_image_file', e.target.files?.[0] || null)}
                  />
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
        onSubmit={({ dueTo, reason, remarks }) => {
          const mode = outcomeDialog?.mode ?? 'unreachable';
          const tag = mode === 'unreachable' ? 'Unreachable' : 'Enquiry';
          const dueLabel = mode === 'unreachable' ? 'Pending Due To' : 'Open Due To';
          const prefix = `[${tag} · ${dueLabel}: ${dueTo} · Reason: ${reason}]`;
          // Preserve any existing remarks the operator typed below
          // the structured prefix.
          const merged = remarks ? `${prefix} ${remarks}` : prefix;
          setF((s) => ({ ...s, remarks: merged }));
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
  onSubmit: (payload: { dueTo: string; reason: string; remarks: string }) => void;
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
    onSubmit({ dueTo, reason, remarks: remarks.trim() });
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
              <dd className="font-medium text-right break-all max-w-[60%]">{v == null || v === '' ? '—' : String(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
