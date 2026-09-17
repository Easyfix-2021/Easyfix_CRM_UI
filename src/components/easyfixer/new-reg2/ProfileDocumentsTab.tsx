'use client';
/*
 * Profile & Documents tab — sectioned read view with the two edit affordances
 * that have real endpoints: mobile update (EasyfixerMobileDialog, wired by the
 * parent) and bank (on the Bank tab). Personal / Identity / Tax fields are
 * filled by the technician and are shown read-only here; their CRM edits run in
 * the verification workflow, so no fake inline editors are rendered.
 */
import { Button } from '@/components/ui/button';
import { maskMobile } from '@/lib/format';
import { SectionCard, KV, MeterRow, EndpointPending } from './ui';
import type { VerificationPayload, ProfileListRow } from './types';

export function ProfileDocumentsTab({
  v,
  row,
  canUpdateMobile,
  onUpdateMobile,
}: {
  v: VerificationPayload;
  row: ProfileListRow | null;
  canUpdateMobile: boolean;
  onUpdateMobile: () => void;
}) {
  const p = v.registrationVerification.personal;
  const id = v.registrationVerification.identity;
  const bank = v.registrationVerification.banking;

  return (
    <div className="space-y-4">
      <SectionCard title="Profile completeness" icon={<span>🪪</span>} right={<span>{row?.efr_profile_perc ?? v.registrationVerification.overall_progress}%</span>}>
        <MeterRow label="Professional details" pct={v.registrationVerification.professional.progress} />
        <MeterRow label="Personal & family" pct={p.progress} />
        <MeterRow label="Banking details" pct={bank.progress} />
        <MeterRow label="Identity documents" pct={id.progress} />
        <MeterRow label="Skills & coverage" pct={v.additional.progress} />
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Personal details" icon={<span>🙍</span>}>
          <KV k="Date of birth" v={p.date_of_birth} />
          <KV k="Marital status" v={p.marital_status} />
          <KV k="Children" v={p.children_count} />
          <KV k="Hobbies" v={p.hobbies} />
          <KV k="Health insurance" v={p.health_insurance ? 'Yes' : 'No'} />
          <KV k="Accidental insurance" v={p.accidental_insurance ? 'Yes' : 'No'} />
        </SectionCard>

        <SectionCard
          title="Contact"
          icon={<span>📇</span>}
          right={canUpdateMobile ? <Button size="sm" variant="outline" onClick={onUpdateMobile}>Update mobile</Button> : undefined}
        >
          <KV k="Primary mobile" v={maskMobile(row?.efr_no ?? v.header.mobile ?? '')} mono />
          <KV k="Emergency mobile" v={p.emergency_mobile} mono />
          <KV k="Email" v={p.email ?? row?.efr_email} />
          <KV k="Email verified" v={p.is_email_verified ? 'Yes' : 'No'} />
        </SectionCard>

        <SectionCard title="Identity & documents" icon={<span>📄</span>}>
          <KV k="Aadhaar" v={id.adhaar_card_number} mono />
          <KV k="PAN card" v={id.pan_card_number} mono />
          <KV k="Driving licence" v={id.driving_lisence_img ? 'Uploaded' : null} />
          <p className="mt-2 text-xs text-muted-foreground">Identity edits &amp; document previews run in the verification workflow.</p>
        </SectionCard>

        <SectionCard title="Payments" icon={<span>🏦</span>} right={<span>read-only · see Bank tab</span>}>
          <KV k="Bank" v={bank.bank_name} />
          <KV k="Account holder" v={bank.account_holder_name} />
          <KV k="Account number" v={bank.account_number} mono />
          <KV k="IFSC" v={bank.ifsc_code} mono />
          <KV k="Mode of transfer" v={bank.mode_of_payment} />
        </SectionCard>

        <SectionCard title="Tax" icon={<span>🧾</span>}>
          <EndpointPending what="TDS / tax deduction details need GET /admin/easyfixers/:id/tax (no tax fields are exposed by the verification payload)." />
        </SectionCard>

        <SectionCard title="Tool bag" icon={<span>🧰</span>}>
          <EndpointPending what="The technician's tool-bag photo needs GET /admin/easyfixers/:id/documents (tool-bag image is not in the verification payload)." />
        </SectionCard>
      </div>
    </div>
  );
}
