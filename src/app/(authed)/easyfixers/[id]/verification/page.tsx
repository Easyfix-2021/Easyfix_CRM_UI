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
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { SkillImageLightbox } from '@/components/easyfixer/SkillImageLightbox';
import { AnimatedLoadingBar } from '@/components/ui/animated-loading-bar';
import { TeleprompterPanel } from '@/components/teleprompter/TeleprompterPanel';
import { showToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/utils';

/*
 * Tiny bridge wrapper (2026-06-11) that memoises the `value` object and the
 * `onClose` callback before passing them to <SkillImageLightbox>. Without
 * this, the inline `onClose={() => setLightboxUrl(null)}` is a fresh
 * function every render, which forces the lightbox child to reconcile
 * even when no state changed. Defining as a real component (not inline
 * useMemo) keeps the host component's hook order untouched.
 */
function MemoizedSkillImageLightboxBridge({
  lightboxUrl,
  setLightboxUrl,
}: {
  lightboxUrl: { url: string; name: string } | null;
  setLightboxUrl: React.Dispatch<React.SetStateAction<{ url: string; name: string } | null>>;
}) {
  const value = useMemo(
    () => (lightboxUrl ? { url: lightboxUrl.url, name: lightboxUrl.name } : null),
    [lightboxUrl],
  );
  const onClose = useCallback(() => setLightboxUrl(null), [setLightboxUrl]);
  return <SkillImageLightbox value={value} onClose={onClose} />;
}

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
              <Button
                className="bg-success hover:bg-success-strong text-white rounded-full px-6"
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
        <Button onClick={() => call(1)} disabled={!checked || busy} className="bg-success hover:bg-success-strong text-white">Accept</Button>
        <Button onClick={() => call(2)} disabled={busy} className="bg-urgent hover:bg-urgent-strong text-white">Deny</Button>
        <Button onClick={() => call(0)} disabled={busy} className="bg-urgent hover:bg-urgent-strong text-white">Send Back To Technician</Button>
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
            <Button disabled={saving || d.is_verified} onClick={markVerified} className="bg-success hover:bg-success-strong text-white">
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
            <Button disabled={busy || d.verification_status === 1} onClick={() => setStatus(1)} className="bg-success hover:bg-success-strong text-white">
              Valid Banking Details
            </Button>
            <Button disabled={busy} onClick={() => setStatus(2)} className="bg-urgent hover:bg-urgent-strong text-white">
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
            <Button disabled={savingStatus || d.verification_status === 1} onClick={() => setStatus(1)} className="bg-success hover:bg-success-strong text-white">
              Send To Finance
            </Button>
            <Button disabled={savingStatus} onClick={() => setStatus(2)} className="bg-urgent hover:bg-urgent-strong text-white">
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
              <Button onClick={activate} disabled={activating} className="bg-success hover:bg-success-strong text-white">
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

/* ───────── Deep Skill Option Mapping ───────── */
/*
 * 4-level tree picker (Service Category → Service Type → Deep Skill →
 * Options) for tbl_efr_deepskill_mapping. The mapping table stores ONE
 * row per (easyfixer × option) — see the docblock in
 * services/easyfixer-verification.service.js for the column-name
 * inversion this FE deliberately abstracts away (we work in semantic
 * names only).
 *
 * Loading model:
 *   - On mount: fetch current mappings + ALL service categories.
 *   - On expanding a category: lazy-load that category's service types.
 *   - On expanding a service type: lazy-load that type's deep skills.
 *   - On expanding a deep skill: lazy-load its options.
 *
 * Lazy-loading keeps the initial paint cheap (3 categories x N types x
 * M skills x K options would balloon fast). Children are cached
 * in-state once fetched so collapse/expand toggles never re-fetch.
 *
 * The "currently mapped" indicator is computed from `original` — the
 * set captured on first fetch. The Save button is disabled until
 * `selected` diverges from `original`.
 *
 * RENDER (2026-07 Figma redesign): the tree is presented as a single-page
 * CATEGORY ACCORDION that mirrors the public profile-update SkillsMappingPicker
 * — expanding a category reveals an app-like LEFT service-type rail + RIGHT
 * grid of deep-skill cards, and tapping a card opens an options bottom sheet.
 * The DATA FLOW is unchanged: every level is still lazy-loaded via the same
 * /admin lookups, cached per-key in-state; only the fetch TRIGGERS were
 * re-shaped to the accordion → rail → cards → sheet interactions.
 */

/* ───────── Deep-skill picker theme + icons (Figma redesign) ─────────
 * Standalone red/blue palette copied from the public profile-update flow so
 * the CRM picker matches the Figma mockup 1:1. Category / service-type ICONS
 * ship as static assets in public/deep-skill-icons/{categories,service-types}/
 * named by the slug of the category / service-type name; until an asset lands,
 * DsIconTile falls back to a coloured first-letter tile. Deep-skill THUMBNAILS
 * keep coming from the DB (deep_skill_image_url). */
const DS_RED = 'hsl(var(--urgent))';
const DS_RED_TINT = 'hsl(var(--urgent-tint))';
const DS_BLUE = 'hsl(var(--info))';
const DS_BLUE_TINT = 'hsl(var(--info-tint))';
const DS_GREEN = 'hsl(var(--success))';
const DS_GREEN_TINT = 'hsl(var(--success-tint))';

function dsSlug(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function DsIconTile({
  name, kind, size = 44, className = '',
}: { name: string; kind: 'categories' | 'service-types'; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const slug = dsSlug(name);
  const letter = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  if (failed || !slug) {
    return (
      <div
        style={{ width: size, height: size, backgroundColor: DS_RED_TINT, color: DS_RED }}
        className={`flex items-center justify-center rounded-lg font-semibold shrink-0 ${className}`}
        aria-hidden
      >
        {letter}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/deep-skill-icons/${kind}/${slug}.png`}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`rounded-lg object-contain shrink-0 ${className}`}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

type OptionMapping = {
  category_id: number; category_name: string | null;
  service_type_id: number; service_type_name: string | null;
  deep_skill_id: number; deep_skill_name: string | null;
  deep_skill_image_url: string | null;
  option_id: number; option_name: string | null;
};

type ServiceCategoryLU = { service_catg_id: number; service_catg_name: string };
type ServiceTypeLU     = { service_type_id: number; service_type_name: string; service_catg_id: number };
type DeepSkillLU       = { deepskill_id: number; deepskill_name: string; category_id: number; service_type_id: number; deep_skill_image_url: string | null; option_count?: number };
type DeepSkillOptionLU = { id: number; skill_option: string; status: number };
type DeepSkillDetail   = { deepskill_id: number; deepskill_name: string; options: DeepSkillOptionLU[] };

function mapKey(catg: number, type: number, skill: number, option: number) {
  return `${catg}|${type}|${skill}|${option}`;
}

function DeepSkillOptionMapping({ efrId, onReload }: { efrId: number; onReload?: () => Promise<void> }) {
  const [categories, setCategories] = useState<ServiceCategoryLU[]>([]);
  const [mappings, setMappings] = useState<OptionMapping[]>([]);
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Accordion / rail / sheet UI state (Figma redesign):
  //   - expandedCatg    : exactly one category card is open at a time.
  //   - activeTypeByCatg: which service-type rail item is active per category
  //     (so re-expanding a category restores the last-viewed rail item).
  //   - sheetSkillId    : which deep-skill's options bottom sheet is open.
  const [expandedCatg, setExpandedCatg] = useState<number | null>(null);
  const [activeTypeByCatg, setActiveTypeByCatg] = useState<Record<number, number>>({});
  const [sheetSkillId, setSheetSkillId] = useState<number | null>(null);
  // Lazy-loaded children — keyed by parent id (cached so re-expanding /
  // re-selecting a rail item never re-fetches).
  const [typesByCatg, setTypesByCatg] = useState<Record<number, ServiceTypeLU[]>>({});
  const [skillsByType, setSkillsByType] = useState<Record<number, DeepSkillLU[]>>({});
  const [optionsBySkill, setOptionsBySkill] = useState<Record<number, DeepSkillOptionLU[]>>({});
  // Click-to-enlarge lightbox for the deep-skill thumbnails.
  const [lightboxUrl, setLightboxUrl] = useState<{ url: string; name: string } | null>(null);

  // Initial fetch — current mappings + the full categories list.
  // Two-request Promise.all + transform-into-Set state pattern doesn't
  // map cleanly to `useFetch` (single URL → single payload); the
  // cancelled-flag + module-level dedupe via api here is the correct
  // shape. Targeted disable, not a global carve-out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [mapResp, catResp] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax
          api.get<{ items: OptionMapping[] }>(`/admin/easyfixers/${efrId}/option-mappings`),
          // eslint-disable-next-line no-restricted-syntax
          api.get<ServiceCategoryLU[]>(`/shared/lookup/service-categories`),
        ]);
        if (cancelled) return;
        const items = mapResp?.items ?? [];
        const set = new Set(items.map((m) => mapKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id)));
        setMappings(items);
        setOriginal(new Set(set));
        setSelected(new Set(set));
        setCategories(Array.isArray(catResp) ? catResp : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load option mappings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [efrId]);

  // ── Lazy-fetch primitives (cache-guarded; identical endpoints to before,
  //    only the invocation triggers were re-shaped for the accordion) ──

  // Fetch a category's service-types (rail). display=2 ⇒ only Tx-app /
  // deep-skill service types (BE also filters active-only by default), so
  // CRM-only types like "Amazon" (display=0) never appear in the tree.
  const ensureTypes = useCallback(async (catgId: number): Promise<ServiceTypeLU[]> => {
    if (typesByCatg[catgId]) return typesByCatg[catgId];
    try {
      const types = await api.get<ServiceTypeLU[]>(`/shared/lookup/service-types?categoryId=${catgId}&display=2`);
      const arr = Array.isArray(types) ? types : [];
      setTypesByCatg((s) => ({ ...s, [catgId]: arr }));
      return arr;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load service types');
      return [];
    }
  }, [typesByCatg]);

  // Fetch a (category, service-type)'s deep-skill cards.
  const ensureSkills = useCallback(async (catgId: number, typeId: number): Promise<void> => {
    if (skillsByType[typeId]) return;
    try {
      const skills = await api.get<DeepSkillLU[]>(`/admin/deep-skills?categoryId=${catgId}&serviceTypeId=${typeId}`);
      setSkillsByType((s) => ({ ...s, [typeId]: Array.isArray(skills) ? skills : [] }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load deep skills');
    }
  }, [skillsByType]);

  // Fetch a deep-skill's options (status===1 only) for the bottom sheet.
  const ensureOptions = useCallback(async (skillId: number): Promise<void> => {
    if (optionsBySkill[skillId]) return;
    try {
      const detail = await api.get<DeepSkillDetail>(`/admin/deep-skills/${skillId}`);
      const opts = (detail?.options || []).filter((o) => Number(o.status) === 1);
      setOptionsBySkill((s) => ({ ...s, [skillId]: opts }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load skill options');
    }
  }, [optionsBySkill]);

  // Accordion toggle: expanding a category collapses any other, closes the
  // sheet, then loads its rail (service-types) and the deep-skills for the
  // active/first rail item.
  const expandCategory = useCallback(async (catgId: number) => {
    setSheetSkillId(null);
    if (expandedCatg === catgId) { setExpandedCatg(null); return; }
    setExpandedCatg(catgId);
    const types = await ensureTypes(catgId);
    if (types.length === 0) return;
    const activeId = activeTypeByCatg[catgId] ?? types[0].service_type_id;
    if (activeTypeByCatg[catgId] == null) {
      setActiveTypeByCatg((s) => ({ ...s, [catgId]: activeId }));
    }
    await ensureSkills(catgId, activeId);
  }, [expandedCatg, activeTypeByCatg, ensureTypes, ensureSkills]);

  // Rail item click: make it the active type for its category and load its
  // deep-skills.
  const selectType = useCallback(async (catgId: number, typeId: number) => {
    setSheetSkillId(null);
    setActiveTypeByCatg((s) => ({ ...s, [catgId]: typeId }));
    await ensureSkills(catgId, typeId);
  }, [ensureSkills]);

  // Card click: open its options bottom sheet and ensure its options loaded.
  const openSheet = useCallback(async (skillId: number) => {
    setSheetSkillId(skillId);
    await ensureOptions(skillId);
  }, [ensureOptions]);

  function toggleOption(catgId: number, typeId: number, skillId: number, optionId: number) {
    const key = mapKey(catgId, typeId, skillId, optionId);
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  }

  const dirty = useMemo(() => {
    if (selected.size !== original.size) return true;
    for (const k of selected) if (!original.has(k)) return true;
    return false;
  }, [selected, original]);

  /*
   * Selected-count badges at EVERY level (2026-06-11). The `selected`
   * Set keys are `${catgId}|${typeId}|${skillId}|${optionId}`. We
   * derive three Maps in a single O(n) pass:
   *   - countByCategory          : key = catgId
   *   - countByType              : key = "catgId|typeId"
   *   - countBySkill             : key = "catgId|typeId|skillId"
   * Surfaced as small emerald pills next to each header so operators
   * see option counts cascade up the hierarchy without expanding every
   * branch. Recomputed on every selected change; Set size is tiny
   * (≤ ~150 in practice) so the cost is negligible.
   */
  const { countByCategory, countByType, countBySkill } = useMemo(() => {
    const byCatg = new Map<number, number>();
    const byType = new Map<string, number>();
    const bySkill = new Map<string, number>();
    for (const k of selected) {
      const [c, t, s] = k.split('|');
      const catgId = Number(c);
      byCatg.set(catgId, (byCatg.get(catgId) || 0) + 1);
      byType.set(`${c}|${t}`, (byType.get(`${c}|${t}`) || 0) + 1);
      bySkill.set(`${c}|${t}|${s}`, (bySkill.get(`${c}|${t}|${s}`) || 0) + 1);
    }
    return { countByCategory: byCatg, countByType: byType, countBySkill: bySkill };
  }, [selected]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const items = Array.from(selected).map((k) => {
        const [c, t, s, o] = k.split('|').map(Number);
        return { category_id: c, service_type_id: t, deep_skill_id: s, option_id: o };
      });
      await api.put(`/admin/easyfixers/${efrId}/option-mappings`, { items });
      // Refetch + re-anchor original to the new server state.
      const mapResp = await api.get<{ items: OptionMapping[] }>(`/admin/easyfixers/${efrId}/option-mappings`);
      const fresh = mapResp?.items ?? [];
      const set = new Set(fresh.map((m) => mapKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id)));
      setMappings(fresh);
      setOriginal(new Set(set));
      setSelected(new Set(set));
      // Refresh parent payload so the Additional Details progress bar
      // reflects the new deep-skill count.
      if (onReload) await onReload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save option mappings');
    } finally {
      setSaving(false);
    }
  }

  // ── Derived render helpers for the open accordion card ──
  // The active rail service-type for the currently-expanded category (falls
  // back to the first loaded type), and the deep-skill whose options sheet is
  // open. `sheetCtx` carries the (catg, type) needed to build option keys.
  const expandedTypes = expandedCatg != null ? (typesByCatg[expandedCatg] ?? null) : null;
  const activeTypeId = expandedCatg != null
    ? (activeTypeByCatg[expandedCatg] ?? expandedTypes?.[0]?.service_type_id ?? null)
    : null;
  const activeType = expandedTypes?.find((t) => t.service_type_id === activeTypeId) ?? null;
  const activeSkills = activeTypeId != null ? (skillsByType[activeTypeId] ?? null) : null;
  const sheetCtx = useMemo(() => {
    if (sheetSkillId == null || expandedCatg == null || activeTypeId == null) return null;
    const skill = (activeSkills ?? []).find((s) => s.deepskill_id === sheetSkillId);
    if (!skill) return null;
    return { catgId: expandedCatg, typeId: activeTypeId, skill };
  }, [sheetSkillId, expandedCatg, activeTypeId, activeSkills]);

  return (
    <div className="border-t pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink-700">Deep Skill Option Mapping</h4>
        <span className="text-xs text-ink-500">
          {selected.size} Option{selected.size === 1 ? '' : 's'} Selected
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-ink-500">Loading…</div>
      ) : error ? (
        <div className="text-xs text-urgent">{error}</div>
      ) : categories.length === 0 ? (
        <div className="text-xs text-ink-500">No Service Categories Available.</div>
      ) : (
        <>
          {mappings.length === 0 && selected.size === 0 && (
            <div className="rounded border border-dashed border-ink-100 bg-ink-50 p-3 text-xs text-ink-500">
              No Options Mapped Yet. Tap A Service Category To Begin.
            </div>
          )}

          {/* ── Category accordion (single page): tapping a category expands it
              in place to reveal its service-type rail + deep-skill cards, and
              collapses the others. ── */}
          <div className="space-y-2">
            {categories.map((c) => {
              const count = countByCategory.get(c.service_catg_id) || 0;
              const expanded = expandedCatg === c.service_catg_id;
              return (
                <div key={c.service_catg_id} className="rounded-xl border border-ink-100 bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => expandCategory(c.service_catg_id)}
                    className="w-full flex items-center gap-3 px-3 py-3 text-left"
                  >
                    <DsIconTile name={c.service_catg_name} kind="categories" size={36} />
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold text-ink-900 truncate">{c.service_catg_name}</span>
                      <span className="block text-xs text-ink-500">{count} Skill{count === 1 ? '' : 's'} Added</span>
                    </span>
                    {count > 0 && <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: DS_GREEN }} />}
                    {expanded
                      ? <ChevronUp className="h-5 w-5 text-ink-500 shrink-0" />
                      : <ChevronDown className="h-5 w-5 text-ink-500 shrink-0" />}
                  </button>

                  {expanded && (
                    <div className="border-t border-ink-100 flex max-h-[70vh]">
                      {/* left service-type rail */}
                      <div className="w-[84px] shrink-0 overflow-y-auto border-r border-ink-100 bg-card">
                        {expandedTypes == null ? (
                          <div className="px-1.5 py-3 text-center text-xs text-ink-500">Loading…</div>
                        ) : expandedTypes.length === 0 ? (
                          <div className="px-1.5 py-3 text-center text-xs text-ink-500">No Service Types.</div>
                        ) : expandedTypes.map((t) => {
                          const isActive = activeTypeId === t.service_type_id;
                          const cnt = countByType.get(`${c.service_catg_id}|${t.service_type_id}`) || 0;
                          return (
                            <button
                              key={t.service_type_id}
                              type="button"
                              onClick={() => selectType(c.service_catg_id, t.service_type_id)}
                              className="w-full flex flex-col items-center gap-1 px-1.5 py-3 text-center border-b border-ink-100"
                              style={isActive ? { backgroundColor: DS_BLUE_TINT, borderLeft: `3px solid ${DS_BLUE}` } : undefined}
                            >
                              <span className="relative">
                                <DsIconTile name={t.service_type_name} kind="service-types" size={34} />
                                {cnt > 0 && (
                                  <span
                                    style={{ backgroundColor: DS_BLUE }}
                                    className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-xs font-semibold text-white flex items-center justify-center"
                                  >
                                    {cnt}
                                  </span>
                                )}
                              </span>
                              <span
                                className="text-xs leading-tight"
                                style={isActive ? { color: DS_BLUE, fontWeight: 600 } : { color: 'hsl(var(--ink-700))' }}
                              >
                                {t.service_type_name}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {/* right skill card grid — small images, 2 columns */}
                      <div className="flex-1 min-w-0 overflow-y-auto p-3 bg-ink-50">
                        <div className="text-sm font-semibold text-ink-900 mb-2">{activeType?.service_type_name}</div>
                        {activeSkills == null ? (
                          <div className="text-sm text-ink-500">Loading…</div>
                        ) : activeSkills.length === 0 ? (
                          <div className="text-sm text-ink-500">No Deep Skills.</div>
                        ) : (
                          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                            {activeSkills.map((s) => {
                              const sel = countBySkill.get(`${c.service_catg_id}|${activeTypeId}|${s.deepskill_id}`) || 0;
                              const optCount = optionsBySkill[s.deepskill_id]?.length ?? s.option_count;
                              return (
                                <div key={s.deepskill_id} className="rounded-xl border border-ink-100 bg-card p-2 flex flex-col">
                                  <button
                                    type="button"
                                    onClick={() => { if (s.deep_skill_image_url) setLightboxUrl({ url: s.deep_skill_image_url, name: s.deepskill_name }); }}
                                    className="relative block w-full aspect-square rounded-lg overflow-hidden bg-ink-100 cursor-zoom-in"
                                    title="Click To Enlarge"
                                  >
                                    {s.deep_skill_image_url ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img src={s.deep_skill_image_url} alt={s.deepskill_name} className="w-full h-full object-cover" loading="lazy" />
                                    ) : (
                                      <span className="flex items-center justify-center w-full h-full text-ink-300"><Wrench className="h-7 w-7" /></span>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openSheet(s.deepskill_id)}
                                    className="mt-2 w-full rounded-lg py-1.5 text-xs font-semibold border"
                                    style={sel > 0
                                      ? { backgroundColor: DS_BLUE, borderColor: DS_BLUE, color: 'hsl(var(--card))' }
                                      : { backgroundColor: 'hsl(var(--card))', borderColor: DS_BLUE, color: DS_BLUE }}
                                  >
                                    {sel > 0 ? `${sel} Selected` : 'ADD'}
                                    {optCount != null && (
                                      <span className="block text-xs font-normal opacity-80">
                                        {optCount} Option{optCount === 1 ? '' : 's'}
                                      </span>
                                    )}
                                  </button>
                                  <span className="mt-1.5 text-xs font-medium text-ink-700 text-center line-clamp-2">{s.deepskill_name}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button disabled={saving || !dirty} onClick={save} className="bg-success hover:bg-success-strong text-white">
              {saving ? 'Saving…' : 'Save Option Mappings'}
            </Button>
          </div>

          {/* ── Options bottom sheet ── */}
          {sheetCtx && (
            <div className="fixed inset-0 z-[60] flex flex-col justify-end">
              <button
                type="button"
                aria-label="Close"
                className="absolute inset-0 bg-black/40"
                onClick={() => setSheetSkillId(null)}
              />
              <div className="relative rounded-t-2xl bg-card max-h-[75vh] flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100">
                  <span className="font-semibold text-ink-900">{sheetCtx.skill.deepskill_name}</span>
                  <button
                    type="button"
                    onClick={() => setSheetSkillId(null)}
                    className="rounded-full p-1 bg-ink-100 text-ink-500"
                    aria-label="Close"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="overflow-y-auto divide-y divide-ink-100">
                  {optionsBySkill[sheetCtx.skill.deepskill_id] == null ? (
                    <div className="px-4 py-4 text-sm text-ink-500">Loading…</div>
                  ) : optionsBySkill[sheetCtx.skill.deepskill_id].length === 0 ? (
                    <div className="px-4 py-4 text-sm text-ink-500">No Options.</div>
                  ) : optionsBySkill[sheetCtx.skill.deepskill_id].map((o) => {
                    const key = mapKey(sheetCtx.catgId, sheetCtx.typeId, sheetCtx.skill.deepskill_id, o.id);
                    const isSel = selected.has(key);
                    const isOriginal = original.has(key);
                    return (
                      <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <span className={`text-sm ${isSel ? 'text-ink-500' : 'text-ink-900'}`}>
                          {o.skill_option}
                          {isOriginal && <span className="ml-1.5 text-xs font-medium" style={{ color: DS_GREEN }}>• Saved</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleOption(sheetCtx.catgId, sheetCtx.typeId, sheetCtx.skill.deepskill_id, o.id)}
                          className="inline-flex items-center gap-1 rounded-lg px-4 py-1.5 text-xs font-semibold shrink-0"
                          style={isSel ? { backgroundColor: DS_GREEN_TINT, color: DS_GREEN } : { backgroundColor: DS_BLUE, color: 'hsl(var(--card))' }}
                        >
                          {isSel ? <><Check className="h-3.5 w-3.5" strokeWidth={3} /> Added</> : 'Add'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <MemoizedSkillImageLightboxBridge lightboxUrl={lightboxUrl} setLightboxUrl={setLightboxUrl} />
    </div>
  );
}

/* ───────── Serviceable Pincodes ───────── */
/*
 * Multi-select of pincodes the technician will accept jobs in. Persisted
 * to tbl_efr_serviceable_pincode_map via /admin/easyfixers/:id/
 * serviceable-pincodes (GET + PUT).
 *
 * Load model (2026-06-11 redesign — server-side typeahead):
 *   - While the dropdown is open, the search input (debounced 300ms via
 *     useDebouncedValue) is sent as `q` to
 *     /admin/pincodes?limit=100&includeInactive=false.
 *   - Empty query intentionally fetches the first 100 rows so the
 *     on-focus dropdown still shows results.
 *   - useFetch's module cache dedupes repeat queries; the full ~155k-row
 *     catalog is never downloaded to the browser.
 *
 * Bulk-paste (operator productivity):
 *   - When the search input contains comma/space/newline separators AND
 *     enough digits for 2+ pincodes, an "Add All Matching Pincodes"
 *     button appears next to the search; Enter triggers the same flow.
 *   - Codes are parsed, 6-digit-validated, and resolved via
 *     POST /admin/pincodes/lookup-many. Matched rows merge into the chip
 *     set; unmatched codes surface in a toast.
 *
 * State model mirrors DeepSkillOptionMapping: `original` is the Set
 * captured on first fetch (re-anchored after Save); `selected` is the
 * working set; Save is disabled until divergence.
 */

type PincodeChip = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_name: string | null;
  state_name: string | null;
};

type PincodeSearchRow = PincodeChip;

// Canonical label for both the picker OPTIONS and the selected chips (#8):
// "<pincode> - <location> - <city_name>". Only genuinely-empty parts drop out.
function pincodeLabel(p: { pincode: string; location?: string | null; city_name?: string | null }): string {
  const loc  = (p.location ?? '').trim();
  const city = (p.city_name ?? '').trim();
  return [String(p.pincode), loc || null, city || null].filter(Boolean).join(' - ');
}

function ServiceablePincodes({ efrId, onReload }: { efrId: number; onReload?: () => Promise<void> }) {
  const [selected, setSelected] = useState<Map<number, PincodeChip>>(new Map());
  const [original, setOriginal] = useState<Map<number, PincodeChip>>(new Map());
  const [search, setSearch] = useState('');
  const [bulkLookupBusy, setBulkLookupBusy] = useState(false);
  // Auto-create-on-no-match (#6): which 6-digit term is being ensured right now
  // (drives the in-dropdown "Adding…" copy) + a transient "Added <pincode>" hint
  // shown briefly after a successful silent create. `ensuredCodes` memoises the
  // codes we've already attempted this session so the no-match effect fires at
  // most once per code (prevents a debounce re-render from re-POSTing).
  const [ensuringCode, setEnsuringCode] = useState<string | null>(null);
  const [ensuredHint, setEnsuredHint] = useState<string | null>(null);
  const ensuredCodes = useRef<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initial load — fetch current serviceable pincodes for this efr.
  // The response is reshaped into a Map<pincodeId, chip> that backs
  // BOTH `selected` and `original` (dirty-tracking). useFetch returns
  // a single `data` value; threading two derived Map states through
  // it would just hide a setEffect-on-data dance. Targeted disable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        // eslint-disable-next-line no-restricted-syntax
        const resp = await api.get<{ items: PincodeChip[] }>(
          `/admin/easyfixers/${efrId}/serviceable-pincodes`
        );
        if (cancelled) return;
        const items = resp?.items ?? [];
        const map = new Map<number, PincodeChip>();
        for (const p of items) {
          map.set(Number(p.pincode_id), {
            pincode_id: Number(p.pincode_id),
            pincode: String(p.pincode),
            location: p.location ?? null,
            city_name: p.city_name ?? null,
            state_name: p.state_name ?? null,
          });
        }
        setSelected(new Map(map));
        setOriginal(new Map(map));
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load serviceable pincodes');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [efrId]);

  // Click-outside to close the dropdown.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Bulk-paste detection heuristic:
  //   • input must contain a comma, space, or newline (separator), AND
  //   • digits-only length ≥ 12 (i.e. at least 2 pincodes worth).
  // Threshold 12 keeps incidental whitespace from triggering while a real
  // paste like "110001, 110002" passes.
  const isBulkInput = useMemo(() => {
    if (!/[,\s\n]/.test(search)) return false;
    const digitsOnly = search.replace(/\D/g, '');
    return digitsOnly.length >= 12;
  }, [search]);

  // Server-side typeahead — debounced q search, limit 100. Empty query
  // intentionally fetches the first 100 rows so the on-focus dropdown
  // still shows results. useFetch's module cache dedupes repeat queries.
  // (status param omitted — BE's status enum is LOCAL/TRAVEL, a derived
  // classification, not active/inactive; includeInactive=false filters.)
  const dq = useDebouncedValue(search.trim(), 300);
  const searchKey = open && !isBulkInput
    ? `/admin/pincodes?limit=100&includeInactive=false${dq ? `&q=${encodeURIComponent(dq)}` : ''}`
    : null;
  const { data: searchData, loading: searchLoading } = useFetch<{ items: PincodeSearchRow[] }>(searchKey);
  const filteredResults = isBulkInput ? [] : (searchData?.items ?? []);

  function toggle(row: PincodeSearchRow) {
    const id = Number(row.pincode_id);
    const next = new Map(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.set(id, {
        pincode_id: id,
        pincode: String(row.pincode),
        location: row.location ?? null,
        city_name: row.city_name ?? null,
        state_name: row.state_name ?? null,
      });
    }
    setSelected(next);
  }

  function removeChip(id: number) {
    const next = new Map(selected);
    next.delete(id);
    setSelected(next);
  }

  async function handleBulkAdd() {
    if (bulkLookupBusy) return;
    const codes = search
      .split(/[,\s\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => /^\d{6}$/.test(p));
    if (codes.length === 0) {
      showToast({ variant: 'error', message: 'No Valid Pincodes Found In Input' });
      return;
    }
    setBulkLookupBusy(true);
    setError(null);
    try {
      const resp = await api.post<{ items: PincodeSearchRow[]; notFound: string[] }>(
        `/admin/pincodes/lookup-many`,
        { pincodes: codes }
      );
      const items = Array.isArray(resp?.items) ? resp.items : [];
      const notFound = Array.isArray(resp?.notFound) ? resp.notFound : [];
      const next = new Map(selected);
      for (const it of items) {
        const id = Number(it.pincode_id);
        next.set(id, {
          pincode_id: id,
          pincode: String(it.pincode),
          location: it.location ?? null,
          city_name: it.city_name ?? null,
          state_name: it.state_name ?? null,
        });
      }
      setSelected(next);
      setSearch('');
      if (items.length > 0) {
        showToast({
          variant: 'success',
          message: `Added ${items.length} Pincode${items.length === 1 ? '' : 's'}`,
        });
      }
      if (notFound.length > 0) {
        const preview = notFound.slice(0, 5).join(', ');
        const suffix = notFound.length > 5 ? '…' : '';
        showToast({
          variant: 'error',
          message: `${notFound.length} pincodes not found: ${preview}${suffix}`,
        });
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Bulk lookup failed';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setBulkLookupBusy(false);
    }
  }

  // #6 — Auto-create a missing pincode on no-match. Silently POSTs
  // /admin/pincodes/ensure { pincode }; the BE is idempotent (returns the
  // existing row if it already exists) and geocodes + find-or-creates the city/
  // state for a brand-new Indian pincode. On success the returned row is merged
  // into `selected` (same shape as toggle()) and a brief "Added <pincode>" hint
  // is shown. A 400 (non-Indian / ungeocodable) surfaces inline via `error`.
  const ensureAndAdd = useCallback(async (code: string) => {
    const pin = String(code).trim();
    if (!/^\d{6}$/.test(pin)) return;
    // Fire at most once per code per session.
    if (ensuredCodes.current.has(pin)) return;
    ensuredCodes.current.add(pin);
    setEnsuringCode(pin);
    setError(null);
    try {
      const resp = await api.post<{
        pincode_id: number; pincode: string; location?: string | null;
        city_name: string | null; state_name: string | null; created: boolean;
      }>(`/admin/pincodes/ensure`, { pincode: pin });
      if (!resp?.pincode_id) return;
      const id = Number(resp.pincode_id);
      setSelected((prev) => {
        const next = new Map(prev);
        next.set(id, {
          pincode_id: id,
          pincode: String(resp.pincode),
          location: resp.location ?? null,
          city_name: resp.city_name ?? null,
          state_name: resp.state_name ?? null,
        });
        return next;
      });
      setSearch('');
      setOpen(false);
      setEnsuredHint(`Added ${resp.pincode}`);
    } catch (e) {
      // Allow a retry on transient failure: drop the memo so the operator can
      // re-trigger by re-typing the same code.
      ensuredCodes.current.delete(pin);
      setError(e instanceof ApiError ? e.message : `Could not add pincode ${pin}`);
    } finally {
      setEnsuringCode(null);
    }
  }, []);

  // No-match watcher: once the debounced query is a complete 6-digit pincode and
  // the (settled) typeahead returned zero rows, silently ensure it. Guards:
  // dropdown open, not a bulk paste, search has finished loading, and no result.
  useEffect(() => {
    if (!open || isBulkInput || searchLoading) return;
    if (!/^\d{6}$/.test(dq)) return;
    if (filteredResults.length > 0) return;
    void ensureAndAdd(dq);
  }, [open, isBulkInput, searchLoading, dq, filteredResults.length, ensureAndAdd]);

  // Auto-dismiss the "Added <pincode>" hint after a short beat.
  useEffect(() => {
    if (!ensuredHint) return;
    const t = setTimeout(() => setEnsuredHint(null), 3000);
    return () => clearTimeout(t);
  }, [ensuredHint]);

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && isBulkInput) {
      e.preventDefault();
      void handleBulkAdd();
    }
  }

  const dirty = useMemo(() => {
    if (selected.size !== original.size) return true;
    for (const k of selected.keys()) if (!original.has(k)) return true;
    return false;
  }, [selected, original]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const pincodeIds = Array.from(selected.keys());
      await api.put(`/admin/easyfixers/${efrId}/serviceable-pincodes`, { pincodeIds });
      // Re-fetch + re-anchor original to the new server state.
      const resp = await api.get<{ items: PincodeChip[] }>(
        `/admin/easyfixers/${efrId}/serviceable-pincodes`
      );
      const items = resp?.items ?? [];
      const map = new Map<number, PincodeChip>();
      for (const p of items) {
        map.set(Number(p.pincode_id), {
          pincode_id: Number(p.pincode_id),
          pincode: String(p.pincode),
          location: p.location ?? null,
          city_name: p.city_name ?? null,
          state_name: p.state_name ?? null,
        });
      }
      setSelected(new Map(map));
      setOriginal(new Map(map));
      showToast({ variant: 'success', message: 'Serviceable Pincodes Updated' });
      // Refresh parent payload so the Additional Details progress bar
      // reflects the new pincode count.
      if (onReload) await onReload();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to save serviceable pincodes';
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  const chips = useMemo(
    () => Array.from(selected.values()).sort((a, b) => a.pincode.localeCompare(b.pincode)),
    [selected]
  );

  return (
    <div className="border-t pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-ink-700">Serviceable Pincodes</h4>
          <p className="text-xs text-ink-500">
            Pincodes Where This Technician Will Accept Jobs. Type To Search, Or Paste A Comma/Space Separated List To Bulk-Add.
          </p>
        </div>
        <span className="text-xs text-ink-500">
          {selected.size} Pincode{selected.size === 1 ? '' : 's'} Selected
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-ink-500">Loading…</div>
      ) : (
        <>
          <div ref={containerRef} className="relative">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500 pointer-events-none" />
                <Input
                  value={search}
                  placeholder="Search By Pincode, Location Or City, Or Paste A List…"
                  onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
                  onFocus={() => setOpen(true)}
                  onKeyDown={onSearchKeyDown}
                  className="pl-8"
                />
              </div>
              {isBulkInput && (
                <Button
                  type="button"
                  onClick={() => void handleBulkAdd()}
                  disabled={bulkLookupBusy}
                  className="bg-success hover:bg-success-strong text-white whitespace-nowrap"
                >
                  {bulkLookupBusy ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…
                    </span>
                  ) : (
                    'Add All Matching Pincodes'
                  )}
                </Button>
              )}
            </div>
            {open && !isBulkInput && (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-ink-100 bg-popover shadow-lg max-h-72 overflow-auto">
                {searchLoading && filteredResults.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-ink-500 inline-flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading Pincodes…
                  </div>
                ) : filteredResults.length === 0 ? (
                  ensuringCode && /^\d{6}$/.test(dq) ? (
                    <div className="px-3 py-3 text-xs text-ink-500 inline-flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding Pincode {ensuringCode}…
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-xs text-ink-500">No Pincodes Match.</div>
                  )
                ) : (
                  <>
                    {filteredResults.map((r) => {
                      const id = Number(r.pincode_id);
                      const isSelected = selected.has(id);
                      return (
                        <button
                          type="button"
                          key={id}
                          onClick={() => toggle(r)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-ink-50"
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              readOnly
                              checked={isSelected}
                              className="h-4 w-4 accent-success pointer-events-none"
                            />
                            <span className="font-medium text-ink-900">{pincodeLabel(r)}</span>
                          </span>
                          {isSelected && <Check className="h-4 w-4 text-success shrink-0" />}
                        </button>
                      );
                    })}
                    {filteredResults.length >= 100 && (
                      <div className="px-3 py-1.5 text-xs text-ink-500 border-t bg-ink-50/60">
                        Showing First 100 Matches — Refine Your Search Or Paste A List To Bulk-Add.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {isBulkInput && (
              <div className="mt-1 text-xs text-ink-500">
                Press Enter Or Click The Button To Resolve And Add All Pincodes.
              </div>
            )}
          </div>

          {/* Selected chips */}
          {chips.length === 0 ? (
            <div className="rounded border border-dashed border-ink-100 bg-ink-50 p-3 text-xs text-ink-500">
              No Serviceable Pincodes Selected Yet — Type Above To Search Or Paste A List To Bulk-Add.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <span
                  key={c.pincode_id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-info-tint border border-info/30 text-info-strong pl-3 pr-1.5 py-0.5 text-xs"
                  title={[c.city_name, c.state_name].filter(Boolean).join(', ') || undefined}
                >
                  <span className="font-medium">{pincodeLabel(c)}</span>
                  <button
                    type="button"
                    onClick={() => removeChip(c.pincode_id)}
                    className="rounded-full p-0.5 hover:bg-info/20"
                    aria-label={`Remove ${c.pincode}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {ensuredHint && (
            <div className="text-xs text-success inline-flex items-center gap-1">
              <Check className="h-3.5 w-3.5" /> {ensuredHint}
            </div>
          )}
          {error && <div className="text-xs text-urgent">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <Button disabled={saving || !dirty} onClick={save} className="bg-success hover:bg-success-strong text-white">
              {saving ? 'Saving…' : 'Save Serviceable Pincodes'}
            </Button>
          </div>
        </>
      )}
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
