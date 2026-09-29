'use client';
/*
 * Self-Registration verification and profile activation
 *
 * Rebuild of legacy EasyFix_CRM/pages/easyfixers/eferVerification.vm as a
 * dedicated Next.js route (NOT a modal). Replaces the inline Pencil-icon
 * EasyfixerModal — the list page now `router.push()`-es here.
 *
 * Layout: single scrollable page with 3 outer collapsible sections.
 *   1. New Technician Lead       (eligibility + accept/deny/send-back)
 *   2. Registration Verification (4 sub-sections w/ per-section progress)
 *        a. Professional Details
 *        b. Personal & Family Details
 *        c. Banking Details
 *        d. Identity Documents
 *      + "Proceed To Tx Activation" gate
 *   3. Technician Activation     (Payment/Beneficiary, Allocate Clients,
 *                                 BGV, Activate)
 *
 * Every field maps to a tbl_easyfixer / tbl_easyfixer_bank_details column
 * — see the field-to-column map in the BE service file header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Check, Loader2, Phone, Smile, X, Upload, ChevronDown, ChevronUp, CheckCircle2, Wrench, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, useDebouncedValue } from '@/lib/hooks';
import { CallableMobile } from '@/components/calls/CallButton';
import { Button } from '@/components/ui/button';
import { BackLink } from '@/components/ui/back-link';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { VerificationSection } from '@/components/easyfixer/VerificationSection';
// Moved out of this file 2026-09-28 so New Registration 2's Work & Coverage tab
// renders the same editor rather than a second copy.
import { ServiceablePincodesEditor as ServiceablePincodes } from '@/components/easyfixer/ServiceablePincodesEditor';
import { DeepSkillOptionMappingEditor as DeepSkillOptionMapping } from '@/components/easyfixer/DeepSkillOptionMappingEditor';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { SkillImageLightbox } from '@/components/easyfixer/SkillImageLightbox';
import { AnimatedLoadingBar } from '@/components/ui/animated-loading-bar';
import { TeleprompterPanel } from '@/components/teleprompter/TeleprompterPanel';
import { showToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/utils';


// ─── BE payload shape (matches getVerificationPage) ─────────────────
type Comment = { id?: number; text: string; author: string | null; createdAt: string | null };
type LookupCity = { city_id: number; city_name: string };
type LookupBank = { id: number; bank_name: string };

type VerificationPayload = {
  header: {
    efr_id: number;
    first_name: string | null; last_name: string | null; full_name: string;
    city_name: string | null;
    is_active: boolean; is_technician_verified: boolean; is_existing_easyfixer: boolean;
    mobile: string | null;
  };
  lead: {
    eligibility: {
      primary_mobile: string | null;
      first_name: string | null; last_name: string | null;
      pincode: string | null; state_name: string | null; district: string | null;
      city_name: string | null; efr_cityId: number | null;
    };
    gps_location: string | null;
    registration: {
      tx_id: number; tx_applied_on: string | null; state_user: string | null;
      approved_by: string | null; approved_on: string | null;
    };
    status: { personal_details_filled: number | null; progress: number };
    comments: Comment[];
  };
  registrationVerification: {
    overall_progress: number;
    is_verified: boolean;
    proceed_allowed: boolean;
    professional: {
      progress: number; is_verified: boolean;
      experience_id: number | null; experience_name: string | null;
      skill_rating: number | null; tool_rating: number | null;
      skill_rating_comment: string | null; tool_rating_comment: string | null;
      service_category: string | null; service_type: string | null;
      have_bike: boolean; use_whatsapp: boolean;
      updated_by_name: string | null; update_date: string | null;
      comments: Comment[];
    };
    personal: {
      progress: number; is_verified: boolean;
      date_of_birth: string | null; marital_status: string | null;
      children_count: number | null; emergency_mobile: string | null;
      health_insurance: boolean; accidental_insurance: boolean;
      hobbies: string | null; email: string | null; is_email_verified: boolean;
      verification_comment: string | null;
      updated_by_name: string | null; update_date: string | null;
      comments: Comment[];
    };
    banking: {
      progress: number; is_verified: boolean; verification_status: number | null;
      bank_name: string | null; account_number: string | null;
      account_holder_name: string | null; ifsc_code: string | null;
      mode_of_payment: string | null; is_verified_by_app: boolean;
      cancelled_cheque_img: string | null;
      verification_comment: string | null;
      updated_by_name: string | null; update_date: string | null;
      comments: Comment[];
    };
    identity: {
      progress: number; is_verified: boolean; verification_status: number | null;
      adhaar_card_number: string | null; pan_card_number: string | null;
      driving_lisence_img: string | null;
      rejected_reason: string | null;
      updated_by_name: string | null; update_date: string | null;
      comments: Comment[];
    };
  };
  activation: {
    progress: number; is_activated: boolean;
    payment: {
      easyfix_bank_name_id: number;
      easyfix_bank_name: string | null;
      beneficiary_id: string | null;
      is_locked: boolean;
    };
    bgv: { is_done: boolean };
    sidebar: {
      profile_img: string | null;
      registration_age_days: number | null;
      ec_date: string | null; bgv_report_done: boolean;
      finance_updated_by: string | null; finance_updated_on: string | null;
    };
    comments: Comment[];
  };
  /*
   * Additional Details section (2026-06-11). Counts come from the BE
   * payload so the progress bar paints correctly on first render
   * without waiting for the child components to mount + fetch.
   */
  additional: {
    deep_skills_count: number;
    serviceable_pincodes_count: number;
    progress: number;
    is_complete: boolean;
  };
  lookups: { cities: LookupCity[]; easyfix_banks: LookupBank[] };
};

