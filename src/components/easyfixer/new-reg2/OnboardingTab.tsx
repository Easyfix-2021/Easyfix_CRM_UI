'use client';
/*
 * Onboarding tab — one consolidated read-only review + decision actions.
 *
 * Read-only review (Identity/KYC, Skills mapping, Serviceable pincodes,
 * Documents) is composed from the verification payload — no duplicated edit
 * blocks. The decision bar and section notes reuse the SAME real endpoints as
 * the legacy verification workflow:
 *   - Approve identity / Send to Finance → PUT .../verification/identity {verification_status:1}
 *   - Reject profile                     → PUT .../verification/identity {verification_status:2, rejected_reason}
 *   - Send back to technician            → PUT .../verification/lead {personal_details_filled:0, reason}
 *   - Notes                              → POST .../verification/comments {text, section}
 * The full multi-field activation (grade / bank / beneficiary) is not
 * re-implemented here; a deep link routes to the canonical workflow page.
 */
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { VerificationSection } from '@/components/easyfixer/VerificationSection';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { formatDate } from '@/lib/utils';
import { SectionCard, KV } from './ui';
import type { VerificationPayload } from './types';

export function OnboardingTab({
  efrId,
  v,
  onReload,
}: {
  efrId: number;
  v: VerificationPayload;
  onReload: () => Promise<void> | void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const leadAccepted = v.lead.status.personal_details_filled === 1;
  const activated = v.activation.is_activated;
  const rv = v.registrationVerification;

  const stage = !leadAccepted ? 1 : !activated ? 2 : 3; // 1 registration, 2 verification, 3 active
  const stages = ['Registration', 'Verification & Activation', 'Active'];

  async function run(kind: 'approve' | 'reject' | 'sendback') {
    if (kind !== 'approve' && note.trim().length === 0) {
      showToast({ variant: 'error', message: 'A note is required for reject / send-back.' });
      return;
    }
    setBusy(true);
    try {
      if (kind === 'approve') {
        await api.put(`/admin/easyfixers/${efrId}/verification/identity`, { verification_status: 1 });
        showToast({ variant: 'success', message: 'Identity approved — sent to Finance.' });
      } else if (kind === 'reject') {
        await api.put(`/admin/easyfixers/${efrId}/verification/identity`, { verification_status: 2, rejected_reason: note });
        showToast({ variant: 'success', message: 'Profile rejected.' });
      } else {
        await api.put(`/admin/easyfixers/${efrId}/verification/lead`, { personal_details_filled: 0, reason: note });
        showToast({ variant: 'success', message: 'Sent back to technician.' });
      }
      setNote('');
      await onReload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Action failed' });
    } finally {
      setBusy(false);
    }
  }

  const addNote = async (text: string) => {
    await api.post(`/admin/easyfixers/${efrId}/verification/comments`, { text, section: 'Registration Details Section' });
    await onReload();
  };

  return (
    <div className="space-y-4">
      {/* Stage stepper */}
      <SectionCard title="Onboarding stage" icon={<span>🚦</span>}>
        <div className="flex flex-wrap items-center gap-2">
          {stages.map((s, i) => {
            const n = i + 1;
            const done = n < stage;
            const cur = n === stage;
            return (
              <div key={s} className="flex items-center gap-2">
                <span className={`grid h-6 w-6 place-items-center rounded-full font-mono text-xs font-bold ${done ? 'bg-success text-white' : cur ? 'bg-primary text-white' : 'border bg-muted text-ink-300'}`}>
                  {done ? '✓' : n}
                </span>
                <b className={`text-[13px] ${n <= stage ? 'text-ink-900' : 'text-ink-300'}`}>{s}</b>
                {i < stages.length - 1 && <span className={`mx-1 block h-0.5 w-8 ${n < stage ? 'bg-success' : 'bg-border'}`} />}
              </div>
            );
          })}
        </div>
      </SectionCard>

      {/* Consolidated read-only review */}
      <SectionCard title="Review — everything the technician filled" icon={<span>🔎</span>} right={<span>read-only</span>} bodyClassName="space-y-3">
        <VerificationSection headerTone="sub" title="Identity & KYC" verified={rv.identity.is_verified} progress={rv.identity.progress} defaultOpen>
          <div className="px-1">
            <KV k="Legal name" v={v.header.full_name} />
            <KV k="Aadhaar" v={rv.identity.adhaar_card_number} mono />
            <KV k="PAN" v={rv.identity.pan_card_number} mono />
            <KV k="Driving licence" v={rv.identity.driving_lisence_img ? 'Uploaded' : null} />
            {rv.identity.rejected_reason && <KV k="Rejection reason" v={rv.identity.rejected_reason} />}
          </div>
        </VerificationSection>

        <VerificationSection headerTone="sub" title="Skills & service mapping" verified={v.additional.deep_skills_count > 0} progress={v.additional.progress}>
          <div className="px-1">
            <KV k="Deep-skill options mapped" v={v.additional.deep_skills_count} />
            <KV k="Service category" v={rv.professional.service_category} />
            <KV k="Service type" v={rv.professional.service_type} />
          </div>
        </VerificationSection>

        <VerificationSection headerTone="sub" title="Serviceable pincodes" verified={v.additional.serviceable_pincodes_count > 0} progress={v.additional.serviceable_pincodes_count > 0 ? 100 : 0}>
          <div className="px-1">
            <KV k="Pincodes selected" v={v.additional.serviceable_pincodes_count} />
          </div>
        </VerificationSection>

        <VerificationSection headerTone="sub" title="Documents" verified={rv.banking.is_verified} progress={rv.banking.progress}>
          <div className="px-1">
            <KV k="Profile picture" v={v.activation.sidebar.profile_img ? 'Uploaded' : null} />
            <KV k="Cancelled cheque" v={rv.banking.cancelled_cheque_img ? 'Uploaded' : null} />
            <KV k="Driving licence" v={rv.identity.driving_lisence_img ? 'Uploaded' : null} />
          </div>
        </VerificationSection>

        <p className="text-xs text-muted-foreground">
          Editable versions live in the <b>Profile</b>, <b>Work &amp; Coverage</b> and <b>Bank</b> tabs — this is the reviewer&apos;s one-screen summary.
        </p>
      </SectionCard>

      {/* Decision bar */}
      {!activated && (
        <SectionCard title="Decision" icon={<span>🧭</span>} right={<span>each decision records who, when &amp; why</span>}>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (required for Reject / Send back)"
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {!leadAccepted && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run('sendback')}>Send back</Button>
            )}
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => run('reject')}>Reject</Button>
            <Button size="sm" disabled={busy} onClick={() => run('approve')} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
              Approve identity → Send to Finance
            </Button>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/easyfixers/${efrId}/verification?from=/easyfixers/new-registration-2/${efrId}`}>Open full activation workflow →</Link>
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Final activation (grade, EasyFix bank, beneficiary, BGV) runs in the full workflow — it is not duplicated here.
          </p>
        </SectionCard>
      )}

      {/* Review notes + short action summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Onboarding review notes" icon={<span>💬</span>}>
          <CommentsPanel entries={v.lead.comments as CommentEntry[]} onAdd={addNote} addLabel="Add a note" />
        </SectionCard>
        <SectionCard title="Onboarding action summary" icon={<span>🗂️</span>} right={<span>from the review record</span>}>
          <KV k="Lead applied on" v={formatDate(v.lead.registration.tx_applied_on)} />
          <KV k="Handled by" v={v.lead.registration.state_user} />
          <KV k="Approved by" v={v.lead.registration.approved_by} />
          <KV k="Approved on" v={formatDate(v.lead.registration.approved_on)} />
          <KV k="Identity reviewed by" v={rv.identity.updated_by_name} />
          <KV k="Banking reviewed by" v={rv.banking.updated_by_name} />
          <p className="mt-2 text-xs text-muted-foreground">Full append-only transition log is in the <b>Status &amp; History</b> tab.</p>
        </SectionCard>
      </div>
    </div>
  );
}
