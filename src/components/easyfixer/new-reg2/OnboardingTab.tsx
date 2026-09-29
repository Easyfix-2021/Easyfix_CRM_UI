'use client';
/*
 * Onboarding tab — one consolidated read-only review + decision actions.
 *
 * SCOPE (agreed with Priyanka, 2026-09-28 and 2026-09-29). Onboarding reviews
 * only what the technician fills in the app at registration:
 *   Identity & KYC (name, DOB, Aadhaar, selfie) · Skills & service mapping ·
 *   Serviceable pincodes · Mandatory training, for information only.
 * It does NOT review banking — Finance verifies bank details separately, and
 * the payout warning + Bank tab carry that. No Documents section either: a
 * cancelled cheque is banking, and neither PAN nor a driving licence is
 * collected at registration.
 *
 * TWO DECISIONS, BOTH GATED. Accept and Deny unlock only once every mandatory
 * field is filled — there is nothing to decide on a half-finished profile — but
 * a note can be left at any time. Accept also requires the vertical the
 * technician is being onboarded FOR. Training never gates either decision.
 * "Send back" is PARKED pending its own design.
 *
 * Endpoints are the legacy verification workflow's, unchanged:
 *   - Accept / Deny lead → PUT .../verification/lead {personal_details_filled:1|2, reason, vertical_id}
 *   - Notes              → POST .../verification/comments {text, section}
 * Identity approve/reject and the full activation (grade / bank / beneficiary /
 * BGV) stay in the canonical verification workflow page.
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { VerificationSection } from '@/components/easyfixer/VerificationSection';
import { DeepSkillOptionMappingEditor } from '@/components/easyfixer/DeepSkillOptionMappingEditor';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { formatDate } from '@/lib/utils';
import { SectionCard, KV } from './ui';
import type { VerificationPayload, PincodeChip, VerticalOption } from './types';

// 'sendback' is PARKED (Priyanka, 2026-09-29) — to be designed later.
type DecisionKind = 'accept' | 'deny';

const LEAD_DECISIONS = {
  accept: { value: 1, toast: 'Technician lead accepted.' },
  deny: { value: 2, toast: 'Technician lead denied.' },
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

/*
 * The category the technician chose at registration, with the skills under it.
 * Read-only: editing happens in Work & Coverage, which owns the mapping modal,
 * so there is one editor rather than two that can disagree.
 */
/*
 * The photographs the technician took during registration: selfie first,
 * because that is the face a reviewer matches against the Aadhaar, then the
 * Aadhaar front and back. Each opens full size in a new tab — the URLs are
 * short-lived signed links, so they are not embedded anywhere else.
 *
 * A missing photo shows its own empty tile rather than vanishing: "no Aadhaar
 * back" is a review finding, and a tile that silently disappears hides it.
 */