const SECTION_LEAD          = 'Registration Details Section';
const SECTION_PROFESSIONAL  = 'Professional Details Section';
const SECTION_PERSONAL      = 'Personal Details Section';
const SECTION_BANKING       = 'Banking Details Section';
const SECTION_IDENTITY      = 'Identity Details Section';
const SECTION_ACTIVATION    = 'Technician Activation Section';

const EXPERIENCE_OPTIONS = [
  { value: 1, label: 'Beginner' },
  { value: 2, label: 'Intermediate' },
  { value: 3, label: 'Advance' },
  { value: 4, label: 'Expert' },
];

export default function EasyfixerVerificationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const efrId = Number(params.id);

  /*
   * "Back" destination (2026-07-09) — this page is reachable from BOTH the
   * Registered Easyfixers queue (/easyfixers/registrations) and the Manage
   * Easyfixers roster (/easyfixers). Each entry point appends `?from=<its
   * path>`; the back-link returns there so the operator lands wherever they
   * came from. Guard against open-redirect: only honour an internal path
   * (leading "/", not protocol-relative "//"); default to the roster.
   */
  const searchParams = useSearchParams();
  const rawFrom = searchParams.get('from');
  // Strict internal-path allowlist: a single leading slash, then a NON-slash
  // path character, then only path characters. The `(?!/)` lookahead is load-
  // bearing — without it, "//1572395042" / "//localhost" (protocol-relative
  // to a dotless host or numeric IP) would pass and router.push would leave
  // the origin (open redirect). Absolute URLs and "/\host" are rejected too
  // (the char class excludes ':', '.', '\\').
  const backHref = rawFrom && /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(rawFrom)
    ? rawFrom
    : '/easyfixers';

  /*
   * Page data load via the shared `useFetch` hook (2026-06-11). The
   * module-level dedupe in `@/lib/hooks` absorbs React 18 Strict-Mode
   * double-mounts so the network panel shows ONE request on first paint,
   * not two. The hook re-fires automatically when the `key` (URL) flips
   * — operator navigating to a different easyfixer changes the URL, so
   * a fresh fetch lands without a manual effect.
   *
   * `enabled` defers the request until we have a valid efrId (the route
   * param could briefly be NaN during a transition).
   *
   * Save handlers in this tree call `onReload` after mutating; that
   * resolves to the hook's `refetch`, which drops the cached entry for
   * this URL and re-fires. We wrap it as a `Promise<void>` so existing
   * `await onReload()` call sites keep their sequencing semantics
   * unchanged.
   */
  const validEfrId = Number.isInteger(efrId) && efrId > 0;
  const fetchKey = validEfrId ? `/admin/easyfixers/${efrId}/verification` : null;
  const { data, loading, error, refetch } = useFetch<VerificationPayload>(fetchKey, {
    enabled: validEfrId,
  });

  const reload = useCallback(async () => {
    refetch();
  }, [refetch]);

  if (loading) return <div className="p-8 text-sm text-ink-500">Loading…</div>;
  if (error || !data) return (
    <div className="p-8">
      {/* Canonical Back-link — returns to the origin (registrations queue or
          roster) captured in `?from=`; see backHref above. */}
      <BackLink href={backHref} label="Back to Easyfixers" />
      <div className="mt-4 text-sm text-urgent">{error || 'Not found'}</div>
    </div>
  );

  return <VerificationView data={data} onReload={reload} backHref={backHref} />;
}

type ActiveSection = 'lead' | 'verification' | 'activation';

/*
 * Compute the "last active" outer section from the payload (2026-06-10).
 * First section in display order that is NOT YET complete becomes the
 * active one — that's the one auto-expanded on page mount. Logic:
 *   - Lead not yet accepted (personal_details_filled !== 1) → 'lead'
 *   - Registration verification not done → 'verification'
 *   - Otherwise → 'activation' (the final step)
 */
function computeActiveSection(data: VerificationPayload): ActiveSection {
  if (data.lead.status.personal_details_filled !== 1) return 'lead';
  if (!data.registrationVerification.is_verified) return 'verification';
  return 'activation';
}

