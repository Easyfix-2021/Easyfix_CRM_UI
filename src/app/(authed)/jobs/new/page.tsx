'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';

/*
 * Comprehensive job create form — covers every field accepted by
 * job.validator.js createBody. Uses real dropdowns for clients / cities /
 * service types, with the legacy addEditJob.vm as layout reference.
 */

type ClientService = {
  client_service_id: number; service_type_id: number; service_type_name: string;
  service_catg_id: number; service_catg_name: string; total_amount: number;
  rate_card_id: number | null; crc_ratecard_name: string | null;
};
type ClientContact = { id: number; contact_name: string; contact_email: string; contact_no: string };

export default function NewJobPage() {
  const router = useRouter();
  const lk = useLookup();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-client loaded dropdowns
  const [clientServices, setClientServices] = useState<ClientService[]>([]);
  const [clientContacts, setClientContacts] = useState<ClientContact[]>([]);

  const [f, setF] = useState({
    // Job details
    fk_client_id: '', job_type: 'Installation', source_type: 'manual',
    fk_service_catg_id: '', fk_service_type_id: '',
    requested_date_time: '', time_slot: 'Morning 9 to 2',
    job_owner: '',
    client_ref_id: '', job_reference_id: '',
    job_desc: '', remarks: '',
    helper_req: false,
    // Customer
    customer_name: '', customer_mob_no: '', customer_email: '',
    // Address
    address: '', building: '', landmark: '', locality: '',
    city_id: '', pin_code: '', gps_location: '', mobile_number: '',
    // Client SPOC
    reporting_contact_id: '',
    client_spoc_name: '', client_spoc_email: '', client_spoc: '',
    additional_name: '', additional_number: '',
    // Services (multi-select from client's rate card)
    services: [] as number[],
  });
  function set<K extends keyof typeof f>(k: K, v: (typeof f)[K]) { setF((s) => ({ ...s, [k]: v })); }

  // When client changes → load their services + SPOCs
  useEffect(() => {
    if (!f.fk_client_id) { setClientServices([]); setClientContacts([]); return; }
    const clientId = Number(f.fk_client_id);
    api.get<ClientService[]>('/shared/lookup/client-services', { clientId })
      .then(setClientServices).catch(() => setClientServices([]));
    // Client contacts fetched via admin route (Phase 8)
    api.get<ClientContact[]>(`/admin/clients/${clientId}/contacts`)
      .then(setClientContacts).catch(() => setClientContacts([]));
    set('services', []);
    set('reporting_contact_id', '');
    set('fk_service_type_id', '');
    set('fk_service_catg_id', '');
  }, [f.fk_client_id]);

  // Auto-fill SPOC details when reporting contact selected
  useEffect(() => {
    if (!f.reporting_contact_id) return;
    const c = clientContacts.find((cc) => String(cc.id) === f.reporting_contact_id);
    if (c) {
      set('client_spoc_name', c.contact_name);
      set('client_spoc_email', c.contact_email || '');
      set('client_spoc', c.contact_no || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.reporting_contact_id]);

  function toggleService(id: number) {
    const s = new Set(f.services);
    s.has(id) ? s.delete(id) : s.add(id);
    set('services', [...s]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const payload: Record<string, unknown> = {
        fk_client_id: Number(f.fk_client_id),
        job_type: f.job_type,
        source_type: f.source_type,
        requested_date_time: new Date(f.requested_date_time).toISOString(),
        time_slot: f.time_slot || undefined,
        helper_req: f.helper_req,
        job_desc: f.job_desc || undefined,
        remarks: f.remarks || undefined,
        client_ref_id: f.client_ref_id || undefined,
        job_reference_id: f.job_reference_id || undefined,
        client_spoc_name: f.client_spoc_name || undefined,
        client_spoc_email: f.client_spoc_email || undefined,
        client_spoc: f.client_spoc || undefined,
        additional_name: f.additional_name || undefined,
        additional_number: f.additional_number || undefined,
        fk_service_type_id: f.fk_service_type_id ? Number(f.fk_service_type_id) : undefined,
        fk_service_catg_id: f.fk_service_catg_id ? Number(f.fk_service_catg_id) : undefined,
        reporting_contact_id: f.reporting_contact_id ? Number(f.reporting_contact_id) : undefined,
        job_owner: f.job_owner ? Number(f.job_owner) : undefined,
        service_type_ids: f.fk_service_type_id ? [Number(f.fk_service_type_id)] : undefined,
        customer: {
          customer_name: f.customer_name,
          customer_mob_no: f.customer_mob_no,
          customer_email: f.customer_email || undefined,
        },
        address: {
          address: f.address,
          building: f.building || undefined,
          landmark: f.landmark || undefined,
          locality: f.locality || undefined,
          city_id: Number(f.city_id),
          pin_code: f.pin_code,
          gps_location: f.gps_location || undefined,
          mobile_number: f.mobile_number || undefined,
        },
        services: f.services.map((sid) => ({ service_id: sid, quantity: 1 })),
      };
      const created = await api.post<{ job_id: number }>('/admin/jobs', payload);
      router.push(`/jobs/${created.job_id}`);
    } catch (err) {
      setError(err instanceof ApiError
        ? err.message + (err.details ? ` — ${JSON.stringify(err.details)}` : '')
        : 'Failed');
    } finally { setLoading(false); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <h1 className="text-2xl font-semibold">New Job</h1>
      <form onSubmit={submit} className="space-y-5">

        <Card>
          <CardHeader><CardTitle>Client & Job Details</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Client *"><Select required value={f.fk_client_id} onChange={(e) => set('fk_client_id', e.target.value)} placeholder="— Select client —" options={lk.toOpts.clients} /></Field>
            <Field label="Source *"><Select value={f.source_type} onChange={(e) => set('source_type', e.target.value)} options={[
              { value: 'manual', label: 'Manual (CRM)' },
              { value: 'dashboard', label: 'Client Dashboard' },
              { value: 'excel', label: 'Excel Upload' },
              { value: 'website', label: 'Website' },
              { value: 'api', label: 'API Integration' },
            ]} /></Field>
            <Field label="Job Type *"><Select value={f.job_type} onChange={(e) => set('job_type', e.target.value)} options={[
              { value: 'Installation', label: 'Installation' }, { value: 'Repair', label: 'Repair' },
              { value: 'Uninstallation', label: 'Uninstallation' }, { value: 'Maintenance', label: 'Maintenance' },
              { value: 'Demo', label: 'Demo' }, { value: 'Inspection', label: 'Inspection' },
            ]} /></Field>
            <Field label="Requested Date/Time *"><Input required type="datetime-local" value={f.requested_date_time} onChange={(e) => set('requested_date_time', e.target.value)} /></Field>
            <Field label="Time Slot"><Select value={f.time_slot} onChange={(e) => set('time_slot', e.target.value)} options={[
              { value: 'Morning 9 to 2', label: 'Morning 9 to 2' },
              { value: 'Afternoon 12 to 5', label: 'Afternoon 12 to 5' },
              { value: 'Evening 2 to 7', label: 'Evening 2 to 7' },
              { value: 'Anytime', label: 'Anytime' },
            ]} /></Field>
            <Field label="Job Owner"><Select value={f.job_owner} onChange={(e) => set('job_owner', e.target.value)} placeholder="— Select owner —" options={lk.toOpts.adminUsers} /></Field>
            <Field label="Client Reference ID"><Input value={f.client_ref_id} onChange={(e) => set('client_ref_id', e.target.value)} placeholder="Client's internal ID" /></Field>
            <Field label="Job Reference ID"><Input value={f.job_reference_id} onChange={(e) => set('job_reference_id', e.target.value)} placeholder="Auto-generated if blank" /></Field>
            <Field label="Helper Required"><Select value={String(f.helper_req)} onChange={(e) => set('helper_req', e.target.value === 'true')} options={[
              { value: 'false', label: 'No' }, { value: 'true', label: 'Yes' },
            ]} /></Field>
            <Field label="Description" full><Input value={f.job_desc} onChange={(e) => set('job_desc', e.target.value)} placeholder="Scope of work" /></Field>
            <Field label="Internal Remarks" full><Input value={f.remarks} onChange={(e) => set('remarks', e.target.value)} placeholder="Notes for internal team" /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Service Selection</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Service Category"><Select value={f.fk_service_catg_id} onChange={(e) => set('fk_service_catg_id', e.target.value)} placeholder="— Select —" options={lk.toOpts.serviceCategories} /></Field>
              <Field label="Service Type"><Select value={f.fk_service_type_id} onChange={(e) => set('fk_service_type_id', e.target.value)} placeholder="— Select —" options={
                f.fk_service_catg_id
                  ? lk.serviceTypes.filter((t) => t.service_catg_id === Number(f.fk_service_catg_id)).map((t) => ({ value: t.service_type_id, label: t.service_type_name }))
                  : lk.toOpts.serviceTypes
              } /></Field>
            </div>
            {f.fk_client_id && (
              <div>
                <Label>Client-specific services (rate card)</Label>
                <p className="text-xs text-muted-foreground mb-2">{clientServices.length} services in this client&apos;s rate card</p>
                <div className="border rounded max-h-56 overflow-y-auto text-sm">
                  {clientServices.length === 0 && <div className="p-3 text-muted-foreground">No services mapped for this client.</div>}
                  {clientServices.map((cs) => (
                    <label key={cs.client_service_id} className="flex items-center gap-3 px-3 py-2 border-b last:border-0 hover:bg-muted/40 cursor-pointer">
                      <input type="checkbox" checked={f.services.includes(cs.client_service_id)} onChange={() => toggleService(cs.client_service_id)} className="h-4 w-4 accent-primary" />
                      <div className="flex-1">
                        <div className="font-medium">{cs.crc_ratecard_name || cs.service_type_name}</div>
                        <div className="text-xs text-muted-foreground">{cs.service_catg_name} · {cs.service_type_name} · ₹{cs.total_amount}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Customer</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Name *"><Input required value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></Field>
            <Field label="Mobile *"><Input required pattern="[0-9]{10}" value={f.customer_mob_no} onChange={(e) => set('customer_mob_no', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Email"><Input type="email" value={f.customer_email} onChange={(e) => set('customer_email', e.target.value)} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Address</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Address *" full><Input required value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label="Building"><Input value={f.building} onChange={(e) => set('building', e.target.value)} /></Field>
            <Field label="Landmark"><Input value={f.landmark} onChange={(e) => set('landmark', e.target.value)} /></Field>
            <Field label="Locality"><Input value={f.locality} onChange={(e) => set('locality', e.target.value)} /></Field>
            <Field label="City *"><Select required value={f.city_id} onChange={(e) => set('city_id', e.target.value)} placeholder="— Select city —" options={lk.toOpts.cities} /></Field>
            <Field label="PIN *"><Input required pattern="[0-9]{6}" value={f.pin_code} onChange={(e) => set('pin_code', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="GPS (lat,lng)"><Input value={f.gps_location} onChange={(e) => set('gps_location', e.target.value)} placeholder="28.6139,77.2090" /></Field>
            <Field label="Mobile at site"><Input pattern="[0-9]{10}" value={f.mobile_number} onChange={(e) => set('mobile_number', e.target.value.replace(/\D/g, ''))} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Client SPOC</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Reporting contact" full>
              <Select value={f.reporting_contact_id} onChange={(e) => set('reporting_contact_id', e.target.value)} placeholder="— Select SPOC —">
                {clientContacts.map((c) => <option key={c.id} value={c.id}>{c.contact_name} · {c.contact_email} · {c.contact_no}</option>)}
              </Select>
            </Field>
            <Field label="SPOC Name"><Input value={f.client_spoc_name} onChange={(e) => set('client_spoc_name', e.target.value)} /></Field>
            <Field label="SPOC Email"><Input type="email" value={f.client_spoc_email} onChange={(e) => set('client_spoc_email', e.target.value)} /></Field>
            <Field label="SPOC Mobile"><Input pattern="[0-9]{10}" value={f.client_spoc} onChange={(e) => set('client_spoc', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Additional contact name"><Input value={f.additional_name} onChange={(e) => set('additional_name', e.target.value)} /></Field>
            <Field label="Additional contact mobile"><Input pattern="[0-9]{10}" value={f.additional_number} onChange={(e) => set('additional_number', e.target.value.replace(/\D/g, ''))} /></Field>
          </CardContent>
        </Card>

        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create Job'}</Button>
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