function KycPhotos({ docs }: { docs: VerificationPayload['registrationVerification']['identity']['documents'] }) {
  const tiles: Array<[string, string | null]> = [
    ['Selfie', docs?.selfie_url ?? null],
    ['Aadhaar front', docs?.aadhaar_front_url ?? null],
    ['Aadhaar back', docs?.aadhaar_back_url ?? null],
  ];
  return (
    <div className="mb-3 flex flex-wrap gap-3">
      {tiles.map(([label, url]) => (
        <figure key={label} className="w-32">
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" title={`Open ${label} full size`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={label} className="h-24 w-32 rounded-md border object-cover hover:opacity-90" />
            </a>
          ) : (
            <div className="grid h-24 w-32 place-items-center rounded-md border border-dashed bg-muted text-xs text-muted-foreground">
              Not uploaded
            </div>
          )}
          <figcaption className="mt-1 text-xs text-muted-foreground">{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/*
 * Mandatory training. Which videos are mandatory is LMS data (is_global), not
 * code, so ops can change the set without a release. Shown for information
 * only — a technician is accepted first and finishes the videos afterwards.
 */
function MandatoryTraining({ training }: { training: VerificationPayload['training'] }) {
  if (training.mandatory_total === 0) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        No training is marked mandatory in the LMS yet, so there is nothing to track here.
      </p>
    );
  }
  return (
    <div className="px-1">
      <ul className="space-y-1.5">
        {training.videos.map((t) => (
          <li key={t.video_id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-ink-900">{t.title || `Video ${t.video_id}`}</span>
            <span className={t.is_complete ? 'text-success' : 'text-muted-foreground'}>
              {t.is_complete ? 'Completed' : `${t.watched_percentage}% watched`}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        {training.mandatory_done} of {training.mandatory_total} done.
        {training.is_complete ? ' ' : ' Training can be finished after acceptance — it does not block a decision.'}
      </p>
    </div>
  );
}

export function OnboardingTab({
  efrId,
  v,
  onReload,
  onEditPincodes,
  onEditSkills,
}: {
  efrId: number;
  v: VerificationPayload;
  onReload: () => Promise<void> | void;
  /* Jumps to Work & Coverage with the pincode editor scrolled into view. */
  onEditPincodes: () => void;
  /* Jumps to Work & Coverage's skill mapping. */
  onEditSkills: () => void;
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
  // is_identity_details_verified_by_crm = 1 means the app already verified the
  // Aadhaar, so the reviewer is confirming, not checking from scratch.
  const aadhaarVerified = rv.identity.verification_status === 1;
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

  const { data: verticals } = useFetchOnce<VerticalOption[]>('/shared/lookup/verticals');
  const [verticalId, setVerticalId] = useState<string>('');

  /*
   * What a technician must have filled before anyone may decide on him.
   * Agreed 2026-09-29: name, date of birth, Aadhaar, selfie, at least one
   * skill and at least one serviceable pincode. PAN is deliberately absent —
   * it is not collected at registration. Training is absent too: it can be
   * finished after acceptance.
   *
   * Named, not counted, so the reviewer is told WHICH field is missing
   * instead of facing a dead button.
   */
  const missingMandatory = useMemo(() => {
    const missing: string[] = [];
    if (!String(v.header.full_name ?? '').trim()) missing.push('Legal name');
    if (!rv.personal.date_of_birth) missing.push('Date of birth');
    if (!String(rv.identity.adhaar_card_number ?? '').trim()) missing.push('Aadhaar');
    if (!v.activation.sidebar.profile_img) missing.push('Profile picture');
    // The backend refuses an accept without this, so the button must say so
    // rather than letting the reviewer discover it as a 409.
    if (rv.identity.verification_status !== 1) missing.push('Aadhaar verification');
    if (v.additional.deep_skills_count === 0) missing.push('Skills');
    if (v.additional.serviceable_pincodes_count === 0) missing.push('Serviceable pincodes');
    return missing;
  }, [v, rv]);
  const profileComplete = missingMandatory.length === 0;
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

  /*
   * Two stages, each carrying its own date, because "when did he register" and
   * "how long did we take to activate him" are the questions asked of this row.
   * Still waiting → the Active chip says how long he has been waiting instead.
   */
  const stage = activated ? 2 : 1;
  const waitingDays = v.timeline.registered_on && !v.timeline.activated_on
    ? Math.max(0, Math.round((Date.now() - new Date(v.timeline.registered_on).getTime()) / 86400000))
    : null;
  const stages = [
    { label: 'Registered', sub: formatDate(v.timeline.registered_on) },
    { label: 'Active', sub: v.timeline.activated_on ? formatDate(v.timeline.activated_on) : 'Not yet' },
  ];
  // The connector carries the elapsed time — taken, or still running.
  const elapsedLabel = v.timeline.days_to_activate != null
    ? `activated in ${v.timeline.days_to_activate} day${v.timeline.days_to_activate === 1 ? '' : 's'}`
    : waitingDays != null
      ? `waiting ${waitingDays} day${waitingDays === 1 ? '' : 's'}`
      : '—';

  async function recordActivityLog(kind: DecisionKind, reason: string) {
    try {
      const eventMap = {
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
    if (note.trim().length === 0) {
      showToast({ variant: 'error', message: 'A note is required — it becomes the accept or reject comment on record.' });
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/lead`, {
        personal_details_filled: LEAD_DECISIONS[kind].value,
        reason: note,
        // Recorded on tbl_easyfixer as the vertical he is onboarded FOR.
        ...(kind === 'accept' && verticalId ? { vertical_id: Number(verticalId) } : {}),
      });
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

  /*
   * Marking the Aadhaar verified is the same endpoint the verification
   * workflow uses, so both surfaces set the same flag. The activity log entry
   * is what makes it answerable later: WHO verified this Aadhaar, and when.
   */
  async function verifyAadhaar() {
    setBusy(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/identity`, { verification_status: 1 });
      await api.post(`/admin/easyfixers/${efrId}/activity-log`, {
        eventType: 'AADHAAR_VERIFIED',
        section: 'onboarding',
        summary: capSummary(`Aadhaar verified by ${me?.user?.user_name ?? 'CRM user'}`),
        metadata: { aadhaar_last4: (rv.identity.adhaar_card_number ?? '').slice(-4) || null },
      });
      showToast({ variant: 'success', message: 'Aadhaar marked verified.' });
      await onReload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not verify the Aadhaar' });
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
      {/*
        A timeline, not two chips: the row spans the width, each stage carries
        its date, and the connector between them is where the elapsed time is
        written — which is the question actually asked of this row ("how long
        did we take?"). Two chips floating at the left said the same thing in a
        fifth of the space and answered neither.
      */}
      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          {stages.map((st, i) => (
            <div key={st.label} className={i === 0 ? 'shrink-0' : 'flex flex-1 items-center gap-3'}>
              {i > 0 && (
                <div className="flex flex-1 items-center gap-2">
                  <span className={`h-px flex-1 ${stage > 1 ? 'bg-success' : 'bg-border'}`} aria-hidden />
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{elapsedLabel}</span>
                  <span className={`h-px flex-1 ${stage > 1 ? 'bg-success' : 'bg-border'}`} aria-hidden />
                </div>
              )}
              <div className="flex items-center gap-2">
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                    stage > i + 1
                      ? 'bg-success text-white'
                      : stage === i + 1
                        ? 'bg-primary text-white'
                        : 'border bg-muted text-muted-foreground'
                  }`}
                >
                  {stage > i + 1 ? '✓' : i + 1}
                </span>
                <span>
                  <span className={`block text-[13px] font-semibold ${stage >= i + 1 ? 'text-ink-900' : 'text-muted-foreground'}`}>
                    {st.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">{st.sub ?? '—'}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Consolidated read-only review */}
      <SectionCard title="Review — everything the technician filled" icon={<span>🔎</span>} bodyClassName="space-y-3">
        <VerificationSection
          headerTone="sub"
          title="Identity & KYC"
          verified={aadhaarVerified}
          progress={rv.identity.progress}
          defaultOpen
        >
          <div className="px-1">
            <KycPhotos docs={rv.identity.documents} />
            <KV k="Legal name" v={v.header.full_name} />
            <KV k="Date of birth" v={formatDate(rv.personal.date_of_birth)} />
            <div className="flex items-center justify-between gap-3 border-b py-1.5 last:border-0">
              <span className="text-sm text-muted-foreground">Aadhaar</span>
              <span className="flex items-center gap-2">
                {aadhaarVerified ? (
                  <span className="rounded-full bg-success-tint px-2 py-0.5 text-xs font-semibold text-success-strong">Verified</span>
                ) : (
                  <span className="rounded-full bg-warning-tint px-2 py-0.5 text-xs font-semibold text-ink-900">Not verified</span>
                )}
                <span className="font-mono text-sm text-ink-900">{rv.identity.adhaar_card_number || '—'}</span>
                {!aadhaarVerified && canDecideLead && rv.identity.adhaar_card_number && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={verifyAadhaar}>Verify</Button>
                )}
              </span>
            </div>
            {rv.identity.rejected_reason && <KV k="Rejection reason" v={rv.identity.rejected_reason} />}
          </div>
        </VerificationSection>

        {/* Skills is scored on DEEP SKILLS ALONE. The payload's
            `additional.progress` is a combined skills-and-pincodes number
            ((skills?50) + (pincodes?50)), so feeding it here read 50% for a
            technician with no skill mapped but one pincode picked. */}
        <VerificationSection headerTone="sub" title="Skills & service mapping" verified={skillsMapped} progress={v.additional.skills_progress}>
          <div className="px-1">
            {/* The same component Work & Coverage edits with, read-only here,
                so the review and the editor cannot render the mapping
                differently. */}
            <DeepSkillOptionMappingEditor efrId={efrId} readOnly />
            {canEditCoverage && (
              <Button size="sm" variant="outline" className="mt-3" onClick={onEditSkills}>Edit skills</Button>
            )}
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

        {/* Training never gates the decision: a technician is accepted first and
            finishes the videos afterwards. It is here so the reviewer knows
            whether he can be sent work straight away. */}
        <VerificationSection
          headerTone="sub"
          title="Mandatory training"
          verified={v.training.is_complete}
          progress={v.training.mandatory_total ? Math.round((v.training.mandatory_done / v.training.mandatory_total) * 100) : null}
        >
          <MandatoryTraining training={v.training} />
        </VerificationSection>

        <p className="text-xs text-muted-foreground">
          Editable versions live in the <b>Profile</b> and <b>Work &amp; Coverage</b> tabs — this is the reviewer&apos;s one-screen summary.
        </p>
      </SectionCard>

      {/* Decision bar */}
      {!activated && (
        <SectionCard title="Decision" icon={<span>🧭</span>} right={<span>each decision records who, when &amp; why</span>}>
          {/* A decided lead has no buttons, so the card must say WHY it is
              empty — an unexplained blank box reads as a broken screen. */}
          {leadDenied && (
            <div className="mb-3 rounded-md border border-urgent/30 bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
              This technician lead was <span className="font-semibold">denied</span>. See the review notes below.
            </div>
          )}
          {leadAccepted && (
            <div className="mb-3 rounded-md border border-success/30 bg-success-tint px-3 py-2 text-sm text-ink-900">
              This technician lead is <span className="font-semibold">accepted</span>
              {v.vertical.vertical_name ? <> · onboarded for <span className="font-semibold">{v.vertical.vertical_name}</span></> : null}
              . Nothing further is decided here — activation runs in its own step. A note can still be added below.
            </div>
          )}
          {leadPending && !canDecideLead && (
            <div className="mb-3 rounded-md border bg-muted px-3 py-2 text-sm text-ink-900">
              You do not have permission to accept or deny a lead. You can still add a note.
            </div>
          )}
          {/* One column, in the order a reviewer works: note → vertical →
              attestation → act. The vertical used to sit between the note and
              the checkbox as a stray inline row, which read as if it belonged
              to neither. */}
          <div className="space-y-3">
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note — required for both Accept and Deny"
              aria-label="Decision note"
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />

            {!profileComplete && (
              <div className="rounded-md border border-warning/40 bg-warning-tint px-3 py-2 text-sm text-ink-900">
                <span className="font-semibold">Not ready for a decision.</span>{' '}
                Still to be filled by the technician: {missingMandatory.join(', ')}.
              </div>
            )}

            {leadPending && canDecideLead && profileComplete && (
              <>
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <label htmlFor="onboarding-vertical" className="block text-sm font-medium text-ink-900">
                    Onboarding for vertical
                  </label>
                  <select
                    id="onboarding-vertical"
                    value={verticalId}
                    onChange={(e) => setVerticalId(e.target.value)}
                    className="mt-1 w-full max-w-xs rounded-md border bg-card px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">Select a vertical…</option>
                    {(verticals ?? []).map((vt) => (
                      <option key={vt.vertical_id} value={String(vt.vertical_id)}>{vt.vertical_name}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recorded against the technician. He can still work jobs in any vertical.
                  </p>
                </div>

                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
                  <span>Yes, This Is A Valid Technician Lead And I Find Him Eligible To Represent Easyfix Customers And Brands.</span>
                </label>
              </>
            )}

            {leadPending && canDecideLead && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  disabled={!profileComplete || !eligible || !verticalId || !note.trim() || busy}
                  onClick={() => run('accept')}
                  className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white"
                >
                  Accept lead
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!profileComplete || !note.trim() || busy}
                  onClick={() => run('deny')}
                >
                  Deny lead
                </Button>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* Review notes + short action summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Onboarding review notes" icon={<span>💬</span>}>
          <CommentsPanel entries={v.lead.comments as CommentEntry[]} onAdd={addNote} addLabel="Add a note" />
        </SectionCard>
        <SectionCard title="Onboarding action summary" icon={<span>🗂️</span>} right={<span>from the review record</span>}>
          <KV k="Lead applied on" v={formatDate(v.lead.registration.tx_applied_on)} />
          <KV k="Approved by" v={v.lead.registration.approved_by} />
          <KV k="Approved on" v={formatDate(v.lead.registration.approved_on)} />
          <KV k="Identity reviewed by" v={rv.identity.updated_by_name} />
          <p className="mt-2 text-xs text-muted-foreground">Full append-only transition log is in the <b>Status &amp; History</b> tab.</p>
        </SectionCard>
      </div>
    </div>
  );
}
