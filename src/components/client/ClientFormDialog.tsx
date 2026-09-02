'use client';

/*
 * ClientFormDialog — Create + Edit client master.
 *
 * Layout matches the legacy EasyFix_CRM Add-Client form (verified
 * against screenshots 2026-05-25). All dropdowns use SearchSelect
 * (mandatory shared component); fixed enums use native <select>.
 *
 * Submit orchestration (the user requested "best UX and optimised
 * backend hits"):
 *
 *   1. Validate locally + show "Creating client…" toast.
 *   2. POST master fields → tbl_client INSERT (single statement).
 *   3. After client_id returns, kick off in parallel:
 *        - up to 4 file uploads (CIN, PAN, MOU, Logo) — one S3 PUT
 *          + one INSERT into tbl_client_document per file.
 *        - Primary + Secondary SPOC upsert — single TX (2 statements).
 *      All run via Promise.allSettled so a partial failure on, say,
 *      the Logo doesn't block the SPOC assignment.
 *   4. Report combined result (per-step status) via single success or
 *      "Created with N warnings" toast.
 *
 * Total round trips for a complete create: 1 (master) + N (files) + 1
 * (SPOC pair). For a 3-document client: 5 round trips total. The
 * parallel post-create batch keeps the wall-clock close to a single
 * round trip thanks to Promise.allSettled.
 *
 * Edit mode: only the master PUT fires; sub-resources (files, SPOCs)
 * are managed via their dedicated tabs.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { UploadCloud, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { COLLECTED_BY_OPTIONS, type ClientDetail } from '@/lib/client-types';

type Mode = 'create' | 'edit';

type City = { city_id: number; city_name: string };
type Vertical = { vertical_id: number; vertical_name: string };
// tbl_user uses single `user_name` + `official_email` per legacy
// (UserDaoImpl#128). first_name / last_name don't exist on this DB.
type UserRow = { user_id: number; user_name: string | null; official_email: string | null };
type UsersResponse = { items: UserRow[]; total?: number } | UserRow[];

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (id: number) => void;
  mode: Mode;
  initial?: ClientDetail | null;
};

// Same enum as Collected By per legacy: 1=Easyfixer, 2=Easyfix, 3=Client.
// "Paid By" reuses the same code space.
const PAID_BY_OPTIONS = COLLECTED_BY_OPTIONS;

type FormState = {
  // master
  clientName: string;
  clientEmail: string;
  clientAddress: string;
  building: string;
  landmark: string;
  cityId: number | '';
  pincode: string;
  // commercial
  paidBy: number | '';
  collectedBy: number | '';
  travelDistance: string;
  bookingCutOff: string;
  minOrders: string;
  couponCode: string;
  // KYC text
  cinNumber: string;
  panNumber: string;
  mouContact: string;
  referenceCode: string;
  // commercial (extended)
  monthlyRevenue: string;
  // mapping refs
  verticalId: number | '';
  primaryUserId: number | '';
  secondaryUserId: number | '';
  reportingContactIds: number[];
  clientStatus: number;
};

function blankForm(): FormState {
  return {
    clientName: '', clientEmail: '', clientAddress: '',
    building: '', landmark: '', cityId: '', pincode: '',
    paidBy: '', collectedBy: '', travelDistance: '0', bookingCutOff: '0',
    minOrders: '0', couponCode: '', monthlyRevenue: '',
    cinNumber: '', panNumber: '', mouContact: '', referenceCode: '',
    verticalId: '', primaryUserId: '', secondaryUserId: '',
    reportingContactIds: [], clientStatus: 1,
  };
}

function seedForm(initial?: ClientDetail | null): FormState {
  if (!initial) return blankForm();
  const num = (v: unknown): number | '' => {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    return Number.isFinite(n) ? n : '';
  };
  return {
    clientName: String(initial.client_name ?? ''),
    clientEmail: String(initial.client_email ?? ''),
    clientAddress: String(initial.client_address ?? ''),
    building: String((initial as Record<string, unknown>).building ?? ''),
    landmark: String((initial as Record<string, unknown>).landmark ?? ''),
    cityId: num((initial as Record<string, unknown>).client_city_id ?? initial.city_id),
    pincode: String((initial as Record<string, unknown>).client_pincode ?? ''),
    paidBy: num((initial as Record<string, unknown>).paid_by),
    collectedBy: num(initial.collected_by),
    travelDistance: String(initial.travel_distance ?? '0'),
    bookingCutOff: String(initial.booking_cut_off ?? '0'),
    minOrders: String(initial.max_orders ?? '0'),
    couponCode: String((initial as Record<string, unknown>).coupon_code ?? ''),
    monthlyRevenue: initial.monthly_revenue != null ? String(initial.monthly_revenue) : '',
    cinNumber: String((initial as Record<string, unknown>).tan_number ?? ''),
    panNumber: String((initial as Record<string, unknown>).client_pan_number ?? ''),
    mouContact: String((initial as Record<string, unknown>).client_aadhaar ?? ''),
    referenceCode: String(initial.reference_code ?? ''),
    verticalId: num(initial.vertical_id),
    primaryUserId: '', secondaryUserId: '',  // SPOCs not part of master row — must be queried via /verticals tab
    reportingContactIds: [],
    clientStatus: typeof initial.client_status === 'number' ? initial.client_status : 1,
  };
}

export function ClientFormDialog({ open, onClose, onSaved, mode, initial }: Props) {
  const isEdit = mode === 'edit';
  const [form, setForm] = useState<FormState>(() => seedForm(initial));
  const [saving, setSaving] = useState(false);

  // File state — kept outside `form` so refs + Files don't pollute the
  // diff/dirty logic. The Edit flow doesn't expose file inputs for
  // existing docs (Documents tab owns that surface).
  const cinFileRef = useRef<HTMLInputElement>(null);
  const panFileRef = useRef<HTMLInputElement>(null);
  const mouFileRef = useRef<HTMLInputElement>(null);
  const logoFileRef = useRef<HTMLInputElement>(null);

  // Re-seed when opened for a different target.
  const seedKey = isEdit ? initial?.client_id : 'create';
  useEffect(() => {
    if (!open) return;
    setForm(seedForm(initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, open]);

  // Lookups — fired once per session, module-deduped. None of these
  // change while the dialog is open.
  const { data: cities } = useFetchOnce<City[]>(`/shared/lookup/cities?limit=1000`);
  const { data: verticals } = useFetchOnce<Vertical[]>(`/shared/lookup/verticals`);
  const { data: usersResp } = useFetchOnce<UsersResponse>(`/admin/users?limit=500`);
  const users: UserRow[] = useMemo(() => {
    if (!usersResp) return [];
    if (Array.isArray(usersResp)) return usersResp;
    return Array.isArray(usersResp.items) ? usersResp.items : [];
  }, [usersResp]);

  // Existing contacts for the Reporting Contacts picker (edit-mode
  // only — create-mode has no contacts yet).
  const { data: contacts } = useFetchOnce<Array<{ id: number; contact_name: string; contact_email: string }>>(
    isEdit && initial?.client_id ? `/admin/clients/${initial.client_id}/contacts` : '',
  );

  const cityOptions = useMemo(() => (cities ?? []).map((c) => ({ value: c.city_id, label: c.city_name })), [cities]);
  const verticalOptions = useMemo(() => (verticals ?? []).map((v) => ({ value: v.vertical_id, label: v.vertical_name })), [verticals]);
  const userOptions = useMemo(() => users.map((u) => {
    const name = u.user_name?.trim() || u.official_email || `User #${u.user_id}`;
    return { value: u.user_id, label: name };
  }), [users]);
  const contactOptions = useMemo(() => (contacts ?? []).map((c) => ({ value: c.id, label: `${c.contact_name ?? ''} · ${c.contact_email ?? ''}` })), [contacts]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function file(ref: React.RefObject<HTMLInputElement | null>): File | null {
    return ref.current?.files?.[0] ?? null;
  }

  /*
   * Upload a single file to /admin/clients/:id/documents/upload and
   * return the resulting S3 key. Returns null if no file picked.
   * Throws on upload failure so the caller can include the error in
   * the combined report.
   */
  async function uploadDoc(clientId: number, fileObj: File | null, docType: 'pan' | 'tan' | 'gstin' | 'aadhaar' | 'other', label: string): Promise<string | null> {
    if (!fileObj) return null;
    const fd = new FormData();
    fd.append('file', fileObj);
    fd.append('docType', docType);
    fd.append('docLabel', label);
    const res = await api.post<{ document_id: number; s3_key: string }>(
      `/admin/clients/${clientId}/documents/upload`, fd,
    );
    return res.s3_key;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form.clientName.trim()) {
      showToast({ variant: 'error', message: 'Client Name is required.' });
      return;
    }
    if (!isEdit && form.primaryUserId && form.primaryUserId === form.secondaryUserId) {
      showToast({ variant: 'error', message: 'Primary and Secondary SPOC must be different users.' });
      return;
    }
    setSaving(true);
    const loadingId = showToast({ variant: 'loading', message: isEdit ? 'Saving…' : 'Creating client…' });
    try {
      // ─── Master payload (strip empty strings to null) ─────────────
      const payload: Record<string, unknown> = {};
      const setIf = (key: string, val: unknown) => {
        if (val === '' || val === undefined || val === null) return;
        payload[key] = val;
      };
      setIf('clientName', form.clientName);
      setIf('clientEmail', form.clientEmail);
      setIf('clientAddress', form.clientAddress);
      setIf('building', form.building);
      setIf('landmark', form.landmark);
      setIf('cityId', form.cityId === '' ? undefined : Number(form.cityId));
      setIf('pincode', form.pincode);
      setIf('paidBy', form.paidBy === '' ? undefined : Number(form.paidBy));
      setIf('collectedBy', form.collectedBy === '' ? undefined : Number(form.collectedBy));
      setIf('travelDistance', form.travelDistance === '' ? undefined : Number(form.travelDistance));
      setIf('bookingCutOff', form.bookingCutOff === '' ? undefined : Number(form.bookingCutOff));
      setIf('minOrders', form.minOrders === '' ? undefined : Number(form.minOrders));
      setIf('couponCode', form.couponCode);
      // monthlyRevenue: include as number or null (never skip — update schema supports it too)
      payload.monthlyRevenue = form.monthlyRevenue.trim() !== '' ? Number(form.monthlyRevenue) : null;
      setIf('cinNumber', form.cinNumber);
      setIf('panNumber', form.panNumber);
      setIf('mouContact', form.mouContact);
      setIf('referenceCode', form.referenceCode);
      setIf('verticalId', form.verticalId === '' ? undefined : Number(form.verticalId));
      if (form.reportingContactIds.length > 0) payload.reportingContactIds = form.reportingContactIds;
      if (isEdit) payload.clientStatus = form.clientStatus;

      // ─── 1. Master create/edit (single SQL statement) ─────────────
      let clientId: number;
      if (isEdit && initial?.client_id) {
        await api.put<{ updated: boolean }>(`/admin/clients/${initial.client_id}`, payload as never);
        clientId = initial.client_id;
      } else {
        const res = await api.post<{ client_id: number }>('/admin/clients', payload as never);
        clientId = res.client_id;
      }

      // ─── 2. Post-create batch (files + SPOC) — in parallel ────────
      // Each file upload is independent; SPOC pair is one TX. Promise.allSettled
      // so one failure doesn't cancel the others. Result statuses are
      // surfaced in the combined toast.
      const cinFile = file(cinFileRef);
      const panFile = file(panFileRef);
      const mouFile = file(mouFileRef);
      const logoFile = file(logoFileRef);
      const wantsSpoc = !isEdit && form.primaryUserId !== '' && form.secondaryUserId !== '';

      type StepResult = { name: string; ok: boolean; error?: string };
      const tasks: Promise<StepResult>[] = [];
      const upload = (lbl: string, f: File | null, t: 'pan' | 'tan' | 'aadhaar' | 'other') =>
        uploadDoc(clientId, f, t, lbl)
          .then(() => ({ name: lbl, ok: true }))
          .catch((err: unknown) => ({ name: lbl, ok: false, error: err instanceof ApiError ? err.message : 'upload failed' }));
      if (cinFile)  tasks.push(upload('CIN', cinFile, 'tan'));
      if (panFile)  tasks.push(upload('PAN', panFile, 'pan'));
      if (mouFile)  tasks.push(upload('MOU Contact', mouFile, 'aadhaar'));
      if (logoFile) tasks.push(upload('Logo', logoFile, 'other'));
      if (wantsSpoc) {
        tasks.push(
          api.put<{ assigned: boolean }>(`/admin/clients/${clientId}/verticals/upsert-spoc`, {
            primaryUserId: Number(form.primaryUserId),
            secondaryUserId: Number(form.secondaryUserId),
          } as never)
            .then(() => ({ name: 'Primary/Secondary SPOC', ok: true }))
            .catch((err: unknown) => ({ name: 'SPOC assignment', ok: false, error: err instanceof ApiError ? err.message : 'failed' })),
        );
      }
      const settled = tasks.length > 0 ? await Promise.all(tasks) : [];
      const failures = settled.filter((s) => !s.ok);

      // Drop module fetch caches so the list + detail dialog refresh.
      invalidateFetch((k) => k.startsWith('/admin/clients'));

      // Single combined toast — count failures, summarise.
      if (failures.length === 0) {
        showToast({
          variant: 'success',
          message: isEdit ? 'Client updated.' : `Client created${settled.length ? ` (+${settled.length} extras)` : ''}.`,
        });
      } else {
        showToast({
          variant: 'error',
          message: `Created, but ${failures.length} step(s) failed: ${failures.map((f) => `${f.name} (${f.error ?? 'unknown'})`).join('; ')}`,
        });
      }
      void loadingId;
      onSaved(clientId);
      onClose();
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  // useFormDirtyGuard (2026-06-03) — Esc / X / overlay-click now
  // prompts with the same "Discard changes?" confirm as the Cancel
  // button. `when: () => !saving` preserves the prior "block close
  // while a save is in flight" idiom. Called at the component's top
  // level (React rules-of-hooks); the saving check is read at click
  // time via the function form so the latest value wins.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog
      open={open}
      onOpenChange={guardedOpenChange}
    >
      {/*
       * Sticky header + sticky footer:
       *   - DialogContent is a flex COLUMN with capped max-height +
       *     overflow-hidden so the inner scroll container owns the
       *     scrolling.
       *   - DialogHeader is shrink-0 → stays pinned to the top.
       *   - The form body is flex-1 + overflow-y-auto → scrolls.
       *   - DialogFooter is shrink-0 → stays pinned to the bottom.
       *   - !p-0 disables the default 24px padding so the header can
       *     paint edge-to-edge; we restore padding inside the scroll
       *     container.
       */}
      <DialogContent className="!max-w-3xl max-h-[calc(100vh-48px)] !p-0 gap-0 overflow-hidden flex flex-col">
        {/*
         * (a) STABLE SURFACE — dark-slate header band pinned to one value in
         * BOTH themes. This is the commit-497cd6e substitution applied to a
         * header that predates it.
         *
         * `--ink-900` and `--ink-700` are text-ramp tokens: they INVERT, which
         * is correct for text and wrong for a plate carrying a fixed
         * `text-white`. Measured against white:
         *
         *   light  --ink-900  rgb(23,27,31)     17.31:1 ✓
         *   dark   --ink-900  rgb(244,246,247)   1.08:1 ✗
         *   light  --ink-700  rgb(54,60,65)     10.99:1 ✓
         *   dark   --ink-700  rgb(226,231,234)   1.25:1 ✗
         *
         * i.e. in dark mode the whole title bar went white-on-near-white.
         * `--sidebar` and `--sidebar-accent` are STABLE and hold exactly the
         * LIGHT-mode ink values — `--sidebar: 210 14.81% 10.59%` is
         * bit-identical to light `--ink-900`, `--sidebar-accent:
         * 212.73 9.24% 23.33%` to light `--ink-700` — so the LIGHT theme
         * renders IDENTICALLY and dark goes 1.08 → 17.31:1. The sky-blue
         * inset underline is a literal rgba, unaffected either way.
         */}
        <DialogHeader className="!mx-0 !mt-0 !mb-0 shrink-0 px-6 py-4 bg-gradient-to-r from-sidebar via-sidebar-accent to-sidebar text-white shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]">
          <DialogTitle className="text-white text-base font-semibold">
            {isEdit ? `Edit Client — ${initial?.client_name ?? ''}` : 'Add New Client'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {/* Master section ── */}
          <Section title="Basic">
            <Field label="Client Name" required>
              <Input value={form.clientName} onChange={(e) => update('clientName', e.target.value)} maxLength={255} required />
            </Field>
            <Field label="Email Address">
              <Input type="email" value={form.clientEmail} onChange={(e) => update('clientEmail', e.target.value)} maxLength={255} />
            </Field>
            <Field label="Reference Code">
              <Input value={form.referenceCode} onChange={(e) => update('referenceCode', e.target.value)} maxLength={50} />
            </Field>
            {/*
             * Status REMOVED from this form per user direction (2026-05-25).
             * Active ↔ Inactive flips happen via the X icon in the row
             * actions menu on the Manage Clients list — keeps a
             * destructive action out of an everyday edit flow.
             */}
          </Section>

          {/* KYC ── */}
          <Section title="KYC & Documents">
            <Field label="CIN NO (Text)">
              <Input value={form.cinNumber} onChange={(e) => update('cinNumber', e.target.value)} maxLength={100} />
            </Field>
            <FileField label="CIN Document" inputRef={cinFileRef} disabled={isEdit} hint={isEdit ? 'Manage via Documents tab' : 'PDF or image'} />
            <Field label="PAN (Text)">
              <Input value={form.panNumber} onChange={(e) => update('panNumber', e.target.value)} maxLength={50} />
            </Field>
            <FileField label="PAN Document" inputRef={panFileRef} disabled={isEdit} hint={isEdit ? 'Manage via Documents tab' : 'PDF or image'} />
            <Field label="MOU Contact (Text)">
              <Input value={form.mouContact} onChange={(e) => update('mouContact', e.target.value)} maxLength={200} />
            </Field>
            <FileField label="MOU Document" inputRef={mouFileRef} disabled={isEdit} hint={isEdit ? 'Manage via Documents tab' : 'PDF or image'} />
            <FileField label="Logo" inputRef={logoFileRef} disabled={isEdit} hint={isEdit ? 'Manage via Documents tab' : 'PNG / JPEG'} full />
          </Section>

          {/* Address ── */}
          <Section title="Address">
            <Field label="Current Address" full>
              <Input value={form.clientAddress} onChange={(e) => update('clientAddress', e.target.value)} maxLength={500} placeholder="Enter a location" />
            </Field>
            <Field label="Building / Apartment No">
              <Input value={form.building} onChange={(e) => update('building', e.target.value)} maxLength={200} placeholder="Enter Building/Apartment No" />
            </Field>
            <Field label="Landmark">
              <Input value={form.landmark} onChange={(e) => update('landmark', e.target.value)} maxLength={200} placeholder="Enter Landmark" />
            </Field>
            <Field label="City">
              <SearchSelect
                value={form.cityId || ''}
                onChange={(v) => update('cityId', v === '' ? '' : Number(v))}
                options={cityOptions}
                placeholder="-- All --"
              />
            </Field>
            <Field label="Pincode">
              <Input
                value={form.pincode}
                onChange={(e) => update('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit PIN"
              />
            </Field>
          </Section>

          {/*
           * LEGACY DEFER — Dashboard Name + Dashboard Password.
           *
           * The legacy CRM's Add Client form required these (they
           * powered a client-portal login backed by tbl_client_website).
           * Per ops + user direction (2026-05-25), both fields are
           * filled with "NA" in legacy and are NOT consumed anywhere
           * downstream. We intentionally OMIT them from the form so
           * operators don't waste time typing throw-away values.
           *
           * If a future workflow needs real client-portal creds, wire
           * a separate `tbl_client_website` upsert helper and add the
           * inputs back to this section.
           */}

          {/* Commercial ── */}
          <Section title="Commercial">
            <Field label="Paid By">
              <SearchSelect
                value={form.paidBy === '' ? '' : form.paidBy}
                onChange={(v) => update('paidBy', v === '' ? '' : Number(v))}
                options={PAID_BY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                placeholder="By client"
              />
            </Field>
            <Field label="Collected By">
              <SearchSelect
                value={form.collectedBy === '' ? '' : form.collectedBy}
                onChange={(v) => update('collectedBy', v === '' ? '' : Number(v))}
                options={COLLECTED_BY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                placeholder="Any"
              />
            </Field>
            <Field label="Max Distance Travel by Easyfixer">
              <Input type="number" min={0} value={form.travelDistance} onChange={(e) => update('travelDistance', e.target.value)} />
            </Field>
            <Field label="Booking Cut-off Time (Hours)">
              <Input type="number" min={0} max={48} value={form.bookingCutOff} onChange={(e) => update('bookingCutOff', e.target.value)} />
            </Field>
            <Field label="Min Orders">
              <Input type="number" min={0} value={form.minOrders} onChange={(e) => update('minOrders', e.target.value)} />
            </Field>
            <Field label="Discount / Coupon Code">
              <Input value={form.couponCode} onChange={(e) => update('couponCode', e.target.value)} maxLength={50} />
            </Field>
            <Field label="Monthly Revenue (INR)">
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">₹</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={form.monthlyRevenue}
                  onChange={(e) => update('monthlyRevenue', e.target.value)}
                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                  placeholder="0"
                  className="pl-6"
                />
              </div>
            </Field>
          </Section>

          {/*
           * Vertical & SPOC — paired layout per user direction:
           *   Row 1: Vertical | Reporting Contacts
           *   Row 2: Primary SPOC | Secondary SPOC
           * Reporting Contacts appears in BOTH create AND edit mode
           * but only carries options when edit-mode populates contacts
           * (create-mode has no existing contacts → SearchMultiSelect
           * stays empty with a tooltip).
           */}
          <Section title="Vertical & SPOC">
            <Field label="Vertical">
              <SearchSelect
                value={form.verticalId || ''}
                onChange={(v) => update('verticalId', v === '' ? '' : Number(v))}
                options={verticalOptions}
                placeholder="Select Vertical"
              />
            </Field>
            <Field label="Reporting Contacts">
              <SearchMultiSelect
                value={form.reportingContactIds}
                onChange={(vals) => update('reportingContactIds', vals.map((v) => Number(v)))}
                options={contactOptions}
                placeholder={isEdit ? 'Select Contacts' : 'Available after first Contact is added'}
                disabled={contactOptions.length === 0}
              />
            </Field>
            <Field label="Primary SPOC">
              <SearchSelect
                value={form.primaryUserId || ''}
                onChange={(v) => update('primaryUserId', v === '' ? '' : Number(v))}
                options={userOptions}
                placeholder={isEdit ? 'Manage via Verticals tab' : 'Select Vertical Head'}
                disabled={isEdit}
              />
            </Field>
            <Field label="Secondary SPOC">
              <SearchSelect
                value={form.secondaryUserId || ''}
                onChange={(v) => update('secondaryUserId', v === '' ? '' : Number(v))}
                options={userOptions}
                placeholder={isEdit ? 'Manage via Verticals tab' : 'Select Project Manager'}
                disabled={isEdit}
              />
            </Field>
          </Section>

          </div>
          {/* Sticky footer — shrink-0 keeps it pinned to the bottom of
              DialogContent's flex column; border-t separates it from
              the scrolling body. */}
          <DialogFooter className="shrink-0 px-6 py-3 border-t bg-card !mx-0 !mb-0 sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-3.5 mr-1 animate-spin" />}
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Internal layout helpers ─────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function Field({ label, required, full, children }: { label: string; required?: boolean; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <Label className="text-xs">
        {label}
        {required && <span className="text-urgent-strong ml-0.5">*</span>}
      </Label>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function FileField({
  label, inputRef, disabled, hint, full,
}: {
  label: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  hint?: string;
  full?: boolean;
}) {
  return (
    <Field label={label} full={full}>
      {/* Native file input — there's no shared FileInput component yet
          across the CRM, and other tabs (Documents, Notice images) also
          use bare <Input type="file"> with their own dropzones. Keep
          consistent; refactor to a shared component when one lands. */}
      {/* Cast because lib/Input's ref is non-nullable while React 19's
          useRef returns a nullable handle. The DOM-side semantics are
          identical. */}
      <Input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
        disabled={disabled}
      />
      {hint && (
        <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
          <UploadCloud className="size-2.5" /> {hint}
        </div>
      )}
    </Field>
  );
}
