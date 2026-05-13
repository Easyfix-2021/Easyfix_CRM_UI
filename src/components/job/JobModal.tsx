'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Search, CalendarCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SearchSelect } from '@/components/ui/search-select';
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
const canAssign         = (s: number) => [ST.BOOKED, ST.SCHEDULED, ST.ENQUIRY, ST.CALL_LATER, ST.REVISIT].includes(s as never);
const canChangeOwner    = (s: number) => ![ST.COMPLETED, ST.COMPLETED_ALT, ST.CANCELLED].includes(s as never);
const canStart          = (s: number) => [ST.SCHEDULED, ST.REVISIT].includes(s as never);
const canComplete       = (s: number) => s === ST.IN_PROGRESS;
const canCancel         = (s: number) => [ST.BOOKED, ST.SCHEDULED, ST.IN_PROGRESS, ST.ENQUIRY, ST.CALL_LATER, ST.REVISIT].includes(s as never);
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
  const title = mode === 'create'  ? 'Create New Job'
             : mode === 'edit'    ? `Edit Job #${jobId}`
             : mode === 'confirm' ? `Confirm & Schedule · Job #${jobId}`
             : loading            ? 'Loading job…'
             : job                ? `Job #${job.job_id}`
             :                       'Job';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* Fixed-height modal so different tabs (Summary / Services / Schedule)
          don't cause the whole dialog to jump in size as the user switches.
          hideClose drops the top-right X since we have a footer Close button. */}
      <DialogContent hideClose className="max-w-5xl w-[min(95vw,1100px)] h-[85vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <div className="flex items-start justify-between gap-3">
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
          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {error && !job && <div className="text-sm text-destructive">{error}</div>}
          {!loading && mode === 'view' && job && <ViewBody job={job} />}
          {!loading && mode !== 'view' && (
            <JobForm
              mode={mode}
              initial={job}
              onCancel={onClose}
              onSaved={(saved) => {
                // Flip a newly-created job into view mode so the user can immediately
                // act on it (assign, start, etc.) without a page round-trip.
                if (mode === 'create' && saved?.job_id) {
                  setJob(saved); setMode('view'); onSaved?.();
                } else {
                  setJob(saved); setMode('view'); onSaved?.();
                }
              }}
            />
          )}
        </div>

        {mode === 'view' && (
          <div className="px-6 py-3 border-t bg-muted/30 flex justify-end">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        )}
      </DialogContent>
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
            ['Name', job.customer_name], ['Mobile', job.customer_mob_no], ['Email', job.customer_email],
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
            <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
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
function JobImagesTab({ images }: { images: Array<Record<string, unknown>> }) {
  // Image storage convention from CLAUDE.md: filenames are stored bare; the
  // public URL is `/easydoc/upload_jobs/<filename>`. Mirrors legacy CRM
  // exactly (Nginx serves the easydoc tree).
  const prefix = '/easydoc/upload_jobs/';
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
        const filename = String(img.image ?? '');
        const stage    = String(img.job_stage ?? '');
        const category = String(img.image_category ?? '');
        if (!filename) return null;
        return (
          <a
            key={id}
            href={`${prefix}${filename}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block border rounded-md overflow-hidden hover:shadow-sm transition-shadow"
            title={`${stage}${category ? ` · ${category}` : ''}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${prefix}${filename}`}
              alt={stage || filename}
              className="w-full h-32 object-cover bg-muted"
              loading="lazy"
            />
            <div className="px-2 py-1 text-[10px] text-muted-foreground truncate">
              {stage || category || filename}
            </div>
          </a>
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
  charge_type: string | null;
  total_amount: number | string | null;  // DECIMAL from MySQL comes as string
  service_status: number;
  service_type_name: string | null;
  service_catg_name: string | null;
  crc_ratecard_name: string | null;
};

// A row in the form's local service basket. `tempId` is a render key — not
// sent to backend (the real key is `client_service_id` once selected).
type ServiceRow = { tempId: number; client_service_id: string; quantity: string };

function JobForm({ mode, initial, onCancel, onSaved }: {
  mode: 'create' | 'edit' | 'confirm';
  initial: Job | null;
  onCancel: () => void;
  onSaved: (saved: Job) => void;
}) {
  const lk = useLookup();
  const isEdit    = mode === 'edit';
  const isConfirm = mode === 'confirm';
  // "Edit-shaped" modes share the compact layout (no client re-pick, no
  // customer/address rewrite) but confirm mode ALSO shows the services basket
  // so ops can add rate-carded products before promoting the job.
  const isEditShape = isEdit || isConfirm;

  const [f, setF] = useState(() => toFormShape(initial));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Services basket (create flow only) ───────────────────────────────
  // `clientServices` is the catalog for the currently-picked client (null = not
  // loaded yet, [] = loaded but empty). `serviceRows` is what the user has
  // picked so far — editable grid, live amount computed from total_amount × qty.
  const [clientServices, setClientServices] = useState<ClientService[] | null>(null);
  const [loadingServices, setLoadingServices] = useState(false);
  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([]);

  useEffect(() => { setF(toFormShape(initial)); }, [initial]);

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

  function set<K extends keyof typeof f>(k: K, v: (typeof f)[K]) { setF((s) => ({ ...s, [k]: v })); }

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
          patch.customer = {
            customer_name:  f.customer_name,
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
        // Confirm flow → immediately promote status 9 (Unconfirmed) → 0 (BOOKED).
        // This mirrors legacy `Book Call` which did save+promote atomically.
        if (isConfirm) {
          await api.patch(`/admin/jobs/${initial.job_id}/status`, { status: 0 });
        }
        onSaved(saved);
      } else {
        // Create flow — full payload including customer + address + services.
        const servicesPayload = buildServicesPayload();

        const payload = {
          fk_client_id: Number(f.fk_client_id),
          job_type: f.job_type,
          source_type: f.source_type,
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
        };
        const saved = await api.post<Job>('/admin/jobs', payload);
        onSaved(saved);
      }
    } catch (err) {
      setError(err instanceof ApiError
        ? err.message + (err.details ? ` — ${JSON.stringify(err.details)}` : '')
        : 'Failed to save');
    } finally { setSubmitting(false); }
  }

  /*
   * Confirm-mode UX: top summary strip + 3 numbered sections replicating the
   * legacy `addEditJob?loc=home` modal structure. Rendered as a separate
   * branch from the edit/create flow so each layout stays readable.
   */
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
            <a href={`tel:${initial.customer_mob_no}`} className="text-sky-800 hover:underline font-semibold">
              ☎ {String(initial.customer_mob_no ?? '—')}
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
        <NumberedSection num={1} title="Client Details">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Client">
              <Input value={String(initial.client_name ?? '')} readOnly disabled />
            </Field>
            <Field label="Client Reference ID *">
              <Input required value={f.client_ref_id} onChange={(e) => set('client_ref_id', e.target.value)} placeholder="Ticket or order ID" />
            </Field>
            <Field label="Client SPOC Phone">
              <Input value={String(initial.client_spoc ?? '')} readOnly disabled />
            </Field>
            <Field label="Client SPOC Name">
              <Input value={String(initial.client_spoc_name ?? '')} readOnly disabled />
            </Field>
            <Field label="Client SPOC Email">
              <Input value={String(initial.client_spoc_email ?? '')} readOnly disabled />
            </Field>
          </div>
        </NumberedSection>

        {/* ── 2 · Customer Details ───────────────────────────────────────── */}
        <NumberedSection num={2} title="Customer Details">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Customer Name *">
              <Input required value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} />
            </Field>
            <Field label="Mobile Number">
              <Input value={f.customer_mob_no} readOnly disabled />
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
        </NumberedSection>

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
        <NumberedSection num={3} title="Select Products">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <Field label="Service Category *">
              <SearchSelect
                required
                value={f.fk_service_catg_id}
                onChange={(v) => set('fk_service_catg_id', v)}
                placeholder="— Select category —"
                options={lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }))}
              />
            </Field>
            <Field label="Service Type *">
              <SearchSelect
                required
                value={f.fk_service_type_id}
                onChange={(v) => set('fk_service_type_id', v)}
                placeholder="— Select service type —"
                options={lk.toOpts.serviceTypes.map((o) => ({ value: o.value, label: String(o.label) }))}
              />
            </Field>
            <Field label="Job Type *">
              <Select
                value={f.job_type}
                onChange={(e) => set('job_type', e.target.value)}
                options={[
                  { value: 'Installation',   label: 'Installation' },
                  { value: 'Repair',         label: 'Repair' },
                  { value: 'Uninstallation', label: 'Uninstallation' },
                  { value: 'Maintenance',    label: 'Maintenance' },
                  { value: 'Demo',           label: 'Demo' },
                  { value: 'Inspection',     label: 'Inspection' },
                ]}
              />
            </Field>
          </div>

          <div className="mb-4">
            <Label className="mb-2 block">Products from client rate card</Label>
            <ServicesBasket
              clientPicked
              services={clientServices}
              loading={loadingServices}
              rows={serviceRows}
              setRows={setServiceRows}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t">
            <Field label="Job Image">
              <Input type="file" accept="image/*,.pdf" onChange={() => { /* wired when upload endpoint is ready */ }} />
            </Field>
            <Field label="Helper Required">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-sky-600"
                  checked={Boolean(f.helper_req)}
                  onChange={(e) => set('helper_req', e.target.checked)}
                />
                <span>{f.helper_req ? 'Yes' : 'No'}</span>
              </label>
            </Field>
            <Field label="Material Required">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-sky-600"
                  checked={Boolean(f.material_req)}
                  onChange={(e) => set('material_req', e.target.checked)}
                />
                <span>{f.material_req ? 'Yes' : 'No'}</span>
              </label>
            </Field>
            <Field label="Special Comments *" full>
              <textarea
                required
                rows={2}
                value={f.remarks}
                onChange={(e) => set('remarks', e.target.value)}
                className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                placeholder="Any special notes visible to ops"
              />
            </Field>
            <Field label="Anything Handyman should keep in mind? *" full>
              <textarea
                required
                rows={2}
                value={f.efr_special_notes}
                onChange={(e) => set('efr_special_notes', e.target.value)}
                className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                placeholder="Notes for the technician"
              />
            </Field>
            <Field label="Collected By *">
              <Select
                value={f.collected_by}
                onChange={(e) => set('collected_by', e.target.value)}
                options={[
                  { value: 'Easyfix', label: 'Easyfix' },
                  { value: 'Client',  label: 'Client' },
                ]}
              />
            </Field>
          </div>
        </NumberedSection>

        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <LoadBtn
            type="submit"
            loading={submitting}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            Confirm &amp; Schedule (Book Call)
          </LoadBtn>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {!isEditShape && (
        <Section title="Client & Schedule">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Client *"><SearchSelect required value={f.fk_client_id} onChange={(v) => set('fk_client_id', v)} placeholder="— Select client —" options={lk.toOpts.clients.map((o) => ({ value: o.value, label: String(o.label) }))} /></Field>
            <Field label="Source"><Select value={f.source_type} onChange={(e) => set('source_type', e.target.value)} options={[
              { value: 'manual', label: 'Manual (CRM)' },
              { value: 'dashboard', label: 'Client Dashboard' },
              { value: 'excel', label: 'Excel Upload' },
              { value: 'api', label: 'API Integration' },
            ]} /></Field>
            <Field label="Job Type"><Select value={f.job_type} onChange={(e) => set('job_type', e.target.value)} options={[
              { value: 'Installation', label: 'Installation' }, { value: 'Repair', label: 'Repair' },
              { value: 'Uninstallation', label: 'Uninstallation' }, { value: 'Maintenance', label: 'Maintenance' },
              { value: 'Demo', label: 'Demo' }, { value: 'Inspection', label: 'Inspection' },
            ]} /></Field>
          </div>
        </Section>
      )}

      <Section title={isEditShape ? 'Schedule & Type' : 'Schedule'}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Requested Date/Time *"><Input required type="datetime-local" min={nowLocalIso()} value={f.requested_date_time} onChange={(e) => set('requested_date_time', e.target.value)} /></Field>
          <Field label="Time Slot"><Select value={f.time_slot} onChange={(e) => set('time_slot', e.target.value)} options={[
            { value: 'Morning 9 to 2', label: 'Morning 9 to 2' },
            { value: 'Afternoon 12 to 5', label: 'Afternoon 12 to 5' },
            { value: 'Evening 2 to 7', label: 'Evening 2 to 7' },
            { value: 'Anytime', label: 'Anytime' },
          ]} /></Field>
          <Field label="Client Ref ID"><Input value={f.client_ref_id} onChange={(e) => set('client_ref_id', e.target.value)} /></Field>
          {isEditShape && (
            <Field label="Job Type"><Select value={f.job_type} onChange={(e) => set('job_type', e.target.value)} options={[
              { value: 'Installation', label: 'Installation' }, { value: 'Repair', label: 'Repair' },
              { value: 'Uninstallation', label: 'Uninstallation' }, { value: 'Maintenance', label: 'Maintenance' },
              { value: 'Demo', label: 'Demo' }, { value: 'Inspection', label: 'Inspection' },
            ]} /></Field>
          )}
          <Field label="Description" full><Input value={f.job_desc} onChange={(e) => set('job_desc', e.target.value)} placeholder="Scope of work" /></Field>
        </div>
      </Section>

      {!isEditShape && (
        <>
          <Section title="Customer">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Name *"><Input required value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></Field>
              <Field label="Mobile *"><Input required pattern="[0-9]{10}" value={f.customer_mob_no} onChange={(e) => set('customer_mob_no', e.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="Email"><Input type="email" value={f.customer_email} onChange={(e) => set('customer_email', e.target.value)} /></Field>
            </div>
          </Section>

          <Section title="Address">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Address *" full><Input required value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
              <Field label="Building"><Input value={f.building} onChange={(e) => set('building', e.target.value)} /></Field>
              <Field label="City *"><SearchSelect required value={f.city_id} onChange={(v) => set('city_id', v)} placeholder="— Select city —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} /></Field>
              <Field label="PIN *"><Input required pattern="[0-9]{6}" value={f.pin_code} onChange={(e) => set('pin_code', e.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="GPS"><Input value={f.gps_location} onChange={(e) => set('gps_location', e.target.value)} placeholder="28.6139,77.2090" /></Field>
            </div>
          </Section>

          <Section title="Services">
            <ServicesBasket
              clientPicked={!!f.fk_client_id}
              services={clientServices}
              loading={loadingServices}
              rows={serviceRows}
              setRows={setServiceRows}
            />
          </Section>
        </>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <LoadBtn
          type="submit"
          loading={submitting}
          className={isConfirm ? 'bg-purple-600 hover:bg-purple-700 text-white' : undefined}
        >
          {isConfirm ? 'Confirm & Schedule (Book Call)' : isEdit ? 'Save changes' : 'Create Job'}
        </LoadBtn>
      </div>
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
  // SearchSelect options — label packs type + category + rate so ops can
  // disambiguate when the same service type appears on multiple rate cards.
  const options = (services ?? []).map((s) => {
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
        const filteredOptions = options.filter((o) => !pickedElsewhere.has(o.value) || o.value === row.client_service_id);
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
  return {
    fk_client_id: pick('fk_client_id'),
    job_type: pick('job_type') || 'Installation',
    source_type: pick('source_type') || 'manual',
    requested_date_time: dt('requested_date_time'),
    time_slot: pick('time_slot') || 'Morning 9 to 2',
    job_desc: pick('job_desc'),
    client_ref_id: pick('client_ref_id'),
    customer_name: pick('customer_name'), customer_mob_no: pick('customer_mob_no'), customer_email: pick('customer_email'),
    address: pick('address'), building: pick('building'), landmark: pick('landmark'),
    city_id: pick('city_id'), pin_code: pick('pin_code'), gps_location: pick('gps_location'),
    // Section-3 / Products metadata — matches legacy addEditJob fields.
    remarks: pick('remarks'),
    efr_special_notes: pick('efr_special_notes'),
    helper_req: Boolean(j?.helper_req),
    material_req: Boolean(j?.material_req),
    collected_by: pick('collected_by') || 'Easyfix',
    fk_service_catg_id: pick('fk_service_catg_id'),
    fk_service_type_id: pick('fk_service_type_id'),
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="px-5 py-3 border-b bg-muted/30"><h3 className="text-sm font-semibold">{title}</h3></div>
      <div className="p-5">{children}</div>
    </section>
  );
}

/*
 * Numbered section — matches the legacy addEditJob modal's "1 Client Details,
 * 2 Customer Details, 3 Select Products" layout. The leading badge gives ops
 * a familiar visual anchor when confirming unconfirmed orders.
 */
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
            <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
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
            <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button onClick={go} disabled={loading}>{loading ? 'Saving…' : 'Save'}</Button>
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
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setReasonId(''); setComment(''); setErr(null); }
  }, [open]);
  async function go() {
    const id = Number(reasonId);
    if (!id) { setErr('Cancel reason is required'); return; }
    setLoading(true); setErr(null);
    try { await onSubmit(id, comment.trim()); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Cancel failed'); }
    finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel Job</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium block mb-1">Cancellation Reason *</Label>
            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value="">Select a reason…</option>
              {lk.cancelReasons.map((r) => (
                <option key={r.id} value={r.id}>{r.reason}</option>
              ))}
            </select>
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
            <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
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