function VerificationView({ data, onReload, backHref }: { data: VerificationPayload; onReload: () => Promise<void>; backHref: string }) {
  const router = useRouter();
  const efrId = data.header.efr_id;

  /*
   * Outer-accordion state (2026-06-10). One of the three sections is
   * "open" at a time; the rest are collapsed. On first paint we pick
   * the last-active section per the payload (see computeActiveSection).
   * Clicking "Proceed To Tx Activation" inside the Registration
   * Verification section flips this to 'activation' so that band
   * expands and the previous band collapses.
   *
   * We memo the initial value so payload changes (e.g. after a reload
   * following an action) don't re-snap the user back to a state-derived
   * section in the middle of their work — only manual toggles + the
   * Proceed button move the active section after first paint.
   *
   * Implementation note (2026-06-10): VerificationSection now supports a
   * controlled `open`/`onOpenChange` mode. We pass the activeSection
   * state through as `open`, which lets the open/close transition
   * animate naturally instead of remounting via a synthetic `key`
   * swap. Remounting was killing scroll position, sub-section state,
   * and giving the impression of a full page reload.
   */
  const initialActive = useMemo(() => computeActiveSection(data), []); // eslint-disable-line react-hooks/exhaustive-deps
  /*
   * Nullable to support manual COLLAPSE (2026-06-11). The earlier
   * `if (o) setActiveSection('X')` guard in each onOpenChange dropped
   * the close intent on the floor — once one section was open, clicking
   * its header did nothing. Allowing `null` means a click on the active
   * header collapses everything; clicking another header opens that one
   * (auto-closing whichever was previously open, since only one open
   * slot exists in this state machine).
   */
  const [activeSection, setActiveSection] = useState<ActiveSection | null>(initialActive);

  // ─── Helpers ──────────────────────────────────────────────────────
  const reloadAfter = async <T,>(p: Promise<T>) => { try { await p; } finally { await onReload(); } };

  const addComment = (section: string) => async (text: string) => {
    await reloadAfter(api.post(`/admin/easyfixers/${efrId}/verification/comments`, { text, section }));
  };

  // ─── Header ───────────────────────────────────────────────────────
  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Back-link — returns to the origin (registrations queue or roster)
          captured in `?from=`; see backHref in the parent. Lives ABOVE the
          title row, matching the other detail pages. */}
      <BackLink href={backHref} label="Back to Easyfixers" />
      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Self-Registration Verification And Profile Activation</h1>
      </div>

      {/* Sub-header: name + city + efr_id + smile/call icons */}
      <div className="flex items-center justify-between border-b pb-3">
        <div className="text-sm text-ink-700">
          <span className="font-medium">{data.header.full_name || '—'}</span>
          {data.header.city_name && <span className="text-ink-500"> from {data.header.city_name}</span>}
          <span className="ml-2 text-ink-500">#{data.header.efr_id}</span>
        </div>
        <div className="flex items-center gap-3">
          {data.header.is_technician_verified && (
            <span className={data.header.is_active ? 'text-success' : 'text-ink-500'}>
              {data.header.is_active ? <Check className="h-5 w-5" /> : <X className="h-5 w-5" />}
            </span>
          )}
          <Smile className="h-5 w-5 text-warning" />
          {/*
            * Click-to-call, NOT a `tel:` link. A raw tel: href hands the number
            * to the operating system — which on a Mac opens FaceTime and on
            * Windows opens nothing useful — so the call never goes through the
            * platform at all: no Plivo/Kaleyra bridge, no respect for the
            * configured web/mobile call mode, no tbl_job_caller_info audit row,
            * and the technician's raw number exposed in the DOM.
            *
            * CallableMobile routes through useClickToCall, which resolves the
            * provider + mode server-side and places the bridge. `efrId` is the
            * technician target (the same component serves customers via
            * customerId and SPOCs via spocJobId). `iconOnly` keeps this a bare
            * icon in the header — and makes the affordance disappear entirely
            * for operators without the isClickToCall action, rather than
            * falling back to printing the number.
            */}
          <CallableMobile
            efrId={data.header.efr_id}
            mobile={data.header.mobile}
            iconOnly
            className="text-primary hover:text-brand-600"
          />
        </div>
      </div>

      {/* ───── Section 1: New Technician Lead ───── */}
      <VerificationSection
        title="New Technician Lead"
        verified={data.lead.status.personal_details_filled === 1}
        progress={data.lead.status.personal_details_filled === 1 ? null : data.lead.status.progress}
        open={activeSection === 'lead'}
        onOpenChange={(o) => setActiveSection(o ? 'lead' : null)}
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <h4 className="text-sm font-semibold text-ink-700 border-b pb-2">Eligibility Check</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ReadField label="Primary Mobile" value={data.lead.eligibility.primary_mobile} />
              <ReadField label="First & Last Name" value={`${data.lead.eligibility.first_name || ''} ${data.lead.eligibility.last_name || ''}`.trim() || data.header.full_name} />
              <ReadField label="Pin Code"      value={data.lead.eligibility.pincode} />
              <ReadField label="State"         value={data.lead.eligibility.state_name} />
              <ReadField label="District"      value={data.lead.eligibility.district} />
              <ReadField label="City"          value={data.lead.eligibility.city_name} verifiedTick={data.lead.status.personal_details_filled === 1} />
            </div>

            {/* Lead accept/deny actions. Hidden once the lead is processed:
                accepted (1) advances to the verification stage below; denied (2)
                shows a read-only notice instead of the action buttons — legacy
                likewise hides Accept/Deny/Send Back at status 2 (it offers only
                a separate "Send Back to New Lead" flow, not built here). The
                buttons stay only for sent-back (0) and brand-new (null) leads. */}
            {data.lead.status.personal_details_filled === 2 ? (
              <div className="mt-4 rounded-md border border-urgent/30 bg-urgent-tint px-3 py-2 text-sm text-urgent-strong">
                This technician lead was <span className="font-semibold">denied</span>.
                See the rejection details and comments in the panel on the right.
              </div>
            ) : data.lead.status.personal_details_filled !== 1 ? (
              <LeadActions efrId={efrId} onReload={onReload} />
            ) : null}
          </div>

          {/* Sidebar */}
          <div className="lg:col-span-1 space-y-4 border-l pl-4">
            <div>
              <h5 className="text-xs font-semibold text-ink-700">GPS Location</h5>
              <p className="text-xs text-ink-700">{data.lead.gps_location || '—'}</p>
            </div>
            <div className="border-t pt-3 space-y-1.5">
              <h5 className="text-xs font-semibold text-ink-700 uppercase">Registration Details</h5>
              <SidebarRow label="TX ID" value={data.lead.registration.tx_id} />
              <SidebarRow label="TX Applied On" value={formatDate(data.lead.registration.tx_applied_on)} />
              <SidebarRow label="State User" value={data.lead.registration.state_user} />
              {data.lead.status.personal_details_filled === 1 && (
                <>
                  <SidebarRow label="Approved By" value={data.lead.registration.approved_by} />
                  <SidebarRow label="Approved On" value={formatDate(data.lead.registration.approved_on)} />
                </>
              )}
              {data.lead.status.personal_details_filled === 2 && (
                <>
                  <SidebarRow label="Rejected By" value={data.lead.registration.approved_by} />
                  <SidebarRow label="Rejected On" value={formatDate(data.lead.registration.approved_on)} />
                </>
              )}
            </div>
            <CommentsPanel
              entries={data.lead.comments as CommentEntry[]}
              onAdd={addComment(SECTION_LEAD)}
              addLabel="Add Your Comment"
            />
          </div>
        </div>
      </VerificationSection>

      {/* ───── Section 2: Registration Verification ───── */}
      <VerificationSection
        title="Registration Verification"
        verified={data.registrationVerification.is_verified}
        progress={data.registrationVerification.overall_progress}
        open={activeSection === 'verification'}
        onOpenChange={(o) => setActiveSection(o ? 'verification' : null)}
      >
        <div className="space-y-3">
          {/* 2a. Professional Details */}
          <VerificationSection
            headerTone="sub"
            title="Professional Details"
            verified={data.registrationVerification.professional.is_verified}
            progress={data.registrationVerification.professional.progress}
          >
            <ProfessionalSection efrId={efrId} d={data.registrationVerification.professional} onReload={onReload} addComment={addComment(SECTION_PROFESSIONAL)} />
          </VerificationSection>

          {/* 2b. Personal & Family Details */}
          <VerificationSection
            headerTone="sub"
            title="Personal & Family Details"
            verified={data.registrationVerification.personal.is_verified}
            progress={data.registrationVerification.personal.progress}
          >
            <PersonalSection efrId={efrId} d={data.registrationVerification.personal} onReload={onReload} addComment={addComment(SECTION_PERSONAL)} />
          </VerificationSection>

          {/* 2c. Banking Details */}
          <VerificationSection
            headerTone="sub"
            title="Banking Details"
            verified={data.registrationVerification.banking.is_verified}
            progress={data.registrationVerification.banking.progress}
          >
            <BankingSection efrId={efrId} d={data.registrationVerification.banking} onReload={onReload} addComment={addComment(SECTION_BANKING)} />
          </VerificationSection>

          {/* 2d. Identity Documents */}
          <VerificationSection
            headerTone="sub"
            title="Identity Documents"
            verified={data.registrationVerification.identity.is_verified}
            progress={data.registrationVerification.identity.progress}
          >
            <IdentitySection efrId={efrId} d={data.registrationVerification.identity} onReload={onReload} addComment={addComment(SECTION_IDENTITY)} />
          </VerificationSection>

          {/* Proceed gate */}
          {data.registrationVerification.is_verified && (
            <div className="flex justify-center pt-2">
              {/*
                * Green-CTA hover, pinned to one dark green in BOTH themes.
                * This page has nine of these buttons; they all carry the same
                * class string, and this is the note for all of them.
                *
                * `--success` is STABLE — rgb(27,158,90) in `:root` and in
                * `.dark` — so the resting `bg-success text-white` is fine.
                * `--success-strong` is not: it and `--success-tint` swap WITH
                * EACH OTHER between themes, so a bare `hover:bg-success-strong`
                * measures
                *
                *   light  --success-strong  rgb(14,92,52)     8.08:1 vs white ✓
                *   dark   --success-strong  rgb(226,245,234)  1.14:1 vs white ✗
                *
                * i.e. on hover the button went near-white under white text in
                * dark mode. Because the pair swaps, dark `--success-tint` IS
                * rgb(14,92,52) — bit-identical to the light-mode hover — so
                * naming both sides pins that one dark green everywhere.
                * `dark:hover:` compiles to `.dark .dark\:hover\:…:hover`,
                * two classes to `hover:`'s one, so it wins on specificity
                * regardless of source order.
                *
                * Light theme is byte-identical to before: the `dark:` half
                * never applies there. `text-white` stays valid at 8.08:1.
                *
                * This also keeps the green CTA behaving like the red one
                * beside it — `bg-destructive hover:bg-destructive-strong` is
                * already stable on both halves, so it darkens on hover in
                * both themes. Letting the green invert its polarity instead
                * would break a pair that sits on the same button row.
                *
                * Same shape as the `text-success-tint dark:text-success-strong`
                * idiom in components/ui/confirm-dialog.
                */}
              <Button
                className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white rounded-full px-6"
                onClick={async () => {
                  /*
                   * proceed-to-activation is a pure gate-check on the BE
                   * (no DB writes), so we don't need to refetch the
                   * payload. On success we just flip the active section
                   * — the controlled VerificationSection animates the
                   * collapse/expand via CSS transition (no remount).
                   * On error we keep the current section open.
                   */
                  try {
                    await api.post(`/admin/easyfixers/${efrId}/verification/proceed-to-activation`, {});
                    setActiveSection('activation');
                  } catch (e) {
                    showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Cannot proceed' });
                  }
                }}
              >
                Proceed To Tx Activation
              </Button>
            </div>
          )}
        </div>
      </VerificationSection>

      {/* ───── Section 3: Technician Activation ───── */}
      <VerificationSection
        title="Technician Activation"
        verified={data.activation.is_activated}
        progress={data.activation.progress}
        open={activeSection === 'activation'}
        onOpenChange={(o) => setActiveSection(o ? 'activation' : null)}
      >
        <ActivationSection
          efrId={efrId}
          activation={data.activation}
          banks={data.lookups.easyfix_banks}
          onReload={onReload}
          addComment={addComment(SECTION_ACTIVATION)}
        />
      </VerificationSection>

      {/* ───── Section 4: Additional Details ───── */}
      {/*
       * Houses Skill & Service Area Mapping (Deep Skill Option Mapping
       * + Serviceable Pincodes). Moved out of Technician Activation
       * (2026-06-10) into its own collapsible band so the activation
       * step stays focused on payment/beneficiary/BGV/activate. Stays
       * uncontrolled (defaultOpen=false) — independent of the
       * activeSection state machine; user opens it on demand.
       */}
      <VerificationSection
        title="Additional Details"
        progress={data.additional.progress}
        verified={data.additional.is_complete}
        defaultOpen={false}
      >
        <SkillAndServiceAreaMapping efrId={efrId} onReload={onReload} />
      </VerificationSection>
    </div>
  );
}

