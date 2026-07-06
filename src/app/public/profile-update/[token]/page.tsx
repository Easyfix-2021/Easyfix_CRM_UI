'use client';

/*
 * Public Profile Update form for the EasyFixer Magic-Link flow.
 *
 * Flow: the CRM operator triggers a WhatsApp message containing a one-time
 * link of the form `https://crm.easyfix.in/profile-update/<jwt>`. The
 * technician opens it on their phone browser; the page hydrates from
 * `GET /api/public/easyfixer-profile-update/prefill?token=<jwt>` and lets
 * them save each of the 3 sub-sections independently via
 * `PUT /api/public/easyfixer-profile-update/save?token=<jwt>`.
 *
 * Auth model: the magic-link JWT is the ENTIRE credential — there is no
 * Authorization header, no localStorage token. We use a bare `publicFetch`
 * helper rather than `@/lib/api` because the latter auto-attaches the staff
 * CRM bearer if one happens to be in localStorage on the technician's
 * device (which would confuse the BE's public route guard).
 *
 * Error envelope: BE returns `{ success: false, error, code? }`. The two
 * states we surface as dedicated full-page errors are:
 *   - 401 — invalid / expired token
 *   - 404 — profile not found
 * Anything else → inline retry on the section.
 *
 * Section model (mobile-first): the form is a vertical stack of 3
 * collapsible Cards (Basic Details, Skills Mapping, Service Area). Each
 * has its own Save button that PUTs only its sub-payload, so the technician
 * can complete the form section-by-section over a few minutes without
 * losing earlier work. After a successful save the section gets a green ✓
 * badge in its header and the local "anchor" snaps to the new server state.
 *
 * Catalog strategy:
 *   - Skills tree (~100–500 nodes) is BUNDLED in the prefill as
 *     `deep_skill_catalog`. If absent we degrade gracefully to a read-only
 *     chip view of the current mappings with a "contact your CRM" hint.
 *   - Pincode catalog (~155k rows) is too large to bundle; the form pulls
 *     suggestions via a debounced `GET /public/easyfixer-profile-update/
 *     pincodes?token=…&q=…` search-as-you-type call. Always editable.
 *
 * The /api/admin/* lookups used by the CRM verification page are NOT
 * callable from the public flow (they require an operator bearer), which
 * is why this surface has its own dedicated /pincodes endpoint.
 */

