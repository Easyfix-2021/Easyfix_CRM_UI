'use client';
/*
 * Onboarding tab — one consolidated read-only review + decision actions.
 *
 * SCOPE (agreed with Priyanka 2026-09-28). Onboarding reviews only what the
 * technician fills in the app at registration:
 *   Identity & KYC (incl. the profile photo) · Skills & service mapping ·
 *   Serviceable pincodes.
 * It does NOT review banking — Finance verifies bank details separately, and
 * the payout warning + Bank tab on this profile carry that. There is likewise
 * no Documents section: a cancelled cheque is banking, and a driving licence is
 * not collected at registration.
 *
 * The decision bar and section notes reuse the SAME real endpoints as the
 * legacy verification workflow:
 *   - Accept / Deny lead / Send back → PUT .../verification/lead {personal_details_filled:1|2|0, reason}
 *   - Notes                          → POST .../verification/comments {text, section}
 * Identity approve/reject and the full multi-field activation (grade / bank /
 * beneficiary / BGV) stay in the canonical verification workflow page.
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { VerificationSection } from '@/components/easyfixer/VerificationSection';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { formatDate } from '@/lib/utils';
import { SectionCard, KV } from './ui';
import type { VerificationPayload, PincodeChip } from './types';

type DecisionKind = 'sendback' | 'accept' | 'deny';

const LEAD_DECISIONS = {
  accept: { value: 1, toast: 'Technician lead accepted.' },
  deny: { value: 2, toast: 'Technician lead denied.' },
  sendback: { value: 0, toast: 'Sent back to technician.' },
} as const;

// Backend caps summary at 500; the full note stays in metadata.reason.
const capSummary = (s: string) => s.slice(0, 500).replace(/[\uD800-\uDBFF]$/, '');

type CityCoverage = {
  key: string;
  city: string;
  state: string | null;
  zonalManager: string | null;
  locations: string[];
  pincodes: string[];
};

/*
 * Serviceable coverage, one row per city: the reviewer's question is "where
 * will this technician take jobs, and who owns that patch", which a flat list
 * of pincode chips never answered. Any row click opens the editor in Work &
 * Coverage, so a wrong pincode is two clicks from being fixed.
 *
 * A row is a <tr role="button"> rather than a nested <button>, which would be
 * invalid inside a table cell and swallow the row click.
 */