/* ───────── Sub-section components ───────── */

function LeadActions({ efrId, onReload }: { efrId: number; onReload: () => Promise<void> }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // AI Teleprompter (property-gated: teleprompter.emails). Absent ⇒ button hidden.
  const features = useFetchOnce<{ canRunTeleprompter?: boolean }>('/admin/access/features');
  const canRunTeleprompter = features.data?.canRunTeleprompter === true;
  const [teleprompterOpen, setTeleprompterOpen] = useState(false);

  async function call(personal_details_filled: 0 | 1 | 2) {
    if (personal_details_filled !== 1 && reason.trim().length === 0) {
      showToast({ variant: 'error', message: 'Remark is required' });
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/lead`, { personal_details_filled, reason });
      if (personal_details_filled === 1) {
        // Accept → the lead stays in active verification; refetch in place so
        // the Registration Verification stage unlocks below.
        await onReload();
      } else {
        // Deny (2) / Send Back To Technician (0) → the lead leaves the
        // operator's hands, so navigate back to the queue instead of
        // refetching in place. Legacy "Send Back" redirected to the
        // efer-registration list; "Deny" is sent to the same queue here.
        // (Without leaving, the lead-action buttons re-render — their gate is
        // `personal_details_filled !== 1` — so the screen looked unchanged.)
        showToast({
          variant: 'success',
          message: personal_details_filled === 0
            ? 'Lead sent back to technician.'
            : 'Technician lead denied.',
        });
        router.push('/easyfixers/registrations');
      }
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 mt-4 border-t pt-4">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>Yes, This Is A Valid Technician Lead And I Find Him Eligible To Represent Easyfix Customers And Brands.</span>
      </label>
      <textarea
        rows={2}
        placeholder="Remark (required for Deny / Send Back)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      <AnimatedLoadingBar visible={busy} message="Saving Lead Action…" tone="emerald" />
      {canRunTeleprompter && (
        <div className="flex justify-center">
          <Button onClick={() => setTeleprompterOpen(true)} disabled={busy} className="bg-primary hover:bg-brand-600 text-white">
            <Phone className="h-4 w-4" /> Start Guided Call
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 justify-center">
        {/* Hover pinned to dark green in both themes — see the Proceed gate above.
            The two destructive buttons beside this one need no `dark:` half:
            `--destructive-strong` is stable, so they already darken in both. */}
        <Button onClick={() => call(1)} disabled={!checked || busy} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">Accept</Button>
        <Button onClick={() => call(2)} disabled={busy} className="bg-destructive hover:bg-destructive-strong text-white">Deny</Button>
        <Button onClick={() => call(0)} disabled={busy} className="bg-destructive hover:bg-destructive-strong text-white">Send Back To Technician</Button>
      </div>
      {canRunTeleprompter && (
        <TeleprompterPanel open={teleprompterOpen} efrId={efrId} onClose={() => setTeleprompterOpen(false)} onApplied={onReload} />
      )}
    </div>
  );
}

function ProfessionalSection({ efrId, d, onReload, addComment }: {
  efrId: number;
  d: VerificationPayload['registrationVerification']['professional'];
  onReload: () => Promise<void>;
  addComment: (text: string) => Promise<void>;
}) {
  const [form, setForm] = useState({
    experience_id: d.experience_id ?? 1,
    skill_rating: d.skill_rating ?? 0,
    tool_rating: d.tool_rating ?? 0,
    skill_rating_comment: d.skill_rating_comment ?? '',
    tool_rating_comment: d.tool_rating_comment ?? '',
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/professional`, form);
      await onReload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' });
    } finally { setSaving(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <ReadField label="Service Category" value={d.service_category} />
        <ReadField label="Service Type" value={d.service_type} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Total Experience</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
              value={form.experience_id}
              onChange={(e) => setForm((s) => ({ ...s, experience_id: Number(e.target.value) }))}
            >
              {EXPERIENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <ReadField label="Bike"     value={d.have_bike ? 'Yes' : 'No'} />
          <ReadField label="WhatsApp" value={d.use_whatsapp ? 'Yes' : 'No'} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t pt-3">
          <div className="space-y-1">
            <Label>Skills Rating (0-10)</Label>
            <Input type="number" min={0} max={10} value={form.skill_rating}
                   onChange={(e) => setForm((s) => ({ ...s, skill_rating: Number(e.target.value) }))} />
            <textarea rows={2} placeholder="Comment For Skill Rating"
                      value={form.skill_rating_comment}
                      onChange={(e) => setForm((s) => ({ ...s, skill_rating_comment: e.target.value }))}
                      className="mt-1 w-full rounded-md border border-ink-100 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <Label>Tools Rating (0-10)</Label>
            <Input type="number" min={0} max={10} value={form.tool_rating}
                   onChange={(e) => setForm((s) => ({ ...s, tool_rating: Number(e.target.value) }))} />
            <textarea rows={2} placeholder="Comment For Tool Rating"
                      value={form.tool_rating_comment}
                      onChange={(e) => setForm((s) => ({ ...s, tool_rating_comment: e.target.value }))}
                      className="mt-1 w-full rounded-md border border-ink-100 px-3 py-2 text-sm" />
          </div>
        </div>

        <AnimatedLoadingBar visible={saving} message="Saving Professional Details…" tone="emerald" />
        <div className="flex justify-end gap-2 pt-2">
          <Button disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Update'}</Button>
        </div>

        <div className="text-xs text-ink-500 border-t pt-2">
          Last Updated By {d.updated_by_name || '—'} On {formatDate(d.update_date)}
        </div>
      </div>
      <aside className="lg:col-span-1 border-l pl-4">
        <CommentsPanel entries={d.comments as CommentEntry[]} onAdd={addComment} addLabel="Add Your Comment" />
      </aside>
    </div>
  );
}

function PersonalSection({ efrId, d, onReload, addComment }: {
  efrId: number;
  d: VerificationPayload['registrationVerification']['personal'];
  onReload: () => Promise<void>;
  addComment: (text: string) => Promise<void>;
}) {
  const [comment, setComment] = useState(d.verification_comment ?? '');
  const [saving, setSaving] = useState(false);

  async function markVerified() {
    setSaving(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/personal-family`, {
        is_verified: true, verification_comment: comment,
      });
      await onReload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
    finally { setSaving(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadField label="Birthday"           value={d.date_of_birth} />
          <ReadField label="Married"            value={d.marital_status} />
          <ReadField label="Number Of Children" value={d.children_count} />
          <ReadField label="Emergency Mobile"   value={d.emergency_mobile} />
          <ReadField label="Health Insurance"     value={d.health_insurance ? 'Yes' : 'No'} />
          <ReadField label="Accidental Insurance" value={d.accidental_insurance ? 'Yes' : 'No'} />
        </div>
        <div>
          <Label>Hobbies And Interests</Label>
          <div className="mt-1 text-sm text-ink-700">{d.hobbies || '—'}</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t pt-3">
          <ReadField label="Email" value={d.email} verifiedTick={d.is_email_verified} />
        </div>

        <div className="border-t pt-3 space-y-2">
          <Label>Verification Notes</Label>
          <textarea rows={2}
            value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="Your remarks and notes"
            className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm" />
          <AnimatedLoadingBar visible={saving} message="Saving Personal Details…" tone="emerald" />
          <div className="flex justify-end">
            <Button disabled={saving || d.is_verified} onClick={markVerified} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
              {saving ? 'Saving…' : 'Yes, I Have Validated All Details'}
            </Button>
          </div>
          {d.verification_comment && (
            <div className="mt-2 text-xs text-ink-700 bg-ink-50 rounded p-2">
              Final Comment: {d.verification_comment}
              <div className="text-xs text-ink-500 mt-1">By {d.updated_by_name || '—'} on {formatDate(d.update_date)}</div>
            </div>
          )}
        </div>
      </div>
      <aside className="lg:col-span-1 border-l pl-4">
        <CommentsPanel entries={d.comments as CommentEntry[]} onAdd={addComment} addLabel="Add Your Notes" />
      </aside>
    </div>
  );
}

function BankingSection({ efrId, d, onReload, addComment }: {
  efrId: number;
  d: VerificationPayload['registrationVerification']['banking'];
  onReload: () => Promise<void>;
  addComment: (text: string) => Promise<void>;
}) {
  const [invalidReason, setInvalidReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function setStatus(verification_status: 1 | 2) {
    if (verification_status === 2 && invalidReason.trim().length === 0) {
      showToast({ variant: 'error', message: 'Please specify the reason for invalid banking details' });
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/banking`, {
        verification_status,
        verification_comment: verification_status === 2 ? invalidReason : undefined,
      });
      await onReload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadField label="Bank Name"           value={d.bank_name} />
          <ReadField label="Verified By App"     value={d.is_verified_by_app ? 'Yes' : '—'} />
          <ReadField label="Bank Account Number" value={d.account_number} />
          <ReadField label="Account Holder Name" value={d.account_holder_name} />
          <ReadField label="IFSC Code"           value={d.ifsc_code} />
          <ReadField label="Preferred Mode Of Transfer" value={d.mode_of_payment} />
        </div>

        {d.cancelled_cheque_img && (
          <div>
            <Label>Photo Of Cancelled Cheque</Label>
            {/* TODO: switch to authenticated image fetcher per memory — for now legacy easydoc path */}
            <img src={`/easydoc/easyfixer_documents/${d.cancelled_cheque_img}`} alt="Cheque" width={120} height={90}
                 className="mt-1 rounded border" />
          </div>
        )}

        <div className="border-t pt-3 space-y-2">
          <Label>Mark Verification</Label>
          <textarea rows={2}
            value={invalidReason} onChange={(e) => setInvalidReason(e.target.value)}
            placeholder="Reason (required if marking invalid)"
            className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm" />
          <AnimatedLoadingBar visible={busy} message="Saving Banking Details…" tone="emerald" />
          <div className="flex flex-wrap gap-2 justify-end">
            <Button disabled={busy || d.verification_status === 1} onClick={() => setStatus(1)} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
              Valid Banking Details
            </Button>
            <Button disabled={busy} onClick={() => setStatus(2)} className="bg-destructive hover:bg-destructive-strong text-white">
              Invalid Banking Details
            </Button>
          </div>
          {d.verification_comment && d.verification_status === 2 && (
            <div className="mt-2 text-xs text-ink-700 bg-ink-50 rounded p-2">
              Invalid Reason: {d.verification_comment}
              <div className="text-xs text-ink-500 mt-1">By {d.updated_by_name || '—'} on {formatDate(d.update_date)}</div>
            </div>
          )}
        </div>
      </div>
      <aside className="lg:col-span-1 border-l pl-4">
        <CommentsPanel entries={d.comments as CommentEntry[]} onAdd={addComment} addLabel="Add Your Notes" />
      </aside>
    </div>
  );
}

function IdentitySection({ efrId, d, onReload, addComment }: {
  efrId: number;
  d: VerificationPayload['registrationVerification']['identity'];
  onReload: () => Promise<void>;
  addComment: (text: string) => Promise<void>;
}) {
  const [aadhaar, setAadhaar] = useState(d.adhaar_card_number ?? '');
  const [pan, setPan] = useState(d.pan_card_number ?? '');
  const [rejectReason, setRejectReason] = useState('');
  const [savingNumbers, setSavingNumbers] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  async function saveNumbers() {
    setSavingNumbers(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/identity`, {
        adhaar_card_number: aadhaar || undefined,
        pan_card_number: pan || undefined,
      });
      await onReload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
    finally { setSavingNumbers(false); }
  }

  async function setStatus(verification_status: 1 | 2) {
    if (verification_status === 2 && rejectReason.trim().length === 0) {
      showToast({ variant: 'error', message: 'Please write a reason to reject' });
      return;
    }
    setSavingStatus(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/identity`, {
        verification_status,
        rejected_reason: verification_status === 2 ? rejectReason : undefined,
      });
      await onReload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
    finally { setSavingStatus(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-3">
        <div className="space-y-1">
          <Label>Aadhaar Card No.</Label>
          <Input value={aadhaar} maxLength={12} onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, ''))} />
          {/* TODO: aadhaar front/back image upload + preview via tbl_easyfixer_documents */}
        </div>
        <div className="space-y-1">
          <Label>PAN Card Number</Label>
          <Input value={pan} maxLength={10} onChange={(e) => setPan(e.target.value.toUpperCase())} />
        </div>
        <AnimatedLoadingBar visible={savingNumbers} message="Saving Identity Details…" tone="emerald" />
        <div className="flex justify-end">
          <Button onClick={saveNumbers} disabled={savingNumbers}>{savingNumbers ? 'Saving…' : 'Update Identity Numbers'}</Button>
        </div>

        {d.driving_lisence_img && (
          <div>
            <Label>Driving Licence Image</Label>
            <img src={`/easydoc/easyfixer_documents/${d.driving_lisence_img}`} alt="DL" width={120} height={90} className="mt-1 rounded border" />
          </div>
        )}

        <div className="border-t pt-3 space-y-2">
          <Label>Verification</Label>
          <textarea rows={2}
            value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Your reasons (required to reject / send back)"
            className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm" />
          <AnimatedLoadingBar visible={savingStatus} message="Saving Identity Verification…" tone="emerald" />
          <div className="flex flex-wrap gap-2 justify-end">
            <Button disabled={savingStatus || d.verification_status === 1} onClick={() => setStatus(1)} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
              Send To Finance
            </Button>
            <Button disabled={savingStatus} onClick={() => setStatus(2)} className="bg-destructive hover:bg-destructive-strong text-white">
              Reject Profile
            </Button>
          </div>
          {d.rejected_reason && (
            <div className="mt-2 text-xs text-ink-700 bg-ink-50 rounded p-2">
              Rejection: {d.rejected_reason}
              <div className="text-xs text-ink-500 mt-1">By {d.updated_by_name || '—'} on {formatDate(d.update_date)}</div>
            </div>
          )}
        </div>
      </div>
      <aside className="lg:col-span-1 border-l pl-4">
        <CommentsPanel entries={d.comments as CommentEntry[]} onAdd={addComment} addLabel="Add Your Notes" />
      </aside>
    </div>
  );
}

function SkillAndServiceAreaMapping({ efrId, onReload }: { efrId: number; onReload: () => Promise<void> }) {
  /*
   * "Skill & Service Area Mapping" — sub-section under Additional
   * Details that groups the Deep Skill Option Mapping picker with the
   * Serviceable Pincodes multi-select. `onReload` (2026-06-11) is
   * forwarded down so each child can refresh the parent payload after
   * a successful save — that's what keeps the Additional Details
   * progress bar in sync without a manual page reload.
   */
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/50">
      <div className="px-4 py-2 border-b border-ink-100 bg-ink-100/60">
        <h4 className="text-sm font-semibold text-ink-700">Skill & Service Area Mapping</h4>
        <p className="text-xs text-ink-500">
          Map This Technician To Deep Skill Options And The Pincodes They Will Service.
        </p>
      </div>
      <div className="p-4 space-y-2 bg-card">
        <DeepSkillOptionMapping efrId={efrId} onReload={onReload} />
        <ServiceablePincodes efrId={efrId} onReload={onReload} />
      </div>
    </div>
  );
}

