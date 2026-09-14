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
 *                                    History renders underneath either way.
 *
 * Location / client / owner fields are DISPLAY ONLY: the server re-derives them
 * from the job or the PIN on create, so the form cannot save a city the job is
 * not in. They render as a summary card of plain text, not as a column of
 * disabled inputs — disabled inputs read as "something you can't fill yet",
 * which is the opposite of "this is already known". What the operator chooses
 * is the category, the Zonal Manager (New City only — a job's ZM is its
 * city's) and the reason.
 *
 * Submitting a Job ID request moves the job's owner to the Zonal Manager and
 * WhatsApps them (see services/quicksight/quicksight-supply-gap.service.js).
 * The form says so before submit; those steps run after the save and are
 * best-effort, so the toast reports what actually happened.
 */

import * as React from 'react';
import {
  Briefcase,
  CheckCircle2,
  FolderOpen,
  Info,
  Loader2,
  MapPin,
  MessageSquare,
  Package,
  Search,
  UserPlus,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast, dismissToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, type SelectOption } from '@/components/ui/select';
import { SearchSelect } from '@/components/ui/search-select';
import {
  AddRemarkBox,
  CloseRequestDialog,
  ExistingSupplyDialog,
  NewTechnicianDialog,
} from '@/components/quicksight/SupplyGapActions';
import {
  SUPPLY_ACTION_LABEL,
  SUPPLY_STATUS_CLASS,
  SUPPLY_STATUS_LABEL,
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
const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40 disabled:opacity-60';

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
  /* Called after a successful create / update so the list can refresh. */
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
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* The header MUST be a direct child of DialogContent: that is how the
            shared Dialog detects it and seats the X inside the dark band. Nested
            in a body component it falls back to a corner X that lands on the
            band's red underline. */}
        <DialogHeader className="shrink-0">
          <DialogTitle>
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

  const zonal = useFetchOnce<Array<{ user_id: number; user_name: string }>>('/shared/lookup/zonal-managers');
  const zonalOptions = React.useMemo(
    () => (zonal.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonal.data],
  );

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
  const zonalName =
    requestFor === 1
      ? job?.stateUserName
      : zonalOptions.find((o) => o.value === stateUser)?.label ?? pin?.stateUserName;

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
      setError(formatApiError(e, { fallback: 'Could not submit the request' }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
        {/* Step 1 — what is this request for? */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Request For</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Request for">
            <ModeCard
              icon={Briefcase}
              title="Job ID"
              hint="No technician available for an existing job"
              selected={requestFor === 1}
              onSelect={() => switchMode(1)}
            />
            <ModeCard
              icon={MapPin}
              title="New City"
              hint="No supply at all in a PIN code / city"
              selected={requestFor === 2}
              onSelect={() => switchMode(2)}
            />
          </div>
        </div>

        {/* Step 2 — look up the job / PIN */}
        {requestFor === 1 && (
          <div className="space-y-3">
            <div>
              <Label className="block mb-1" required>Job ID</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={jobIdInput}
                    inputMode="numeric"
                    placeholder="e.g. 383795"
                    className="pl-9"
                    onChange={(e) => { setJobIdInput(e.target.value.replace(/\D/g, '')); setJob(null); setJobError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupJob(); } }}
                  />
                </div>
                <Button variant="outline" onClick={lookupJob} disabled={jobLoading || !jobIdInput}>
                  {jobLoading ? <Loader2 className="size-4 animate-spin" /> : 'Fetch Details'}
                </Button>
              </div>
              {jobError && <p className="mt-1.5 text-xs text-urgent-strong">{jobError}</p>}
              {!job && !jobError && (
                <p className="mt-1.5 text-xs text-muted-foreground">Press Enter to load the job’s location, client and Zonal Manager.</p>
              )}
            </div>

            {job && (
              <SummaryCard
                title={`Job #${job.referenceId}`}
                badges={
                  <>
                    {job.jobStatus && <Pill className="bg-info-tint text-info-strong">{job.jobStatus}</Pill>}
                    {job.jobAge != null && (
                      <Pill className="bg-muted text-muted-foreground">
                        {job.jobAge} day{job.jobAge === 1 ? '' : 's'} old
                      </Pill>
                    )}
                  </>
                }
                items={[
                  ['Client', job.clientName],
                  ['PIN Code', job.pin],
                  ['City', job.cityName],
                  ['District', job.districtName],
                  ['State', job.stateName],
                  ['Zonal Manager', job.stateUserName],
                ]}
              />
            )}
          </div>
        )}

        {requestFor === 2 && (
          <div className="space-y-3">
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
                {pinError && <p className="mt-1.5 text-xs text-urgent-strong">{pinError}</p>}
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

            {pin && (
              <SummaryCard
                title={[pin.cityName, pin.stateName].filter(Boolean).join(', ') || `PIN ${pin.pin}`}
                badges={<Pill className="bg-muted text-muted-foreground">PIN {pin.pin}</Pill>}
                items={[
                  ['City', pin.cityName],
                  ['District', pin.districtName],
                  ['State', pin.stateName],
                ]}
              />
            )}
          </div>
        )}

        {/* Step 3 — what the operator decides */}
        {ready && (
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Request Details</p>
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
              {requestFor === 2 && (
                <div>
                  <Label className="block mb-1" required>Zonal Manager</Label>
                  <SearchSelect
                    value={stateUser}
                    onChange={(v) => setStateUser(v ? Number(v) : '')}
                    options={zonalOptions}
                    placeholder="Select Zonal Manager"
                  />
                </div>
              )}
            </div>
            <div>
              <Label className="block mb-1" required>
                {requestFor === 1 ? 'Reason For Existing Job' : 'Reason For Supply Gap'}
              </Label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={REASON_MAX}
                rows={3}
                placeholder="What is needed? e.g. “Need to install mechanism part, carry required tools”"
                className={TEXTAREA_CLASS}
              />
              <div className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
                {reason.length} / {REASON_MAX}
              </div>
            </div>

            <Callout>
              {requestFor === 1 ? (
                <>
                  On submit, this job’s owner changes to{' '}
                  <span className="font-medium">{zonalName || 'the Zonal Manager'}</span>, and they get a WhatsApp
                  with the request details.
                </>
              ) : (
                <>
                  On submit, <span className="font-medium">{zonalName || 'the Zonal Manager'}</span> gets a WhatsApp
                  with the request details.
                </>
              )}
            </Callout>
          </div>
        )}

        {error && <ErrorLine>{error}</ErrorLine>}
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 border-t pt-3">
        <CancelButton onCancel={onClose} disabled={submitting} />
        <Button onClick={submit} disabled={!ready || submitting}>
          {submitting ? 'Submitting…' : 'Submit Request'}
        </Button>
      </div>
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

  /* Action sub-dialogs (legacy button row). */
  const [action, setAction] = React.useState<'complete' | 'cancel' | 'newSupply' | 'existingSupply' | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const status = d?.status ?? -1;
  const canCancel = status === 0 || status === 1 || status === 2;
  const canComplete = status === 1 || status === 2;
  const canAddNew = status === 0 || status === 1 || status === 2;
  const canAllocateExisting = status === 0;

  // Re-read this request (detail + history) and the list after any action.
  function refreshAfterAction() {
    invalidateFetch((k) => k.startsWith(`${API_BASE}/${id}`));
    onSaved();
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

  const [catgId, setCatgId] = React.useState<number | ''>('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

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

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
        {detail.loading && !d ? (
          <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> Loading request…
          </div>
        ) : detail.error && !d ? (
          <ErrorLine>{detail.error}</ErrorLine>
        ) : d ? (
          <>
            <SummaryCard
              title={isJob ? `Job #${d.referenceId}` : 'New City'}
              subtitle={
                d.initiatedByUser
                  ? `Opened by ${d.initiatedByUser}${d.initiatedOn ? ` · ${d.initiatedOn}` : ''}`
                  : undefined
              }
              badges={
                <>
                  {d.status != null && (
                    <Pill className={SUPPLY_STATUS_CLASS[d.status] ?? 'bg-muted text-muted-foreground'}>
                      {SUPPLY_STATUS_LABEL[d.status] ?? `Status ${d.status}`}
                    </Pill>
                  )}
                  {d.isJobEscalated === 1 && <Pill className="bg-urgent-tint text-urgent-strong">Escalated</Pill>}
                </>
              }
              items={[
                ['Client', d.clientName],
                ['PIN Code', d.pin],
                ['City', d.cityName],
                ['District', d.districtName],
                ['State', d.stateName],
                ['Zonal Manager', d.stateUserName],
                ...(editable ? [] : ([['Category', d.catgName]] as Array<[string, string | null]>)),
              ]}
            />

            {editable ? (
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Request Details</p>
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
                <div>
                  <Label className="block mb-1" required>
                    {isJob ? 'Reason For Existing Job' : 'Reason For Supply Gap'}
                  </Label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={REASON_MAX}
                    rows={3}
                    className={TEXTAREA_CLASS}
                  />
                  <div className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
                    {reason.length} / {REASON_MAX}
                  </div>
                </div>
                <Callout>Saving an edit sends the Zonal Manager an updated WhatsApp.</Callout>
              </div>
            ) : (
              d.comments && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {isJob ? 'Reason For Existing Job' : 'Reason For Supply Gap'}
                  </p>
                  <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap">
                    {d.comments}
                  </p>
                </div>
              )
            )}

            {error && <ErrorLine>{error}</ErrorLine>}

            <ActionHistory history={history} />

            <div className="rounded-lg border border-border p-3">
              <AddRemarkBox id={id} onAdded={refreshAfterAction} />
            </div>
          </>
        ) : null}
      </div>

      {d && (canCancel || canComplete || canAddNew || canAllocateExisting) && (
        <div className="shrink-0 space-y-2 border-t pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Actions</p>
          <div className="flex flex-wrap gap-2">
            {canAllocateExisting && (
              <Button size="sm" variant="outline" onClick={() => { setActionError(null); setAction('existingSupply'); }}>
                Allocate An Existing Supply
              </Button>
            )}
            {canAddNew && (
              <Button size="sm" variant="outline" onClick={() => { setActionError(null); setAction('newSupply'); }}>
                Add A New Supply
              </Button>
            )}
            {canComplete && (
              <Button size="sm" variant="outline" className="text-success-strong" onClick={openComplete}>
                <CheckCircle2 className="size-4" /> Mark Complete
              </Button>
            )}
            {canCancel && (
              <Button size="sm" variant="outline" className="text-urgent-strong" onClick={() => { setActionError(null); setAction('cancel'); }}>
                <XCircle className="size-4" /> Cancel Request
              </Button>
            )}
          </div>
          {actionError && <ErrorLine>{actionError}</ErrorLine>}
        </div>
      )}

      <div className="shrink-0 flex items-center justify-end gap-2 border-t pt-3">
        {editable ? (
          <>
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={submit} disabled={submitting}>
              {submitting ? 'Saving…' : 'Save Changes'}
            </Button>
          </>
        ) : (
          // Nothing to discard on a read-only request — no confirm prompt.
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        )}
      </div>

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

/* ── Action History timeline ───────────────────────────────────────────── */

const ACTION_STYLE: Record<number, { icon: LucideIcon; dot: string }> = {
  0: { icon: FolderOpen, dot: 'bg-info-tint text-info-strong' },
  1: { icon: UserPlus, dot: 'bg-warning-tint text-warning-strong' },
  2: { icon: Package, dot: 'bg-warning-tint text-warning-strong' },
  3: { icon: XCircle, dot: 'bg-urgent-tint text-urgent-strong' },
  4: { icon: CheckCircle2, dot: 'bg-success-tint text-success-strong' },
  9: { icon: MessageSquare, dot: 'bg-muted text-muted-foreground' },
};

function ActionHistory({
  history,
}: {
  history: { data: SupplyGapHistoryEntry[] | null; loading: boolean; error: string | null };
}) {
  return (
    <section>
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Action History</p>
      {history.loading && !history.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : history.error ? (
        <ErrorLine>{history.error}</ErrorLine>
      ) : (history.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No actions recorded yet.</p>
      ) : (
        <ol className="relative space-y-4 border-l border-border pl-6 ml-3">
          {history.data!.map((h) => {
            const style = ACTION_STYLE[h.actionType] ?? { icon: Info, dot: 'bg-muted text-muted-foreground' };
            const Icon = style.icon;
            // tx_details is "name_mobile" — show the technician's name only;
            // the CRM never renders a raw technician mobile.
            const txName = h.txDetails ? h.txDetails.split('_')[0] : null;
            return (
              <li key={h.commentId} className="relative">
                <span
                  className={`absolute -left-[37px] top-0 flex size-6 items-center justify-center rounded-full ring-4 ring-background ${style.dot}`}
                >
                  <Icon className="size-3.5" />
                </span>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-sm">
                    <span className="font-semibold">{SUPPLY_ACTION_LABEL[h.actionType] ?? 'Updated'}</span>
                    <span className="text-muted-foreground"> by </span>
                    <span className="font-medium">{h.userName ?? '-'}</span>
                  </p>
                  <span className="text-xs text-muted-foreground tabular-nums">{h.insertOn ?? ''}</span>
                </div>
                {txName && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Technician: {txName}{h.efrCurrentStatus ? ` · ${h.efrCurrentStatus}` : ''}
                  </p>
                )}
                {h.comment && (
                  <p className="mt-1.5 rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap">{h.comment}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ── Small presentational pieces ───────────────────────────────────────── */

function ModeCard({
  icon: Icon, title, hint, selected, onSelect,
}: { icon: LucideIcon; title: string; hint: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-foreground/30 hover:bg-muted/40'
      }`}
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-md ${
          selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        }`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function SummaryCard({
  title, subtitle, badges, items,
}: {
  title: string;
  subtitle?: string;
  badges?: React.ReactNode;
  items: Array<[string, string | number | null | undefined]>;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm font-medium" title={value == null ? undefined : String(value)}>
              {value == null || value === '' ? '—' : value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-info-tint px-3 py-2 text-xs text-info-strong">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
      <XCircle className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
