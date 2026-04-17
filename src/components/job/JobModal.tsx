'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SearchSelect } from '@/components/ui/search-select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, statusColorClass, statusLabel } from '@/lib/utils';

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

export type JobModalMode = 'create' | 'edit' | 'view';

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
  useEffect(() => {
    if (!open) return;
    if (!jobId) { setJob(null); return; }
    (async () => {
      setLoading(true); setError(null);
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

  const title = mode === 'create' ? 'Create New Job'
             : mode === 'edit'   ? `Edit Job #${jobId}`
             : job ? `Job #${job.job_id}` : 'Job';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* Fixed-height modal so different tabs (Summary / Services / Schedule)
          don't cause the whole dialog to jump in size as the user switches. */}
      <DialogContent className="max-w-5xl w-[min(95vw,1100px)] h-[85vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate">{title}</DialogTitle>
              {mode === 'view' && job && (
                <DialogDescription className="mt-1 flex items-center gap-2">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(Number(job.job_status))}`}>
                    {statusLabel(Number(job.job_status))}
                  </span>
                  <span className="text-xs">{String(job.job_type ?? '')}</span>
                </DialogDescription>
              )}
            </div>
            {mode === 'view' && job && (
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

type BusyKey = 'start' | 'complete' | 'cancel' | 'incomplete' | 'assign' | 'owner' | null;

function ActionBar({ job, jobId, onChanged, onEdit }: {
  job: Job; jobId: number; onChanged: () => void; onEdit: () => void;
}) {
  const s = Number(job.job_status);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);

  async function doStatus(key: BusyKey, status: number, reasonId?: number, comment?: string) {
    setBusy(key);
    try { await api.patch(`/admin/jobs/${jobId}/status`, { status, reasonId, comment }); onChanged(); }
    finally { setBusy(null); }
  }

  return (
    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
      <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
      {canAssign(s)         && <Button size="sm" onClick={() => setAssignOpen(true)}>{job.fk_easyfixter_id ? 'Reassign' : 'Assign'}</Button>}
      {canChangeOwner(s)    && <Button size="sm" variant="outline" onClick={() => setOwnerOpen(true)}>Change Owner</Button>}
      {canStart(s)          && <LoadBtn size="sm" variant="outline" loading={busy === 'start'}      onClick={() => doStatus('start', ST.IN_PROGRESS)}>Start</LoadBtn>}
      {canComplete(s)       && <LoadBtn size="sm" variant="outline" loading={busy === 'complete'}   onClick={() => doStatus('complete', ST.COMPLETED)}>Complete</LoadBtn>}
      {canCancel(s)         && <LoadBtn size="sm" variant="destructive" loading={busy === 'cancel'} onClick={() => doStatus('cancel', ST.CANCELLED, 1, 'Cancelled from CRM')}>Cancel</LoadBtn>}
      {canMarkIncomplete(s) && <LoadBtn size="sm" variant="outline" loading={busy === 'incomplete'} onClick={() => doStatus('incomplete', ST.REVISIT, undefined, 'Marked incomplete from CRM')}>Mark InComplete</LoadBtn>}

      <AssignDialog
        open={assignOpen} onClose={() => setAssignOpen(false)}
        currentTech={job.fk_easyfixter_id as number | null}
        onSubmit={async (efrId) => {
          await api.patch(`/admin/jobs/${jobId}/assign`, { easyfixerId: efrId });
          setAssignOpen(false); onChanged();
        }}
      />
      <ChangeOwnerDialog
        open={ownerOpen} onClose={() => setOwnerOpen(false)}
        onSubmit={async (newOwnerId, reason) => {
          await api.patch(`/admin/jobs/${jobId}/owner`, { newOwnerId, reason });
          setOwnerOpen(false); onChanged();
        }}
      />
    </div>
  );
}

// ─── View body (tabbed read-only display) ────────────────────────────────────

function ViewBody({ job }: { job: Job }) {
  return (
    <Tabs defaultValue="summary">
      <TabsList>
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="services">Services ({Array.isArray(job.services) ? job.services.length : 0})</TabsTrigger>
        <TabsTrigger value="schedule">Schedule</TabsTrigger>
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
            ['Technician',   job.easyfixer_name],
            ['Tech mobile',  job.easyfixer_mobile],
            ['Helper req',   job.helper_req ? 'Yes' : 'No'],
            ['Time slot',    job.time_slot],
          ]}/>
        </div>
      </TabsContent>
    </Tabs>
  );
}

// ─── Create/Edit form (condensed — essential fields, detail form lives on /jobs/new for now) ─

function JobForm({ mode, initial, onCancel, onSaved }: {
  mode: 'create' | 'edit';
  initial: Job | null;
  onCancel: () => void;
  onSaved: (saved: Job) => void;
}) {
  const lk = useLookup();
  const isEdit = mode === 'edit';

  const [f, setF] = useState(() => toFormShape(initial));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setF(toFormShape(initial)); }, [initial]);

  function set<K extends keyof typeof f>(k: K, v: (typeof f)[K]) { setF((s) => ({ ...s, [k]: v })); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSubmitting(true);
    try {
      if (isEdit && initial) {
        const patch: Record<string, unknown> = {};
        if (f.job_type)             patch.job_type = f.job_type;
        if (f.source_type)          patch.source_type = f.source_type;
        if (f.requested_date_time)  patch.requested_date_time = new Date(f.requested_date_time).toISOString();
        if (f.time_slot)            patch.time_slot = f.time_slot;
        if (f.job_desc !== undefined) patch.job_desc = f.job_desc;
        if (f.client_ref_id !== undefined) patch.client_ref_id = f.client_ref_id;
        const saved = await api.patch<Job>(`/admin/jobs/${initial.job_id}`, patch);
        onSaved(saved);
      } else {
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

  return (
    <form onSubmit={submit} className="space-y-5">
      {!isEdit && (
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

      <Section title={isEdit ? 'Schedule & Type' : 'Schedule'}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Requested Date/Time *"><Input required type="datetime-local" min={nowLocalIso()} value={f.requested_date_time} onChange={(e) => set('requested_date_time', e.target.value)} /></Field>
          <Field label="Time Slot"><Select value={f.time_slot} onChange={(e) => set('time_slot', e.target.value)} options={[
            { value: 'Morning 9 to 2', label: 'Morning 9 to 2' },
            { value: 'Afternoon 12 to 5', label: 'Afternoon 12 to 5' },
            { value: 'Evening 2 to 7', label: 'Evening 2 to 7' },
            { value: 'Anytime', label: 'Anytime' },
          ]} /></Field>
          <Field label="Client Ref ID"><Input value={f.client_ref_id} onChange={(e) => set('client_ref_id', e.target.value)} /></Field>
          {isEdit && (
            <Field label="Job Type"><Select value={f.job_type} onChange={(e) => set('job_type', e.target.value)} options={[
              { value: 'Installation', label: 'Installation' }, { value: 'Repair', label: 'Repair' },
              { value: 'Uninstallation', label: 'Uninstallation' }, { value: 'Maintenance', label: 'Maintenance' },
              { value: 'Demo', label: 'Demo' }, { value: 'Inspection', label: 'Inspection' },
            ]} /></Field>
          )}
          <Field label="Description" full><Input value={f.job_desc} onChange={(e) => set('job_desc', e.target.value)} placeholder="Scope of work" /></Field>
        </div>
      </Section>

      {!isEdit && (
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
        </>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <LoadBtn type="submit" loading={submitting}>{isEdit ? 'Save changes' : 'Create Job'}</LoadBtn>
      </div>
    </form>
  );
}

// ─── Dialog helpers (Assign + Change Owner) ──────────────────────────────────

function AssignDialog({ open, onClose, currentTech, onSubmit }: {
  open: boolean; onClose: () => void; currentTech: number | null;
  onSubmit: (efrId: number) => Promise<void>;
}) {
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
      <DialogContent>
        <DialogHeader><DialogTitle>{currentTech ? 'Reassign Technician' : 'Assign Technician'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Label>Easyfixer ID</Label>
          <Input
            type="number" min={1} step={1}
            value={efrId}
            onChange={(e) => setEfrId(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="Pick ID from the Easyfixers page"
          />
          <p className="text-xs text-muted-foreground">
            Tip: to auto-pick the best-matched technician by distance, workload, rating and completion, use the Auto-assignment page.
          </p>
          {err && <div className="text-sm text-destructive">{err}</div>}
          <LoadBtn onClick={submit} loading={loading} disabled={!valid}>{currentTech ? 'Reassign' : 'Assign'}</LoadBtn>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChangeOwnerDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void;
  onSubmit: (newOwnerId: number, reason: string) => Promise<void>;
}) {
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
      <DialogContent>
        <DialogHeader><DialogTitle>Change Job Owner</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>New Owner (staff ID)</Label>
            <Input
              type="number" min={1} step={1}
              value={newOwnerId}
              onChange={(e) => setNewOwnerId(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="Pick ID from the Users page"
            />
          </div>
          <div>
            <Label>Reason (at least 3 characters)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the owner changing?" />
          </div>
          {err && <div className="text-sm text-destructive">{err}</div>}
          <LoadBtn onClick={submit} loading={loading} disabled={!valid}>Update</LoadBtn>
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
    address: pick('address'), building: pick('building'),
    city_id: pick('city_id'), pin_code: pick('pin_code'), gps_location: pick('gps_location'),
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="px-5 py-3 border-b bg-muted/30"><h3 className="text-sm font-semibold">{title}</h3></div>
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