import { useParams } from 'next/navigation';
import Image from 'next/image';
import * as React from 'react';
import {
  ChevronDown,
  ChevronUp,
  Check,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
  MapPin,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { SkillImageLightbox } from '@/components/easyfixer/SkillImageLightbox';
import { AnimatedLoadingBar } from '@/components/ui/animated-loading-bar';

/*
 * Tiny bridge wrapper (2026-06-11) that memoises the `value` object and the
 * `onClose` callback before passing them to <SkillImageLightbox>. Without
 * this, the inline `onClose={() => setLightboxUrl(null)}` is a fresh
 * function every render, which forces the lightbox child to reconcile
 * even when no state changed. Defining as a real component (not inline
 * useMemo) keeps the host component's hook order untouched.
 */
function MemoizedSkillImageLightboxBridgePublic({
  lightboxUrl,
  setLightboxUrl,
}: {
  lightboxUrl: { url: string; name: string } | null;
  setLightboxUrl: React.Dispatch<React.SetStateAction<{ url: string; name: string } | null>>;
}) {
  const value = React.useMemo(
    () => (lightboxUrl ? { url: lightboxUrl.url, name: lightboxUrl.name } : null),
    [lightboxUrl],
  );
  const onClose = React.useCallback(() => setLightboxUrl(null), [setLightboxUrl]);
  return <SkillImageLightbox value={value} onClose={onClose} />;
}
import { showToast, ToastHost } from '@/components/ui/toast';
import { useDebouncedValue } from '@/lib/hooks';

/* ───────── OTP Gate ───────── */
/*
 * Renders an inline "Verify Via WhatsApp OTP" step that sits between the
 * user clicking the single "Save Profile" button and the actual PUT /save call.
 *
 * Flow:
 *   1. User clicks Save Profile → parent (ReadyForm) calls setOtpGateOpen(true).
 *   2. OtpGate shows a "Send OTP" button.
 *   3. User taps Send OTP → POST /send-otp fired; Gallabox delivers the
 *      code to the easyfixer's WhatsApp.
 *   4. User types the 4-digit code → clicks "Verify & Save".
 *   5. Parent's onVerified(otp) is called with the entered code; the parent
 *      includes it in the PUT /save body.
 *   6. If the BE returns 400 (invalid OTP), the error is surfaced here so
 *      the user can retry without losing their form edits.
 *
 * onVerified receives the raw OTP string — the parent converts to Number
 * before including it in the body.
 * onCancel closes the gate and returns the user to the form (no data lost).
 */
function OtpGate({
  token,
  open,
  sending,          // parent sets true while it is executing the save after OTP
  onVerified,
  onCancel,
  saveError,
}: {
  token: string;
  open: boolean;
  sending: boolean;
  onVerified: (otp: string) => void;
  onCancel: () => void;
  saveError: string | null;
}) {
  const [otpSending, setOtpSending] = React.useState(false);
  const [otpSent, setOtpSent] = React.useState(false);
  const [otpValue, setOtpValue] = React.useState('');
  const [otpError, setOtpError] = React.useState<string | null>(null);

  // Reset when gate is re-opened (e.g. after a failed save).
  React.useEffect(() => {
    if (!open) {
      setOtpSent(false);
      setOtpValue('');
      setOtpError(null);
      setOtpSending(false);
    }
  }, [open]);

  if (!open) return null;

  async function handleSendOtp() {
    setOtpSending(true);
    setOtpError(null);
    try {
      await publicFetch<{ sent: boolean }>(
        `/public/easyfixer-profile-update/send-otp?token=${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
      setOtpSent(true);
    } catch (e) {
      const err = e as { message?: string };
      setOtpError(err?.message || 'Failed to send OTP. Please try again.');
    } finally {
      setOtpSending(false);
    }
  }

  function handleVerify() {
    if (otpValue.length !== 4) {
      setOtpError('Please enter the 4-digit OTP you received on WhatsApp.');
      return;
    }
    setOtpError(null);
    onVerified(otpValue);
  }

  return (
    <div className="rounded-md border border-sky-200 bg-sky-50 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="h-5 w-5 text-sky-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-sky-900">Verify Via WhatsApp OTP</p>
          <p className="text-xs text-sky-700 mt-0.5">
            We'll send a 4-digit code to your registered WhatsApp number to confirm this change.
          </p>
        </div>
      </div>

      {!otpSent ? (
        <Button
          onClick={handleSendOtp}
          disabled={otpSending}
          className="w-full sm:w-auto h-10 bg-sky-600 hover:bg-sky-700 text-white"
        >
          {otpSending ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending OTP…</>
          ) : (
            'Send OTP On WhatsApp'
          )}
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-sky-700">
            OTP sent! Enter the 4-digit code you received on WhatsApp.
          </p>
          <div className="flex gap-2 items-center">
            <Input
              id="otp-input"
              value={otpValue}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                setOtpValue(v);
                setOtpError(null);
              }}
              placeholder="Enter OTP"
              inputMode="numeric"
              maxLength={4}
              className="h-11 sm:h-9 w-36 text-center tracking-widest font-mono text-lg"
              autoFocus
            />
            <Button
              onClick={handleVerify}
              disabled={sending || otpValue.length !== 4}
              className="h-11 sm:h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {sending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving…</>
              ) : (
                'Verify & Save'
              )}
            </Button>
          </div>
          <button
            type="button"
            onClick={handleSendOtp}
            disabled={otpSending}
            className="text-xs text-sky-600 underline underline-offset-2 hover:text-sky-800 disabled:opacity-50"
          >
            Resend OTP
          </button>
        </div>
      )}

      {/* Errors: either OTP gate errors or the parent's save error */}
      {(otpError || saveError) ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {otpError || saveError}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700"
      >
        Cancel
      </button>
    </div>
  );
}

/* ───────── Types (mirror the BE contract) ───────── */

type HeaderBlock = {
  /*
   * Field names match what the BE actually returns from
   * services/easyfixer-profile-update-link.service.js::fetchPrefill —
   * `efr_id` (not `easyfixer_id`) and `efr_no` (not `mobile_number`).
   * The earlier `easyfixer_id` / `mobile_number` names were aspirational
   * and produced `undefined` at runtime (2026-06-11 fix).
   */
  efr_id: number;
  full_name: string;
  efr_no?: string | null;
  // View-only context fields rendered in the header strip above the
  // editable sections so the technician can confirm they opened the
  // right link. Any field may be null/empty — the strip hides it
  // gracefully.
  joining_date?: string | null;
  // 2026-06-11: was `service_category` (string). The BE now returns a
  // resolved array of category names so the strip can render inline
  // when length === 1, as a bullet list when length > 1, and hide the
  // row when length === 0. CSV-of-IDs / CSV-of-names from the legacy
  // column is normalised in the BE's `resolveServiceCategories`.
  service_categories?: string[];
  current_city?: string | null;
  // 2026-06-11: technician's registered pincode (`tbl_easyfixer.efr_pin_no`)
  // — rendered inline with `current_city` as "<city> (Pincode: <pin>)".
  pincode?: string | null;
  profile_image_url?: string | null;
};

type BasicBlock = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  alternate_mobile: string | null;
  date_of_birth: string | null;
  marital_status: string | null;
  number_of_children: number | null;
  hobbies: string | null;
  gender: string | null;
};

type DeepSkillMapping = {
  category_id: number; category_name: string | null;
  service_type_id: number; service_type_name: string | null;
  deep_skill_id: number; deep_skill_name: string | null;
  option_id: number; option_name: string | null;
};

type PincodeMapping = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_name: string | null;
  state_name: string | null;
};

/* Catalog payloads.
 *   - deep_skill_catalog: SHIPPED INLINE in the prefill (full active 4-level
 *     tree, ~100–500 nodes). When present the Skills section renders an
 *     editable tree; when absent we fall back to a read-only chip view.
 *   - Pincode catalog: NOT bundled — too large (~155k rows). Fetched lazily
 *     from `GET /public/easyfixer-profile-update/pincodes?token=…&q=…` as
 *     the user types in the Service Area search box. */
type CatalogSkillOption = { option_id: number; option_name: string };
type CatalogDeepSkill = {
  deep_skill_id: number;
  deep_skill_name: string;
  deep_skill_image_url: string | null;
  options: CatalogSkillOption[];
};
type CatalogServiceType = {
  service_type_id: number;
  service_type_name: string;
  deep_skills: CatalogDeepSkill[];
};
type CatalogCategory = {
  category_id: number;
  category_name: string;
  service_types: CatalogServiceType[];
};

type CatalogPincode = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_name: string | null;
  state_name: string | null;
};

type PrefillResponse = {
  header: HeaderBlock;
  basic: BasicBlock;
  deep_skill_mappings: DeepSkillMapping[];
  serviceable_pincodes: PincodeMapping[];
  deep_skill_catalog?: CatalogCategory[];
  /** BE-gated: whether the form must collect a WhatsApp OTP before saving.
   *  Mirrors property `profile_update.otp.enabled`; absent → treat as true. */
  otp_required?: boolean;
};

type DeepSkillItem = {
  category_id: number;
  service_type_id: number;
  deep_skill_id: number;
  option_id: number;
};

/* ───────── Public fetch helper ───────── */
/*
 * Mirrors the success envelope of `@/lib/api` (`{ success, data }`) but:
 *   - never sends credentials/cookies (`credentials: 'omit'`)
 *   - never attaches an Authorization header
 *   - throws a typed object `{status, code, message}` so the page can
 *     dispatch on HTTP status (401 / 404) without an ApiError class check.
 */
/*
 * Module-scope pincode-search cache (2026-06-11). Keyed by the trimmed
 * query string; survives section expand/collapse but evaporates on a
 * full page reload (which is the right TTL for a magic-link session).
 * The empty-query key holds the most-recent 50 pincodes — the case the
 * user reported as wasteful re-fetching on every Service Area expand.
 */
/*
 * Pincode-search cache + in-flight dedup (2026-06-11 v2).
 *
 * 5-minute TTL via per-entry `expiresAt` timestamps — long enough to
 * absorb every section expand/collapse during a typical magic-link
 * session but short enough that fresh CRM pincode additions show up
 * within a few minutes of typing.
 *
 * Separate `pincodeSearchInflight` Map dedupes concurrent same-query
 * fetches: if two debounced typings land in the same query slot while
 * a request is still in flight, both await the same Promise instead
 * of firing two requests. Cleared on resolve/reject so the next fetch
 * goes live.
 */
const PINCODE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
type PincodeCacheEntry = { items: CatalogPincode[]; expiresAt: number };
const pincodeSearchCache = new Map<string, PincodeCacheEntry>();
const pincodeSearchInflight = new Map<string, Promise<CatalogPincode[]>>();

async function publicFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
  const res = await fetch(`${apiBase}${url}`, { ...init, credentials: 'omit' });
  let body: { success?: boolean; data?: T; error?: string; code?: string } = {};
  try { body = await res.json(); } catch { /* defensive — server may return empty */ }
  if (!res.ok || body?.success === false) {
    // eslint-disable-next-line no-throw-literal
    throw { status: res.status, code: body?.code, message: body?.error || 'Request failed' };
  }
  return body.data as T;
}

/* ───────── Page state ───────── */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PrefillResponse }
  | { kind: 'done' }
  | { kind: 'expired' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/* ───────── Section shell ───────── */
/*
 * Lightweight collapsible card. Default-open state is driven from the
 * page so we can open Basic first and keep Skills/Service Area collapsed.
 * The header carries a green ✓ pill once that section's `saved` flag has
 * flipped true at least once.
 */
function SectionShell({
  title,
  subtitle,
  icon,
  open,
  onToggle,
  saved,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  saved: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-4 sm:px-5 text-left bg-white hover:bg-slate-50 transition-colors"
        aria-expanded={open}
      >
        <span className="shrink-0 rounded-md bg-sky-50 text-sky-600 p-2">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-base font-semibold text-slate-900 truncate">{title}</span>
          {subtitle ? (
            <span className="block text-xs text-slate-500 truncate">{subtitle}</span>
          ) : null}
        </span>
        {saved ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium px-2 py-0.5">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        ) : null}
        {open ? (
          <ChevronUp className="h-5 w-5 text-slate-500" />
        ) : (
          <ChevronDown className="h-5 w-5 text-slate-500" />
        )}
      </button>
      {open ? (
        <CardContent className="border-t border-slate-100 bg-slate-50/40 pt-4">{children}</CardContent>
      ) : null}
    </Card>
  );
}

/* ───────── Page ───────── */

export default function ProfileUpdatePage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token || '');
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await publicFetch<PrefillResponse>(
          `/public/easyfixer-profile-update/prefill?token=${encodeURIComponent(token)}`
        );
        if (!cancelled) setState({ kind: 'ready', data });
      } catch (e) {
        if (cancelled) return;
        const err = e as { status?: number; message?: string };
        if (err?.status === 401) setState({ kind: 'expired' });
        else if (err?.status === 404) setState({ kind: 'not_found' });
        else setState({ kind: 'error', message: err?.message || 'Unable to load your profile.' });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  /* ───── Full-page error states ───── */

  if (state.kind === 'loading') {
    return (
      <>
        <ToastHost />
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="flex items-center gap-2 text-slate-600">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading Your Profile…</span>
          </div>
        </div>
      </>
    );
  }

  if (state.kind === 'expired') {
    return <FullPageError title="This Link Has Expired" message="Please contact your CRM to request a new one." />;
  }
  if (state.kind === 'not_found') {
    return <FullPageError title="Profile Not Found" message="We couldn't find your profile. Please contact your CRM." />;
  }
  if (state.kind === 'error') {
    return (
      <FullPageError
        title="Something Went Wrong"
        message={state.message}
        retry={() => {
          setState({ kind: 'loading' });
          // Force re-run of the effect by toggling a noop dep — simplest is
          // to re-fetch inline here.
          void (async () => {
            try {
              const data = await publicFetch<PrefillResponse>(
                `/public/easyfixer-profile-update/prefill?token=${encodeURIComponent(token)}`
              );
              setState({ kind: 'ready', data });
            } catch (e) {
              const err = e as { status?: number; message?: string };
              if (err?.status === 401) setState({ kind: 'expired' });
              else if (err?.status === 404) setState({ kind: 'not_found' });
              else setState({ kind: 'error', message: err?.message || 'Unable to load your profile.' });
            }
          })();
        }}
      />
    );
  }

  if (state.kind === 'done') {
    return <FullPageSuccess />;
  }

  /* ───── Ready ───── */

  const { data } = state;

  // OTP requirement is BE-gated (property profile_update.otp.enabled), delivered
  // in the prefill. Absent → assume required (safe default for a stale BE).
  const otpRequired = data.otp_required ?? true;

  // On a successful save the profile is complete — swap the WHOLE page to a
  // dedicated Thank-You screen (the form unmounts) instead of leaving the
  // technician on the form with just a transient toast.
  const onDone = () => setState({ kind: 'done' });

  // The Ready branch lives in a dedicated component so its lifted form
  // hooks (selSkills / selPincodes / saving / …) are never called
  // conditionally after the early-return error states above — that would
  // violate the rules of hooks.
  return (
    <ReadyForm token={token} data={data} otpRequired={otpRequired} onDone={onDone} />
  );
}

/* ───────── Ready form (single combined submit) ───────── */
/*
 * Holds the lifted selection state for BOTH editable sections (Skills
 * Mapping + Service Area). The two pickers are CONTROLLED — they render
 * the tree / search UI and report toggles back up; they no longer save.
 * A single page-level "Save Profile" button (with one OTP gate) PUTs both
 * arrays in one request. Both sections are mandatory, so the button is
 * disabled until both are non-empty AND something changed.
 */
function ReadyForm({
  token,
  data,
  otpRequired,
  onDone,
}: {
  token: string;
  data: PrefillResponse;
  otpRequired: boolean;
  onDone: () => void;
}) {
  // Open/closed state for the 2 editable sections. Both start collapsed so
  // the first viewport on a phone fits the read-only header strip without
  // scrolling past empty Card chrome.
  const [openSection, setOpenSection] = React.useState<{ skills: boolean; pincodes: boolean }>({
    skills: false,
    pincodes: false,
  });
  const toggleSection = (key: 'skills' | 'pincodes') =>
    setOpenSection((s) => ({ ...s, [key]: !s[key] }));

  // ── Lifted selection state ──
  // Skills: a set of `c|t|s|o` keys (see skillKey). Pincodes: a Map keyed
  // by pincode_id → the full mapping row (so chips can render city/state).
  // Both lazy-init from `data` so the very first render is correct.
  const [selSkills, setSelSkills] = React.useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const m of data.deep_skill_mappings) s.add(skillKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id));
    return s;
  });
  const [selPincodes, setSelPincodes] = React.useState<Map<number, PincodeMapping>>(() => {
    const m = new Map<number, PincodeMapping>();
    const list: PincodeMapping[] = Array.isArray(data.serviceable_pincodes)
      ? data.serviceable_pincodes
      : ((data.serviceable_pincodes as unknown as { items?: PincodeMapping[] } | null | undefined)?.items ?? []);
    for (const p of list) m.set(Number(p.pincode_id), p);
    return m;
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [otpGateOpen, setOtpGateOpen] = React.useState(false);

  // Re-init both selections whenever `data` changes (e.g. after a save
  // replaces the prefill via onSaved) so the selections snap back to the
  // saved server state, and clear any transient save / gate flags.
  React.useEffect(() => {
    const s = new Set<string>();
    for (const m of data.deep_skill_mappings) s.add(skillKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id));
    setSelSkills(s);
    const map = new Map<number, PincodeMapping>();
    const list: PincodeMapping[] = Array.isArray(data.serviceable_pincodes)
      ? data.serviceable_pincodes
      : ((data.serviceable_pincodes as unknown as { items?: PincodeMapping[] } | null | undefined)?.items ?? []);
    for (const p of list) map.set(Number(p.pincode_id), p);
    setSelPincodes(map);
    setSaved(false);
    setError(null);
    setOtpGateOpen(false);
  }, [data]);

  // Baselines derived from the current server prefill.
  const originalSkills = React.useMemo(() => {
    const s = new Set<string>();
    for (const m of data.deep_skill_mappings) s.add(skillKey(m.category_id, m.service_type_id, m.deep_skill_id, m.option_id));
    return s;
  }, [data.deep_skill_mappings]);
  const originalPincodeIds = React.useMemo(() => {
    const s = new Set<number>();
    for (const p of data.serviceable_pincodes) s.add(Number(p.pincode_id));
    return s;
  }, [data.serviceable_pincodes]);

  const dirty = React.useMemo(() => {
    if (selSkills.size !== originalSkills.size) return true;
    for (const k of selSkills) if (!originalSkills.has(k)) return true;
    if (selPincodes.size !== originalPincodeIds.size) return true;
    for (const id of selPincodes.keys()) if (!originalPincodeIds.has(id)) return true;
    return false;
  }, [selSkills, originalSkills, selPincodes, originalPincodeIds]);

  // A technician must serve at least MIN_PINCODES areas — the BE enforces the
  // same floor in acceptSubmission (keep the two in lock-step).
  const MIN_PINCODES = 3;
  const enoughPincodes = selPincodes.size >= MIN_PINCODES;
  const bothFilled = selSkills.size > 0 && enoughPincodes;
  const canSave = dirty && bothFilled;

  // ── Selection handlers (passed down to the controlled pickers) ──
  const toggleSkill = React.useCallback((c: number, t: number, s: number, o: number) => {
    const key = skillKey(c, t, s, o);
    setSelSkills((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const togglePincode = React.useCallback((row: CatalogPincode) => {
    const id = Number(row.pincode_id);
    setSelPincodes((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, {
        pincode_id: id,
        pincode: String(row.pincode),
        location: row.location ?? null,
        city_name: row.city_name ?? null,
        state_name: row.state_name ?? null,
      });
      return next;
    });
  }, []);

  const removePincode = React.useCallback((id: number) => {
    setSelPincodes((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const addEnsuredPincode = React.useCallback((row: CatalogPincode) => {
    const id = Number(row.pincode_id);
    setSelPincodes((prev) => {
      const next = new Map(prev);
      next.set(id, {
        pincode_id: id,
        pincode: String(row.pincode),
        location: row.location ?? null,
        city_name: row.city_name ?? null,
        state_name: row.state_name ?? null,
      });
      return next;
    });
  }, []);

  // ── Single combined save: PUT both arrays in one request ──
  async function save(otp?: string) {
    setSaving(true);
    setError(null);
    try {
      const deep_skill_items: DeepSkillItem[] = Array.from(selSkills).map((k) => {
        const [c, t, s, o] = k.split('|').map(Number);
        return { category_id: c, service_type_id: t, deep_skill_id: s, option_id: o };
      });
      const serviceable_pincode_ids = Array.from(selPincodes.keys());
      const body: {
        deep_skill_items: DeepSkillItem[];
        serviceable_pincode_ids: number[];
        otp?: number;
      } = { deep_skill_items, serviceable_pincode_ids };
      if (otp != null) body.otp = Number(otp);
      await publicFetch<PrefillResponse>(
        `/public/easyfixer-profile-update/save?token=${encodeURIComponent(token)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      setSaved(true);
      setOtpGateOpen(false);
      // Whole-page redirect to the Thank-You screen (replaces the old
      // "Profile Saved" toast, which read as a dead-end).
      onDone();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      const msg = err?.message || 'Failed to save profile';
      setError(msg);
      // Keep gate open on OTP error so the user can retry.
      if (err?.status !== 400) setOtpGateOpen(false);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  // Both sections are MANDATORY to complete the profile. Surface a
  // persistent completion banner until BOTH have at least one entry on
  // the server.
  const skillsDone = data.deep_skill_mappings.length > 0;
  const pincodesDone = data.serviceable_pincodes.length > 0;

  return (
    <div className="mx-auto max-w-2xl lg:max-w-3xl py-4 sm:py-6">
      {/* ToastHost lives at the page root (the public layout doesn't mount
       *  one — the authed layout does, but this route is outside that
       *  group). Without this, showToast() fires events with no listener
       *  and the save feedback never renders. */}
      <ToastHost />
      {/* Header band — keeps the logo + the technician's name visible while
       *  they scroll. No sidebar / no navbar — the layout's bg-slate-50
       *  wraps everything. */}
      <header className="mb-4 sm:mb-6 flex items-center gap-3 px-1">
        <Image
          src="/logo-icon.png"
          alt="EasyFix"
          width={40}
          height={40}
          className="rounded-md shrink-0"
          priority
        />
        <div className="min-w-0">
          {/*
            * Name + mobile removed from this top band (2026-06-11) —
            * those fields are already surfaced by the `<ProfileHeaderStrip>`
            * below (name + ID on the title line, mobile inline next to ID).
            * Showing them in both places was duplicate noise; keeping only
            * the page-level "Update Your Profile" title here gives the
            * strip room to be the canonical personal-info surface.
            */}
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">Update Your Profile</h1>
        </div>
      </header>

      {/* View-only context strip — confirms which technician this link
       *  belongs to before they edit anything. Sits above the editable
       *  sections; gracefully hides individual fields the BE left null. */}
      <ProfileHeaderStrip header={data.header} />

      {/* Completion banner — both Skills Mapping AND Service Area are required.
          Stays until both have at least one entry saved on the server. */}
      {(!skillsDone || !pincodesDone) ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              Both sections are required to complete your profile.
            </p>
            <ul className="mt-1.5 space-y-1 text-xs text-amber-800">
              <li className="flex items-center gap-1.5">
                {skillsDone
                  ? <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                  : <X className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
                <span>Skills Mapping — {skillsDone ? 'done' : 'still pending'}</span>
              </li>
              <li className="flex items-center gap-1.5">
                {pincodesDone
                  ? <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                  : <X className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
                <span>Service Area — {pincodesDone ? 'done' : 'still pending'}</span>
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      <div className="space-y-3 sm:space-y-4">
        {/*
         * Basic Details section removed (2026-06-11). The form is now
         * focused on Skills Mapping + Service Area only — the read-only
         * `<ProfileHeaderStrip>` above surfaces the basic identifying
         * fields (name, ID, category, location, joined date) for context.
         * Editable basic fields (DOB, marital status, hobbies, etc.) are
         * handled by the CRM verification page; the technician's self-
         * serve scope is now strictly skills + service area.
         */}
        <SectionShell
          title="Skills Mapping"
          subtitle={`${data.deep_skill_mappings.length} option${data.deep_skill_mappings.length === 1 ? '' : 's'} currently mapped`}
          icon={<Wrench className="h-5 w-5" />}
          open={openSection.skills}
          onToggle={() => toggleSection('skills')}
          saved={false}
        >
          <SkillsMappingSection
            mappings={data.deep_skill_mappings}
            catalog={data.deep_skill_catalog}
            selected={selSkills}
            original={originalSkills}
            onToggleOption={toggleSkill}
          />
        </SectionShell>

        <SectionShell
          title="Service Area"
          subtitle={`${data.serviceable_pincodes.length} pincode${data.serviceable_pincodes.length === 1 ? '' : 's'} currently set`}
          icon={<MapPin className="h-5 w-5" />}
          open={openSection.pincodes}
          onToggle={() => toggleSection('pincodes')}
          saved={false}
        >
          <ServiceAreaSection
            token={token}
            selected={selPincodes}
            onToggle={togglePincode}
            onRemove={removePincode}
            onEnsureAdd={addEnsuredPincode}
          />
        </SectionShell>
      </div>

      {/* ───── Single combined action area — sticky to the viewport bottom on
          mobile so the Save button stays reachable after a long scroll through
          Skills + Service Area; reverts to a normal static block on sm+. ───── */}
      <div className="mt-6 space-y-3 sticky bottom-0 z-20 border-t border-slate-200 bg-slate-50/95 supports-[backdrop-filter]:bg-slate-50/80 backdrop-blur px-1 py-3 sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none">
        {!bothFilled ? (
          <p className="text-center text-xs font-medium text-amber-700">
            Both Skills Mapping and Service Area are required to save.
          </p>
        ) : null}

        <AnimatedLoadingBar visible={saving} message="Saving Profile…" tone="sky" />

        {otpRequired ? (
          <OtpGate
            token={token}
            open={otpGateOpen}
            sending={saving}
            onVerified={(otp) => save(otp)}
            onCancel={() => { setOtpGateOpen(false); setError(null); }}
            saveError={error}
          />
        ) : null}

        {!otpGateOpen ? (
          <>
            {error ? (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
            ) : null}
            {!enoughPincodes ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Please add at least {MIN_PINCODES} serviceable pincodes to submit — {selPincodes.size} selected.
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                // OTP on → open the gate (which calls save(otp)); OTP off → save directly.
                onClick={otpRequired
                  ? () => { setError(null); setOtpGateOpen(true); }
                  : () => { setError(null); void save(); }}
                disabled={!canSave || saving}
                className="h-11 sm:h-9 w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {saved && !dirty ? 'Saved · Tap To Re-Save' : 'Save Profile'}
              </Button>
            </div>
          </>
        ) : null}
      </div>

      <p className="mt-6 text-center text-xs text-slate-400 px-2">
        You can re-open this link any time before it expires to make more updates.
      </p>
    </div>
  );
}

/* ───────── View-only Profile Header Strip ───────── */
/*
 * Rendered above the editable sections so the technician can confirm they
 * opened the right magic-link before editing anything. All fields are
 * optional — missing values are hidden (no empty "Service Category" label
 * stub), and a missing profile photo falls back to a 2-letter initials
 * avatar. Nothing here is editable.
 */
function formatJoiningDate(s: string): string {
  // BE may return ISO ("2024-04-15T00:00:00.000Z") or the MySQL DATETIME
  // form ("2024-04-15 00:00:00"). Normalise both, fall through to the raw
  // string if the Date constructor can't parse it (defensive: never blank
  // out a value we don't recognise — at worst the user sees the raw form).
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function ProfileHeaderStrip({ header }: { header: HeaderBlock }) {
  const initials = (header.full_name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  /*
   * Header strip rendering convention (2026-06-11):
   *   - Title line:    "<Name> (ID: <efr_id>)"
   *   - Service Categories:
   *       length === 0 → row hidden
   *       length === 1 → inline label "Service Categories: <name>"
   *       length > 1   → label + bulleted list below
   *   - Current Location: "<city> (Pincode: <pin>)" — pincode in parens
   *     when present; just the city otherwise; row hidden if neither.
   *   - Date of Joining: relabel of the old "Joined" field.
   * Each row hides itself gracefully when its source field is empty.
   */
  const categories = Array.isArray(header.service_categories) ? header.service_categories.filter(Boolean) : [];
  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex items-start gap-4">
          {header.profile_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={header.profile_image_url}
              alt={header.full_name}
              className="h-16 w-16 rounded-full object-cover border border-slate-200 shrink-0"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-semibold text-lg shrink-0">
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="text-base font-semibold text-slate-900">
              <span>{header.full_name || 'Easyfixer'}</span>
              <span className="ml-1 text-xs font-normal text-slate-500">(ID: {header.efr_id})</span>
            </div>
            {/*
              * Mobile on its own labelled row (2026-06-11). Was inline
              * after "(ID: …)" but the muted middot didn't read clearly
              * on narrow phone viewports and got mistaken for a list
              * separator. Putting it on its own line matches the pattern
              * used by every other strip field below (Pincode, Service
              * Category, Date of Joining).
              */}
            {header.efr_no ? (
              <div className="text-xs">
                <span className="text-slate-500">Mobile:</span>{' '}
                <span className="text-slate-800 font-medium">{header.efr_no}</span>
              </div>
            ) : null}
            <div className="space-y-1.5 text-xs">
              {categories.length > 0 ? (
                <div>
                  {/*
                   * Label switches between singular / plural based on
                   * the resolved-name count (2026-06-11). "Service
                   * Category: Plumbing" vs "Service Categories:" + bullet
                   * list — reads as natural English instead of the
                   * always-plural "Service Categories: Plumbing".
                   */}
                  <span className="text-slate-500">
                    {categories.length === 1 ? 'Service Category:' : 'Service Categories:'}
                  </span>{' '}
                  {categories.length === 1 ? (
                    <span className="text-slate-800 font-medium">{categories[0]}</span>
                  ) : (
                    <ul className="mt-1 ml-4 list-disc text-slate-800 font-medium space-y-0.5">
                      {categories.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
              {header.current_city ? (
                <div>
                  <span className="text-slate-500">Current Location:</span>{' '}
                  <span className="text-slate-800 font-medium">{header.current_city}</span>
                </div>
              ) : null}
              {/*
                * Pincode on its own row (2026-06-11). Previously inline
                * as "<city> (Pincode: <pin>)" but the parens caused
                * awkward line-wrapping on narrow phone viewports.
                * Splitting into a separate row reads cleanly at every
                * width and lets the row hide independently when only
                * one of city/pincode is present.
                */}
              {header.pincode ? (
                <div>
                  <span className="text-slate-500">Pincode:</span>{' '}
                  <span className="text-slate-800 font-medium">{header.pincode}</span>
                </div>
              ) : null}
              {header.joining_date ? (
                <div>
                  <span className="text-slate-500">Date of Joining:</span>{' '}
                  <span className="text-slate-800 font-medium">{formatJoiningDate(header.joining_date)}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ───────── Full-page error card ───────── */

function FullPageError({ title, message, retry }: { title: string; message: string; retry?: () => void }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <Card className="max-w-md w-full">
        <CardContent className="pt-6 pb-6 text-center space-y-3">
          <div className="mx-auto inline-flex items-center justify-center h-12 w-12 rounded-full bg-rose-100">
            <AlertTriangle className="h-6 w-6 text-rose-600" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="text-sm text-slate-600">{message}</p>
          {retry ? (
            <Button onClick={retry} className="mt-2">Try Again</Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/* ───────── Full-page success (post-submit Thank-You) ───────── */
function FullPageSuccess() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <Card className="max-w-md w-full">
        <CardContent className="pt-8 pb-8 text-center space-y-3">
          <div className="mx-auto inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-100">
            <CheckCircle2 className="h-7 w-7 text-emerald-600" />
          </div>
          <h2 className="text-xl font-semibold text-slate-900">Thank You!</h2>
          <p className="text-sm text-slate-600">Your Profile is Saved.</p>
          <p className="text-xs text-slate-500">You can close this page now.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ───────── Field shell ───────── */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
          {label}
        </Label>
        {hint ? <span className="text-[11px] text-slate-400 tabular-nums">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/* ───────── TASK 3 — Skills Mapping ───────── */

function skillKey(c: number, t: number, s: number, o: number): string {
  return `${c}|${t}|${s}|${o}`;
}

function SkillsMappingSection({
  mappings,
  catalog,
  selected,
  original,
  onToggleOption,
}: {
  mappings: DeepSkillMapping[];
  catalog: CatalogCategory[] | undefined;
  selected: Set<string>;
  original: Set<string>;
  onToggleOption: (c: number, t: number, s: number, o: number) => void;
}) {
  const hasCatalog = Array.isArray(catalog) && catalog.length > 0;

  // Read-only fallback when the BE didn't ship the catalog.
  if (!hasCatalog) {
    return <ReadOnlyMappings mappings={mappings} />;
  }

  return (
    <SkillsMappingPicker
      catalog={catalog!}
      selected={selected}
      original={original}
      onToggleOption={onToggleOption}
    />
  );
}

function ReadOnlyMappings({ mappings }: { mappings: DeepSkillMapping[] }) {
  if (!mappings.length) {
    return (
      <div className="rounded-md border border-dashed border-slate-200 bg-white p-4 text-center text-sm text-slate-500">
        No Service Categories Mapped Yet. Please Contact Your CRM To Set Up Your Profile.
      </div>
    );
  }
  // Group by category → service type → deep skill so the chip list reads
  // like a hierarchy even though it's not editable.
  const byCatg = new Map<number, { name: string; types: Map<number, { name: string; skills: Map<number, { name: string; options: string[] }> }> }>();
  for (const m of mappings) {
    if (!byCatg.has(m.category_id)) byCatg.set(m.category_id, { name: m.category_name || `Category ${m.category_id}`, types: new Map() });
    const catg = byCatg.get(m.category_id)!;
    if (!catg.types.has(m.service_type_id)) catg.types.set(m.service_type_id, { name: m.service_type_name || `Type ${m.service_type_id}`, skills: new Map() });
    const type = catg.types.get(m.service_type_id)!;
    if (!type.skills.has(m.deep_skill_id)) type.skills.set(m.deep_skill_id, { name: m.deep_skill_name || `Skill ${m.deep_skill_id}`, options: [] });
    type.skills.get(m.deep_skill_id)!.options.push(m.option_name || `Option ${m.option_id}`);
  }
  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {Array.from(byCatg.entries()).map(([catgId, catg]) => (
          <div key={catgId} className="rounded-md border border-slate-200 bg-white p-3">
            <div className="text-sm font-semibold text-slate-800">{catg.name}</div>
            <div className="mt-2 space-y-2">
              {Array.from(catg.types.entries()).map(([typeId, type]) => (
                <div key={typeId} className="pl-3 border-l-2 border-slate-200">
                  <div className="text-xs font-medium text-slate-600">{type.name}</div>
                  <div className="mt-1 space-y-1">
                    {Array.from(type.skills.entries()).map(([skillId, skill]) => (
                      <div key={skillId} className="text-xs">
                        <span className="text-slate-500">{skill.name}:</span>{' '}
                        <span className="text-slate-700">{skill.options.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-md bg-sky-50 border border-sky-100 text-sky-800 text-xs px-3 py-2">
        To Add Or Remove Skill Mappings, Please Contact Your CRM.
      </div>
    </div>
  );
}

/* ───────── Deep-skill picker theme + icons (Figma redesign) ─────────
 * Standalone red/blue palette for the public form's Deep Skills flow so it
 * matches the Figma mockup without pulling in the CRM sky/slate theme. */
const DS_RED = '#DC4B41';
const DS_RED_TINT = '#FDECEC';
const DS_BLUE = '#2D9CDB';
const DS_BLUE_TINT = '#EAF6FD';
const DS_GREEN = '#16A34A';
const DS_GREEN_TINT = '#DCFCE7';

/*
 * Category + service-type ICONS are not in the DB. They ship as static assets
 * exported from Figma into  public/deep-skill-icons/{categories,service-types}/
 * named by the slug of the category / service-type name (e.g. Carpenter →
 * carpenter.png, "Wooden Furniture Installation" → wooden-furniture-installation.png).
 * Until an asset is dropped in, a coloured first-letter tile is shown (onError
 * fallback) — so the flow is fully functional now and the real art appears the
 * moment the file lands. Deep-skill THUMBNAILS keep coming from the DB.
 */
function dsSlug(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function DsIconTile({
  name, kind, size = 44, className = '',
}: { name: string; kind: 'categories' | 'service-types'; size?: number; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  const slug = dsSlug(name);
  const letter = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  if (failed || !slug) {
    return (
      <div
        style={{ width: size, height: size, backgroundColor: DS_RED_TINT, color: DS_RED }}
        className={`flex items-center justify-center rounded-lg font-bold shrink-0 ${className}`}
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

function SkillsMappingPicker({
  catalog,
  selected,
  original,
  onToggleOption,
}: {
  catalog: CatalogCategory[];
  selected: Set<string>;
  original: Set<string>;
  onToggleOption: (c: number, t: number, s: number, o: number) => void;
}) {
  // Accordion: exactly one category card can be expanded at a time. Expanding a
  // card reveals its in-place app-view (service-type rail + skill cards) and
  // collapses the others. No grid, no navigation — single page.
  const [expandedCatId, setExpandedCatId] = React.useState<number | null>(null);
  const [activeTypeId, setActiveTypeId] = React.useState<number | null>(null);
  const [sheetSkillId, setSheetSkillId] = React.useState<number | null>(null);
  // Click-to-enlarge lightbox for the deep-skill thumbnails.
  const [lightboxUrl, setLightboxUrl] = React.useState<{ url: string; name: string } | null>(null);

  const activeCat = React.useMemo(
    () => catalog.find((c) => c.category_id === expandedCatId) || null,
    [catalog, expandedCatId],
  );
  const activeType = React.useMemo(() => {
    if (!activeCat) return null;
    return activeCat.service_types.find((t) => t.service_type_id === activeTypeId)
      || activeCat.service_types[0] || null;
  }, [activeCat, activeTypeId]);
  const sheetSkill = React.useMemo(() => {
    if (!activeType || sheetSkillId == null) return null;
    return activeType.deep_skills.find((s) => s.deep_skill_id === sheetSkillId) || null;
  }, [activeType, sheetSkillId]);

  function toggleCategory(catId: number) {
    setSheetSkillId(null);
    if (expandedCatId === catId) {
      setExpandedCatId(null); // collapse the open one
    } else {
      const cat = catalog.find((c) => c.category_id === catId);
      setActiveTypeId(cat?.service_types[0]?.service_type_id ?? null);
      setExpandedCatId(catId); // expand this, collapse others
    }
  }

  // Cascading count badges for category / type / skill so the technician
  // sees option counts roll up without having to expand each branch.
  const { countByCategory, countByType, countBySkill } = React.useMemo(() => {
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

  return (
    <div className="space-y-3">
      {/* ── Category accordion (single page): all categories listed; expanding
          one reveals its rail + skill cards IN PLACE and collapses the others.
          No "Add Skill", no "Choose a Category" grid, no navigation. ── */}
      <div className="space-y-2">
        {catalog.map((c) => {
          const count = countByCategory.get(c.category_id) || 0;
          const expanded = expandedCatId === c.category_id;
          return (
            <div key={c.category_id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <button
                type="button"
                onClick={() => toggleCategory(c.category_id)}
                className="w-full flex items-center gap-3 px-3 py-3 text-left"
              >
                <DsIconTile name={c.category_name} kind="categories" size={36} />
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold text-slate-800 truncate">{c.category_name}</span>
                  <span className="block text-xs text-slate-500">{count} Skill{count === 1 ? '' : 's'} Added</span>
                </span>
                {count > 0 && <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: DS_GREEN }} />}
                {expanded
                  ? <ChevronUp className="h-5 w-5 text-slate-400 shrink-0" />
                  : <ChevronDown className="h-5 w-5 text-slate-400 shrink-0" />}
              </button>

              {expanded && (
                <div className="border-t border-slate-200 flex max-h-[70vh]">
                  {/* left service-type rail */}
                  <div className="w-[84px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
                    {c.service_types.map((t) => {
                      const isActive = activeType?.service_type_id === t.service_type_id;
                      const cnt = countByType.get(`${c.category_id}|${t.service_type_id}`) || 0;
                      return (
                        <button
                          key={t.service_type_id}
                          type="button"
                          onClick={() => { setActiveTypeId(t.service_type_id); setSheetSkillId(null); }}
                          className="w-full flex flex-col items-center gap-1 px-1.5 py-3 text-center border-b border-slate-100"
                          style={isActive ? { backgroundColor: DS_BLUE_TINT, borderLeft: `3px solid ${DS_BLUE}` } : undefined}
                        >
                          <span className="relative">
                            <DsIconTile name={t.service_type_name} kind="service-types" size={34} />
                            {cnt > 0 && (
                              <span
                                style={{ backgroundColor: DS_BLUE }}
                                className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center"
                              >
                                {cnt}
                              </span>
                            )}
                          </span>
                          <span
                            className="text-[11px] leading-tight"
                            style={isActive ? { color: DS_BLUE, fontWeight: 600 } : { color: '#475569' }}
                          >
                            {t.service_type_name}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* right skill card grid — small images, 2 columns */}
                  <div className="flex-1 min-w-0 overflow-y-auto p-3 bg-slate-50">
                    <div className="text-sm font-semibold text-slate-800 mb-2">{activeType?.service_type_name}</div>
                    {(activeType?.deep_skills.length || 0) === 0 ? (
                      <div className="text-sm text-slate-500">No Deep Skills.</div>
                    ) : (
                      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 148px))' }}>
                        {activeType?.deep_skills.map((s) => {
                          const sel = countBySkill.get(`${c.category_id}|${activeType.service_type_id}|${s.deep_skill_id}`) || 0;
                          return (
                            <div key={s.deep_skill_id} className="rounded-xl border border-slate-200 bg-white p-2 flex flex-col">
                              <button
                                type="button"
                                onClick={() => { if (s.deep_skill_image_url) setLightboxUrl({ url: s.deep_skill_image_url, name: s.deep_skill_name }); }}
                                className="relative block w-full aspect-square rounded-lg overflow-hidden bg-slate-100 cursor-zoom-in"
                                title="Click To Enlarge"
                              >
                                {s.deep_skill_image_url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={s.deep_skill_image_url} alt={s.deep_skill_name} className="w-full h-full object-cover" loading="lazy" />
                                ) : (
                                  <span className="flex items-center justify-center w-full h-full text-slate-300"><Wrench className="h-7 w-7" /></span>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => setSheetSkillId(s.deep_skill_id)}
                                className="mt-2 w-full rounded-lg py-1.5 text-xs font-semibold border"
                                style={sel > 0
                                  ? { backgroundColor: DS_BLUE, borderColor: DS_BLUE, color: '#fff' }
                                  : { backgroundColor: '#fff', borderColor: DS_BLUE, color: DS_BLUE }}
                              >
                                {sel > 0 ? `${sel} Selected` : 'ADD'}
                                <span className="block text-[10px] font-normal opacity-80">
                                  {s.options.length} option{s.options.length === 1 ? '' : 's'}
                                </span>
                              </button>
                              <span className="mt-1.5 text-xs font-medium text-slate-700 text-center line-clamp-2">{s.deep_skill_name}</span>
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

      {/* ── Options bottom sheet ── */}
      {sheetSkill && activeCat && activeType && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/40"
            onClick={() => setSheetSkillId(null)}
          />
          <div className="relative rounded-t-2xl bg-white max-h-[75vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <span className="font-semibold text-slate-800">{sheetSkill.deep_skill_name}</span>
              <button
                type="button"
                onClick={() => setSheetSkillId(null)}
                className="rounded-full p-1 bg-slate-100 text-slate-500"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto divide-y divide-slate-100">
              {sheetSkill.options.length === 0 ? (
                <div className="px-4 py-4 text-sm text-slate-500">No Options.</div>
              ) : sheetSkill.options.map((o) => {
                const key = skillKey(activeCat.category_id, activeType.service_type_id, sheetSkill.deep_skill_id, o.option_id);
                const isSel = selected.has(key);
                const isOriginal = original.has(key);
                return (
                  <div key={o.option_id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className={`text-sm ${isSel ? 'text-slate-400' : 'text-slate-800'}`}>
                      {o.option_name}
                      {isOriginal && <span className="ml-1.5 text-[10px] font-medium" style={{ color: DS_GREEN }}>• Saved</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => onToggleOption(activeCat.category_id, activeType.service_type_id, sheetSkill.deep_skill_id, o.option_id)}
                      className="inline-flex items-center gap-1 rounded-lg px-4 py-1.5 text-xs font-bold shrink-0"
                      style={isSel ? { backgroundColor: DS_GREEN_TINT, color: DS_GREEN } : { backgroundColor: DS_BLUE, color: '#fff' }}
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

      <MemoizedSkillImageLightboxBridgePublic lightboxUrl={lightboxUrl} setLightboxUrl={setLightboxUrl} />
    </div>
  );
}

/* ───────── TASK 4 — Service Area (Pincodes) ───────── */

// The location-and-city portion of a pincode label: "<location> - <city>".
// Only genuinely-empty parts drop out (both values are shown even when equal).
function pincodeLocCity(p: { location?: string | null; city_name?: string | null }): string {
  const loc = (p.location ?? '').trim();
  const city = (p.city_name ?? '').trim();
  return [loc || null, city || null].filter(Boolean).join(' - ');
}

function ServiceAreaSection({
  token,
  selected,
  onToggle,
  onRemove,
  onEnsureAdd,
}: {
  token: string;
  selected: Map<number, PincodeMapping>;
  onToggle: (row: CatalogPincode) => void;
  onRemove: (id: number) => void;
  onEnsureAdd: (row: CatalogPincode) => void;
}) {
  // Pincodes are too large (~155k rows) to bundle in the prefill, so the
  // picker is always editable and pulls suggestions from the public search
  // endpoint instead of a bundled catalog.
  return (
    <PincodePicker
      token={token}
      selected={selected}
      onToggle={onToggle}
      onRemove={onRemove}
      onEnsureAdd={onEnsureAdd}
    />
  );
}

function PincodePicker({
  token,
  selected,
  onToggle,
  onRemove,
  onEnsureAdd,
}: {
  token: string;
  selected: Map<number, PincodeMapping>;
  onToggle: (row: CatalogPincode) => void;
  onRemove: (id: number) => void;
  onEnsureAdd: (row: CatalogPincode) => void;
}) {
  const [search, setSearch] = React.useState('');
  const [results, setResults] = React.useState<CatalogPincode[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  // "Ensure pincode" (on-the-fly create) state for the No-Matches branch.
  // `ensuring` blocks a double-tap while the POST is in flight; `ensureHint`
  // is the brief "Added <pincode>" confirmation; `ensureError` is the inline
  // 400 message (e.g. "not a valid Indian pincode").
  const [ensuring, setEnsuring] = React.useState(false);
  const [ensureHint, setEnsureHint] = React.useState<string | null>(null);
  const [ensureError, setEnsureError] = React.useState<string | null>(null);

  // Debounce the input so we don't fire one request per keystroke. 300ms is
  // the project-standard debounce (see useDebouncedValue docblock).
  const debouncedSearch = useDebouncedValue(search, 300);

  /*
   * Server-driven search with module-scope query cache (2026-06-11).
   * Operators expand / collapse Service Area many times in one session;
   * before the cache, every expand-and-empty-query re-fetched the same
   * "top 50 recent" list. The cache lives at module scope (declared at
   * the top of this file) so it persists for the lifetime of the page —
   * which for a single magic-link session is everything we need. Cache
   * key is the trimmed query string; values are the items arrays. We
   * skip the loading-state flash entirely when the cache hits.
   *
   * The cancellation guard still prevents a stale response from
   * overwriting a newer one (the BE doesn't dedupe in-flight requests).
   */
  React.useEffect(() => {
    let cancelled = false;
    const q = debouncedSearch.trim();
    // A new search term invalidates any prior on-the-fly ensure feedback.
    setEnsureHint(null);
    setEnsureError(null);
    const now = Date.now();
    const cached = pincodeSearchCache.get(q);
    const isFresh = cached && cached.expiresAt > now;

    /*
     * Stale-while-revalidate (2026-06-11 v3):
     *   - Fresh cache hit → render instantly, no spinner, no fetch.
     *   - Stale cache hit → render stale items instantly (no spinner),
     *     AND fire a background fetch to refresh. When the fresh
     *     response arrives, snap to it. If the revalidate FAILS, keep
     *     showing the stale data and swallow the error silently —
     *     stale data is better than an error toast.
     *   - Cache miss → spinner + fetch (the previous behaviour).
     */
    if (cached) {
      setResults(cached.items);
      setSearchError(null);
      setSearching(false);
      if (isFresh) return;
      // Fall through — fire revalidate below without showing a spinner.
    } else {
      setSearching(true);
      setSearchError(null);
    }

    // In-flight dedup: if another effect already kicked off the
    // same-query request, await its Promise instead of starting a
    // duplicate.
    let promise = pincodeSearchInflight.get(q);
    if (!promise) {
      promise = (async () => {
        try {
          const data = await publicFetch<{ items: CatalogPincode[] }>(
            `/public/easyfixer-profile-update/pincodes?token=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}&limit=50`
          );
          const items = Array.isArray(data?.items) ? data.items : [];
          pincodeSearchCache.set(q, { items, expiresAt: Date.now() + PINCODE_CACHE_TTL_MS });
          return items;
        } finally {
          pincodeSearchInflight.delete(q);
        }
      })();
      pincodeSearchInflight.set(q, promise);
    }
    promise.then(
      (items) => {
        if (cancelled) return;
        setResults(items);
      },
      (e: { message?: string }) => {
        if (cancelled) return;
        // Only surface the error when there's NO stale data to show.
        // With stale data, prefer "results are slightly old" over a
        // visible failure state.
        if (!cached) {
          setSearchError(e?.message || 'Failed to load pincodes');
          setResults([]);
        }
      },
    ).finally(() => {
      if (!cancelled) setSearching(false);
    });
    return () => { cancelled = true; };
  }, [debouncedSearch, token]);

  function toggle(row: CatalogPincode) {
    onToggle(row);
  }

  function removeChip(id: number) {
    onRemove(id);
  }

  /*
   * On-the-fly pincode create (#6). When a searched 6-digit pincode returns
   * NO catalog match, the technician can still add it: we silently POST it to
   * `/ensure-pincode`, which geocodes it (India-only gate) and find-or-creates
   * the row, then merge the returned pincode into `selected` exactly like a
   * normal toggle so the Save flow (serviceable_pincode_ids) picks it up
   * unchanged. A brief hint confirms the add; a 400 surfaces inline.
   *
   * The pincode is also seeded into the module-scope search cache under its own
   * 6-digit key so re-typing the same pincode shows it as a real match (with a
   * checked box) instead of "No Matches." again.
   */
  async function ensurePincode(pincode: string) {
    const pin = pincode.trim();
    if (!/^\d{6}$/.test(pin)) return;
    setEnsuring(true);
    setEnsureError(null);
    setEnsureHint(null);
    try {
      const row = await publicFetch<CatalogPincode>(
        `/public/easyfixer-profile-update/ensure-pincode?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pincode: pin }),
        }
      );
      // Merge into the lifted selection (same shape as toggle's add-branch).
      onEnsureAdd(row);
      // Seed the search cache so re-searching this pincode lists it as a match.
      pincodeSearchCache.set(pin, {
        items: [row],
        expiresAt: Date.now() + PINCODE_CACHE_TTL_MS,
      });
      setResults([row]);
      setEnsureHint(
        `Added ${row.pincode}${row.city_name ? ` · ${row.city_name}` : ''} to your service area`
      );
    } catch (e) {
      const err = e as { message?: string };
      setEnsureError(err?.message || 'Could not add this pincode');
    } finally {
      setEnsuring(false);
    }
  }

  const chips = Array.from(selected.values());

  return (
    <div className="space-y-3">
      {/* Selected chips */}
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {chips.map((p) => (
            <span
              key={p.pincode_id}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-xs text-emerald-800"
            >
              <span className="font-semibold tabular-nums">{p.pincode}</span>
              {pincodeLocCity(p) ? (
                <span className="text-emerald-600">- {pincodeLocCity(p)}</span>
              ) : null}
              <button
                type="button"
                onClick={() => removeChip(p.pincode_id)}
                className="ml-0.5 rounded hover:bg-emerald-200 p-0.5"
                aria-label={`Remove ${p.pincode}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-500">No Pincodes Selected Yet.</div>
      )}

      {/* Search */}
      <div className="space-y-2">
        <Field label="Add Pincodes" htmlFor="pf-pincode-search">
          <Input
            id="pf-pincode-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by pincode, location or city"
            inputMode="search"
            className="h-11 sm:h-9"
          />
        </Field>

        {/* Results list — server-side limited to 50 rows so the phone never
         *  renders the full 155k-row catalog. */}
        {/*
          * Search results container — flicker fix (2026-06-11).
          *
          * Previously this whole container's body swapped between
          * "Searching…" (a single ~40px line) and the full 50-row
          * results list (~288px), which produced a ~250px layout
          * shift on every keystroke. From the user's POV the page
          * "flickered" — actually the entire form below jumped.
          *
          * Fix: keep the existing results rendered while `searching`
          * is true (stale-while-revalidate UX); surface the loading
          * signal with a thin top bar inside the container. Container
          * height is now stable across the search lifecycle. The
          * search effect's SWR logic already preserves previous
          * results in state, so no data plumbing change is needed.
          */}
        <div className="relative rounded-md border border-slate-200 bg-white max-h-72 overflow-y-auto divide-y divide-slate-100">
          <AnimatedLoadingBar visible={searching} message="Searching…" tone="slate" sticky />
          {/*
            * Body: show existing results even during `searching` so the
            * container height stays stable. The error / empty states only
            * render when we have NO data to show (cache miss + failure).
            */}
          {!searching && searchError ? (
            <div className="p-3 text-xs text-rose-600">{searchError}</div>
          ) : !searching && results.length === 0 ? (
            <div className="p-3 space-y-2">
              <div className="text-xs text-slate-500">No Matches.</div>
              {/*
                * On-the-fly create (#6): only when the term is a clean 6-digit
                * pincode. We add it silently to the catalog + selection. The
                * hint / error render below the button.
                */}
              {/^\d{6}$/.test(debouncedSearch.trim()) ? (
                <Button
                  type="button"
                  onClick={() => ensurePincode(debouncedSearch.trim())}
                  disabled={ensuring}
                  className="h-9 w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                >
                  {ensuring ? 'Adding…' : `Add Pincode ${debouncedSearch.trim()}`}
                </Button>
              ) : null}
              {ensureError ? (
                <div className="text-xs text-rose-600">{ensureError}</div>
              ) : null}
            </div>
          ) : results.map((row) => {
            const id = Number(row.pincode_id);
            const isSelected = selected.has(id);
            return (
              <label
                key={id}
                className="flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-emerald-600 shrink-0"
                  checked={isSelected}
                  onChange={() => toggle(row)}
                />
                <span className="flex-1 min-w-0">
                  <span className="font-semibold text-slate-800 tabular-nums">{row.pincode}</span>
                  {pincodeLocCity(row) ? (
                    <span className="text-slate-500 ml-2">- {pincodeLocCity(row)}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {/*
            * Edge case: first-ever load with zero results AND zero
            * cached data — `results` is empty and `searching` is true.
            * Show a minimum-height placeholder so the container isn't
            * an empty 0px box during the very first network call.
            */}
          {searching && results.length === 0 ? (
            <div className="p-3 text-xs text-slate-400">Loading initial pincodes…</div>
          ) : null}
        </div>

        {/* Brief confirmation after an on-the-fly pincode add (#6). Sits
          * outside the results box so it persists once the row appears as a
          * real (checked) match. */}
        {ensureHint ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {ensureHint}
          </div>
        ) : null}
      </div>
    </div>
  );
}
