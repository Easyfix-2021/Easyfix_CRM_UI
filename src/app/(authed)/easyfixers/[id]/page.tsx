'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

/*
 * Detail view — exposes every meaningful easyfixer profile field the backend
 * returns, grouped into sections that match the legacy CRM profile page.
 * Inactive / verification / completion toggles are present as actions.
 */

type Ef = Record<string, unknown> & {
  efr_id: number; efr_name: string; efr_status: number;
};

export default function EasyfixerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Ef | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try { setData(await api.get<Ef>(`/admin/easyfixers/${id}`)); }
    catch { setErr('not found'); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function toggle() {
    if (!data) return;
    const active = !Number(data.efr_status);
    await api.patch(`/admin/easyfixers/${id}/status`, {
      active,
      reasonId: active ? undefined : 1,
      comment: active ? undefined : 'deactivated from CRM',
    });
    await refresh();
  }

  if (err) return <div className="text-destructive">{err}</div>;
  if (!data) return <div className="text-muted-foreground">Loading…</div>;

  const sections: { title: string; rows: [string, unknown][] }[] = [
    { title: 'Basic', rows: [
      ['Easyfixer ID', data.efr_id], ['Full name', data.efr_name],
      ['First name', data.efr_first_name], ['Last name', data.efr_last_name],
      ['Mobile', data.efr_no], ['Alt mobile', data.efr_alt_no],
      ['Email', data.efr_email], ['Type', data.efr_type],
    ]},
    { title: 'Address', rows: [
      ['Work address', data.efr_address],
      ['Residential', data.efr_address_res],
      ['Building', data.efr_building], ['Landmark', data.efr_landmark],
      ['PIN', data.efr_pin_no], ['City', data.city_name],
      ['Base GPS', data.efr_base_gps], ['Current GPS', data.efr_current_gps],
    ]},
    { title: 'Service', rows: [
      ['Category', data.efr_service_category],
      ['Service type', data.efr_service_type],
      ['Manager ID', data.efr_manager_id],
      ['Experience ID', data.experience_id],
    ]},
    { title: 'Personal', rows: [
      ['Date of birth', data.date_of_birth ? formatDate(data.date_of_birth as string) : null],
      ['Age', data.efr_age], ['Marital status', data.efr_marital_status],
      ['Children', data.efr_children], ['About', data.about_yourself],
    ]},
    { title: 'Identity', rows: [
      ['Aadhaar', data.adhaar_card_number], ['PAN', data.pan_card_number],
      ['Profile image', data.efr_profile_img],
    ]},
    { title: 'Skills & Tools', rows: [
      ['Tools', data.efr_tools], ['Skill', data.skill],
      ['Skill rating', data.skill_rating], ['Tool rating', data.tool_rating],
    ]},
    { title: 'Flags', rows: [
      ['Has bike', boolish(data.have_bike)],
      ['Uses WhatsApp', boolish(data.use_whatsapp)],
      ['Driving licence', boolish(data.have_driving_lisence)],
      ['Health insurance', boolish(data.health_insurance)],
      ['Accidental insurance', boolish(data.accidental_insurance)],
      ['Technician verified', boolish(data.is_technician_verified)],
      ['Email verified', boolish(data.is_email_verified)],
      ['New easyfixer', boolish(data.new_easy_fixer)],
      ['Existing easyfixer', boolish(data.is_existing_easyfixer)],
      ['Final submission', boolish(data.final_submission)],
    ]},
    { title: 'Profile completion', rows: [
      ['Overall %', data.efr_profile_perc],
      ['Personal %', data.efr_personal_details_perc],
      ['Professional %', data.efr_professional_details_perc],
      ['Identity %', data.efr_identity_details_perc],
      ['Bank %', data.efr_bank_details_perc],
    ]},
    { title: 'Finance', rows: [
      ['Current balance', data.current_balance],
      ['Balance updated', data.balance_updated ? formatDate(data.balance_updated as string) : null],
      ['Registration fee date', data.efr_reg_fee_date ? formatDate(data.efr_reg_fee_date as string) : null],
      ['Collection mode', data.efr_collection_mode],
      ['Collected by', data.efr_amnt_collected_by],
    ]},
    { title: 'Verification remarks (CRM)', rows: [
      ['Bank remarks', data.bank_details_verification_comment],
      ['Personal remarks', data.personal_details_verification_comment_crm],
      ['Skill rating remarks', data.skill_rating_comment_from_crm],
      ['Tool rating remarks', data.tool_rating_comment_from_crm],
      ['Final accept', data.final_accept_comment],
      ['Final reject', data.final_reject_comment],
    ]},
    { title: 'Inactive / send-back', rows: [
      ['Inactive reason', data.inactive_reason],
      ['Inactive comment', data.inactive_comment],
      ['Suspend date', data.efr_suspend_date ? formatDate(data.efr_suspend_date as string) : null],
      ['Last inactive', data.last_inactive_date_time ? formatDate(data.last_inactive_date_time as string) : null],
      ['Send back reason', data.send_back_to_tx_reason_crm],
    ]},
    { title: 'Audit', rows: [
      ['Inserted by', data.inserted_by], ['Created', formatDate(data.insert_date as string)],
      ['Updated by', data.updated_by], ['Updated', data.update_date ? formatDate(data.update_date as string) : null],
      ['Profile activated', data.profile_activation_date_time ? formatDate(data.profile_activation_date_time as string) : null],
      ['Sent to finance', data.send_to_finance_date_time ? formatDate(data.send_to_finance_date_time as string) : null],
    ]},
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{String(data.efr_name)}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Easyfixer #{id}</span>
            <span>·</span>
            <span>{String(data.efr_no ?? '')}</span>
            <span>·</span>
            <span>{String((data as Record<string, unknown>).city_name ?? '—')}</span>
          </div>
        </div>
        <Button variant={Number(data.efr_status) ? 'destructive' : 'default'} onClick={toggle}>
          {Number(data.efr_status) ? 'Deactivate' : 'Activate'}
        </Button>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="flags">Flags & Verification</TabsTrigger>
          <TabsTrigger value="finance">Finance & Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <div className="grid md:grid-cols-2 gap-5">
            {sections.slice(0, 6).map((sec) => <SectionCard key={sec.title} {...sec} />)}
          </div>
        </TabsContent>
        <TabsContent value="flags">
          <div className="grid md:grid-cols-2 gap-5">
            {sections.slice(6, 8).map((sec) => <SectionCard key={sec.title} {...sec} />)}
          </div>
        </TabsContent>
        <TabsContent value="finance">
          <div className="grid md:grid-cols-2 gap-5">
            {sections.slice(8).map((sec) => <SectionCard key={sec.title} {...sec} />)}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SectionCard({ title, rows }: { title: string; rows: [string, unknown][] }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        <dl className="text-sm space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b last:border-0 pb-1.5 last:pb-0">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium text-right break-all max-w-[60%]">{v == null || v === '' ? '—' : String(v)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function boolish(v: unknown): string {
  if (v === true || v === 1 || v === '1') return 'Yes';
  if (v === false || v === 0 || v === '0') return 'No';
  return '—';
}
