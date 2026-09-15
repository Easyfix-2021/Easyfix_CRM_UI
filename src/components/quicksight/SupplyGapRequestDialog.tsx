'use client';

/*
 * Supply Gap Request dialog — legacy "Open City" app-opencity modal, rebuilt.
 *
 * Two entry points on the Supply Gap page, one component:
 *
 *   target = { kind: 'new' }        "New Supply Request" button. The operator
 *                                    picks Job ID or New City first; nothing
 *                                    else is shown until they do (legacy parity).
 *   target = { kind: 'existing' }   eye icon on a row. EDITABLE while the
 *                                    request is Open (category + reason);
 *                                    READ-ONLY for every other status. Action
 *                                    History, Add Remark and the status-driven
 *                                    action buttons render underneath.
 *
 * Location / client / owner fields are DISPLAY ONLY: the server re-derives them
 * from the job or the PIN on create, so the form cannot save a city the job is
 * not in. They render as a plain fact grid, not as disabled inputs. The
 * operator chooses the category, the reason and — for New City, or a job whose
 * address resolves to no Zonal Manager — the Zonal Manager (legacy showed the
 * ZM dropdown exactly when the name was missing).
 *
 * Built from the shared components/ui kit only (Dialog, Card, Button,
 * StatusChip, Input, Select, SearchSelect, Label) — no bespoke colours, pills
 * or header bands, so it looks like every other CRM modal.
 *
 * Submitting a Job ID request moves the job's owner to the Zonal Manager and
 * WhatsApps them (see services/quicksight/quicksight-supply-gap.service.js).
 * The form says so before submit; the toast reports what actually happened.
 */

import * as React from 'react';
import {
  Briefcase,
  Building2,
  CalendarClock,
  CheckCircle2,
  Hash,
  Landmark,
  Loader2,
  Map as MapIcon,
  MapPin,
  Package,
  Search,
  Sparkles,
  UserCheck,
  UserCog,
  UserPlus,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast, dismissToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, type SelectOption } from '@/components/ui/select';
import { SearchSelect } from '@/components/ui/search-select';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import {
  AddRemarkBox,
  CloseRequestDialog,
  ExistingSupplyDialog,
  NewTechnicianDialog,
  TEXTAREA_CLASS,
} from '@/components/quicksight/SupplyGapActions';
import {
  SUPPLY_ACTION_LABEL,
  SUPPLY_STATUS_LABEL,
  SUPPLY_STATUS_TONE,
  describeSupplySave,
  type SupplyGapDetail,
  type SupplyGapHistoryEntry,
  type SupplyGapJobPrefill,
  type SupplyGapPinPrefill,
  type SupplyGapSaveResult,
  type SupplyRequestFor,
} from '@/lib/supply-gap';

const API_BASE = '/admin/quicksight/supply-gap';
const REASON_MAX = 1000;
/* Mirrors the backend: job statuses (closed / cancelled / audit…) that let a Job ID gap be completed. */
const JOB_STATUSES_THAT_ALLOW_COMPLETE = new Set([3, 5, 6, 7, 10, 15, 21]);

export type SupplyGapDialogTarget = { kind: 'new' } | { kind: 'existing'; id: number };

