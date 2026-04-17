'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';

/*
 * Full easyfixer create form — covers every mutable column accepted by
 * easyfixer.validator.js createBody (~35 fields). Fields are grouped by
 * section to match the density + layout of legacy EasyFix_CRM's addEditFixer.vm.
 */
export default function NewEasyfixerPage() {
  const router = useRouter();
  const lk = useLookup();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = {
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
  const [f, setF] = useState(initial);
  function set<K extends keyof typeof f>(k: K, v: (typeof f)[K]) { setF((s) => ({ ...s, [k]: v })); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === 'boolean') { payload[k] = v; continue; }
        if (v === '' || v === null) continue;
        if (['efr_cityId', 'efr_zone_city_id', 'efr_manager_id', 'experience_id',
             'efr_children', 'efr_age', 'skill', 'skill_rating', 'tool_rating'].includes(k)) {
          payload[k] = Number(v);
        } else {
          payload[k] = v;
        }
      }
      const created = await api.post<{ efr_id: number }>('/admin/easyfixers', payload);
      router.push(`/easyfixers/${created.efr_id}`);
    } catch (err) {
      setError(err instanceof ApiError
        ? err.message + (err.details ? ` — ${JSON.stringify(err.details)}` : '')
        : 'Failed');
    } finally { setLoading(false); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <h1 className="text-2xl font-semibold">New Easyfixer</h1>
      <form onSubmit={submit} className="space-y-5">

        <Card>
          <CardHeader><CardTitle>Basic Details</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Full name *"><Input required value={f.efr_name} onChange={(e) => set('efr_name', e.target.value)} /></Field>
            <Field label="First name"><Input value={f.efr_first_name} onChange={(e) => set('efr_first_name', e.target.value)} /></Field>
            <Field label="Last name"><Input value={f.efr_last_name} onChange={(e) => set('efr_last_name', e.target.value)} /></Field>
            <Field label="Mobile *"><Input required pattern="[0-9]{10}" value={f.efr_no} onChange={(e) => set('efr_no', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Alternate mobile"><Input pattern="[0-9]{10}" value={f.efr_alt_no} onChange={(e) => set('efr_alt_no', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Email"><Input type="email" value={f.efr_email} onChange={(e) => set('efr_email', e.target.value)} /></Field>
            <Field label="Type"><Input placeholder="e.g. Technician / Helper" value={f.efr_type} onChange={(e) => set('efr_type', e.target.value)} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Address</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Work address" full><Input value={f.efr_address} onChange={(e) => set('efr_address', e.target.value)} /></Field>
            <Field label="Residential address" full><Input value={f.efr_address_res} onChange={(e) => set('efr_address_res', e.target.value)} /></Field>
            <Field label="Building"><Input value={f.efr_building} onChange={(e) => set('efr_building', e.target.value)} /></Field>
            <Field label="Landmark"><Input value={f.efr_landmark} onChange={(e) => set('efr_landmark', e.target.value)} /></Field>
            <Field label="PIN code"><Input pattern="[0-9]{6}" value={f.efr_pin_no} onChange={(e) => set('efr_pin_no', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="City *"><Select required value={f.efr_cityId} onChange={(e) => set('efr_cityId', e.target.value)} placeholder="— Select city —" options={lk.toOpts.cities} /></Field>
            <Field label="Zonal city"><Select value={f.efr_zone_city_id} onChange={(e) => set('efr_zone_city_id', e.target.value)} placeholder="— Select zone —" options={lk.toOpts.cities} /></Field>
            <Field label="Base GPS (lat,lng)"><Input placeholder="28.6139,77.2090" value={f.efr_base_gps} onChange={(e) => set('efr_base_gps', e.target.value)} /></Field>
            <Field label="Current GPS"><Input placeholder="auto from mobile app" value={f.efr_current_gps} onChange={(e) => set('efr_current_gps', e.target.value)} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Service & Assignment</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Service category *">
              <Select required value={f.efr_service_category} onChange={(e) => set('efr_service_category', e.target.value)} placeholder="— Select —">
                {lk.serviceCategories.map((c) => <option key={c.service_catg_id} value={c.service_catg_name}>{c.service_catg_name}</option>)}
              </Select>
            </Field>
            <Field label="Service type *">
              <Select required value={f.efr_service_type} onChange={(e) => set('efr_service_type', e.target.value)} placeholder="— Select —">
                {lk.serviceTypes.map((t) => <option key={t.service_type_id} value={t.service_type_name}>{t.service_type_name}</option>)}
              </Select>
            </Field>
            <Field label="Manager"><Select value={f.efr_manager_id} onChange={(e) => set('efr_manager_id', e.target.value)} placeholder="— Select —" options={lk.toOpts.adminUsers} /></Field>
            <Field label="Experience"><Input type="number" value={f.experience_id} onChange={(e) => set('experience_id', e.target.value)} placeholder="ID from experience list" /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Personal</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Date of birth"><Input type="date" value={f.date_of_birth} onChange={(e) => set('date_of_birth', e.target.value)} /></Field>
            <Field label="Age"><Input type="number" min={16} max={90} value={f.efr_age} onChange={(e) => set('efr_age', e.target.value)} /></Field>
            <Field label="Marital status"><Select value={f.efr_marital_status} onChange={(e) => set('efr_marital_status', e.target.value)} placeholder="— Select —" options={[
              { value: 'Single', label: 'Single' }, { value: 'Married', label: 'Married' },
              { value: 'Divorced', label: 'Divorced' }, { value: 'Widowed', label: 'Widowed' },
            ]} /></Field>
            <Field label="Children"><Input type="number" min={0} max={20} value={f.efr_children} onChange={(e) => set('efr_children', e.target.value)} /></Field>
            <Field label="About yourself" full><Input value={f.about_yourself} onChange={(e) => set('about_yourself', e.target.value)} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Identity Documents</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Aadhaar number (12 digits)"><Input pattern="[0-9]{12}" value={f.adhaar_card_number} onChange={(e) => set('adhaar_card_number', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="PAN number"><Input pattern="[A-Z]{5}[0-9]{4}[A-Z]" value={f.pan_card_number} onChange={(e) => set('pan_card_number', e.target.value.toUpperCase())} /></Field>
            <Field label="Profile image URL" full><Input value={f.efr_profile_img} onChange={(e) => set('efr_profile_img', e.target.value)} placeholder="Paste image link (use the file upload tool first)" /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Skills & Tools</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Field label="Tools (list)" full><Input value={f.efr_tools} onChange={(e) => set('efr_tools', e.target.value)} placeholder="e.g. drill, hammer, ladder" /></Field>
            <Field label="Skill score"><Input type="number" value={f.skill} onChange={(e) => set('skill', e.target.value)} /></Field>
            <Field label="Skill rating (0-5)"><Input type="number" min={0} max={5} value={f.skill_rating} onChange={(e) => set('skill_rating', e.target.value)} /></Field>
            <Field label="Tool rating (0-5)"><Input type="number" min={0} max={5} value={f.tool_rating} onChange={(e) => set('tool_rating', e.target.value)} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Flags</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Check label="Has bike" checked={f.have_bike} onChange={(v) => set('have_bike', v)} />
            <Check label="Uses WhatsApp" checked={f.use_whatsapp} onChange={(v) => set('use_whatsapp', v)} />
            <Check label="Driving licence" checked={f.have_driving_lisence} onChange={(v) => set('have_driving_lisence', v)} />
            <Check label="Health insurance" checked={f.health_insurance} onChange={(v) => set('health_insurance', v)} />
            <Check label="Accidental insurance" checked={f.accidental_insurance} onChange={(v) => set('accidental_insurance', v)} />
            <Check label="Technician verified" checked={f.is_technician_verified} onChange={(v) => set('is_technician_verified', v)} />
            <Check label="Email verified" checked={f.is_email_verified} onChange={(v) => set('is_email_verified', v)} />
          </CardContent>
        </Card>

        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Create Easyfixer'}</Button>
        </div>
      </form>
    </div>
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