function ActivationSection({
  efrId, activation, banks, onReload, addComment,
}: {
  efrId: number;
  activation: VerificationPayload['activation'];
  banks: LookupBank[];
  onReload: () => Promise<void>;
  addComment: (text: string) => Promise<void>;
}) {
  const [bankId, setBankId] = useState(activation.payment.easyfix_bank_name_id || 0);
  const [beneficiary, setBeneficiary] = useState(activation.payment.beneficiary_id ?? '');
  const [grade, setGrade] = useState<'Silver' | 'Gold' | 'Diamond'>('Silver');
  const [activateComment, setActivateComment] = useState('');
  const [tempFlag, setTempFlag] = useState(false);
  /*
   * Split per-action busy flags (2026-06-11). Previously a single
   * `busy` flag controlled both the Edit Finance row and the Activate
   * Technician row, which meant clicking either button greyed out the
   * OTHER row's button + bar — visually confusing because the operator
   * had no signal about which save was actually in flight. Each handler
   * now owns its own flag and its own AnimatedLoadingBar.
   */
  const [savingFinance, setSavingFinance] = useState(false);
  const [activating, setActivating] = useState(false);

  const isLocked = activation.payment.is_locked;

  async function saveFinance() {
    setSavingFinance(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/activation`, {
        easyfix_bank_name_id: bankId || 0,
        beneficiary_id: beneficiary || null,
      });
      await onReload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
    finally { setSavingFinance(false); }
  }

  async function activate() {
    if (!activateComment.trim()) { showToast({ variant: 'error', message: 'Comment is required' }); return; }
    setActivating(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/activation`, {
        activate: true,
        grade,
        final_accept_comment: activateComment,
        is_eligible_for_offline_orders: tempFlag ? 1 : 0,
      });
      await onReload();
    } catch (e) { showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed' }); }
    finally { setActivating(false); }
  }

  const bankOptions = useMemo(() => banks.map((b) => ({ value: b.id, label: b.bank_name })), [banks]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <h4 className="text-sm font-semibold text-ink-700">Payment & Beneficiary Details</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>EasyFix Bank Name</Label>
            <SearchSelect
              value={bankId}
              onChange={(v) => setBankId(Number(v) || 0)}
              options={[{ value: 0, label: 'Choose Bank' }, ...bankOptions]}
              disabled={isLocked}
              placeholder="Choose Bank"
            />
          </div>
          <div className="space-y-1">
            <Label>Beneficiary ID</Label>
            <Input value={beneficiary} disabled={isLocked} onChange={(e) => setBeneficiary(e.target.value)} />
          </div>
        </div>
        <AnimatedLoadingBar visible={savingFinance} message="Saving Finance Details…" tone="emerald" />
        <div className="flex justify-end">
          <Button disabled={savingFinance} onClick={saveFinance}>Edit Finance Details</Button>
        </div>

        <hr />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Allocate Clients</Label>
            {/* TODO: multi-select w/ already-mapped client list. For now a stubbed read-only hint. */}
            <div className="text-xs text-ink-500">Use Manage Clients ➜ Easyfixer mapping for now.</div>
          </div>
          <div className="space-y-1">
            <Label>Add Tx Under Master</Label>
            <Input placeholder="Enter Mobile Number" disabled />
          </div>
        </div>

        <hr />
        {/*
         * Skill & Service Area Mapping has moved to the new
         * "Additional Details" top-level section (2026-06-10). Kept
         * the divider above for visual consistency between the
         * Allocate Clients / Add Tx block and the BGV Upload block.
         */}

        <div className="space-y-2">
          <Label>Upload BGV Report</Label>
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled><Upload className="h-4 w-4 mr-1" /> Choose File</Button>
            <span className="text-xs text-ink-500">
              {activation.bgv.is_done ? 'BGV uploaded' : 'No file chosen'} — TODO: S3 wiring for technician-scoped uploads
            </span>
          </div>
        </div>

        {!activation.is_activated ? (
          <div className="border-t pt-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label>Grade</Label>
                <select className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                        value={grade} onChange={(e) => setGrade(e.target.value as 'Silver' | 'Gold' | 'Diamond')}>
                  <option value="Silver">Silver</option>
                  <option value="Gold">Gold</option>
                  <option value="Diamond">Diamond</option>
                </select>
              </div>
              <div className="md:col-span-2 flex items-end">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={tempFlag} onChange={(e) => setTempFlag(e.target.checked)} />
                  Temporary Activated
                </label>
              </div>
            </div>
            <textarea rows={3}
              placeholder="Comment (required)"
              value={activateComment} onChange={(e) => setActivateComment(e.target.value)}
              className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm" />
            <AnimatedLoadingBar visible={activating} message="Activating Technician…" tone="emerald" />
            <div className="flex justify-end">
              {/* Hover pinned to dark green in both themes — see the Proceed
                  gate near the top of this file; bare `hover:bg-success-strong`
                  lands on rgb(226,245,234) in dark mode, 1.14:1 under white. */}
              <Button onClick={activate} disabled={activating} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">
                Activate Technician
              </Button>
            </div>
          </div>
        ) : (
          <div className="border-t pt-4 flex items-center justify-end">
            <span className="inline-flex items-center rounded-full bg-success-tint text-success-strong px-3 py-0.5 text-xs font-medium">Active</span>
          </div>
        )}
      </div>

      <aside className="lg:col-span-1 border-l pl-4 space-y-3">
        <div className="text-center">
          {activation.sidebar.profile_img ? (
            <img src={`/easydoc/easyfixer_documents/${activation.sidebar.profile_img}`} alt="Profile" width={70} height={70} className="rounded-full inline-block border" />
          ) : (
            <div className="w-[70px] h-[70px] rounded-full border bg-ink-100 mx-auto" />
          )}
        </div>
        <div className="space-y-1 border-t pt-2">
          <h5 className="text-xs font-semibold text-ink-700 uppercase">Registration Details</h5>
          <SidebarRow label="Registration Age" value={activation.sidebar.registration_age_days != null ? `${activation.sidebar.registration_age_days} days` : '—'} />
          <SidebarRow label="EC" value={formatDate(activation.sidebar.ec_date)} />
          <SidebarRow label="BGV Report" value={activation.sidebar.bgv_report_done ? 'Yes' : 'No'} />
          <SidebarRow label="Finance Details Updated By" value={activation.sidebar.finance_updated_by} />
          <SidebarRow label="Finance Updated Date" value={formatDate(activation.sidebar.finance_updated_on)} />
        </div>
        <CommentsPanel entries={activation.comments as CommentEntry[]} onAdd={addComment} addLabel="Add Your Notes" />
      </aside>
    </div>
  );
}



/* ───────── Small primitives ───────── */

function ReadField({ label, value, verifiedTick }: { label: string; value: string | number | null | undefined; verifiedTick?: boolean }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-ink-700">{label}</Label>
      <div className="flex items-center gap-2">
        <Input value={value == null || value === '' ? '' : String(value)} readOnly className="bg-ink-50" />
        {verifiedTick && <Check className="h-4 w-4 text-success shrink-0" />}
      </div>
    </div>
  );
}

function SidebarRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <span className="text-ink-500 uppercase tracking-wide">{label}</span>
      <span className="text-ink-900 break-words">{value == null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}
