'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * One component, two modes — `create` | `edit`. The legacy `view` mode
 * was retired 2026-06 — list page now opens the modal directly in edit
 * mode (with the same dirty-state guard as the rest of the CRM).
 *
 * Both modes render the same 3-tab layout — Profile / Flags & Verification
 * / Finance & Audit — matching the legacy easyfixer detail screen. In
 * Profile, the body is two side-by-side cards (Basic on the left, Address
 * on the right) with `<dl>` row layouts inside each card. Edit mode slots
 * an `<Input>` into the `<dd>` cell; the un-editable rows (ID, audit
 * timestamps, balance) render as plain text in both modes.
 */

export type EasyfixerModalMode = 'create' | 'edit';

type EfRecord = Record<string, unknown> & { efr_id: number; efr_name: string; efr_status: number };

const emptyForm = {
  efr_name: '', efr_first_name: '', efr_last_name: '',
  efr_no: '', efr_alt_no: '', efr_email: '',
  efr_type: '',
  efr_address: '', efr_address_res: '', efr_building: '', efr_landmark: '',
  efr_pin_no: '', efr_cityId: '', efr_zone_city_id: '',
  efr_base_gps: '', efr_current_gps: '',
  efr_service_category: '', efr_service_type: '',
  efr_manager_id: '', experience_id: '',
  efr_marital_status: '', efr_children: '', efr_age: '',
  date_of_birth: '', about_yourself: '',
  adhaar_card_number: '', pan_card_number: '',
  efr_tools: '', skill: '', skill_rating: '', tool_rating: '',
  health_insurance: false, accidental_insurance: false, have_driving_lisence: false,
  have_bike: false, use_whatsapp: false,
  is_technician_verified: false, is_email_verified: false,
  efr_profile_img: '',
  inactive_reason: '', inactive_comment: '',
};

type FormShape = typeof emptyForm;