function CoverageByCity({
  rows,
  loading,
  canEdit,
  onEdit,
}: {
  rows: CityCoverage[];
  loading: boolean;
  canEdit: boolean;
  onEdit: () => void;
}) {
  if (loading) return <p className="px-1 text-sm text-muted-foreground">Loading coverage…</p>;
  if (rows.length === 0) {
    return (
      <div className="px-1">
        <p className="text-sm text-muted-foreground">No serviceable pincodes selected yet.</p>
        {canEdit && <Button size="sm" variant="outline" className="mt-2" onClick={onEdit}>Edit pincodes</Button>}
      </div>
    );
  }
  const total = rows.reduce((n, r) => n + r.pincodes.length, 0);
  return (
    <div className="px-1">
      <div className="overflow-x-auto rounded-md border">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="!text-left">City</th>
              <th className="!text-left">Location</th>
              <th className="!text-left">Pincodes</th>
              <th className="!text-left">Zonal manager</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="!text-left">
                  <span className="font-medium text-ink-900">{r.city}</span>
                  {r.state && <span className="block text-xs text-muted-foreground">{r.state}</span>}
                </td>
                <td className="!text-left text-ink-700">{r.locations.join(', ') || '—'}</td>
                <td className="!text-left">
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {/* The per-city count rides on the pincodes themselves as a
                        chip, so the table does not spend a whole column on one
                        digit per row. */}
                    <span className="font-mono text-xs text-ink-700">{r.pincodes.join(', ')}</span>
                    <span className="rounded-full border bg-muted px-1.5 py-0.5 text-xs text-ink-700">{r.pincodes.length}</span>
                  </span>
                </td>
                <td className="!text-left text-ink-700">{r.zonalManager || '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="!text-left font-semibold text-ink-900" colSpan={canEdit ? 3 : 4}>
                {total} pincode{total === 1 ? '' : 's'} selected in {rows.length} cit{rows.length === 1 ? 'y' : 'ies'}
              </td>
              {canEdit && (
                <td className="!text-right">
                  <Button size="sm" variant="outline" onClick={onEdit}>Edit pincodes</Button>
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        A city shows &quot;—&quot; for its zonal manager when none is assigned to its state.
      </p>
    </div>
  );
}

export function OnboardingTab({
  efrId,
  v,
  onReload,
  onEditPincodes,
}: {
  efrId: number;
  v: VerificationPayload;
  onReload: () => Promise<void> | void;
  /* Jumps to Work & Coverage with the pincode editor scrolled into view. */
  onEditPincodes: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [eligible, setEligible] = useState(false);
  const { me } = useMe();
  // Legacy verification page is only reachable behind isEdit.
  const canDecideLead = hasAction(me, 'isEdit');

  const leadAccepted = v.lead.status.personal_details_filled === 1;
  const leadDenied = v.lead.status.personal_details_filled === 2;
  const leadPending = !leadAccepted && !leadDenied;
  const activated = v.activation.is_activated;
  const rv = v.registrationVerification;
  const skillsMapped = v.additional.deep_skills_count > 0;
  // Onboarding stops being the place to change coverage the moment the
  // technician is live — edits then belong in Work & Coverage, which stays
  // open. Read-only here, not hidden: the reviewer still needs to see it.
  const canEditCoverage = !activated;

  // Coverage is read from the pincode endpoint rather than the payload's bare
  // count, because the reviewer needs city / location / zonal manager per row.
  const { data: pinData, loading: pinLoading } = useFetch<{ items: PincodeChip[] }>(
    `/admin/easyfixers/${efrId}/serviceable-pincodes`,
  );
  const pins = useMemo(() => pinData?.items ?? [], [pinData]);
  const pinCount = pins.length;

  // One row per city. city_id is the key where present; some catalogue rows
  // have none, so the city name is the fallback and unnamed rows collapse into
  // a single "Unknown city" row rather than disappearing.
  const byCity = useMemo(() => {
    const map = new Map<string, CityCoverage>();
    for (const pin of pins) {
      const key = pin.city_id != null ? `id:${pin.city_id}` : `name:${pin.city_name ?? '—'}`;
      let row = map.get(key);
      if (!row) {
        row = {
          key,
          city: pin.city_name ?? 'Unknown city',
          state: pin.state_name ?? null,
          zonalManager: pin.zonal_manager_name ?? null,
          locations: [],
          pincodes: [],
        };
        map.set(key, row);
      }
      const loc = (pin.location ?? '').trim();
      if (loc && !row.locations.includes(loc)) row.locations.push(loc);
      if (!row.pincodes.includes(pin.pincode)) row.pincodes.push(pin.pincode);
    }
    return [...map.values()].sort((a, b) => a.city.localeCompare(b.city));
  }, [pins]);

  const stage = !leadAccepted ? 1 : !activated ? 2 : 3; // 1 registration, 2 verification, 3 active
  const stages = ['Registration', 'Verification & Activation', 'Active'];

  async function recordActivityLog(kind: DecisionKind, reason: string) {
    try {
      const eventMap = {
        sendback: { eventType: 'SENT_BACK', summary: `Sent back to technician — ${reason}` },
        accept: { eventType: 'LEAD_ACCEPTED', summary: reason.trim() ? `Technician lead accepted — ${reason}` : 'Technician lead accepted' },
        deny: { eventType: 'LEAD_DENIED', summary: `Technician lead denied — ${reason}` },
      };
      const event = eventMap[kind];
      await api.post(`/admin/easyfixers/${efrId}/activity-log`, {
        eventType: event.eventType,
        section: 'onboarding',
        summary: capSummary(event.summary),
        metadata: { reason: reason || null },
      });
    } catch (e) {
      console.warn('Failed to record activity log:', e);
    }
  }

  async function run(kind: DecisionKind) {
    if (kind !== 'accept' && note.trim().length === 0) {
      showToast({ variant: 'error', message: 'A note is required for deny / send-back.' });
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/lead`, { personal_details_filled: LEAD_DECISIONS[kind].value, reason: note });
      await recordActivityLog(kind, note);
      showToast({ variant: 'success', message: LEAD_DECISIONS[kind].toast });
      setNote('');
      setEligible(false);
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
                <span className={`grid h-6 w-6 place-items-center rounded-full font-mono text-xs font-semibold ${done ? 'bg-success text-white' : cur ? 'bg-primary text-white' : 'border bg-muted text-ink-300'}`}>
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
            <KV k="Profile picture" v={v.activation.sidebar.profile_img ? 'Uploaded' : null} />
            {rv.identity.rejected_reason && <KV k="Rejection reason" v={rv.identity.rejected_reason} />}
          </div>
        </VerificationSection>

        {/* Skills is scored on DEEP SKILLS ALONE. The payload's
            `additional.progress` is a combined skills-and-pincodes number
            ((skills?50) + (pincodes?50)), so feeding it here read 50% for a
            technician with no skill mapped but one pincode picked. */}
        <VerificationSection headerTone="sub" title="Skills & service mapping" verified={skillsMapped} progress={skillsMapped ? 100 : 0}>
          <div className="px-1">
            <KV k="Deep-skill options mapped" v={v.additional.deep_skills_count} />
            <KV k="Service category" v={rv.professional.service_category} />
            <KV k="Service type" v={rv.professional.service_type} />
          </div>
        </VerificationSection>

        <VerificationSection headerTone="sub" title="Serviceable pincodes" verified={pinCount > 0} progress={pinCount > 0 ? 100 : 0}>
          <CoverageByCity
            rows={byCity}
            loading={pinLoading && !pinData}
            canEdit={canEditCoverage}
            onEdit={onEditPincodes}
          />
        </VerificationSection>

        <p className="text-xs text-muted-foreground">
          Editable versions live in the <b>Profile</b> and <b>Work &amp; Coverage</b> tabs — this is the reviewer&apos;s one-screen summary.
        </p>
      </SectionCard>

      {/* Decision bar */}
      {!activated && (
        <SectionCard title="Decision" icon={<span>🧭</span>} right={<span>each decision records who, when &amp; why</span>}>
          {leadDenied && (
            <div className="mb-3 rounded-md border border-urgent/30 bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
              This technician lead was <span className="font-semibold">denied</span>. See the review notes below.
            </div>
          )}
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (required for Deny / Send back)"
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {leadPending && canDecideLead && (
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
              <span>Yes, This Is A Valid Technician Lead And I Find Him Eligible To Represent Easyfix Customers And Brands.</span>
            </label>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {leadPending && canDecideLead && (
              <>
                <Button size="sm" disabled={!eligible || busy} onClick={() => run('accept')} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
                  Accept lead
                </Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => run('deny')}>Deny lead</Button>
              </>
            )}
            {leadPending && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run('sendback')}>Send back</Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Identity approval, bank verification and final activation are not part of onboarding — they run in their own steps.
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
          <p className="mt-2 text-xs text-muted-foreground">Full append-only transition log is in the <b>Status &amp; History</b> tab.</p>
        </SectionCard>
      </div>
    </div>
  );
}