export function SupplyGapRequestDialog({
  target,
  onClose,
  onSaved,
  onOpenExisting,
  categoryOptions,
  clientOptions,
}: {
  target: SupplyGapDialogTarget;
  onClose: () => void;
  /* Called after a successful create / update / action so the list can refresh. */
  onSaved: () => void;
  /* A Job ID that already has an open request jumps to that request. */
  onOpenExisting: (id: number) => void;
  categoryOptions: SelectOption[];
  clientOptions: SelectOption[];
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => dirty && !submitting });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      {/* eslint-disable-next-line local/no-unscrollable-dialog-content -- the scroll region (flex-1 min-h-0 overflow-y-auto) is inside NewRequestBody / ExistingRequestBody, between a shrink-0 header and footer */}
      <DialogContent className="max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* The header MUST be a direct child of DialogContent: that is how the
            shared Dialog detects it and seats the X inside the band. Nested in a
            body component it falls back to a corner X on the band's underline. */}
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            {target.kind === 'new' ? 'New Supply Gap Request' : `Supply Gap Request #${target.id}`}
          </DialogTitle>
        </DialogHeader>
        {target.kind === 'new' ? (
          <NewRequestBody
            onClose={onClose}
            onSaved={onSaved}
            onOpenExisting={onOpenExisting}
            categoryOptions={categoryOptions}
            clientOptions={clientOptions}
            submitting={submitting}
            setSubmitting={setSubmitting}
            setDirty={setDirty}
          />
        ) : (
          <ExistingRequestBody
            id={target.id}
            onClose={onClose}
            onSaved={onSaved}
            categoryOptions={categoryOptions}
            submitting={submitting}
            setSubmitting={setSubmitting}
            setDirty={setDirty}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type BodyCommon = {
  onClose: () => void;
  onSaved: () => void;
  categoryOptions: SelectOption[];
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
  setDirty: (v: boolean) => void;
};

function useZonalOptions() {
  const zonal = useFetchOnce<Array<{ user_id: number; user_name: string }>>('/shared/lookup/zonal-managers');
  return React.useMemo(
    () => (zonal.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonal.data],
  );
}

/* ── New request ───────────────────────────────────────────────────────── */

function NewRequestBody({
  onClose, onSaved, onOpenExisting, categoryOptions, clientOptions,
  submitting, setSubmitting, setDirty,
}: BodyCommon & { onOpenExisting: (id: number) => void; clientOptions: SelectOption[] }) {
  const [requestFor, setRequestFor] = React.useState<SupplyRequestFor | null>(null);

  // Job ID mode
  const [jobIdInput, setJobIdInput] = React.useState('');
  const [job, setJob] = React.useState<SupplyGapJobPrefill | null>(null);
  const [jobLoading, setJobLoading] = React.useState(false);
  const [jobError, setJobError] = React.useState<string | null>(null);

  // New City mode
  const [pinInput, setPinInput] = React.useState('');
  const [pin, setPin] = React.useState<SupplyGapPinPrefill | null>(null);
  const [pinLoading, setPinLoading] = React.useState(false);
  const [pinError, setPinError] = React.useState<string | null>(null);
  const [clientId, setClientId] = React.useState<number | ''>('');

  // Shared
  const [catgId, setCatgId] = React.useState<number | ''>('');
  const [stateUser, setStateUser] = React.useState<number | ''>('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const zonalOptions = useZonalOptions();

  React.useEffect(() => {
    setDirty(Boolean(jobIdInput || pinInput || reason || catgId));
  }, [jobIdInput, pinInput, reason, catgId, setDirty]);

  function switchMode(next: SupplyRequestFor) {
    if (next === requestFor) return;
    setRequestFor(next);
    setJob(null); setJobError(null); setJobIdInput('');
    setPin(null); setPinError(null); setPinInput(''); setClientId('');
    setCatgId(''); setStateUser(''); setError(null);
  }

  async function lookupJob() {
    const id = jobIdInput.trim();
    if (!/^\d+$/.test(id)) { setJobError('Enter a numeric Job ID.'); return; }
    setJobLoading(true); setJobError(null); setJob(null); setError(null);
    try {
      const r = await api.get<SupplyGapJobPrefill>(`${API_BASE}/job/${id}`);
      if (r.id) {
        // An open request already exists — legacy jumped straight into it.
        onOpenExisting(r.id);
        return;
      }
      if (!r.referenceId) { setJobError(r.comments || 'This job cannot take a supply request.'); return; }
      setJob(r);
      setCatgId(r.catgId ?? '');
      setStateUser(r.stateUser ?? '');
    } catch (e) {
      setJobError(formatApiError(e, { fallback: 'Could not load this job' }));
    } finally {
      setJobLoading(false);
    }
  }

  async function lookupPin(value: string) {
    setPinInput(value);
    setPin(null); setPinError(null);
    if (!/^\d{6}$/.test(value)) return;
    setPinLoading(true);
    try {
      const r = await api.get<SupplyGapPinPrefill>(`${API_BASE}/pin/${value}`);
      setPin(r);
      setStateUser(r.stateUser ?? '');
    } catch (e) {
      setPinError(formatApiError(e, { fallback: 'Could not look up this PIN code' }));
    } finally {
      setPinLoading(false);
    }
  }

  const ready = (requestFor === 1 && job != null) || (requestFor === 2 && pin != null);
  // Legacy: the ZM is chosen, not shown, whenever the location has none.
  const chooseZonal = requestFor === 2 || (requestFor === 1 && job != null && !job.stateUser);
  const zonalName =
    zonalOptions.find((o) => o.value === stateUser)?.label
    ?? (requestFor === 1 ? job?.stateUserName : pin?.stateUserName);

  async function submit() {
    if (!ready || submitting) return;
    if (!catgId) { setError('Select a category.'); return; }
    if (!stateUser) { setError('Please assign a Zonal Manager before submitting.'); return; }
    if (!reason.trim()) { setError('Enter a reason.'); return; }
    setError(null);
    setSubmitting(true);
    const t = showToast({ variant: 'loading', message: 'Submitting supply gap request…' });
    try {
      const body =
        requestFor === 1
          ? { requestFor: 1, jobId: Number(job!.referenceId), catgId, stateUser, comments: reason.trim() }
          : { requestFor: 2, pin: pinInput, clientId: clientId || null, catgId, stateUser, comments: reason.trim() };
      const res = await api.post<SupplyGapSaveResult>(API_BASE, body);
      dismissToast(t);
      showToast(describeSupplySave(res, 'submitted'));
      setDirty(false);
      onSaved();
      onClose();
    } catch (e) {
      dismissToast(t);
      // Someone raised a request for this job between Fetch and Submit — the
      // backend refuses the duplicate (409 + "Request ID: N"); go to that one.
      const existing = e instanceof ApiError && e.status === 409 ? /Request ID:\s*(\d+)/.exec(e.message) : null;
      if (existing) {
        setDirty(false);
        onOpenExisting(Number(existing[1]));
        return;
      }
      setError(formatApiError(e, { fallback: 'Could not submit the request' }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
        {/* Step 1 — what is this request for? */}
        <Section title="1. What do you need supply for?">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Request for">
            <ModeButton icon={Briefcase} title="Job ID" selected={requestFor === 1} onSelect={() => switchMode(1)} />
            <ModeButton icon={MapPin} title="New City" selected={requestFor === 2} onSelect={() => switchMode(2)} />
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Job ID</span> — no technician available for an existing job.{' '}
            <span className="font-medium">New City</span> — no supply at all in a PIN code / city.
          </p>
        </Section>

        {/* Step 2 — look up the job / PIN */}
        {requestFor === 1 && (
          <Section title="2. Find the job">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Hash className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={jobIdInput}
                  inputMode="numeric"
                  placeholder="Enter Job ID, e.g. 383795"
                  className="pl-9"
                  onChange={(e) => { setJobIdInput(e.target.value.replace(/\D/g, '')); setJob(null); setJobError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupJob(); } }}
                />
              </div>
              <Button onClick={lookupJob} disabled={jobLoading || !jobIdInput}>
                {jobLoading ? <Loader2 className="size-4 animate-spin" /> : <><Search className="mr-1 size-4" /> Fetch</>}
              </Button>
            </div>
            {jobError && <ErrorText>{jobError}</ErrorText>}
            {!job && !jobError && (
              <p className="text-xs text-muted-foreground">Press Enter to load the job’s location, client and Zonal Manager.</p>
            )}
          </Section>
        )}

        {requestFor === 1 && job && (
          <InfoPanel
            icon={Briefcase}
            title={`Job #${job.referenceId}`}
            badges={
              <>
                {job.jobStatus && <StatusChip tone="info">{job.jobStatus}</StatusChip>}
                {job.jobAge != null && (
                  <StatusChip tone="gold" className="gap-1">
                    <CalendarClock className="size-3" /> {job.jobAge} day{job.jobAge === 1 ? '' : 's'} old
                  </StatusChip>
                )}
              </>
            }
            tiles={[
              { icon: Building2, label: 'Client', value: job.clientName },
              { icon: Hash, label: 'PIN Code', value: job.pin },
              { icon: MapPin, label: 'City', value: job.cityName },
              { icon: MapIcon, label: 'District', value: job.districtName },
              { icon: Landmark, label: 'State', value: job.stateName },
              { icon: UserCog, label: 'Zonal Manager', value: job.stateUserName },
            ]}
          />
        )}

        {requestFor === 2 && (
          <Section title="2. Where is the gap?">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label className="block mb-1" required>PIN Code</Label>
                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={pinInput}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6-digit PIN code"
                    className="pl-9"
                    onChange={(e) => lookupPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                  {pinLoading && (
                    <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                  )}
                </div>
              </div>
              <div>
                <Label className="block mb-1">Client Team</Label>
                <SearchSelect
                  value={clientId}
                  onChange={(v) => setClientId(v ? Number(v) : '')}
                  options={clientOptions}
                  placeholder="Optional"
                  disabled={!pin}
                />
              </div>
            </div>
            {pinError && <ErrorText>{pinError}</ErrorText>}
          </Section>
        )}

        {requestFor === 2 && pin && (
          <InfoPanel
            icon={MapPin}
            title={[pin.cityName, pin.stateName].filter(Boolean).join(', ') || `PIN ${pin.pin}`}
            badges={<StatusChip tone="neutral">PIN {pin.pin}</StatusChip>}
            tiles={[
              { icon: MapPin, label: 'City', value: pin.cityName },
              { icon: MapIcon, label: 'District', value: pin.districtName },
              { icon: Landmark, label: 'State', value: pin.stateName },
            ]}
          />
        )}

        {/* Step 3 — what the operator decides */}
        {ready && (
          <Section title="3. Request details">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label className="block mb-1" required>Category</Label>
                <Select
                  value={catgId}
                  options={categoryOptions}
                  placeholder="Select category"
                  onChange={(e) => setCatgId(e.target.value ? Number(e.target.value) : '')}
                />
              </div>
              {chooseZonal && (
                <div>
                  <Label className="block mb-1" required>Zonal Manager</Label>
                  <SearchSelect
                    value={stateUser}
                    onChange={(v) => setStateUser(v ? Number(v) : '')}
                    options={zonalOptions}
                    placeholder="Select Zonal Manager"
                  />
                  {requestFor === 1 && (
                    <p className="mt-1 text-xs text-warning-strong">This job’s city has no Zonal Manager — pick one.</p>
                  )}
                </div>
              )}
            </div>
            <ReasonField
              label={requestFor === 1 ? 'Reason For Existing Job' : 'Reason For Supply Gap'}
              value={reason}
              onChange={setReason}
              placeholder="What is needed? e.g. “Need to install mechanism part, carry required tools”"
            />
            <p className="text-xs text-muted-foreground">
              {requestFor === 1 ? (
                <>
                  On submit, this job’s owner changes to{' '}
                  <span className="font-semibold text-foreground">{zonalName || 'the Zonal Manager'}</span>, and they get a
                  WhatsApp with the request details.
                </>
              ) : (
                <>
                  On submit, <span className="font-semibold text-foreground">{zonalName || 'the Zonal Manager'}</span> gets a
                  WhatsApp with the request details.
                </>
              )}
            </p>
          </Section>
        )}

        {error && <ErrorText>{error}</ErrorText>}
      </div>

      <DialogFooter className="shrink-0">
        <CancelButton onCancel={onClose} disabled={submitting} />
        <Button onClick={submit} disabled={!ready || submitting}>
          {submitting ? <><Loader2 className="mr-1 size-4 animate-spin" /> Submitting…</> : <><CheckCircle2 className="mr-1 size-4" /> Submit Request</>}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ── Existing request (eye icon) ───────────────────────────────────────── */

function ExistingRequestBody({
  id, onClose, onSaved, categoryOptions, submitting, setSubmitting, setDirty,
}: BodyCommon & { id: number }) {
  const detail = useFetch<SupplyGapDetail>(`${API_BASE}/${id}`);
  const history = useFetch<SupplyGapHistoryEntry[]>(`${API_BASE}/${id}/history`);
  const d = detail.data;
  const editable = d?.status === 0;

  const [catgId, setCatgId] = React.useState<number | ''>('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  /* Action sub-dialogs (legacy button row). */
  const [action, setAction] = React.useState<'complete' | 'cancel' | 'newSupply' | 'existingSupply' | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const status = d?.status ?? -1;
  const canCancel = status === 0 || status === 1 || status === 2;
  const canComplete = status === 1 || status === 2;
  const canAddNew = status === 0 || status === 1 || status === 2;
  const canAllocateExisting = status === 0;
  const hasActions = canCancel || canComplete || canAddNew || canAllocateExisting;

  // Seed the editable fields once the detail lands (and again if it reloads).
  React.useEffect(() => {
    if (!d) return;
    setCatgId(d.catgId ?? '');
    setReason(d.comments ?? '');
  }, [d]);

  React.useEffect(() => {
    if (!d) return;
    setDirty(editable && (catgId !== (d.catgId ?? '') || reason !== (d.comments ?? '')));
  }, [d, editable, catgId, reason, setDirty]);

  // Re-read this request (detail + history) and the list after any action.
  function refreshAfterAction() {
    invalidateFetch((k) => k.startsWith(`${API_BASE}/${id}`));
    onSaved();
  }

  function openAction(next: 'cancel' | 'newSupply' | 'existingSupply') {
    setActionError(null);
    setAction(next);
  }

  function openComplete() {
    // Legacy isCompleteEnabled — a Job ID gap closes only once its job has.
    if (d?.requestFor === 1 && !JOB_STATUSES_THAT_ALLOW_COMPLETE.has(Number(d.jobStatus))) {
      setActionError('You cannot complete this request because its job is still open.');
      return;
    }
    setActionError(null);
    setAction('complete');
  }

  async function submit() {
    if (!d || !editable || submitting) return;
    if (!catgId) { setError('Select a category.'); return; }
    if (!reason.trim()) { setError('Enter a reason.'); return; }
    setError(null);
    setSubmitting(true);
    const t = showToast({ variant: 'loading', message: 'Updating supply gap request…' });
    try {
      const res = await api.put<SupplyGapSaveResult>(`${API_BASE}/${id}`, { catgId, comments: reason.trim() });
      dismissToast(t);
      showToast(describeSupplySave(res, 'updated'));
      invalidateFetch((k) => k.startsWith(`${API_BASE}/${id}`));
      setDirty(false);
      onSaved();
      onClose();
    } catch (e) {
      dismissToast(t);
      setError(formatApiError(e, { fallback: 'Could not update the request' }));
    } finally {
      setSubmitting(false);
    }
  }

  const isJob = d?.requestFor === 1;
  const reasonLabel = isJob ? 'Reason For Existing Job' : 'Reason For Supply Gap';

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
        {detail.loading && !d ? (
          <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> Loading request…
          </div>
        ) : detail.error && !d ? (
          <ErrorText>{detail.error}</ErrorText>
        ) : d ? (
          <>
            <InfoPanel
              icon={isJob ? Briefcase : MapPin}
              title={isJob ? `Job #${d.referenceId}` : `New City · ${d.cityName ?? '—'}`}
              subtitle={
                d.initiatedByUser
                  ? `Opened by ${d.initiatedByUser}${d.initiatedOn ? ` · ${d.initiatedOn}` : ''}`
                  : undefined
              }
              badges={
                <>
                  {d.status != null && (
                    <StatusChip tone={SUPPLY_STATUS_TONE[d.status] ?? 'neutral'}>
                      {SUPPLY_STATUS_LABEL[d.status] ?? `Status ${d.status}`}
                    </StatusChip>
                  )}
                  {d.isJobEscalated === 1 && <StatusChip tone="urgent">🔥 Escalated</StatusChip>}
                </>
              }
              tiles={[
                { icon: Building2, label: 'Client', value: d.clientName },
                { icon: Hash, label: 'PIN Code', value: d.pin },
                { icon: MapPin, label: 'City', value: d.cityName },
                { icon: MapIcon, label: 'District', value: d.districtName },
                { icon: Landmark, label: 'State', value: d.stateName },
                { icon: UserCog, label: 'Zonal Manager', value: d.stateUserName },
                ...(editable ? [] : [{ icon: Package, label: 'Category', value: d.catgName }]),
              ]}
            />

            {editable ? (
              <Section title="Request details">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="block mb-1" required>Category</Label>
                    <Select
                      value={catgId}
                      options={categoryOptions}
                      placeholder="Select category"
                      onChange={(e) => setCatgId(e.target.value ? Number(e.target.value) : '')}
                    />
                  </div>
                </div>
                <ReasonField label={reasonLabel} value={reason} onChange={setReason} />
                <p className="text-xs text-muted-foreground">Saving an edit sends the Zonal Manager an updated WhatsApp.</p>
              </Section>
            ) : (
              d.comments && (
                <Section title={reasonLabel}>
                  <p className="text-sm whitespace-pre-wrap">{d.comments}</p>
                </Section>
              )
            )}

            {error && <ErrorText>{error}</ErrorText>}

            {hasActions && (
              <Section title="Take action">
                {/* Outline for every step, destructive only for Cancel — like the
                    JobModal footer. The brand primary is also red, so a filled
                    primary here would read the same as Cancel Request. */}
                <div className="flex flex-wrap gap-2">
                  {canAllocateExisting && (
                    <Button variant="outline" title="Assign a registered technician" onClick={() => openAction('existingSupply')}>
                      <UserCheck className="mr-1 size-4" /> Allocate An Existing Supply
                    </Button>
                  )}
                  {canAddNew && (
                    <Button variant="outline" title="Onboard a new technician" onClick={() => openAction('newSupply')}>
                      <UserPlus className="mr-1 size-4" /> Add A New Supply
                    </Button>
                  )}
                  {canComplete && (
                    <Button variant="outline" title="Gap is filled — close it" onClick={openComplete}>
                      <CheckCircle2 className="mr-1 size-4" /> Mark Complete
                    </Button>
                  )}
                  {canCancel && (
                    <Button variant="destructive" title="No longer needed" onClick={() => openAction('cancel')}>
                      <XCircle className="mr-1 size-4" /> Cancel Request
                    </Button>
                  )}
                </div>
                {actionError && <ErrorText>{actionError}</ErrorText>}
              </Section>
            )}

            <ActionHistory history={history} />

            <AddRemarkBox id={id} onAdded={refreshAfterAction} />
          </>
        ) : null}
      </div>

      <DialogFooter className="shrink-0">
        {editable ? (
          <>
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={submit} disabled={submitting}>
              {submitting ? <><Loader2 className="mr-1 size-4 animate-spin" /> Saving…</> : <><CheckCircle2 className="mr-1 size-4" /> Save Changes</>}
            </Button>
          </>
        ) : (
          // Nothing to discard on a read-only request — no confirm prompt.
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        )}
      </DialogFooter>

      {d && (action === 'complete' || action === 'cancel') && (
        <CloseRequestDialog id={id} kind={action} onClose={() => setAction(null)} onDone={refreshAfterAction} />
      )}
      {d && action === 'newSupply' && (
        <NewTechnicianDialog mode="supply" id={id} onClose={() => setAction(null)} onDone={refreshAfterAction} />
      )}
      {d && action === 'existingSupply' && (
        <ExistingSupplyDialog
          id={id}
          requestFor={d.requestFor}
          referenceId={d.referenceId}
          cityName={d.cityName}
          catgId={d.catgId}
          catgName={d.catgName}
          onClose={() => setAction(null)}
          onDone={refreshAfterAction}
        />
      )}
    </>
  );
}

/* ── Action History ────────────────────────────────────────────────────── */

/* supply_request_log.action_type → shared StatusChip tone. */
const ACTION_TONE: Record<number, StatusChipTone> = {
  0: 'info',
  1: 'gold',
  2: 'warning',
  3: 'urgent',
  4: 'success',
  9: 'neutral',
};

function ActionHistory({
  history,
}: {
  history: { data: SupplyGapHistoryEntry[] | null; loading: boolean; error: string | null };
}) {
  return (
    <Section title="Action History">
      {history.loading && !history.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : history.error ? (
        <ErrorText>{history.error}</ErrorText>
      ) : (history.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No actions recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {history.data!.map((h) => {
            // tx_details is "name_mobile" — show the technician's name only;
            // the CRM never renders a raw technician mobile.
            const txName = h.txDetails ? h.txDetails.split('_')[0] : null;
            return (
              <li key={h.commentId} className="border-l-2 border-border pl-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm">
                    <StatusChip tone={ACTION_TONE[h.actionType] ?? 'neutral'}>
                      {SUPPLY_ACTION_LABEL[h.actionType] ?? 'Updated'}
                    </StatusChip>
                    <span className="text-muted-foreground">by</span>
                    <span className="font-medium">{h.userName ?? '-'}</span>
                  </p>
                  <span className="text-xs text-muted-foreground tabular-nums">{h.insertOn ?? ''}</span>
                </div>
                {txName && (
                  <StatusChip tone="gold" size="sm" className="mt-1 gap-1">
                    <UserPlus className="size-3" /> {txName}{h.efrCurrentStatus ? ` · ${h.efrCurrentStatus}` : ''}
                  </StatusChip>
                )}
                {h.comment && <p className="mt-1 text-sm text-foreground/90 whitespace-pre-wrap">{h.comment}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

/* ── Layout pieces (compositions of the shared kit) ────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function ModeButton({
  icon: Icon, title, selected, onSelect,
}: { icon: LucideIcon; title: string; selected: boolean; onSelect: () => void }) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={selected}
      variant={selected ? 'default' : 'outline'}
      onClick={onSelect}
    >
      <Icon className="mr-1 size-4" /> {title}
    </Button>
  );
}

function ReasonField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <Label className="block mb-1" required>{label}</Label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={REASON_MAX}
        rows={3}
        placeholder={placeholder}
        className={TEXTAREA_CLASS}
      />
      <div className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
        {value.length} / {REASON_MAX}
      </div>
    </div>
  );
}

type TileSpec = { icon: LucideIcon; label: string; value: string | number | null | undefined };

function InfoPanel({
  icon: Icon, title, subtitle, badges, tiles,
}: { icon: LucideIcon; title: string; subtitle?: string; badges?: React.ReactNode; tiles: TileSpec[] }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate">{title}</CardTitle>
            {subtitle && <CardDescription className="text-xs">{subtitle}</CardDescription>}
          </div>
        </div>
        {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      </CardHeader>
      <CardContent className="pt-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map(({ icon: TileIcon, label, value }) => {
            const empty = value == null || value === '';
            const text = empty ? '' : String(value);
            return (
              <div key={label} className="flex min-w-0 items-start gap-2.5">
                <TileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd
                    className={`truncate text-sm font-medium ${empty ? 'text-muted-foreground' : ''}`}
                    // Tooltip only when the value can actually be cut off.
                    title={text.length > 28 ? text : undefined}
                  >
                    {empty ? '—' : value}
                  </dd>
                </div>
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="text-sm text-urgent-strong">{children}</p>;
}