export function EasyfixerModal({
  open, onClose, mode, easyfixerId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: EasyfixerModalMode;
  easyfixerId?: number;
  onSaved?: (record: EfRecord) => void;
}) {
  const lk = useLookup();
  // Modal-internal permission gates. Edit + Activate/Deactivate + Save
  // require `isEasyfixerEdit`; the Create flow requires `isEasyfixerAddNew`
  // so a user without add rights doesn't see a non-functional Save.
  const { me } = useMe();
  const can = actionFlags(me, ['isEasyfixerAddNew', 'isEasyfixerEdit']);
  const [record, setRecord] = useState<EfRecord | null>(null);
  const [form, setForm] = useState<FormShape>(emptyForm);
  const [pristine, setPristine] = useState<FormShape>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) setError(null); }, [open]);

  useEffect(() => {
    if (!open || !easyfixerId) {
      if (!easyfixerId) { setRecord(null); setForm(emptyForm); setPristine(emptyForm); }
      return;
    }
    // Stale-data guard: clear before the fetch so the header doesn't
    // flash the previously-opened easyfixer's name/id/city.
    setRecord(null);
    setForm(emptyForm);
    setPristine(emptyForm);
    setError(null);
    setLoading(true);
    // Edit mode opts out of the /admin/* mobile-masking middleware so
    // the round-trip is clean — saving an unchanged "9310••••••" would
    // otherwise fail the Joi mobile-pattern validator. (Same trick as
    // JobModal — see comment there for the longer rationale.)
    const fetchQuery = mode === 'edit' ? { unmasked: 'true' } : undefined;
    (async () => {
      try {
        const data = await api.get<EfRecord>(`/admin/easyfixers/${easyfixerId}`, fetchQuery);
        setRecord(data);
        const fresh = recordToForm(data);
        setForm(fresh);
        setPristine(fresh);
      } catch {
        setError('Could Not Load Easyfixer Details');
      } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, easyfixerId, mode]);

  function set<K extends keyof FormShape>(k: K, v: FormShape[K]) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  const isDirty = useMemo(() => {
    for (const k of Object.keys(form) as (keyof FormShape)[]) {
      if (form[k] !== pristine[k]) return true;
    }
    return false;
  }, [form, pristine]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setSaving(true); setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'boolean') { payload[k] = v; continue; }
        if (v === '' || v === null) continue;
        if (['efr_cityId', 'efr_zone_city_id', 'efr_manager_id', 'experience_id',
             'efr_children', 'efr_age', 'skill', 'skill_rating', 'tool_rating',
             'inactive_reason'].includes(k)) {
          payload[k] = Number(v);
        } else {
          payload[k] = v;
        }
      }
      const saved = mode === 'create'
        ? await api.post<EfRecord>('/admin/easyfixers', payload)
        : await api.patch<EfRecord>(`/admin/easyfixers/${easyfixerId}`, payload);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError
        ? err.message + (err.details ? ` — ${JSON.stringify(err.details)}` : '')
        : 'Failed To Save');
    } finally { setSaving(false); }
  }

  // Header title + subtitle composition — matches the screenshot:
  //   line 1: large readable name (or "New Easyfixer" in create)
  //   line 2: muted subtitle "Easyfixer #<id> · <masked mobile> · <city>"
  // During load, suppress identity-bearing parts so the prior record's
  // details can't flash through.
  const displayName = loading
    ? 'Easyfixer'
    : mode === 'create'
      ? (form.efr_name || 'New Easyfixer')
      : formatEasyfixerName(String(record?.efr_name ?? form.efr_name ?? '')) || 'Easyfixer';

  const subtitle = mode === 'edit' && !loading && record
    ? <>Easyfixer #{record.efr_id} · {maskMobile(record.efr_no)} · {String(record.city_name ?? '—')}</>
    : <>New Technician Registration</>;

  // Discard-changes guard on Esc / X / overlay-click. Skipped while
  // saving (modal is about to unmount). Matches the `!saving && onClose()`
  // idiom used elsewhere in the codebase.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    when: () => !saving,
    isDirty: () => isDirty,
  });

  const canSave = mode === 'create' ? can.isEasyfixerAddNew : can.isEasyfixerEdit;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent hideClose className="max-w-5xl w-[min(95vw,1100px)] h-[85vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 !mb-0 px-6 py-4">
          {/* Header band uses the auto-styled dark-slate gradient. Close
              moved to the footer per ops 2026-06 — header carries only
              identity (name + meta subtitle) and an optional read-only
              hint when the user has no edit rights. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg">{displayName}</DialogTitle>
              <DialogDescription className="mt-1 text-white/80">
                {subtitle}
              </DialogDescription>
            </div>
            {mode === 'edit' && !can.isEasyfixerEdit && (
              <span className="text-xs text-white/70 italic shrink-0">view-only</span>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                  <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                </svg>
                Loading…
              </span>
            </div>
          )}
          {!loading && (
            <form id="efr-form" onSubmit={submit}>
              <Tabs defaultValue="profile">
                <TabsList>
                  <TabsTrigger value="profile">Profile</TabsTrigger>
                  <TabsTrigger value="flags">Flags &amp; Verification</TabsTrigger>
                  <TabsTrigger value="finance">Finance &amp; Audit</TabsTrigger>
                </TabsList>

                <TabsContent value="profile" className="mt-4">
                  <div className="grid md:grid-cols-2 gap-5">
                    <ProfileBasicCard mode={mode} form={form} record={record} set={set} />
                    <ProfileAddressCard form={form} set={set} lk={lk} />
                  </div>
                </TabsContent>

                <TabsContent value="flags" className="mt-4">
                  <div className="grid md:grid-cols-2 gap-5">
                    <FlagsCard form={form} set={set} />
                    <InactiveReasonCard form={form} set={set} record={record} />
                  </div>
                </TabsContent>

                <TabsContent value="finance" className="mt-4">
                  <div className="grid md:grid-cols-2 gap-5">
                    <FinanceCard record={record} />
                    <AuditCard record={record} />
                  </div>
                </TabsContent>
              </Tabs>
              {error && <div className="mt-4 text-sm text-destructive">{error}</div>}
            </form>
          )}
        </div>

        <DialogFooter className="!mb-0 px-6 pb-4 pt-3">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {canSave && (
            <Button
              type="submit"
              form="efr-form"
              disabled={saving || loading || (mode === 'edit' && !isDirty)}
            >
              {saving ? 'Saving…' : mode === 'create' ? 'Create Easyfixer' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function recordToForm(r: EfRecord): FormShape {
  const pick = (k: string): string => {
    const v = (r as Record<string, unknown>)[k];
    if (v == null) return '';
    return String(v);
  };
  const bool = (k: string): boolean => {
    const v = (r as Record<string, unknown>)[k];
    return v === true || v === 1 || v === '1';
  };
  return {
    efr_name: pick('efr_name'), efr_first_name: pick('efr_first_name'), efr_last_name: pick('efr_last_name'),
    efr_no: pick('efr_no'), efr_alt_no: pick('efr_alt_no'), efr_email: pick('efr_email'),
    efr_type: pick('efr_type'),
    efr_address: pick('efr_address'), efr_address_res: pick('efr_address_res'),
    efr_building: pick('efr_building'), efr_landmark: pick('efr_landmark'),
    efr_pin_no: pick('efr_pin_no'), efr_cityId: pick('efr_cityId'), efr_zone_city_id: pick('efr_zone_city_id'),
    efr_base_gps: pick('efr_base_gps'), efr_current_gps: pick('efr_current_gps'),
    efr_service_category: pick('efr_service_category'), efr_service_type: pick('efr_service_type'),
    efr_manager_id: pick('efr_manager_id'), experience_id: pick('experience_id'),
    efr_marital_status: pick('efr_marital_status'), efr_children: pick('efr_children'), efr_age: pick('efr_age'),
    date_of_birth: pick('date_of_birth').slice(0, 10), about_yourself: pick('about_yourself'),
    adhaar_card_number: pick('adhaar_card_number'), pan_card_number: pick('pan_card_number'),
    efr_tools: pick('efr_tools'), skill: pick('skill'), skill_rating: pick('skill_rating'), tool_rating: pick('tool_rating'),
    health_insurance: bool('health_insurance'), accidental_insurance: bool('accidental_insurance'),
    have_driving_lisence: bool('have_driving_lisence'), have_bike: bool('have_bike'),
    use_whatsapp: bool('use_whatsapp'),
    is_technician_verified: bool('is_technician_verified'), is_email_verified: bool('is_email_verified'),
    efr_profile_img: pick('efr_profile_img'),
    inactive_reason: pick('inactive_reason'), inactive_comment: pick('inactive_comment'),
  };
}

// ─── Tabbed cards ────────────────────────────────────────────────────────────

type Lookup = ReturnType<typeof useLookup>;
type Setter = <K extends keyof FormShape>(k: K, v: FormShape[K]) => void;

/*
 * Each card uses a <dl> row layout matching the screenshot:
 *   label on the left (muted text), value on the right (right-aligned,
 *   font-medium). In edit mode, the value slot renders an <Input>; the
 *   un-editable rows (ID, audit fields, balance) render plain text in
 *   both modes.
 */

function ProfileBasicCard({
  mode, form, record, set,
}: { mode: EasyfixerModalMode; form: FormShape; record: EfRecord | null; set: Setter }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Basic</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Easyfixer ID" value={record?.efr_id ?? '—'} />
          <EditableRow label="Full Name" mode={mode} display={form.efr_name}>
            <Input required value={form.efr_name} onChange={(e) => set('efr_name', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="First Name" mode={mode} display={form.efr_first_name}>
            <Input value={form.efr_first_name} onChange={(e) => set('efr_first_name', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Last Name" mode={mode} display={form.efr_last_name}>
            <Input value={form.efr_last_name} onChange={(e) => set('efr_last_name', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Mobile" mode={mode} display={maskMobile(form.efr_no)}>
            <Input required pattern="[0-9]{10}" value={form.efr_no} onChange={(e) => set('efr_no', e.target.value.replace(/\D/g, ''))} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Alt Mobile" mode={mode} display={form.efr_alt_no ? maskMobile(form.efr_alt_no) : '—'}>
            <Input pattern="[0-9]{10}" value={form.efr_alt_no} onChange={(e) => set('efr_alt_no', e.target.value.replace(/\D/g, ''))} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Email" mode={mode} display={form.efr_email}>
            <Input type="email" value={form.efr_email} onChange={(e) => set('efr_email', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Type" mode={mode} display={form.efr_type}>
            <Input value={form.efr_type} onChange={(e) => set('efr_type', e.target.value)} placeholder="Technician / Helper" className="h-8 text-sm" />
          </EditableRow>
        </dl>
      </CardContent>
    </Card>
  );
}

function ProfileAddressCard({ form, set, lk }: { form: FormShape; set: Setter; lk: Lookup }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Address</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <EditableRow label="Work Address" mode="edit" display={form.efr_address}>
            <Input value={form.efr_address} onChange={(e) => set('efr_address', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Residential" mode="edit" display={form.efr_address_res}>
            <Input value={form.efr_address_res} onChange={(e) => set('efr_address_res', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Building" mode="edit" display={form.efr_building}>
            <Input value={form.efr_building} onChange={(e) => set('efr_building', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Landmark" mode="edit" display={form.efr_landmark}>
            <Input value={form.efr_landmark} onChange={(e) => set('efr_landmark', e.target.value)} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="PIN Code" mode="edit" display={form.efr_pin_no}>
            <Input pattern="[0-9]{6}" value={form.efr_pin_no} onChange={(e) => set('efr_pin_no', e.target.value.replace(/\D/g, ''))} className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="City" mode="edit" display={cityLabel(form.efr_cityId, lk)}>
            <div className="w-full max-w-[60%]">
              <SearchSelect required value={form.efr_cityId} onChange={(v) => set('efr_cityId', v)} placeholder="— Select City —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} />
            </div>
          </EditableRow>
          <EditableRow label="Zonal City" mode="edit" display={cityLabel(form.efr_zone_city_id, lk)}>
            <div className="w-full max-w-[60%]">
              <SearchSelect value={form.efr_zone_city_id} onChange={(v) => set('efr_zone_city_id', v)} placeholder="— Select Zone —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} />
            </div>
          </EditableRow>
          <EditableRow label="Base GPS" mode="edit" display={form.efr_base_gps}>
            <Input value={form.efr_base_gps} onChange={(e) => set('efr_base_gps', e.target.value)} placeholder="28.6139,77.2090" className="h-8 text-sm" />
          </EditableRow>
          <EditableRow label="Current GPS" mode="edit" display={form.efr_current_gps}>
            <Input value={form.efr_current_gps} onChange={(e) => set('efr_current_gps', e.target.value)} placeholder="auto from mobile" className="h-8 text-sm" />
          </EditableRow>
        </dl>
      </CardContent>
    </Card>
  );
}

function FlagsCard({ form, set }: { form: FormShape; set: Setter }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Verification &amp; Flags</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <CheckRow label="Technician Verified" checked={form.is_technician_verified} onChange={(v) => set('is_technician_verified', v)} />
          <CheckRow label="Email Verified" checked={form.is_email_verified} onChange={(v) => set('is_email_verified', v)} />
          {/* legacy typo preserved verbatim — DB column is `have_driving_lisence` */}
          <CheckRow label="Driving Licence" checked={form.have_driving_lisence} onChange={(v) => set('have_driving_lisence', v)} />
          <CheckRow label="Has Bike" checked={form.have_bike} onChange={(v) => set('have_bike', v)} />
          <CheckRow label="Uses WhatsApp" checked={form.use_whatsapp} onChange={(v) => set('use_whatsapp', v)} />
          <CheckRow label="Accidental Insurance" checked={form.accidental_insurance} onChange={(v) => set('accidental_insurance', v)} />
          <CheckRow label="Health Insurance" checked={form.health_insurance} onChange={(v) => set('health_insurance', v)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function InactiveReasonCard({ form, set, record }: { form: FormShape; set: Setter; record: EfRecord | null }) {
  const isInactive = record ? !Number(record.efr_status) : false;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Inactive Reason</CardTitle>
      </CardHeader>
      <CardContent>
        {isInactive ? (
          <dl className="divide-y">
            <EditableRow label="Reason Code" mode="edit" display={form.inactive_reason || '—'}>
              <Input type="number" value={form.inactive_reason} onChange={(e) => set('inactive_reason', e.target.value)} className="h-8 text-sm" />
            </EditableRow>
            <EditableRow label="Comment" mode="edit" display={form.inactive_comment || '—'}>
              <Input value={form.inactive_comment} onChange={(e) => set('inactive_comment', e.target.value)} className="h-8 text-sm" />
            </EditableRow>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Easyfixer Is Currently Active — No Inactive Reason On Record.</p>
        )}
      </CardContent>
    </Card>
  );
}

function FinanceCard({ record }: { record: EfRecord | null }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Finance</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Current Balance" value={record?.current_balance ?? '—'} />
          <Row label="Balance Updated" value={record?.balance_updated ? formatDate(String(record.balance_updated)) : '—'} />
          <Row label="Registration Fee Date" value={record?.efr_reg_fee_date ? formatDate(String(record.efr_reg_fee_date)) : '—'} />
          <Row label="Collection Mode" value={record?.efr_collection_mode ?? '—'} />
          <Row label="Collected By" value={record?.efr_amnt_collected_by ?? '—'} />
        </dl>
      </CardContent>
    </Card>
  );
}

function AuditCard({ record }: { record: EfRecord | null }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Audit</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Inserted By" value={record?.inserted_by ?? '—'} />
          <Row label="Created" value={record?.insert_date ? formatDate(String(record.insert_date)) : '—'} />
          <Row label="Updated By" value={record?.updated_by ?? '—'} />
          <Row label="Updated" value={record?.update_date ? formatDate(String(record.update_date)) : '—'} />
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Row primitives ──────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex justify-between items-center gap-4 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-right break-all max-w-[60%]">
        {value == null || value === '' ? '—' : String(value)}
      </dd>
    </div>
  );
}

/*
 * EditableRow — display an editable form control in `edit`/`create` mode,
 * or a read-only display value otherwise. The display string is used as
 * the value-cell text when the row is non-editable (currently only on
 * fields hard-coded to `mode="edit"`, i.e. the address card which is
 * always editable when shown). Kept as a single component so future
 * read-only modes don't need a parallel tree.
 */
function EditableRow({
  label, mode, display, children,
}: { label: string; mode: EasyfixerModalMode; display: unknown; children: React.ReactNode }) {
  // Both `create` and `edit` are editable today; keeping the prop for
  // future-proofing in case a `view` mode resurfaces.
  const editable = mode === 'create' || mode === 'edit';
  return (
    <div className="flex justify-between items-center gap-4 py-2">
      <dt className="text-sm text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-sm font-medium text-right break-all min-w-0 flex-1 flex justify-end">
        {editable ? children : (display == null || display === '' ? '—' : String(display))}
      </dd>
    </div>
  );
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex justify-between items-center gap-4 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-input accent-primary" />
      </dd>
    </div>
  );
}

function cityLabel(id: string, lk: Lookup): string {
  if (!id) return '—';
  const found = lk.toOpts.cities.find((o) => String(o.value) === String(id));
  return found ? String(found.label) : id;
}
