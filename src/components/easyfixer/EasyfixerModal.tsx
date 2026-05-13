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
import { formatDate, formatEasyfixerName } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

/*
 * One component, three modes — `create` | `edit` | `view`. The field set is
 * identical across modes; only the rendering style (inputs vs. read-only rows)
 * and the footer actions differ. This avoids the trap of having three diverging
 * forms that drift apart with each schema change.
 *
 * Callers decide which entry they're hitting:
 *   mode="create"                      — empty form; submit → POST /admin/easyfixers
 *   mode="view"  + easyfixerId         — loads record; inputs disabled; "Edit" button flips to edit
 *   mode="edit"  + easyfixerId         — loads record; inputs editable; submit → PATCH /admin/easyfixers/:id
 *
 * Detail view is tabbed (Profile / Flags & Verification / Finance & Audit)
 * matching the legacy easyfixer profile page layout.
 */

export type EasyfixerModalMode = 'create' | 'edit' | 'view';

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
};

type FormShape = typeof emptyForm;

export function EasyfixerModal({
  open, onClose, mode: initialMode, easyfixerId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: EasyfixerModalMode;
  easyfixerId?: number;
  onSaved?: (record: EfRecord) => void;
}) {
  const lk = useLookup();
  // Modal-internal permission gates. View mode is open to anyone with
  // access to /easyfixers; Edit + Activate/Deactivate + Save require
  // the legacy `isEasyfixerEdit` action, and the Create form's submit
  // requires `isEasyfixerAddNew` so a user who can browse but not add
  // doesn't see a non-functional submit button after switching modes.
  const { me } = useMe();
  const can = actionFlags(me, ['isEasyfixerAddNew', 'isEasyfixerEdit']);
  const [mode, setMode] = useState<EasyfixerModalMode>(initialMode);
  const [record, setRecord] = useState<EfRecord | null>(null);
  const [form, setForm] = useState<FormShape>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the caller's requested mode whenever the modal re-opens. Prevents
  // state bleed-through when the user views one easyfixer, closes, then opens
  // another — they'd otherwise land on whatever mode the previous session ended in.
  useEffect(() => { if (open) { setMode(initialMode); setError(null); } }, [open, initialMode, easyfixerId]);

  useEffect(() => {
    if (!open || !easyfixerId) { if (!easyfixerId) { setRecord(null); setForm(emptyForm); } return; }
    // Stale-data fix: clear record + form BEFORE the fetch so the title,
    // subtitle, and any field that reads from `record.efr_name` don't
    // flash the previously-opened easyfixer's details. Title/subtitle
    // fall through to "Loading…" via the !loading gate below.
    setRecord(null);
    setForm(emptyForm);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const data = await api.get<EfRecord>(`/admin/easyfixers/${easyfixerId}`);
        setRecord(data);
        setForm(recordToForm(data));
      } catch {
        setError('Could not load easyfixer details');
      } finally { setLoading(false); }
    })();
  }, [open, easyfixerId]);

  function set<K extends keyof FormShape>(k: K, v: FormShape[K]) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'boolean') { payload[k] = v; continue; }
        if (v === '' || v === null) continue;
        if (['efr_cityId', 'efr_zone_city_id', 'efr_manager_id', 'experience_id',
             'efr_children', 'efr_age', 'skill', 'skill_rating', 'tool_rating'].includes(k)) {
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
        : 'Failed to save');
    } finally { setSaving(false); }
  }

  async function toggleStatus() {
    if (!record) return;
    const active = !Number(record.efr_status);
    await api.patch(`/admin/easyfixers/${record.efr_id}/status`, {
      active, reasonId: active ? undefined : 1,
      comment: active ? undefined : 'deactivated from CRM',
    });
    const refreshed = await api.get<EfRecord>(`/admin/easyfixers/${record.efr_id}`);
    setRecord(refreshed); setForm(recordToForm(refreshed));
    onSaved?.(refreshed);
  }

  // While the fresh record is loading, suppress the identity-bearing
  // parts of the title/subtitle (name, id, city) so the operator can't
  // see the previously-opened easyfixer's details flash. We render a
  // neutral title ("Easyfixer") rather than "Loading easyfixer…" so
  // the centered body loader is the ONLY loading indicator visible —
  // header + body together used to produce two loading hints which
  // looked sloppy.
  const title = mode === 'create' ? 'Add New Easyfixer'
             : loading            ? 'Easyfixer'
             : mode === 'edit'    ? `Edit · ${formatEasyfixerName(record?.efr_name ?? '')}`
             : formatEasyfixerName(record?.efr_name ?? '') || 'Easyfixer';
  const subtitle = mode === 'view' && !loading && record
    ? `Easyfixer #${record.efr_id} · ${String(record.efr_no ?? '')} · ${String(record.city_name ?? '—')}`
    : undefined;

  const readOnly = mode === 'view';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose className="max-w-5xl w-[min(95vw,1100px)] h-[85vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate">{title}</DialogTitle>
              {subtitle && <DialogDescription className="mt-1">{subtitle}</DialogDescription>}
            </div>
            {mode === 'view' && record && can.isEasyfixerEdit && (
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" variant="outline" onClick={() => setMode('edit')}>Edit</Button>
                <Button size="sm" variant={Number(record.efr_status) ? 'destructive' : 'default'} onClick={toggleStatus}>
                  {Number(record.efr_status) ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            )}
            {mode === 'view' && record && !can.isEasyfixerEdit && (
              <span className="text-xs text-muted-foreground italic shrink-0">view-only</span>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Single centered loader — see JobModal for the same pattern.
              Header title stays neutral while loading; this is the only
              loading indicator the operator sees. */}
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
          {!loading && mode === 'view' && record && <ViewBody record={record} />}
          {!loading && mode !== 'view' && (
            <form id="efr-form" onSubmit={submit} className="space-y-5">
              <FormSections form={form} set={set} readOnly={false} lk={lk} />
              {error && <div className="text-sm text-destructive">{error}</div>}
            </form>
          )}
        </div>

        <div className="px-6 py-3 border-t bg-muted/30 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {mode === 'create' && can.isEasyfixerAddNew && (
            <Button type="submit" form="efr-form" disabled={saving || loading}>
              {saving ? 'Saving…' : 'Create Easyfixer'}
            </Button>
          )}
          {mode === 'edit' && can.isEasyfixerEdit && (
            <Button type="submit" form="efr-form" disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </div>
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
  };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

type Lookup = ReturnType<typeof useLookup>;

function FormSections({ form, set, lk }: {
  form: FormShape;
  set: <K extends keyof FormShape>(k: K, v: FormShape[K]) => void;
  readOnly: boolean;
  lk: Lookup;
}) {
  return (
    <>
      <Section title="Basic">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Full name *"><Input required value={form.efr_name} onChange={(e) => set('efr_name', e.target.value)} /></Field>
          <Field label="First name"><Input value={form.efr_first_name} onChange={(e) => set('efr_first_name', e.target.value)} /></Field>
          <Field label="Last name"><Input value={form.efr_last_name} onChange={(e) => set('efr_last_name', e.target.value)} /></Field>
          <Field label="Mobile *"><Input required pattern="[0-9]{10}" value={form.efr_no} onChange={(e) => set('efr_no', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="Alt mobile"><Input pattern="[0-9]{10}" value={form.efr_alt_no} onChange={(e) => set('efr_alt_no', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="Email"><Input type="email" value={form.efr_email} onChange={(e) => set('efr_email', e.target.value)} /></Field>
          <Field label="Type"><Input value={form.efr_type} onChange={(e) => set('efr_type', e.target.value)} placeholder="Technician / Helper" /></Field>
        </div>
      </Section>

      <Section title="Address">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Work address" full><Input value={form.efr_address} onChange={(e) => set('efr_address', e.target.value)} /></Field>
          <Field label="Residential address" full><Input value={form.efr_address_res} onChange={(e) => set('efr_address_res', e.target.value)} /></Field>
          <Field label="Building"><Input value={form.efr_building} onChange={(e) => set('efr_building', e.target.value)} /></Field>
          <Field label="Landmark"><Input value={form.efr_landmark} onChange={(e) => set('efr_landmark', e.target.value)} /></Field>
          <Field label="PIN code"><Input pattern="[0-9]{6}" value={form.efr_pin_no} onChange={(e) => set('efr_pin_no', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="City *"><SearchSelect required value={form.efr_cityId} onChange={(v) => set('efr_cityId', v)} placeholder="— Select city —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} /></Field>
          <Field label="Zonal city"><SearchSelect value={form.efr_zone_city_id} onChange={(v) => set('efr_zone_city_id', v)} placeholder="— Select zone —" options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} /></Field>
          <Field label="Base GPS"><Input value={form.efr_base_gps} onChange={(e) => set('efr_base_gps', e.target.value)} placeholder="28.6139,77.2090" /></Field>
          <Field label="Current GPS"><Input value={form.efr_current_gps} onChange={(e) => set('efr_current_gps', e.target.value)} placeholder="auto from mobile" /></Field>
        </div>
      </Section>

      <Section title="Service">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Service category *">
            <SearchSelect
              required
              value={form.efr_service_category}
              onChange={(v) => set('efr_service_category', v)}
              placeholder="— Select —"
              options={lk.serviceCategories.map((c) => ({ value: c.service_catg_name, label: c.service_catg_name }))}
            />
          </Field>
          <Field label="Service type *">
            {/*
              * Easyfixer record stores the service_type_name (not id) so the
              * option value must match. Same contract as the original native
              * <Select> above; SearchSelect adds type-to-filter for 100+ items.
              */}
            <SearchSelect
              required
              value={form.efr_service_type}
              onChange={(v) => set('efr_service_type', v)}
              placeholder="— Select —"
              options={lk.serviceTypes.map((t) => ({ value: t.service_type_name, label: t.service_type_name }))}
            />
          </Field>
          <Field label="Manager"><SearchSelect value={form.efr_manager_id} onChange={(v) => set('efr_manager_id', v)} placeholder="— Select —" options={lk.toOpts.adminUsers.map((o) => ({ value: o.value, label: String(o.label) }))} /></Field>
          <Field label="Experience ID"><Input type="number" value={form.experience_id} onChange={(e) => set('experience_id', e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Personal">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Date of birth"><Input type="date" value={form.date_of_birth} onChange={(e) => set('date_of_birth', e.target.value)} /></Field>
          <Field label="Age"><Input type="number" min={16} max={90} value={form.efr_age} onChange={(e) => set('efr_age', e.target.value)} /></Field>
          <Field label="Marital status">
            <Select value={form.efr_marital_status} onChange={(e) => set('efr_marital_status', e.target.value)} placeholder="— Select —" options={[
              { value: 'Single', label: 'Single' }, { value: 'Married', label: 'Married' },
              { value: 'Divorced', label: 'Divorced' }, { value: 'Widowed', label: 'Widowed' },
            ]} />
          </Field>
          <Field label="Children"><Input type="number" min={0} max={20} value={form.efr_children} onChange={(e) => set('efr_children', e.target.value)} /></Field>
          <Field label="About" full><Input value={form.about_yourself} onChange={(e) => set('about_yourself', e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Identity & Skills">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Aadhaar (12 digits)"><Input pattern="[0-9]{12}" value={form.adhaar_card_number} onChange={(e) => set('adhaar_card_number', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="PAN"><Input pattern="[A-Z]{5}[0-9]{4}[A-Z]" value={form.pan_card_number} onChange={(e) => set('pan_card_number', e.target.value.toUpperCase())} /></Field>
          <Field label="Profile image URL"><Input value={form.efr_profile_img} onChange={(e) => set('efr_profile_img', e.target.value)} /></Field>
          <Field label="Tools (list)" full><Input value={form.efr_tools} onChange={(e) => set('efr_tools', e.target.value)} placeholder="drill, hammer, ladder…" /></Field>
          <Field label="Skill score"><Input type="number" value={form.skill} onChange={(e) => set('skill', e.target.value)} /></Field>
          <Field label="Skill rating (0-5)"><Input type="number" min={0} max={5} value={form.skill_rating} onChange={(e) => set('skill_rating', e.target.value)} /></Field>
          <Field label="Tool rating (0-5)"><Input type="number" min={0} max={5} value={form.tool_rating} onChange={(e) => set('tool_rating', e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Flags">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Check label="Has bike" checked={form.have_bike} onChange={(v) => set('have_bike', v)} />
          <Check label="Uses WhatsApp" checked={form.use_whatsapp} onChange={(v) => set('use_whatsapp', v)} />
          <Check label="Driving licence" checked={form.have_driving_lisence} onChange={(v) => set('have_driving_lisence', v)} />
          <Check label="Health insurance" checked={form.health_insurance} onChange={(v) => set('health_insurance', v)} />
          <Check label="Accidental insurance" checked={form.accidental_insurance} onChange={(v) => set('accidental_insurance', v)} />
          <Check label="Technician verified" checked={form.is_technician_verified} onChange={(v) => set('is_technician_verified', v)} />
          <Check label="Email verified" checked={form.is_email_verified} onChange={(v) => set('is_email_verified', v)} />
        </div>
      </Section>
    </>
  );
}

function ViewBody({ record }: { record: EfRecord }) {
  // Matches the legacy detail-page tabs exactly (Profile / Flags & Verification / Finance & Audit)
  // so muscle memory carries across.
  const sections: { title: string; rows: [string, unknown][] }[] = [
    { title: 'Basic', rows: [
      ['Easyfixer ID', record.efr_id], ['Full name', formatEasyfixerName(String(record.efr_name ?? ''))],
      ['First name', record.efr_first_name], ['Last name', record.efr_last_name],
      ['Mobile', record.efr_no], ['Alt mobile', record.efr_alt_no],
      ['Email', record.efr_email], ['Type', record.efr_type],
    ]},
    { title: 'Address', rows: [
      ['Work address', record.efr_address], ['Residential', record.efr_address_res],
      ['Building', record.efr_building], ['Landmark', record.efr_landmark],
      ['PIN', record.efr_pin_no], ['City', record.city_name],
      ['Base GPS', record.efr_base_gps], ['Current GPS', record.efr_current_gps],
    ]},
    { title: 'Service', rows: [
      ['Category', record.efr_service_category], ['Service type', record.efr_service_type],
      ['Manager ID', record.efr_manager_id], ['Experience ID', record.experience_id],
    ]},
    { title: 'Personal', rows: [
      ['Date of birth', record.date_of_birth ? formatDate(String(record.date_of_birth)) : null],
      ['Age', record.efr_age], ['Marital status', record.efr_marital_status],
      ['Children', record.efr_children], ['About', record.about_yourself],
    ]},
    { title: 'Identity', rows: [
      ['Aadhaar', record.adhaar_card_number], ['PAN', record.pan_card_number],
      ['Profile image', record.efr_profile_img],
    ]},
    { title: 'Skills & Tools', rows: [
      ['Tools', record.efr_tools], ['Skill', record.skill],
      ['Skill rating', record.skill_rating], ['Tool rating', record.tool_rating],
    ]},
    { title: 'Flags', rows: [
      ['Has bike', boolish(record.have_bike)], ['Uses WhatsApp', boolish(record.use_whatsapp)],
      ['Driving licence', boolish(record.have_driving_lisence)],
      ['Health insurance', boolish(record.health_insurance)],
      ['Accidental insurance', boolish(record.accidental_insurance)],
      ['Technician verified', boolish(record.is_technician_verified)],
      ['Email verified', boolish(record.is_email_verified)],
      ['New easyfixer', boolish(record.new_easy_fixer)],
      ['Existing easyfixer', boolish(record.is_existing_easyfixer)],
      ['Final submission', boolish(record.final_submission)],
    ]},
    { title: 'Profile completion', rows: [
      ['Overall %', record.efr_profile_perc],
      ['Personal %', record.efr_personal_details_perc],
      ['Professional %', record.efr_professional_details_perc],
      ['Identity %', record.efr_identity_details_perc],
      ['Bank %', record.efr_bank_details_perc],
    ]},
    { title: 'Finance', rows: [
      ['Current balance', record.current_balance],
      ['Balance updated', record.balance_updated ? formatDate(String(record.balance_updated)) : null],
      ['Registration fee date', record.efr_reg_fee_date ? formatDate(String(record.efr_reg_fee_date)) : null],
      ['Collection mode', record.efr_collection_mode],
      ['Collected by', record.efr_amnt_collected_by],
    ]},
    { title: 'Audit', rows: [
      ['Inserted by', record.inserted_by],
      ['Created', record.insert_date ? formatDate(String(record.insert_date)) : null],
      ['Updated by', record.updated_by],
      ['Updated', record.update_date ? formatDate(String(record.update_date)) : null],
    ]},
  ];

  return (
    <Tabs defaultValue="profile">
      <TabsList>
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="flags">Flags &amp; Verification</TabsTrigger>
        <TabsTrigger value="finance">Finance &amp; Audit</TabsTrigger>
      </TabsList>
      <TabsContent value="profile">
        <div className="grid md:grid-cols-2 gap-5">
          {sections.slice(0, 6).map((s) => <DlCard key={s.title} title={s.title} rows={s.rows} />)}
        </div>
      </TabsContent>
      <TabsContent value="flags">
        <div className="grid md:grid-cols-2 gap-5">
          {sections.slice(6, 8).map((s) => <DlCard key={s.title} title={s.title} rows={s.rows} />)}
        </div>
      </TabsContent>
      <TabsContent value="finance">
        <div className="grid md:grid-cols-2 gap-5">
          {sections.slice(8).map((s) => <DlCard key={s.title} title={s.title} rows={s.rows} />)}
        </div>
      </TabsContent>
    </Tabs>
  );
}

// ─── Tiny presentational helpers ─────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="px-5 py-3 border-b bg-muted/30">
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

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-input accent-primary" />
      <span>{label}</span>
    </label>
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

function boolish(v: unknown): string {
  if (v === true || v === 1 || v === '1') return 'Yes';
  if (v === false || v === 0 || v === '0') return 'No';
  return '—';
}
