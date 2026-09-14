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
 * not in. They render as a plain, uncoloured fact grid, not as disabled inputs. The
 * operator chooses the category, the reason and — for New City, or a job whose
 * address resolves to no Zonal Manager — the Zonal Manager (legacy showed the
 * ZM dropdown exactly when the name was missing).
 *
 * Colour comes only from the brand meaning tokens (info / success / gold /
 * warning / urgent / brand), so both themes and a future rebrand keep working.
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
  ClipboardList,
  FolderOpen,
  Hash,
  History,
  Info,
  Landmark,
  Loader2,
  Map as MapIcon,
  MapPin,
  MessageSquare,
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
  'flex w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/20 disabled:opacity-60';

/* Solid, colourful action buttons — the legacy red / green / amber row. */
const SOLID = {
  info: 'bg-info text-white shadow-sm hover:brightness-110',
  success: 'bg-success text-white shadow-sm hover:brightness-110',
  gold: 'bg-gold text-white shadow-sm hover:brightness-110',
  urgent: 'bg-destructive text-white shadow-sm hover:brightness-110',
} as const;

/* Status → solid pill (the table uses tints; the dialog hero uses the loud version). */
const STATUS_SOLID: Record<number, string> = {
  0: 'bg-info text-white',
  1: 'bg-warning text-white',
  2: 'bg-gold text-white',
  3: 'bg-destructive text-white',
  4: 'bg-success text-white',
};

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
        <DialogHeader className="shrink-0 from-info via-info to-success shadow-none">
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
      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 pr-1">
        {/* Step 1 — what is this request for? */}
        <section>
          <SectionTitle icon={ClipboardList} tone="info" step={1}>What do you need supply for?</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Request for">
            <ModeCard
              icon={Briefcase}
              tone="info"
              title="Job ID"
              hint="No technician available for an existing job"
              selected={requestFor === 1}
              onSelect={() => switchMode(1)}
            />
            <ModeCard
              icon={MapPin}
              tone="success"
              title="New City"
              hint="No supply at all in a PIN code / city"
              selected={requestFor === 2}
              onSelect={() => switchMode(2)}
            />
          </div>
        </section>

        {/* Step 2 — look up the job / PIN */}
        {requestFor === 1 && (
          <section className="space-y-3">
            <SectionTitle icon={Search} tone="info" step={2}>Find the job</SectionTitle>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Hash className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-info" />
                <Input
                  autoFocus
                  value={jobIdInput}
                  inputMode="numeric"
                  placeholder="Enter Job ID, e.g. 383795"
                  className="h-11 rounded-lg pl-9 text-base"
                  onChange={(e) => { setJobIdInput(e.target.value.replace(/\D/g, '')); setJob(null); setJobError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupJob(); } }}
                />
              </div>
              <Button className={`h-11 px-5 ${SOLID.info}`} onClick={lookupJob} disabled={jobLoading || !jobIdInput}>
                {jobLoading ? <Loader2 className="size-4 animate-spin" /> : <><Search className="size-4" /> Fetch</>}
              </Button>
            </div>
            {jobError && <ErrorLine>{jobError}</ErrorLine>}
            {!job && !jobError && (
              <p className="text-xs text-muted-foreground">Press Enter to load the job’s location, client and Zonal Manager.</p>
            )}

            {job && (
              <InfoPanel
                tone="info"
                icon={Briefcase}
                title={`Job #${job.referenceId}`}
                badges={
                  <>
                    {job.jobStatus && <Pill className="bg-info text-white">{job.jobStatus}</Pill>}
                    {job.jobAge != null && (
                      <Pill className="bg-gold-tint text-gold-strong">
                        <CalendarClock className="size-3" /> {job.jobAge} day{job.jobAge === 1 ? '' : 's'} old
                      </Pill>
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
          </section>
        )}

        {requestFor === 2 && (
          <section className="space-y-3">
            <SectionTitle icon={MapPin} tone="success" step={2}>Where is the gap?</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label className="block mb-1" required>PIN Code</Label>
                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-success" />
                  <Input
                    autoFocus
                    value={pinInput}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6-digit PIN code"
                    className="h-11 rounded-lg pl-9 text-base"
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
                  className="h-11"
                />
              </div>
            </div>
            {pinError && <ErrorLine>{pinError}</ErrorLine>}

            {pin && (
              <InfoPanel
                tone="success"
                icon={MapPin}
                title={[pin.cityName, pin.stateName].filter(Boolean).join(', ') || `PIN ${pin.pin}`}
                badges={<Pill className="bg-success text-white">PIN {pin.pin}</Pill>}
                tiles={[
                  { icon: MapPin, label: 'City', value: pin.cityName },
                  { icon: MapIcon, label: 'District', value: pin.districtName },
                  { icon: Landmark, label: 'State', value: pin.stateName },
                ]}
              />
            )}
          </section>
        )}

        {/* Step 3 — what the operator decides */}
        {ready && (
          <section className="space-y-4">
            <SectionTitle icon={Sparkles} tone="gold" step={3}>Request details</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label className="block mb-1" required>Category</Label>
                <Select
                  value={catgId}
                  options={categoryOptions}
                  placeholder="Select category"
                  className="h-11 rounded-lg"
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
                    className="h-11"
                  />
                  {requestFor === 1 && (
                    <p className="mt-1 text-xs text-warning-strong">This job’s city has no Zonal Manager — pick one.</p>
                  )}
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
                  <span className="font-semibold">{zonalName || 'the Zonal Manager'}</span>, and they get a WhatsApp
                  with the request details.
                </>
              ) : (
                <>
                  On submit, <span className="font-semibold">{zonalName || 'the Zonal Manager'}</span> gets a WhatsApp
                  with the request details.
                </>
              )}
            </Callout>
          </section>
        )}

        {error && <ErrorLine>{error}</ErrorLine>}
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 border-t pt-3">
        <CancelButton onCancel={onClose} disabled={submitting} />
        <Button className={SOLID.success} onClick={submit} disabled={!ready || submitting}>
          {submitting ? <><Loader2 className="size-4 animate-spin" /> Submitting…</> : <><CheckCircle2 className="size-4" /> Submit Request</>}
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

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-6 pr-1">
        {detail.loading && !d ? (
          <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-info" /> Loading request…
          </div>
        ) : detail.error && !d ? (
          <ErrorLine>{detail.error}</ErrorLine>
        ) : d ? (
          <>
            <InfoPanel
              tone={isJob ? 'info' : 'success'}
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
                    <Pill className={STATUS_SOLID[d.status] ?? 'bg-muted text-muted-foreground'}>
                      {SUPPLY_STATUS_LABEL[d.status] ?? `Status ${d.status}`}
                    </Pill>
                  )}
                  {d.isJobEscalated === 1 && <Pill className="bg-destructive text-white">🔥 Escalated</Pill>}
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
              <section className="space-y-4">
                <SectionTitle icon={Sparkles} tone="gold">Request details</SectionTitle>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="block mb-1" required>Category</Label>
                    <Select
                      value={catgId}
                      options={categoryOptions}
                      placeholder="Select category"
                      className="h-11 rounded-lg"
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
              </section>
            ) : (
              d.comments && (
                <section>
                  <SectionTitle icon={MessageSquare} tone="gold">
                    {isJob ? 'Reason For Existing Job' : 'Reason For Supply Gap'}
                  </SectionTitle>
                  <p className="rounded-lg border-l-4 border-gold bg-gold-tint px-4 py-3 text-sm whitespace-pre-wrap">
                    {d.comments}
                  </p>
                </section>
              )
            )}

            {error && <ErrorLine>{error}</ErrorLine>}

            {hasActions && (
              <section className="rounded-xl border border-border bg-muted/30 p-4">
                <SectionTitle icon={Sparkles} tone="brand">Take action</SectionTitle>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {canAllocateExisting && (
                    <ActionButton tone="info" icon={UserCheck} title="Allocate An Existing Supply" hint="Assign a registered technician" onClick={() => openAction('existingSupply')} />
                  )}
                  {canAddNew && (
                    <ActionButton tone="gold" icon={UserPlus} title="Add A New Supply" hint="Onboard a new technician" onClick={() => openAction('newSupply')} />
                  )}
                  {canComplete && (
                    <ActionButton tone="success" icon={CheckCircle2} title="Mark Complete" hint="Gap is filled — close it" onClick={openComplete} />
                  )}
                  {canCancel && (
                    <ActionButton tone="urgent" icon={XCircle} title="Cancel Request" hint="No longer needed" onClick={() => openAction('cancel')} />
                  )}
                </div>
                {actionError && <div className="mt-3"><ErrorLine>{actionError}</ErrorLine></div>}
              </section>
            )}

            <ActionHistory history={history} />

            <AddRemarkBox id={id} onAdded={refreshAfterAction} />
          </>
        ) : null}
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 border-t pt-3">
        {editable ? (
          <>
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button className={SOLID.success} onClick={submit} disabled={submitting}>
              {submitting ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : <><CheckCircle2 className="size-4" /> Save Changes</>}
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

const ACTION_STYLE: Record<number, { icon: LucideIcon; dot: string; card: string }> = {
  0: { icon: FolderOpen, dot: 'bg-info text-white', card: 'border-info' },
  1: { icon: UserPlus, dot: 'bg-gold text-white', card: 'border-gold' },
  2: { icon: UserCheck, dot: 'bg-warning text-white', card: 'border-warning' },
  3: { icon: XCircle, dot: 'bg-destructive text-white', card: 'border-urgent' },
  4: { icon: CheckCircle2, dot: 'bg-success text-white', card: 'border-success' },
  9: { icon: MessageSquare, dot: 'bg-brand-500 text-white', card: 'border-primary' },
};

function ActionHistory({
  history,
}: {
  history: { data: SupplyGapHistoryEntry[] | null; loading: boolean; error: string | null };
}) {
  return (
    <section>
      <SectionTitle icon={History} tone="info">Action History</SectionTitle>
      {history.loading && !history.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : history.error ? (
        <ErrorLine>{history.error}</ErrorLine>
      ) : (history.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No actions recorded yet.</p>
      ) : (
        <ol className="relative ml-4 space-y-4 border-l-2 border-dashed border-border pl-7">
          {history.data!.map((h) => {
            const style = ACTION_STYLE[h.actionType] ?? { icon: Info, dot: 'bg-brand-500 text-white', card: 'border-primary' };
            const Icon = style.icon;
            // tx_details is "name_mobile" — show the technician's name only;
            // the CRM never renders a raw technician mobile.
            const txName = h.txDetails ? h.txDetails.split('_')[0] : null;
            return (
              <li key={h.commentId} className="relative">
                <span className={`absolute -left-[45px] top-1 flex size-8 items-center justify-center rounded-full shadow-sm ring-4 ring-background ${style.dot}`}>
                  <Icon className="size-4" />
                </span>
                <div className={`rounded-lg border border-l-4 bg-background px-4 py-3 shadow-sm ${style.card}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="text-sm">
                      <span className="font-semibold">{SUPPLY_ACTION_LABEL[h.actionType] ?? 'Updated'}</span>
                      <span className="text-muted-foreground"> by </span>
                      <span className="font-medium">{h.userName ?? '-'}</span>
                    </p>
                    <span className="text-xs text-muted-foreground tabular-nums">{h.insertOn ?? ''}</span>
                  </div>
                  {txName && (
                    <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-gold-tint px-2 py-0.5 text-xs text-gold-strong">
                      <UserPlus className="size-3" /> {txName}{h.efrCurrentStatus ? ` · ${h.efrCurrentStatus}` : ''}
                    </p>
                  )}
                  {h.comment && <p className="mt-1.5 text-sm text-foreground/90 whitespace-pre-wrap">{h.comment}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ── Presentational pieces ─────────────────────────────────────────────── */

type Tone = 'info' | 'success' | 'gold' | 'warning' | 'urgent' | 'brand';

const TONE = {
  info: { chip: 'bg-info text-white', tint: 'bg-info-tint', text: 'text-info-strong', ring: 'border-info ring-info/25', border: 'border-info' },
  success: { chip: 'bg-success text-white', tint: 'bg-success-tint', text: 'text-success-strong', ring: 'border-success ring-success/25', border: 'border-success' },
  gold: { chip: 'bg-gold text-white', tint: 'bg-gold-tint', text: 'text-gold-strong', ring: 'border-gold ring-gold/25', border: 'border-gold' },
  warning: { chip: 'bg-warning text-white', tint: 'bg-warning-tint', text: 'text-warning-strong', ring: 'border-warning ring-warning/25', border: 'border-warning' },
  urgent: { chip: 'bg-destructive text-white', tint: 'bg-urgent-tint', text: 'text-urgent-strong', ring: 'border-urgent ring-urgent/25', border: 'border-urgent' },
  brand: { chip: 'bg-primary text-white', tint: 'bg-brand-50', text: 'text-brand-700', ring: 'border-primary ring-primary/25', border: 'border-primary' },
} satisfies Record<Tone, { chip: string; tint: string; text: string; ring: string; border: string }>;

function SectionTitle({
  icon: Icon, tone, step, children,
}: { icon: LucideIcon; tone: Tone; step?: number; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className={`flex size-7 items-center justify-center rounded-lg ${TONE[tone].chip}`}>
        {step != null ? <span className="text-xs font-semibold">{step}</span> : <Icon className="size-4" />}
      </span>
      <h3 className="text-sm font-semibold">{children}</h3>
    </div>
  );
}

function ModeCard({
  icon: Icon, tone, title, hint, selected, onSelect,
}: { icon: LucideIcon; tone: Tone; title: string; hint: string; selected: boolean; onSelect: () => void }) {
  const t = TONE[tone];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`group flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all focus:outline-none focus-visible:ring-4 ${
        selected ? `${t.tint} ${t.ring} ring-4` : 'border-border bg-background hover:-translate-y-0.5 hover:shadow-md'
      }`}
    >
      <span className={`flex size-11 shrink-0 items-center justify-center rounded-xl shadow-sm ${t.chip}`}>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-base font-semibold ${selected ? t.text : ''}`}>{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
          selected ? `${t.border} ${t.chip}` : 'border-border'
        }`}
      >
        {selected && <CheckCircle2 className="size-3" />}
      </span>
    </button>
  );
}

type TileSpec = { icon: LucideIcon; label: string; value: string | number | null | undefined };

function InfoPanel({
  tone, icon: Icon, title, subtitle, badges, tiles,
}: { tone: Tone; icon: LucideIcon; title: string; subtitle?: string; badges?: React.ReactNode; tiles: TileSpec[] }) {
  const t = TONE[tone];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
      <div className={`flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 ${t.tint}`}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm ${t.chip}`}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className={`truncate text-base font-semibold ${t.text}`}>{title}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      </div>
      {/* Plain facts, deliberately uncoloured: colour in this dialog is kept for
          things that MEAN something (status, actions), so a row of six hues for
          client / PIN / city would only compete with them. */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
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
    </div>
  );
}

function ActionButton({
  tone, icon: Icon, title, hint, onClick,
}: { tone: 'info' | 'success' | 'gold' | 'urgent'; icon: LucideIcon; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-4 focus-visible:ring-foreground/20 ${SOLID[tone]}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/20">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-white/85">{hint}</span>
      </span>
    </button>
  );
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold shadow-sm ${className}`}>
      {children}
    </span>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-info/30 bg-gradient-to-r from-info-tint to-success-tint px-4 py-3 text-sm text-info-strong">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-info text-white">
        <Info className="size-4" />
      </span>
      <p className="self-center">{children}</p>
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-urgent/30 bg-urgent-tint px-4 py-3 text-sm text-urgent-strong">
      <XCircle className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
