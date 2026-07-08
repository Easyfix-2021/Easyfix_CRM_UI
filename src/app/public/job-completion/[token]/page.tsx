'use client';

/*
 * Customer Magic-Link Job Completion form.
 *
 * Flow: an SMS to the customer carries a one-time link of the form
 * `https://crm.easyfix.in/job-completion/<jwt>`. The page hydrates from
 * `GET /api/public/job-completion/:token`, lets the customer correct any
 * details, then POSTs to `/api/public/job-completion/:token/submit`.
 *
 * Auth model: the magic-link JWT is the ENTIRE credential — there is no
 * Authorization header, no localStorage token. We use a bare `publicFetch`
 * helper rather than `@/lib/api` because the latter auto-attaches the staff
 * CRM bearer if one happens to be in localStorage (which would confuse the
 * BE's public route guard).
 *
 * Error envelope: BE returns `{ success: false, error, code? }`. The two
 * codes we surface as dedicated full-page states are:
 *   - 410 / JOB_NO_LONGER_PENDING — job already confirmed (state-bound expiry)
 *   - 401                          — invalid / expired token
 * Anything else → generic "Something went wrong" with a Try Again button.
 *
 * Maps: we deliberately inline a minimal Google Maps + Places impl rather
 * than reusing `<AddressPickerWithMap />` because that component hits
 * `/api/admin/maps/*` (auth-gated) — extending it to be token-aware would
 * mean touching shared CRM code which is out of scope here. The public
 * maps endpoints (`/api/public/maps/*`) take a `?token=<jwt>` query arg
 * instead of a bearer header.
 */

import { useParams } from 'next/navigation';
import Image from 'next/image';
import { X, CalendarClock, CheckCircle2, LifeBuoy, MapPin, Wrench, Phone, User } from 'lucide-react';
import * as React from 'react';
import type { PrefillResponse, SubmitPayload } from '@/lib/magic-link-types';
// Searchable city/long-list select — shared, no auth dependency → safe public.
import { SearchSelect } from '@/components/ui/search-select';
// Shared masked from→to preview (also used by the CRM operator click-to-call).
import { CallLegsPreview } from '@/components/ui/CallLegsPreview';
// Shared presentational Button (cva-based, no auth dependency → safe on the
// public page). Used for every button on the page so size/font/padding match;
// colour is differentiated via `variant` + `className`, NOT by `size`.
import { Button } from '@/components/ui/button';
// Extracted shared public-page building blocks (also used by the shared-job
// page). Behaviour-identical to the former inline definitions.
import { publicFetch } from '@/lib/public-fetch';
import { InfoCard } from '@/components/public/InfoCard';
import { OverlayShell } from '@/components/public/OverlayShell';
import { FullPageMessage } from '@/components/public/FullPageMessage';


type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PrefillResponse }
  | { kind: 'submitting'; data: PrefillResponse }
  | { kind: 'submitted'; variant?: 'complete' | 'reschedule' | 'cancel' }
  | { kind: 'expired_state' }
  | { kind: 'invalid_token' }
  | { kind: 'error'; message: string };

type FormState = {
  customer_name: string;
  customer_email: string;
  address: string;
  building: string;
  landmark: string;
  city_id: string;
  pin_code: string;
  gps_location: string;
  address_instruction: string;
  time_slot: string;
  requested_date_time: string;
  additional_name: string;
  additional_number: string;
  job_desc: string;
  branch_details: string;
  building_name: string;
  product_code: string;
  // Generic per-client custom-property values, keyed by the property's
  // canonical (lower-cased) name. Holds every customer-facing field that is
  // NOT one of the three canonical ones above (which keep dedicated keys for
  // their tbl_job columns).
  customValues: Record<string, string>;
  services: Map<number, number>;
};

/*
 * Per-client custom-property descriptor surfaced by the BE prefill.
 * Mirrors the shape the CRM Book-New-Call modal already consumes from
 * /admin/clients/:clientId/custom-properties. We keep a Map keyed by
 * canonical name so the 3 render branches below can look up directly
 * (branchProp / buildingProp / productProp).
 */
type CustomProp = { name: string; mandatory: boolean; label: string | null; value: string | null };

// The three canonical keys have dedicated form-state fields + tbl_job columns.
// Feature toggle (2026-07-08): the per-client custom-property section ("Additional
// Details" — Branch Details / Bill Number / Store Code, etc.) is HIDDEN on the
// customer-facing job-completion form. These are internal client/ops fields the
// customer can't meaningfully provide (and were showing the legacy "(NULL)"
// default value). Flip to `true` to collect them here again — the
// branchProp/buildingProp/… derivations + validation stay wired behind this flag.
const COLLECT_CUSTOM_PROPS = false;

const CANONICAL_PROP_KEYS = new Set(['branch_details', 'building_name', 'product_code']);

// Operator-config rows in tbl_client_custom_properties are NOT customer-facing.
// The BE already strips these from the prefill, but we filter defensively in
// case the FE ever talks to an older deploy that doesn't. Compared after the
// same a-z0-9→underscore normalisation the BE uses.
const CONFIG_PROP_KEYS = new Set([
  'auto_process_unconfirmed_order',
  'max_magic_link_send_count',
  'collected_by',
]);
const normalizePropKey = (n: string) =>
  String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Custom-property names that duplicate a field the form ALREADY collects in a
// dedicated input (PIN Code, City, Address, Email, Alternate contact, etc.).
// The BE strips these from the prefill; we filter defensively in case the FE
// talks to an older deploy. (building/property intentionally NOT here — they
// map to the canonical building_name custom field, distinct from the address
// "Building / Floor" input.)
const BUILTIN_ALIAS_KEYS = new Set([
  'pin_code', 'pincode', 'pin', 'zip', 'zipcode', 'postal_code', 'postalcode',
  'city', 'town', 'city_name',
  'address', 'complete_address', 'full_address',
  'landmark',
  'gps', 'gps_location', 'location', 'coordinates', 'lat_lng', 'latlng', 'lat_long', 'gps_coordinates',
  'email', 'customer_email', 'e_mail', 'mail',
  'customer_name', 'name', 'full_name', 'cust_name',
  'alternate_name', 'additional_name', 'alt_name', 'alternate_contact_name',
  'alternate_number', 'additional_number', 'alt_number', 'secondary_number',
  'alternate_contact_number', 'alternate_mobile',
  'address_instruction', 'address_instructions', 'instructions', 'landing_notes', 'delivery_instructions',
  'mobile', 'phone', 'mobile_no', 'mobile_number', 'phone_number', 'contact', 'contact_number', 'customer_mobile',
]);
// "branch_details" → "Branch Details" (fallback label when the client set none).
const prettyPropName = (n: string) =>
  String(n || '').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

function canonicaliseCustomProps(
  rows: PrefillResponse['custom_properties']
): Map<string, CustomProp> {
  // Same canonicalisation rules as JobModal.tsx (CRM Book-New-Call flow):
  //   branch | branch_details            → branch_details
  //   building | building_name | property | property_name
  //                                     → building_name
  //   sku | product_code                  → product_code
  // Everything else passes through under its lower-cased name (the BE
  // already lower-cases on its side, but we belt-and-braces here in case
  // the FE ever talks to a deploy that doesn't).
  const map = new Map<string, CustomProp>();
  for (const p of rows || []) {
    const n = String(p.name || '').toLowerCase().trim();
    if (!n) continue;
    if (CONFIG_PROP_KEYS.has(normalizePropKey(n))) continue; // never render config flags
    const canonical = (() => {
      if (n === 'branch' || n === 'branch_details') return 'branch_details';
      if (n === 'building' || n === 'building_name' || n === 'property_name' || n === 'property') return 'building_name';
      if (n === 'sku' || n === 'product_code') return 'product_code';
      return n;
    })();
    map.set(canonical, { ...p, name: canonical });
  }
  return map;
}

type ImageRow = { image_id: number; key: string; url?: string | null };
// `poster` is a client-generated thumbnail data URL (first frame), set only for
// videos the customer just picked this session — prefilled videos (re-opened
// link) have no local File so they fall back to the play-glyph tile.
// `poster` = local frame grabbed from the just-picked File (instant preview);
// `url` = server presigned playback source (works on reload too).
type VideoRow = { media_id: number; key: string; poster?: string | null; url?: string | null };

type GMaps = {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => unknown;
  Marker: new (opts: Record<string, unknown>) => {
    setPosition: (latLng: { lat: number; lng: number } | unknown) => void;
    getPosition: () => { lat: () => number; lng: () => number } | null;
    addListener: (event: string, cb: () => void) => unknown;
  };
};
type GMapsWindow = { google?: { maps: GMaps } };
let mapsLoader: Promise<GMaps> | null = null;
function loadGoogleMaps(apiKey: string): Promise<GMaps> {
  if (mapsLoader) return mapsLoader;
  mapsLoader = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(new Error('No window')); return; }
    const w = window as unknown as GMapsWindow;
    if (w.google?.maps) { resolve(w.google.maps); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&v=weekly`;
    script.async = true; script.defer = true;
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    script.onload = () => {
      const ww = window as unknown as GMapsWindow;
      if (ww.google?.maps) resolve(ww.google.maps);
      else reject(new Error('Maps loaded but namespace missing'));
    };
    document.head.appendChild(script);
  });
  return mapsLoader;
}

function parseLatLng(csv: string | null | undefined): { lat: number; lng: number } | null {
  if (!csv) return null;
  const parts = csv.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return { lat: parts[0], lng: parts[1] };
}

function toDatetimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/*
 * Derive the Time Slot from a picked datetime-local value (YYYY-MM-DDTHH:mm).
 * The customer picks date+time once and the slot follows automatically — the
 * 4 slot buttons are display-only indicators, not directly selectable.
 *
 * Mapping (mirrors the CRM JobModal bookingSlotFor() banding) — the returned
 * labels match exactly the strings the BE sends in `timeSlots`
 * (['9 AM – 12 PM', '12 PM – 3 PM', '3 PM – 7 PM', 'After Hours'], note the
 * en-dash) so the highlighted button + submitted time_slot stay in sync:
 *     hour 9–<12  → "9 AM – 12 PM"
 *     hour 12–<15 → "12 PM – 3 PM"
 *     hour 15–<19 → "3 PM – 7 PM"
 *     else        → "After Hours"
 * Returns '' for an empty/invalid pick so the slot clears until a time is set.
 */
function deriveTimeSlot(datetimeLocal: string): string {
  if (!datetimeLocal) return '';
  // datetime-local is "YYYY-MM-DDTHH:mm" — read the hour after the "T".
  const timePart = datetimeLocal.split('T')[1] || '';
  const h = Number(timePart.split(':')[0]);
  if (Number.isNaN(h)) return '';
  if (h >= 9  && h < 12) return '9 AM – 12 PM';
  if (h >= 12 && h < 15) return '12 PM – 3 PM';
  if (h >= 15 && h < 19) return '3 PM – 7 PM';
  return 'After Hours';
}

/* Format the naive datetime-local value (YYYY-MM-DDTHH:mm) the Reschedule
 * picker emits into the "YYYY-MM-DD HH:mm" string the BE expects. Returns
 * undefined for an empty pick (preferred_datetime is optional). */
function toBackendDateTime(value: string): string | undefined {
  if (!value) return undefined;
  // datetime-local can emit 16 (no seconds) or 19 (with seconds) chars.
  const trimmed = value.length > 16 ? value.slice(0, 16) : value;
  return trimmed.replace('T', ' ');
}

export default function JobCompletionMagicLinkPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token || '';

  const [state, setState] = React.useState<PageState>({ kind: 'loading' });
  const [form, setForm] = React.useState<FormState | null>(null);
  const [images, setImages] = React.useState<ImageRow[]>([]);
  // Customer-shared videos (tbl_job_media). Same endpoint as images
  // server-side; the BE branches on MIME and the response's `kind` discriminator
  // tells us which collection to update.
  const [videos, setVideos] = React.useState<VideoRow[]>([]);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  // True after the first failed submit — drives inline red highlights that
  // clear per-field as the customer fills each one (replaces the old
  // persistent top-of-form "please fill…" banner).
  const [submitAttempted, setSubmitAttempted] = React.useState(false);
  const [customProps, setCustomProps] = React.useState<Map<string, CustomProp>>(new Map());

  // ── Customer-facing order-page additions ────────────────────────────────
  // Toast: a single ephemeral status line for the click-to-call / request
  // actions (auto-dismisses). Kept lightweight — no toast library on the
  // public bundle.
  const [toast, setToast] = React.useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = React.useCallback((text: string, tone: 'ok' | 'err' = 'ok', ms = 5000) => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  React.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Which secondary action is mid-flight (disables its button + shows a
  // spinner-ish label). Calling actions hit click-to-call endpoints.
  const [actionBusy, setActionBusy] = React.useState<null | 'spoc' | 'support' | 'reschedule' | 'cancel'>(null);
  // Inline overlay dialogs (no CRM Dialog import — plain styled overlays).
  // `spoc_confirm` is the "Need Help" → Call EasyFix SPOC confirmation step
  // (reuses OverlayShell; on confirm it runs handleSpocCall).
  const [dialog, setDialog] = React.useState<null | 'reschedule' | 'cancel' | 'spoc_confirm' | 'support_confirm'>(null);
  // Inline reveal state for the "Pin Exact Location On Map" toggle in the
  // Service Address card (mounts AddressMapWidget on demand).
  const [mapOpen, setMapOpen] = React.useState(false);
  // Masked from→to the SPOC bridge would dial — shown in the "Need Help"
  // confirmation for customer visibility (mirrors the CRM operator click-to-
  // call confirm dialog). Fetched lazily when the dialog opens.
  type CallPreviewState = null | 'loading' | 'error' | { from: string | null; to: string | null; suppressed: boolean };
  const [spocPreview, setSpocPreview] = React.useState<CallPreviewState>(null);
  // Same, for the Contact-Support bridge. `unavailable` = SUPPORT_PHONE unset
  // server-side (support_phone:null) → the confirm dialog shows a fallback.
  const [supportPreview, setSupportPreview] =
    React.useState<CallPreviewState | 'unavailable'>(null);
  // Narrow a preview state to its data object (or null) for the shared preview
  // component — avoids repeating the multi-literal guard inline in JSX.
  const asPreviewObj = (p: CallPreviewState | 'unavailable') =>
    p && p !== 'loading' && p !== 'error' && p !== 'unavailable' ? p : null;

  React.useEffect(() => {
    if (!token) { setState({ kind: 'invalid_token' }); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await publicFetch<PrefillResponse>(`/public/job-completion/${encodeURIComponent(token)}`);
        if (cancelled) return;
        // Seed previously-picked services from the BE prefill so a re-opened
        // link doesn't silently soft-delete the customer's earlier picks on
        // resubmit. Falls back to [] for older BE deployments that don't yet
        // include `selectedServices`.
        const seededServices = new Map<number, number>();
        for (const sel of data.selectedServices ?? []) {
          seededServices.set(sel.client_service_id, sel.quantity ?? 1);
        }
        const props = canonicaliseCustomProps(data.custom_properties);
        // Seed inputs from any pre-existing custom-property values returned
        // by the BE (`value` on the descriptor). Falls back to '' so the
        // input remains controlled.
        const seedFromProp = (key: string) => props.get(key)?.value ?? '';
        // Seed generic (non-canonical) custom-property inputs from any
        // pre-existing value the BE returned, keyed by canonical name.
        const seededCustomValues: Record<string, string> = {};
        for (const [k, p] of props.entries()) {
          if (!CANONICAL_PROP_KEYS.has(k)) seededCustomValues[k] = p.value ?? '';
        }
        setForm({
          customer_name: data.customer.name || '',
          customer_email: data.customer.email || '',
          address: data.address.address || '',
          building: data.address.building || '',
          landmark: data.address.landmark || '',
          city_id: data.address.city_id ? String(data.address.city_id) : '',
          pin_code: data.address.pin_code || '',
          gps_location: data.address.gps_location || '',
          address_instruction: data.address.address_instruction || '',
          // Time Slot is DERIVED from the requested datetime (auto-selected),
          // not picked directly. Seed it from the prefilled datetime so the
          // display indicator matches; fall back to the BE's stored slot when
          // there's no datetime yet.
          time_slot: deriveTimeSlot(toDatetimeLocal(data.schedule.requested_date_time)) || data.schedule.time_slot || '',
          requested_date_time: toDatetimeLocal(data.schedule.requested_date_time),
          additional_name: data.additional.name || '',
          additional_number: data.additional.number || '',
          job_desc: data.jobDesc || '',
          branch_details: seedFromProp('branch_details'),
          building_name:  seedFromProp('building_name'),
          product_code:   seedFromProp('product_code'),
          customValues: seededCustomValues,
          services: seededServices,
        });
        setCustomProps(props);
        setImages(data.images.map((i) => ({ image_id: i.image_id, key: i.key, url: i.url ?? null })));
        setVideos((data.videos ?? []).map((v) => ({ media_id: v.media_id, key: v.key, url: v.url ?? null })));
        setState({ kind: 'ready', data });
      } catch (err) {
        if (cancelled) return;
        const e = err as { status?: number; code?: string; message?: string };
        if (e.status === 410 || e.code === 'JOB_NO_LONGER_PENDING') setState({ kind: 'expired_state' });
        else if (e.status === 401) setState({ kind: 'invalid_token' });
        else setState({ kind: 'error', message: e.message || 'Failed to load' });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Lazily fetch the masked from→to whenever the "Need Help" confirmation opens
  // so the customer sees which two numbers will be bridged (CRM-parity), in all
  // envs. A fetch failure is non-fatal — we just hide the preview line.
  React.useEffect(() => {
    if (dialog !== 'spoc_confirm') { setSpocPreview(null); return; }
    let cancelled = false;
    setSpocPreview('loading');
    (async () => {
      try {
        const p = await publicFetch<{ from: string | null; to: string | null; suppressed: boolean }>(
          `/public/job-completion/${encodeURIComponent(token)}/spoc-call/preview`
        );
        if (!cancelled) setSpocPreview({ from: p.from, to: p.to, suppressed: !!p.suppressed });
      } catch {
        if (!cancelled) setSpocPreview('error');
      }
    })();
    return () => { cancelled = true; };
  }, [dialog, token]);

  // Same lazy preview for the Contact-Support confirmation. `support_phone:null`
  // (SUPPORT_PHONE unset) maps to the 'unavailable' state.
  React.useEffect(() => {
    if (dialog !== 'support_confirm') { setSupportPreview(null); return; }
    let cancelled = false;
    setSupportPreview('loading');
    (async () => {
      try {
        const p = await publicFetch<{ from: string | null; to: string | null; suppressed: boolean; support_phone: boolean | null }>(
          `/public/job-completion/${encodeURIComponent(token)}/support-call/preview`
        );
        if (cancelled) return;
        if (!p.support_phone) setSupportPreview('unavailable');
        else setSupportPreview({ from: p.from, to: p.to, suppressed: !!p.suppressed });
      } catch {
        if (!cancelled) setSupportPreview('error');
      }
    })();
    return () => { cancelled = true; };
  }, [dialog, token]);

  if (state.kind === 'loading') return <div className="text-center text-slate-500 py-12">Loading…</div>;
  if (state.kind === 'expired_state') return (
    <FullPageMessage
      title="This Booking Has Already Been Confirmed"
      message="Our team has finalised the details for this order. If you need to make changes, please contact EasyFix support."
      helpline
    />
  );
  if (state.kind === 'invalid_token') return (
    <FullPageMessage
      title="This Link Is Invalid Or Has Expired"
      message="Please use the most recent link sent to you, or contact EasyFix support if you didn't receive one."
      helpline
    />
  );
  if (state.kind === 'error') return (
    <FullPageMessage title="Something Went Wrong" message={state.message} retry />
  );
  if (state.kind === 'submitted') {
    // Terminal confirmation screen — worded per the action taken. Reschedule
    // and cancel are REQUESTS ops will action later, so avoid "Order Confirmed".
    const confirm =
      state.variant === 'reschedule'
        ? { title: 'Reschedule Requested', message: 'Our Team Will Review Your Preferred Date & Time And Get Back To You. You Can Close This Page.' }
        : state.variant === 'cancel'
          ? { title: 'Cancellation Requested', message: 'Our Team Will Review Your Request And Reach Out To You. You Can Close This Page.' }
          : { title: 'Thank You', message: 'Order Confirmed — Our Team Will Finalise The Schedule Shortly. You Can Close This Page.' };
    return <FullPageMessage title={confirm.title} message={confirm.message} />;
  }

  const data = state.data;
  const isSubmitting = state.kind === 'submitting';
  if (!form) return null;

  // Per-client custom-prop convenience flags. `branchProp`/etc. are present
  // only when the client has the matching row in tbl_client_custom_properties;
  // when absent we skip rendering the input AND skip gating on it.
  const branchProp   = customProps.get('branch_details');
  const buildingProp = customProps.get('building_name');
  const productProp  = customProps.get('product_code');

  // Every OTHER customer-facing client field (beyond the three canonical ones)
  // — rendered generically and submitted in the `custom_properties` map.
  const extraProps = Array.from(customProps.values()).filter(
    (p) => !CANONICAL_PROP_KEYS.has(p.name) && !BUILTIN_ALIAS_KEYS.has(normalizePropKey(p.name)),
  );

  // Submit-button gate mirror of `section1Complete` in JobModal.tsx
  // (CRM Book-New-Call). Disables Submit when ANY mandatory custom-prop
  // input is empty so the customer can't bypass the requirement by
  // clicking through; the missing-fields banner above still catches the
  // case where they manage to submit anyway (e.g. older browser
  // ignoring `required`).
  const mandatoryCustomPropsComplete =
    !COLLECT_CUSTOM_PROPS || (
      (!branchProp   || !branchProp.mandatory   || !!form.branch_details.trim()) &&
      (!buildingProp || !buildingProp.mandatory || !!form.building_name.trim()) &&
      (!productProp  || !productProp.mandatory  || !!form.product_code.trim()) &&
      extraProps.every((p) => !p.mandatory || !!(form.customValues[p.name] || '').trim()));

  const patch = (p: Partial<FormState>) => setForm((f) => (f ? { ...f, ...p } : f));


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSubmitAttempted(true);
    const missing: string[] = [];
    if (!form.customer_name.trim()) missing.push('Name');
    // address / city / PIN are booked & display-only here (customer can't edit
    // them; the pin captures GPS only), so they no longer gate submission — the
    // BE keeps the booked values. Only the customer's own fields are required.
    if (!form.time_slot) missing.push('Time Slot');
    if (!form.requested_date_time) missing.push('Appointment Time');
    // Mirror JobModal `section1Complete`: only enforce when the client has
    // the prop AND it's marked mandatory. Reuse the BE-provided label when
    // present so the missing-fields banner reads in the client's own
    // wording where they've customised it.
    if (COLLECT_CUSTOM_PROPS) {
      if (branchProp?.mandatory && !form.branch_details.trim()) {
        missing.push(branchProp.label || 'Branch Details');
      }
      if (buildingProp?.mandatory && !form.building_name.trim()) {
        missing.push(buildingProp.label || 'Property / Building Name');
      }
      if (productProp?.mandatory && !form.product_code.trim()) {
        missing.push(productProp.label || 'Product Code');
      }
      // Generic (non-canonical) client custom fields — same mandatory rule.
      for (const p of extraProps) {
        if (p.mandatory && !(form.customValues[p.name] || '').trim()) {
          missing.push(p.label || prettyPropName(p.name));
        }
      }
    }
    if (missing.length) {
      // Ephemeral toast (3s) + inline red highlights (driven by submitAttempted)
      // instead of a persistent top-of-form banner. The highlights clear
      // reactively as each field is filled.
      showToast(`Please Fill: ${missing.join(', ')}`, 'err', 3000);
      setSubmitError(null);
      return;
    }
    setSubmitError(null);

    const payload: SubmitPayload = {
      customer_name: form.customer_name.trim(),
      customer_email: form.customer_email.trim() || undefined,
      // Booked address fields — send when present, OMIT when empty so the BE's
      // COALESCE keeps the booked value instead of nulling/blanking it.
      address: form.address.trim() || undefined,
      building: form.building.trim() || undefined,
      landmark: form.landmark.trim() || undefined,
      city_id: form.city_id ? Number(form.city_id) : undefined,
      pin_code: form.pin_code || undefined,
      time_slot: form.time_slot,
      // datetime-local emits naive `YYYY-MM-DDTHH:mm`. Joi.date().iso() on the
      // BE treats unannotated ISO as UTC, which would shift IST wall-clock by
      // -5:30. EasyFix is IST-locked everywhere (see Asia/Kolkata scheduler),
      // so we tack the IST offset on so the customer's wall-clock pick is the
      // wall-clock value ops sees in tbl_job. Two branches because
      // datetime-local can emit either 16 or 19 chars depending on browser.
      requested_date_time: form.requested_date_time.length === 16
        ? `${form.requested_date_time}:00+05:30`
        : `${form.requested_date_time}+05:30`,
      gps_location: form.gps_location.trim() || undefined,
      address_instruction: form.address_instruction.trim() || undefined,
      additional_name: form.additional_name.trim() || undefined,
      additional_number: form.additional_number.trim() || undefined,
      job_desc: form.job_desc.trim() || undefined,
      // Per-client custom-property values. Only included when the client
      // has the matching descriptor AND the customer typed something —
      // sending `undefined` when absent keeps the BE's COALESCE-preserves
      // semantics intact (existing column value is not overwritten with
      // an empty string).
      branch_details: COLLECT_CUSTOM_PROPS && branchProp && form.branch_details.trim()
        ? form.branch_details.trim() : undefined,
      building_name: COLLECT_CUSTOM_PROPS && buildingProp && form.building_name.trim()
        ? form.building_name.trim() : undefined,
      product_code: COLLECT_CUSTOM_PROPS && productProp && form.product_code.trim()
        ? form.product_code.trim() : undefined,
      // Generic custom-property values — only the ones the customer filled.
      custom_properties: COLLECT_CUSTOM_PROPS ? (() => {
        const out: Record<string, string> = {};
        for (const p of extraProps) {
          const v = (form.customValues[p.name] || '').trim();
          if (v) out[p.name] = v;
        }
        return Object.keys(out).length ? out : undefined;
      })() : undefined,
      services: Array.from(form.services.entries()).map(([id, qty]) => ({
        client_service_id: id, quantity: qty,
      })),
    };

    setState({ kind: 'submitting', data });
    try {
      await publicFetch<{ success: true }>(
        `/public/job-completion/${encodeURIComponent(token)}/submit`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      setState({ kind: 'submitted' });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e.status === 410 || e.code === 'JOB_NO_LONGER_PENDING') { setState({ kind: 'expired_state' }); return; }
      if (e.status === 401) { setState({ kind: 'invalid_token' }); return; }
      setState({ kind: 'ready', data });
      setSubmitError(e.message || 'Submission failed. Please try again.');
    }
  }

  // ── Click-to-call: EasyFix SPOC ─────────────────────────────────────────
  // POST /spoc-call (no body). The BE places the call server-side; we only
  // surface delivery status. 422 → no SPOC available.
  async function handleSpocCall() {
    if (actionBusy) return;
    setActionBusy('spoc');
    try {
      const r = await publicFetch<{ delivered: boolean }>(
        `/public/job-completion/${encodeURIComponent(token)}/spoc-call`, { method: 'POST' }
      );
      if (r.delivered) showToast('Connecting Your Call — Please Keep Your Phone Handy.', 'ok');
      else showToast('Calling Is Currently Unavailable, Please Try Again Later.', 'err');
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 422) showToast('No SPOC Is Available To Call Right Now.', 'err');
      else showToast(e.message || 'Calling Is Currently Unavailable, Please Try Again Later.', 'err');
    } finally {
      setActionBusy(null);
    }
  }

  // ── Click-to-call: EasyFix Support ──────────────────────────────────────
  // POST /support-call (no body). Bridges the customer to the SUPPORT_PHONE
  // line server-side. delivered:false + support_phone:null → support not
  // configured (FE shows a fallback message).
  async function handleSupportCall() {
    if (actionBusy) return;
    setActionBusy('support');
    try {
      const r = await publicFetch<{ delivered: boolean; support_phone?: string | null }>(
        `/public/job-completion/${encodeURIComponent(token)}/support-call`, { method: 'POST' }
      );
      if (r.delivered) showToast('Connecting Your Call — Please Keep Your Phone Handy.', 'ok');
      else if (r.support_phone === null) showToast('Support Calling Is Not Available Right Now.', 'err');
      else showToast('Calling Is Currently Unavailable, Please Try Again Later.', 'err');
    } catch (err) {
      const e = err as { status?: number; message?: string };
      showToast(e.message || 'Calling Is Currently Unavailable, Please Try Again Later.', 'err');
    } finally {
      setActionBusy(null);
    }
  }

  // ── Request: Reschedule ─────────────────────────────────────────────────
  // POST /reschedule-request { reason, remarks?, preferred_datetime? }.
  // Reason is required (enforced in the dialog). Closes the dialog + toasts
  // on success; surfaces errors via toast.
  async function handleRescheduleSubmit(reason: string, preferred: string, remarks: string) {
    if (actionBusy) return;
    setActionBusy('reschedule');
    try {
      await publicFetch<{ request_id: number }>(
        `/public/job-completion/${encodeURIComponent(token)}/reschedule-request`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason,
            remarks: remarks.trim() || undefined,
            preferred_datetime: toBackendDateTime(preferred),
          }),
        }
      );
      setDialog(null);
      // Show the same persistent confirmation screen as Complete (issue: a
      // 5s toast was the only feedback, so the page just looked unchanged).
      setState({ kind: 'submitted', variant: 'reschedule' });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e.status === 410 || e.code === 'JOB_NO_LONGER_PENDING') { setDialog(null); setState({ kind: 'expired_state' }); return; }
      if (e.status === 401) { setDialog(null); setState({ kind: 'invalid_token' }); return; }
      showToast(e.message || 'Could Not Submit Reschedule Request. Please Try Again.', 'err');
    } finally {
      setActionBusy(null);
    }
  }

  // ── Request: Cancel ─────────────────────────────────────────────────────
  // POST /cancel-request { reason, remarks? }. Reason required.
  async function handleCancelSubmit(reason: string, remarks: string) {
    if (actionBusy) return;
    setActionBusy('cancel');
    try {
      await publicFetch<{ request_id: number }>(
        `/public/job-completion/${encodeURIComponent(token)}/cancel-request`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, remarks: remarks.trim() || undefined }),
        }
      );
      setDialog(null);
      setState({ kind: 'submitted', variant: 'cancel' });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e.status === 410 || e.code === 'JOB_NO_LONGER_PENDING') { setDialog(null); setState({ kind: 'expired_state' }); return; }
      if (e.status === 401) { setDialog(null); setState({ kind: 'invalid_token' }); return; }
      showToast(e.message || 'Could Not Submit Cancellation Request. Please Try Again.', 'err');
    } finally {
      setActionBusy(null);
    }
  }

  // Convenience reads of the expanded contract (all optional → safe reads).
  const jobId = data.job_id ?? data.jobId;
  const clientName = data.client_name || data.client.name;
  const spoc = data.spoc;
  const cancelReasons = data.cancel_reasons ?? [];
  const rescheduleReasons = data.reschedule_reasons ?? [];
  const customerMob = data.customer_mob || data.customer.mobile;

  // ── Derived display values for the redesigned card layout ────────────────
  const customerFirstName = (data.customer.name || '').trim().split(/\s+/)[0] || 'there';
  // Best-effort single service label for the "Order for" subline + the
  // "Service Requested" fallback text: the job's first selected service
  // resolved against the client catalogue, else the first catalogue entry.
  const primaryService =
    data.services.find(
      (s) => s.client_service_id === data.selectedServices?.[0]?.client_service_id,
    ) || data.services[0];
  const serviceName =
    (primaryService?.service_name && primaryService.service_name.trim()) ||
    (primaryService?.service_type_name && primaryService.service_type_name.trim()) ||
    (primaryService?.service_catg_name && primaryService.service_catg_name.trim()) ||
    'Service Visit';
  // City NAME (not id) for the read-only assembled address line.
  const cityName =
    data.cityOptions.find((c) => String(c.value) === form.city_id)?.label || '';
  // Read-only assembled address: Building/Floor, Complete Address, City,
  // Landmark, Pincode — skipping empty parts, joined by ", ".
  const assembledAddress = [form.building, form.address, cityName, form.landmark, form.pin_code]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(', ');
  // Appointment display (form.requested_date_time is naive "YYYY-MM-DDTHH:mm").
  const apptDate = form.requested_date_time ? new Date(form.requested_date_time) : null;
  const apptValid = !!apptDate && !Number.isNaN(apptDate.getTime());
  const apptDateLabel = apptValid
    ? apptDate!.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
    : 'To Be Scheduled';
  const apptTimeLabel = apptValid
    ? apptDate!.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    : '';
  // Coordinator identity + avatar initials for the "Your Coordinator" card.
  const coordinatorName = spoc?.name || data.job_owner?.name || 'EasyFix Coordinator';
  const coordinatorInitials =
    coordinatorName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('') || 'EF';

  // Inline validation highlights — only after a failed submit, and each clears
  // the moment its field becomes valid (reactive on form state).
  const nameError = submitAttempted && !form.customer_name.trim();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Blue header band: client name (left) + "Fulfilled by EasyFix" pill
          (right). The SPOC now lives in the "Your Coordinator" card below. */}
      <OrderHeader clientName={clientName} />

      {/* Floating toast — fixed above the sticky footer so it stays visible
          wherever the customer has scrolled (validation + click-to-call). */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-24 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-md border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {toast.text}
        </div>
      )}

      {submitError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">{submitError}</div>
      )}

      <form id="order-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Order context — ORDER FOR + client name are now merged into the blue
            header above; here we keep the service · Job ID line and the
            personalised greeting chip. */}
        <div className="space-y-2 px-1">
          <div className="text-sm text-slate-500">{serviceName} · Job ID #{jobId}</div>
          <div className="rounded-md bg-sky-100 px-4 py-3 text-sm font-medium text-sky-900 ring-1 ring-inset ring-sky-200">
            Hi {customerFirstName} — please confirm your service visit below.
          </div>
        </div>

        {/* CARD: Service requested (read-only — set at booking, not editable). */}
        <InfoCard icon={<Wrench className="h-4 w-4" />} title="Service Requested">
          <p className="text-sm leading-relaxed text-slate-600 whitespace-pre-wrap">
            {(form.job_desc && form.job_desc.trim()) || serviceName}
          </p>
        </InfoCard>

        {/* Per-client custom-property inputs. Mirrors the CRM Book-New-Call
            flow (JobModal.tsx → Branch Details / Property or Building Name /
            Product Code). Renders ONLY the inputs the client has configured
            in tbl_client_custom_properties; mandatory flag drives both the
            red asterisk + native `required` attribute + the Submit-button
            gate above. Placed adjacent to Address since these fields are
            typically address-context (which branch / which property / which
            product line is the service for). */}
        {COLLECT_CUSTOM_PROPS && (branchProp || buildingProp || productProp || extraProps.length > 0) && (
          <Section title="Additional Details" cols={3}>
            {branchProp && (
              <Field
                label={branchProp.label || 'Branch Details'}
                required={branchProp.mandatory}
              >
                <input
                  type="text"
                  required={branchProp.mandatory}
                  value={form.branch_details}
                  onChange={(e) => patch({ branch_details: e.target.value })}
                  className={inputClass}
                  placeholder={branchProp.mandatory ? 'Required for this client' : 'Optional'}
                  maxLength={200}
                />
              </Field>
            )}
            {buildingProp && (
              <Field
                label={buildingProp.label || 'Property / Building Name'}
                required={buildingProp.mandatory}
              >
                <input
                  type="text"
                  required={buildingProp.mandatory}
                  value={form.building_name}
                  onChange={(e) => patch({ building_name: e.target.value })}
                  className={inputClass}
                  placeholder={buildingProp.mandatory ? 'Required for this client' : 'Optional'}
                  maxLength={200}
                />
              </Field>
            )}
            {productProp && (
              <Field
                label={productProp.label || 'Product Code'}
                required={productProp.mandatory}
              >
                <input
                  type="text"
                  required={productProp.mandatory}
                  value={form.product_code}
                  onChange={(e) => patch({ product_code: e.target.value })}
                  className={inputClass}
                  placeholder={productProp.mandatory ? 'Required for this client' : 'Optional'}
                  maxLength={200}
                />
              </Field>
            )}
            {/* Generic client-defined custom fields (anything beyond the three
                canonical ones). label falls back to a Title-Cased prop name;
                mandatory drives the red asterisk + native `required` + the
                Submit-button gate above. */}
            {extraProps.map((p) => (
              <Field key={p.name} label={p.label || prettyPropName(p.name)} required={p.mandatory}>
                <input
                  type="text"
                  required={p.mandatory}
                  value={form.customValues[p.name] || ''}
                  onChange={(e) => patch({ customValues: { ...form.customValues, [p.name]: e.target.value } })}
                  className={inputClass}
                  placeholder={p.mandatory ? 'Required for this client' : 'Optional'}
                  maxLength={500}
                />
              </Field>
            ))}
          </Section>
        )}

        {/* CARD: Service address — read-only assembled address + map pin + notes. */}
        <InfoCard icon={<MapPin className="h-4 w-4" />} title="Service Address">
          {/* Read-only assembled address (display-only; the customer edits the
              underlying fields via the map reveal below, not here). */}
          <div className="flex w-full rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-base text-slate-600">
            {assembledAddress || '—'}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setMapOpen((o) => !o)}
              className="gap-2 border-sky-300 text-sky-700 hover:bg-sky-50 hover:text-sky-800"
            >
              <MapPin className="h-4 w-4" />
              {mapOpen ? 'Hide Map' : 'Pin Exact Location On Map'}
            </Button>
            {form.gps_location && !mapOpen && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                Location Captured
              </span>
            )}
          </div>
          {/* Reveal the existing AddressMapWidget on demand (Google Places
              search + draggable pin). It writes gps_location / address / city /
              pin back into form state via patch() exactly as before. */}
          {mapOpen && (
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
              <AddressMapWidget
                token={token}
                cityOptions={data.cityOptions}
                form={form}
                patch={patch}
                mapClickable={data.mapClickable !== false}
                mapOnly
              />
            </div>
          )}
          <Field label="Address Instructions (Optional)">
            <input
              type="text"
              value={form.address_instruction}
              onChange={(e) => patch({ address_instruction: e.target.value })}
              className={inputClass}
              placeholder="Landmark, Gate Code, Floor…"
            />
          </Field>
        </InfoCard>

        {/* CARD: Appointment — display-only; changes go through Reschedule. */}
        <InfoCard
          icon={<CalendarClock className="h-4 w-4" />}
          title="Appointment"
        >
          <div className="flex items-center justify-between gap-3">
            {/* Mobile: date on top, time below (slot hidden — date + time is
                enough on a small screen and avoids the 3-line wrap). Desktop
                (sm+): date + time · slot inline, unchanged. */}
            <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3 sm:gap-y-1">
              <span className="text-lg font-semibold text-slate-900">{apptDateLabel}</span>
              <span className="text-sm text-slate-600">
                {apptTimeLabel && <span className="font-mono">{apptTimeLabel}</span>}
                <span className="hidden sm:inline">
                  {apptTimeLabel && form.time_slot ? ' · ' : ''}
                  {form.time_slot}
                </span>
              </span>
            </div>
            {/* Reschedule aligned to the right of the date/time row, vertically centered. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialog('reschedule')}
              className="shrink-0 gap-1.5 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:text-amber-900"
            >
              <CalendarClock className="h-4 w-4" />
              Reschedule
            </Button>
          </div>
        </InfoCard>

        {/* CARD: Your coordinator — single point of contact + click-to-call. */}
        <InfoCard icon={<User className="h-4 w-4" />} title="Your Coordinator">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-semibold text-sky-700">
              {coordinatorInitials}
            </div>
            <div className="min-w-0 flex-1">
              {/* Smaller than the card title (text-base) so the section header
                  and the person's name read as a clear hierarchy, not twins. */}
              <div className="truncate text-sm font-semibold text-slate-800">{coordinatorName}</div>
            </div>
            {/* Green Call button → existing bridged SPOC call flow (spoc_confirm).
                Green = "go / place call", mirroring the Call EasyFix SPOC CTA. */}
            <Button
              type="button"
              onClick={() => setDialog('spoc_confirm')}
              disabled={actionBusy === 'spoc'}
              className="shrink-0 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Phone className="h-4 w-4" />
              {actionBusy === 'spoc' ? 'Connecting…' : 'Call'}
            </Button>
          </div>
        </InfoCard>

        {/* CARD: Your details — editable contact fields + reference media. */}
        <InfoCard icon={<User className="h-4 w-4" />} title="Your Details" bodyClassName="space-y-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <Field label="Name" required>
              <input type="text" required value={form.customer_name}
                autoComplete="name"
                onChange={(e) => patch({ customer_name: e.target.value })}
                className={nameError ? `${inputClass} !border-red-400 focus:!border-red-500` : inputClass} />
            </Field>
            <Field label="Mobile">
              {/* Read-only — the customer's OWN number is the identity field on
                  the magic-link JWT; changing it would break the link binding.
                  Shown UNMASKED (it's their own number). */}
              <div className="px-3 py-2 rounded-md bg-slate-100 text-slate-700 text-base font-mono">
                {customerMob}
              </div>
            </Field>
            <Field label="Alternate Contact Name">
              <input type="text" value={form.additional_name}
                autoComplete="name"
                onChange={(e) => patch({ additional_name: e.target.value })} className={inputClass} placeholder="Optional" />
            </Field>
            <Field label="Alternate Mobile">
              <input type="tel" value={form.additional_number}
                autoComplete="tel" inputMode="numeric"
                onChange={(e) => patch({ additional_number: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                className={inputClass} pattern="[0-9]{10}" placeholder="10 Digits" />
            </Field>
            <Field label="Email (For Invoice)">
              <input type="email" value={form.customer_email}
                autoComplete="email" inputMode="email"
                onChange={(e) => patch({ customer_email: e.target.value })} className={inputClass} placeholder="you@example.com" />
            </Field>
          </div>

          {/* Reference media — full-width block below the contact grid so the
              dropzone has room to breathe (a cramped half-column read poorly).
              Label + counter share one row; the tiles sit in a horizontal strip.
              Naturally stacks under the fields on mobile. */}
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <label className="text-xs font-medium text-slate-700">
                Add Reference Photo Of Appliance / Issue
              </label>
              <span className="text-xs text-slate-500">
                Up To 5 Photos ({images.length}/5) · 2 Videos ({videos.length}/2)
              </span>
            </div>
            <div className="mt-2">
              <MediaUploader
                token={token}
                images={images}
                setImages={setImages}
                videos={videos}
                setVideos={setVideos}
              />
            </div>
          </div>
        </InfoCard>

        {/* Contact Support — kept, gated by support_available (no dead-end). */}
        {data?.support_available && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setDialog('support_confirm')}
              disabled={actionBusy === 'support'}
              className="inline-flex items-center gap-1.5 text-sm text-slate-500 underline-offset-4 hover:text-sky-700 hover:underline disabled:opacity-60"
            >
              <LifeBuoy className="h-4 w-4" />
              {actionBusy === 'support' ? 'Connecting…' : 'Contact EasyFix Support'}
            </button>
          </div>
        )}

        {/* Sticky footer action bar. The outer wrapper is a bottom-anchored
            gradient that fades to the page bg (slate-50), so cards dissolve
            into it as they scroll underneath instead of colliding with the
            hard edge of the button bar. The inner bar is solid white with a
            soft upward shadow. Cancel = red, Confirm = blue. */}
        <div className="sticky bottom-0 z-30 bg-gradient-to-t from-slate-50 from-60% via-slate-50/95 to-transparent pb-3 pt-8">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-[0_-2px_16px_rgba(15,23,42,0.10)]">
            <Button
              type="button"
              size="lg"
              onClick={() => setDialog('cancel')}
              className="gap-2 bg-rose-600 text-white hover:bg-rose-700"
            >
              <X className="h-5 w-5" />
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={isSubmitting || !mandatoryCustomPropsComplete}
              className="gap-2 bg-sky-600 text-white hover:bg-sky-700"
            >
              <CheckCircle2 className="h-5 w-5" />
              {isSubmitting ? 'Confirming…' : 'Confirm Details'}
            </Button>
          </div>
        </div>
      </form>

      {/* ── Lightweight inline overlay dialogs (no CRM Dialog import) ────── */}
      {dialog === 'reschedule' && (
        <RescheduleDialog
          reasons={rescheduleReasons}
          busy={actionBusy === 'reschedule'}
          onClose={() => { if (actionBusy !== 'reschedule') setDialog(null); }}
          onSubmit={handleRescheduleSubmit}
        />
      )}
      {dialog === 'cancel' && (
        <CancelDialog
          reasons={cancelReasons}
          busy={actionBusy === 'cancel'}
          onClose={() => { if (actionBusy !== 'cancel') setDialog(null); }}
          onSubmit={handleCancelSubmit}
        />
      )}
      {/* "Need Help" → Call EasyFix SPOC confirmation. Reuses OverlayShell
          (same overlay pattern as Reschedule/Cancel — NOT CRM useConfirm).
          On confirm we close the dialog and run the existing handleSpocCall
          (same toasts / busy state). */}
      {dialog === 'spoc_confirm' && (
        <OverlayShell
          title="Call EasyFix SPOC"
          busy={actionBusy === 'spoc'}
          onClose={() => { if (actionBusy !== 'spoc') setDialog(null); }}
        >
          <p className="text-sm text-slate-600">
            Call EasyFix SPOC? We&apos;ll Connect You To Your EasyFix Point Of Contact.
          </p>
          {/* Masked from→to the bridge will dial — customer visibility, all
              envs. Shared with the CRM operator click-to-call dialog. */}
          <CallLegsPreview
            loading={spocPreview === 'loading'}
            from={asPreviewObj(spocPreview)?.from ?? null}
            to={asPreviewObj(spocPreview)?.to ?? null}
            suppressed={!!asPreviewObj(spocPreview)?.suppressed}
          />
          {/* Shared <Button> at size="lg" so dialog footer matches the rest of
              the page: dismiss = outline, confirm = solid emerald CTA. */}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <Button type="button" size="lg" variant="outline" disabled={actionBusy === 'spoc'}
              onClick={() => { if (actionBusy !== 'spoc') setDialog(null); }}
              className="w-full sm:w-auto">
              Close
            </Button>
            <Button type="button" size="lg" disabled={actionBusy === 'spoc'}
              onClick={() => { setDialog(null); void handleSpocCall(); }}
              className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white">
              {actionBusy === 'spoc' ? 'Connecting…' : 'Call EasyFix SPOC'}
            </Button>
          </div>
        </OverlayShell>
      )}
      {/* "Contact Support" → Call EasyFix Support confirmation. Same pattern as
          the SPOC confirm; shows the shared masked from→to preview and falls
          back gracefully when SUPPORT_PHONE is not configured. */}
      {dialog === 'support_confirm' && (
        <OverlayShell
          title="Contact EasyFix Support"
          busy={actionBusy === 'support'}
          onClose={() => { if (actionBusy !== 'support') setDialog(null); }}
        >
          {supportPreview === 'unavailable' ? (
            <p className="text-sm text-slate-600">
              Support calling isn&apos;t available right now. Please try the EasyFix Point Of Contact above, or reach us through your usual support channel.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Contact EasyFix Support? We&apos;ll Connect You To Our Support Team.
              </p>
              <CallLegsPreview
                loading={supportPreview === 'loading'}
                from={asPreviewObj(supportPreview)?.from ?? null}
                to={asPreviewObj(supportPreview)?.to ?? null}
                suppressed={!!asPreviewObj(supportPreview)?.suppressed}
              />
            </>
          )}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <Button type="button" size="lg" variant="outline" disabled={actionBusy === 'support'}
              onClick={() => { if (actionBusy !== 'support') setDialog(null); }}
              className="w-full sm:w-auto">
              Close
            </Button>
            {supportPreview !== 'unavailable' && (
              <Button type="button" size="lg" disabled={actionBusy === 'support' || supportPreview === 'loading'}
                onClick={() => { setDialog(null); void handleSupportCall(); }}
                className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white">
                {actionBusy === 'support' ? 'Connecting…' : 'Call EasyFix Support'}
              </Button>
            )}
          </div>
        </OverlayShell>
      )}
    </div>
  );
}

// Mobile-first input styling.
//   text-base (16px) — Critical for iOS Safari: any input below 16px
//     triggers an auto-zoom on focus that doesn't reverse when the user
//     looks away, leaving the page mis-scaled. 16px sidesteps the zoom
//     entirely. The desktop look is slightly less dense as a result;
//     acceptable for a customer-facing public form (single-task page).
//   px-3 py-2 — gives ~44px tap height with text-base, meeting the
//     iOS HIG / WCAG touch-target minimum without needing explicit
//     height classes.
const inputClass =
  'flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500';

/*
 * Order header band — a blue brand band with the CLIENT name on the left and a
 * "Fulfilled by EasyFix" pill on the right. The old logo, status chip and the
 * in-header SPOC block were removed; the SPOC now lives in the "Your
 * Coordinator" card in the form body.
 */
function OrderHeader({ clientName }: { clientName: string }) {
  return (
    // Same band treatment as every CRM modal header (see DialogHeader):
    // slate-900 → 700 → 900 gradient + a 3px sky-500 inset underline.
    <div className="rounded-lg bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900 px-5 py-4 text-white shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Order For</div>
      {/* Always side-by-side. On mobile the chip stacks its own two parts
          ("Fulfilled by" over the logo) so it's narrow enough to leave the
          client name real room (it was clipping to "For Testi…"); on sm+ it's
          the inline "Fulfilled by [logo]" — web layout unchanged. */}
      {/* items-end on mobile aligns the client name's baseline with the logo
          (the chip's bottom element), so name ↔ logo read as one line with
          "Fulfilled by" as a caption above. sm+ keeps the centered inline row. */}
      <div className="mt-1 flex items-end justify-between gap-3 sm:items-center">
        <div className="min-w-0 truncate text-2xl font-bold leading-tight">{clientName}</div>
        {/* logo-full.png is light-on-transparent, so it reads directly on the
            dark band (no backing pill needed). */}
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs font-medium text-white/80 sm:flex-row sm:items-center sm:gap-2">
          <span>Fulfilled by</span>
          <Image src="/logo-full.png" alt="EasyFix" width={139} height={34} className="h-5 w-auto" priority />
        </span>
      </div>
    </div>
  );
}

/*
 * Generic white card shell for the redesigned form — mirrors <Section>'s
 * bg-white/rounded/border look but adds a small tinted leading icon and a
 * free-form (non-grid) body. Used for the Service Requested / Address /
 * Appointment / Coordinator / Your Details cards.
 */


/*
 * Reschedule dialog — reason (required, from reschedule_reasons), an optional
 * Preferred Date & Time picker (datetime-local → "YYYY-MM-DD HH:mm"), and an
 * optional Remarks textarea.
 */
function RescheduleDialog({
  reasons, busy, onClose, onSubmit,
}: {
  reasons: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string, preferred: string, remarks: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [preferred, setPreferred] = React.useState('');
  const [remarks, setRemarks] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  return (
    <OverlayShell title="Reschedule Order" onClose={onClose} busy={busy}>
      <Field label="Reason" required>
        <select value={reason} required onChange={(e) => setReason(e.target.value)} className={inputClass}>
          <option value="">— Select A Reason —</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {touched && !reason && <p className="text-xs text-red-600 mt-1">Please Select A Reason.</p>}
      </Field>
      <Field label="Preferred Date & Time">
        <input type="datetime-local" value={preferred}
          min={toDatetimeLocal(new Date().toISOString())}
          onChange={(e) => {
            const minStr = toDatetimeLocal(new Date().toISOString());
            setPreferred(e.target.value && e.target.value < minStr ? minStr : e.target.value);
          }} className={inputClass} />
      </Field>
      <Field label="Remarks">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)}
          rows={3} className={`${inputClass} resize-y`} placeholder="Optional" />
      </Field>
      {/* Shared <Button> footer (size="lg") — dismiss = outline, confirm =
          emerald CTA. Stacks full-width on mobile (flex-col-reverse), inline-
          right on desktop. */}
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
        <Button type="button" size="lg" variant="outline" onClick={onClose} disabled={busy}
          className="w-full sm:w-auto">
          Close
        </Button>
        <Button type="button" size="lg" disabled={busy}
          onClick={() => { setTouched(true); if (reason) onSubmit(reason, preferred, remarks); }}
          className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white">
          {busy ? 'Submitting…' : 'Request Reschedule'}
        </Button>
      </div>
    </OverlayShell>
  );
}

/*
 * Cancel dialog — reason (required, from cancel_reasons) + optional Remarks.
 * Destructive accent on the confirm button.
 */
function CancelDialog({
  reasons, busy, onClose, onSubmit,
}: {
  reasons: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string, remarks: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [remarks, setRemarks] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  return (
    <OverlayShell title="Cancel Order" onClose={onClose} busy={busy}>
      <p className="text-sm text-slate-600">
        Let Us Know Why You&apos;d Like To Cancel — Our Team Will Reach Out To Confirm.
      </p>
      <Field label="Reason" required>
        <select value={reason} required onChange={(e) => setReason(e.target.value)} className={inputClass}>
          <option value="">— Select A Reason —</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {touched && !reason && <p className="text-xs text-red-600 mt-1">Please Select A Reason.</p>}
      </Field>
      <Field label="Remarks">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)}
          rows={3} className={`${inputClass} resize-y`} placeholder="Optional" />
      </Field>
      {/* Shared <Button> footer (size="lg") — dismiss = outline ("Keep Order"),
          confirm = destructive rose. Stacks full-width on mobile, inline-right
          on desktop. */}
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
        <Button type="button" size="lg" variant="outline" onClick={onClose} disabled={busy}
          className="w-full sm:w-auto">
          Keep Order
        </Button>
        <Button type="button" size="lg" variant="destructive" disabled={busy}
          onClick={() => { setTouched(true); if (reason) onSubmit(reason, remarks); }}
          className="w-full sm:w-auto bg-rose-600 hover:bg-rose-700 text-white">
          {busy ? 'Submitting…' : 'Request Cancellation'}
        </Button>
      </div>
    </OverlayShell>
  );
}

function Section({
  title, subtitle, children, cols, action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /* Optional header-aligned action (e.g. the contextual "Update Location" /
   * "Upload Product Photo" buttons that now sit next to the section they
   * act on instead of in a shared top action bar). */
  action?: React.ReactNode;
  /* Responsive layout for the section body:
   *   undefined → single column on every breakpoint (default; use for
   *               full-width sections like Services / Images / Map / Notes).
   *   2         → 1-col on mobile, 2-col on md+ (640px is too tight for two
   *               labelled inputs, so the split kicks in at `md`).
   *   3         → 1-col on mobile, 2-col on md, 3-col on lg+. For sections
   *               with several short single-line fields (e.g. Customer
   *               Details); the wide `max-w-7xl` container fills nicely with
   *               three columns on a desktop while mobile stays a tidy single
   *               column and the inputs never stretch absurdly wide. */
  cols?: 2 | 3;
}) {
  const bodyClass =
    cols === 3
      ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3'
      : cols === 2
      ? 'grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3'
      : 'space-y-3';
  return (
    <div className="bg-white rounded-lg border p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-base font-semibold text-slate-700">{title}</h2>
          {subtitle && <span className="text-xs text-slate-500 shrink-0">{subtitle}</span>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}


/*
 * Pared-down version of `<AddressPickerWithMap />` rebuilt against the
 * public `/api/public/maps/*` endpoints. Differences:
 *   - All BE calls carry `?token=<jwt>` instead of a bearer header.
 *   - Native `<select>` for the city dropdown — keeps the public bundle slim.
 *   - Single-column layout (form fields above the map) — better for mobile.
 *   - Bare debounced fetch for autocomplete; no shared hooks (the public
 *     page intentionally avoids `@/lib/api` and its hook layer).
 */
function AddressMapWidget({
  token, cityOptions, form, patch, mapClickable, mapOnly = false,
}: {
  token: string;
  cityOptions: { value: number; label: string }[];
  form: FormState;
  patch: (p: Partial<FormState>) => void;
  mapClickable: boolean;
  // When true, render ONLY a location-search box + the map. The building /
  // landmark / city / PIN / GPS / instructions inputs are suppressed because
  // the redesigned form already shows those as a disabled Service Address card
  // (+ a separate Address Instructions field), so repeating them here is noise.
  mapOnly?: boolean;
}) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstance = React.useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markerInstance = React.useRef<any>(null);
  const [mapsError, setMapsError] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<Array<{ place_id: string; description: string }>>([]);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  // In mapOnly mode the search box drives a LOCAL query and NEVER writes back to
  // form.address — the booked Service Address must stay exactly as-is; the pin
  // only captures gps_location (for a future navigation flow). In the full form
  // the box stays bound to form.address as before.
  const [searchText, setSearchText] = React.useState('');
  const searchQuery = mapOnly ? searchText : form.address;

  const cityByName = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cityOptions) m.set(c.label.toLowerCase(), c.value);
    return m;
  }, [cityOptions]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await publicFetch<{ apiKey: string | null }>(`/public/maps/config?token=${encodeURIComponent(token)}`);
        if (cancelled) return;
        if (!cfg.apiKey) { setMapsError('Map unavailable — fill the address manually.'); return; }
        const maps = await loadGoogleMaps(cfg.apiKey);
        if (cancelled || !mapRef.current) return;
        const initial = parseLatLng(form.gps_location) || { lat: 28.6139, lng: 77.2090 };
        const map = new maps.Map(mapRef.current, {
          center: initial, zoom: form.gps_location ? 16 : 11,
          mapTypeControl: false, streetViewControl: false,
          // Flag off → static preview: no zoom/UI, gestures + marker drag off.
          disableDefaultUI: !mapClickable,
          gestureHandling: mapClickable ? 'auto' : 'none',
          clickableIcons: mapClickable,
        });
        mapInstance.current = map;
        const marker = new maps.Marker({ position: initial, map, draggable: mapClickable });
        if (mapClickable) {
          marker.addListener('dragend', () => {
            const pos = marker.getPosition();
            if (!pos) return;
            void reverseGeocode(pos.lat(), pos.lng());
          });
        }
        markerInstance.current = marker;
      } catch (e) {
        if (!cancelled) setMapsError(e instanceof Error ? e.message : 'Map unavailable — fill the address manually.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autocomplete — 1s after the last keystroke, fire if length ≥ 3.
  React.useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 3) { setSuggestions([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const r = await publicFetch<{ items: Array<{ place_id: string; description: string; primary: string; secondary: string }> }>(
          `/public/maps/autocomplete?token=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`
        );
        if (cancelled) return;
        setSuggestions(r.items || []);
      } catch { /* Silent — autocomplete is best-effort. */ }
    }, 1000);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  async function reverseGeocode(lat: number, lng: number) {
    // mapOnly: capture GPS only — never overwrite the booked address/city/PIN
    // (and skip the geocode network call, since we don't use its components).
    if (mapOnly) { patch({ gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}` }); return; }
    try {
      const r = await publicFetch<{
        formatted_address?: string;
        address_components?: { postal_code?: string; city?: string };
      }>(`/public/maps/geocode?token=${encodeURIComponent(token)}&latlng=${lat},${lng}`);
      const next: Partial<FormState> = { gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}` };
      if (r.formatted_address) next.address = r.formatted_address;
      const comps = r.address_components || {};
      if (comps.postal_code) next.pin_code = comps.postal_code;
      if (comps.city) {
        const match = cityByName.get(comps.city.toLowerCase());
        if (match) next.city_id = String(match);
      }
      patch(next);
    } catch {
      patch({ gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}` });
    }
  }

  async function pickSuggestion(place_id: string, description: string) {
    setShowSuggestions(false);
    // Reflect the pick in the search box. mapOnly uses a LOCAL field so the
    // booked address is never mutated; the full form writes to form.address.
    if (mapOnly) setSearchText(description); else patch({ address: description });
    try {
      const r = await publicFetch<{
        lat?: number; lng?: number;
        formatted_address?: string;
        address_components?: { postal_code?: string; city?: string };
      }>(`/public/maps/geocode?token=${encodeURIComponent(token)}&place_id=${encodeURIComponent(place_id)}`);
      const next: Partial<FormState> = {};
      if (r.lat != null && r.lng != null) {
        next.gps_location = `${r.lat.toFixed(6)},${r.lng.toFixed(6)}`;
        if (markerInstance.current) markerInstance.current.setPosition({ lat: r.lat, lng: r.lng });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (mapInstance.current) { (mapInstance.current as any).panTo({ lat: r.lat, lng: r.lng }); (mapInstance.current as any).setZoom(16); }
      }
      // mapOnly: GPS coordinates only. Full form: also fill address/PIN/city.
      if (!mapOnly) {
        if (r.formatted_address) next.address = r.formatted_address;
        const comps = r.address_components || {};
        if (comps.postal_code) next.pin_code = comps.postal_code;
        if (comps.city) {
          const match = cityByName.get(comps.city.toLowerCase());
          if (match) next.city_id = String(match);
        }
      }
      patch(next);
    } catch { /* Silent — text already in field, customer can finish manually. */ }
  }

  return (
    /* Address/map split: 2-column grid at md+ (5/7 — inputs on the LEFT,
       map on the RIGHT) to shorten the page. On mobile it collapses to a
       single column and the map stacks BELOW the inputs (DOM order). The
       left column keeps its own vertical rhythm via space-y-3. */
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:items-start">
      {/* LEFT column — all the text inputs (address, building, landmark,
          city, PIN, GPS, instructions). */}
      <div className="md:col-span-5 space-y-3">
      <Field label={mapOnly ? 'Search Your Location' : 'Complete Address'} required={!mapOnly}>
        <div className="relative">
          <textarea
            value={searchQuery}
            onChange={(e) => { if (mapOnly) setSearchText(e.target.value); else patch({ address: e.target.value }); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); }}
            rows={2} required={!mapOnly}
            className={`${inputClass} resize-y`}
            placeholder={mapOnly ? 'Search an address or landmark to drop the pin' : "Start typing — we'll suggest matches"}
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-white border rounded-md shadow-md max-h-64 overflow-y-auto">
              {suggestions.map((s) => (
                <button key={s.place_id} type="button"
                  onMouseDown={(e) => { e.preventDefault(); void pickSuggestion(s.place_id, s.description); }}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100">
                  {s.description}
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>
      {/* In mapOnly mode these inputs are suppressed — the redesigned form
          shows Building / Address / City / Landmark / PIN as a disabled
          Service Address card, and Address Instructions as its own field. */}
      {!mapOnly && (
        <>
      {/* grid-cols-1 on mobile (no horizontal cram of two placeholders
          at 320-400px widths), sm:grid-cols-2 at 640px+ where a phone
          in landscape or a tablet portrait has the room. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Building / Floor">
          <input type="text" value={form.building}
            autoComplete="address-line2"
            onChange={(e) => patch({ building: e.target.value })} className={inputClass} placeholder="House / flat / floor" />
        </Field>
        <Field label="Landmark">
          <input type="text" value={form.landmark}
            onChange={(e) => patch({ landmark: e.target.value })} className={inputClass} placeholder="Optional" />
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="City" required>
          <SearchSelect
            value={form.city_id}
            onChange={(v) => patch({ city_id: v })}
            options={cityOptions}
            placeholder="— Select city —"
            required
          />
        </Field>
        <Field label="PIN Code" required>
          {/* inputMode="numeric" pops the numeric keyboard on iOS/Android
              without the JS keyboard symbol row. autoComplete hints at
              browser address-autofill. */}
          <input type="text" required value={form.pin_code}
            inputMode="numeric" autoComplete="postal-code"
            onChange={(e) => patch({ pin_code: e.target.value.replace(/\D/g, '').slice(0, 6) })}
            className={inputClass} pattern="[0-9]{6}" maxLength={6} placeholder="6 digits" />
        </Field>
      </div>
      <Field label="GPS Coordinates">
        <input type="text" value={form.gps_location}
          onChange={(e) => patch({ gps_location: e.target.value })}
          className={`${inputClass} font-mono`} placeholder="Drag the marker, or paste lat,lng" />
      </Field>
      <Field label="Address Instructions">
        <textarea value={form.address_instruction}
          onChange={(e) => patch({ address_instruction: e.target.value })}
          rows={2} className={`${inputClass} resize-y`}
          placeholder="Landing notes for the technician (optional)" />
      </Field>
        </>
      )}
      </div>
      {/* RIGHT column — the map canvas. Taller fixed height (h-72 → grows to
          fill on md+) so it renders usefully large beside the inputs. The
          maps init logic + the "Map Unavailable" fallback are UNCHANGED — only
          the container's grid placement moved. On mobile this column comes
          AFTER the inputs (single-column stack). */}
      <div className="md:col-span-7">
        <label className="block text-xs font-medium text-slate-600 mb-1">Location On Map</label>
        <div className="relative h-72 md:h-[420px] rounded-md border overflow-hidden bg-slate-50">
          {mapsError ? (
            <div className="absolute inset-0 grid place-items-center text-xs text-slate-500 p-4 text-center">
              <div>
                <div className="font-medium">Map Unavailable</div>
                <div className="mt-1">{mapsError}</div>
                <div className="mt-2 text-[10px] leading-snug">You can still proceed — fill the address fields manually.</div>
              </div>
            </div>
          ) : (
            <div ref={mapRef} className="w-full h-full" />
          )}
        </div>
        {!mapsError && (
          <p className="text-[10px] text-slate-500 mt-1">
            {mapOnly
              ? 'Drag the marker or search to set your exact location. This saves GPS coordinates only — your address stays as booked.'
              : 'Drag the marker to drop a new pin. Address, PIN and City update automatically.'}
          </p>
        )}
      </div>
    </div>
  );
}

/*
 * Media grid with an "Add" tile until the per-kind caps are hit. The BE now
 * hands us a short-TTL presigned GET (`url`) for each item on the public route,
 * so tiles render the actual photo / a video poster and tap to enlarge/play in
 * a lightbox. Items without a `url` (older uploads / transient presign miss)
 * fall back to a text tile — never a broken image.
 */
// Per-kind caps + size ceilings — keep in sync with the BE in
// routes/public/job-completion.js (MAX_PHOTOS_PER_JOB / MAX_VIDEOS_PER_JOB /
// MAX_IMAGE_BYTES / MAX_VIDEO_BYTES). Both sides cap independently so neither
// trusts the other; a mismatch surfaces a clear FE message before the upload.
const MAX_PHOTOS = 5;
const MAX_VIDEOS = 2;
const MAX_IMAGE_MB = 5;
const MAX_VIDEO_MB = 50;
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/3gpp', 'video/webm']);
const ACCEPT_ATTR = [...PHOTO_MIMES, ...VIDEO_MIMES].join(',');

/*
 * Extract a poster-frame thumbnail (~first frame) from a picked video File,
 * entirely client-side — gives the customer instant visual confirmation of
 * what they uploaded without any BE thumbnailing. Loads the file into an
 * off-DOM <video>, seeks just past the start (0 can be a black frame on some
 * encoders), draws to a downscaled canvas, returns a JPEG data URL. Best-effort:
 * resolves null on any failure (unsupported codec, decode error, timeout) so
 * the tile falls back to the play-glyph. Never throws.
 */
function extractVideoPoster(file: File, maxEdge = 144): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let url: string | null = null;
    const done = (val: string | null) => {
      if (settled) return;
      settled = true;
      if (url) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
      resolve(val);
    };
    try {
      url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.crossOrigin = 'anonymous';
      // Safety net — some codecs never fire `seeked`/`loadeddata`.
      const timer = setTimeout(() => done(null), 4000);
      const grab = () => {
        try {
          const vw = video.videoWidth, vh = video.videoHeight;
          if (!vw || !vh) { clearTimeout(timer); return done(null); }
          const scale = Math.min(1, maxEdge / Math.max(vw, vh));
          const cw = Math.max(1, Math.round(vw * scale));
          const ch = Math.max(1, Math.round(vh * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext('2d');
          if (!ctx) { clearTimeout(timer); return done(null); }
          ctx.drawImage(video, 0, 0, cw, ch);
          clearTimeout(timer);
          done(canvas.toDataURL('image/jpeg', 0.6));
        } catch { clearTimeout(timer); done(null); }
      };
      video.addEventListener('seeked', grab, { once: true });
      video.addEventListener('loadeddata', () => { try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); } catch { grab(); } }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); done(null); }, { once: true });
      video.src = url;
    } catch { done(null); }
  });
}

function MediaUploader({
  token, images, setImages, videos, setVideos,
}: {
  token: string;
  images: ImageRow[];
  setImages: React.Dispatch<React.SetStateAction<ImageRow[]>>;
  videos: VideoRow[];
  setVideos: React.Dispatch<React.SetStateAction<VideoRow[]>>;
}) {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  // Full-screen preview: tap a photo to enlarge, tap a video to play. src is a
  // short-TTL presigned URL from the BE (image tiles) or the same for playback.
  const [lightbox, setLightbox] = React.useState<{ type: 'image' | 'video'; src: string } | null>(null);

  React.useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  async function handleFile(file: File) {
    setUploadError(null);
    const mime = file.type || '';
    const isPhoto = PHOTO_MIMES.has(mime);
    const isVideo = VIDEO_MIMES.has(mime);
    if (!isPhoto && !isVideo) {
      setUploadError('Unsupported file. Please share a photo (JPEG/PNG/WebP/GIF) or short video (MP4/MOV/3GP/WebM).');
      return;
    }
    // Pre-flight cap & size so the customer gets an instant message instead of
    // burning a multipart roundtrip just for the BE to reject it.
    if (isPhoto && images.length >= MAX_PHOTOS) {
      setUploadError(`Maximum ${MAX_PHOTOS} photos reached.`);
      return;
    }
    if (isVideo && videos.length >= MAX_VIDEOS) {
      setUploadError(`Maximum ${MAX_VIDEOS} videos reached.`);
      return;
    }
    const limitMb = isPhoto ? MAX_IMAGE_MB : MAX_VIDEO_MB;
    if (file.size > limitMb * 1024 * 1024) {
      setUploadError(`${isPhoto ? 'Photo' : 'Video'} too large — maximum size is ${limitMb}MB.`);
      return;
    }

    setUploading(true);
    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${apiBase}/public/job-completion/${encodeURIComponent(token)}/images`, {
        method: 'POST', credentials: 'omit', body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.data) throw new Error(body?.error || 'Upload failed');
      const d = body.data as { kind?: 'image' | 'video'; image_id?: number; media_id?: number; key?: string; image?: string; url?: string | null };
      // BE writes `key` for both kinds (and keeps the legacy `image` alias for
      // older deploys). Newer responses also carry the `kind` discriminator and
      // a short-TTL presigned `url` we render as the thumbnail / lightbox source.
      const key = d.key || d.image || '';
      const url = d.url ?? null;
      if (d.kind === 'video' && d.media_id) {
        // Generate the poster from the just-picked File (best-effort). We have
        // the local File here, so no extra network — the customer sees a real
        // frame immediately. Falls back to null → play-glyph tile.
        const poster = isVideo ? await extractVideoPoster(file) : null;
        setVideos((prev) => [...prev, { media_id: d.media_id!, key, poster, url }]);
      } else if (d.image_id) {
        setImages((prev) => [...prev, { image_id: d.image_id!, key, url }]);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteImage(imageId: number) {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || '/api'}/public/job-completion/${encodeURIComponent(token)}/images/${imageId}`,
        { method: 'DELETE', credentials: 'omit' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Delete failed');
      }
      setImages((prev) => prev.filter((i) => i.image_id !== imageId));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function handleDeleteVideo(mediaId: number) {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || '/api'}/public/job-completion/${encodeURIComponent(token)}/videos/${mediaId}`,
        { method: 'DELETE', credentials: 'omit' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Delete failed');
      }
      setVideos((prev) => prev.filter((v) => v.media_id !== mediaId));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const photoFull = images.length >= MAX_PHOTOS;
  const videoFull = videos.length >= MAX_VIDEOS;
  const fullyFull = photoFull && videoFull;

  return (
    <>
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((img, idx) => (
          <div key={`img-${img.image_id}`}
            className="relative w-[72px] h-[72px] rounded-md border bg-slate-100 overflow-hidden">
            {img.url ? (
              // Real thumbnail — tap to enlarge in the lightbox.
              <button type="button" onClick={() => setLightbox({ type: 'image', src: img.url! })}
                className="absolute inset-0 h-full w-full" aria-label={`View photo ${idx + 1}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={`Photo ${idx + 1}`} className="h-full w-full object-cover" />
              </button>
            ) : (
              // Presign missing (older upload / transient S3 issue) → text tile.
              <div className="absolute inset-0 flex items-center justify-center text-center">
                <div>
                  <div className="text-[10px] text-slate-500">Photo</div>
                  <div className="text-xs font-semibold text-slate-700">#{idx + 1}</div>
                  <div className="text-[9px] text-emerald-600 font-medium">uploaded</div>
                </div>
              </div>
            )}
            <button type="button" onClick={() => handleDeleteImage(img.image_id)}
              className="absolute z-10 -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold leading-none flex items-center justify-center hover:bg-red-600"
              aria-label="Remove photo">×</button>
          </div>
        ))}
        {videos.map((vid, idx) => (
          <div key={`vid-${vid.media_id}`}
            className="relative w-[72px] h-[72px] rounded-md border bg-slate-800 text-white overflow-hidden">
            {/* The whole tile is a play button when we have a playback URL:
                poster-frame thumbnail (just-picked video) + play-glyph overlay.
                Tap → lightbox <video>. Falls back to a non-clickable dark tile
                with the glyph when neither poster nor url is available yet. */}
            <button type="button"
              onClick={() => { if (vid.url) setLightbox({ type: 'video', src: vid.url }); }}
              disabled={!vid.url}
              className="absolute inset-0 flex h-full w-full items-center justify-center disabled:cursor-default"
              aria-label={`Play video ${idx + 1}`}>
              {vid.poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={vid.poster} alt={`Video ${idx + 1} preview`} className="absolute inset-0 h-full w-full object-cover" />
              )}
              <span className="relative z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/45">
                <svg viewBox="0 0 24 24" className="h-4 w-4 opacity-95" fill="currentColor" aria-hidden>
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </button>
            <div className="pointer-events-none absolute z-10 bottom-0 inset-x-0 text-[9px] text-center bg-black/60 py-0.5">
              Video #{idx + 1}
            </div>
            <button type="button" onClick={() => handleDeleteVideo(vid.media_id)}
              className="absolute z-20 -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold leading-none flex items-center justify-center hover:bg-red-600"
              aria-label="Remove video">×</button>
          </div>
        ))}
        {!fullyFull && (
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}
            className="w-[72px] h-[72px] rounded-md border-2 border-dashed border-slate-300 text-slate-500 hover:border-sky-400 hover:text-sky-600 transition flex flex-col items-center justify-center text-[11px] leading-tight">
            {uploading ? '…' : (<><span>+ Add</span><span className="text-[9px]">Photo / Video</span></>)}
          </button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
      {fullyFull && <p className="text-xs text-slate-500">Maximum {MAX_PHOTOS} photos and {MAX_VIDEOS} videos reached.</p>}
      {!fullyFull && (photoFull || videoFull) && (
        <p className="text-xs text-slate-500">
          {photoFull ? `Photo limit reached (${MAX_PHOTOS}). You can still add a video.` : `Video limit reached (${MAX_VIDEOS}). You can still add a photo.`}
        </p>
      )}
      {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
    </div>

    {/* Full-screen preview overlay — tap backdrop / Esc / ✕ to dismiss.
        Inner wrapper stops propagation so taps on the media don't close it. */}
    {lightbox && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        role="dialog" aria-modal="true"
        onClick={() => setLightbox(null)}
      >
        <button type="button" onClick={() => setLightbox(null)}
          className="absolute top-4 right-4 text-white/80 hover:text-white" aria-label="Close preview">
          <X className="h-7 w-7" />
        </button>
        <div className="max-h-[85vh] max-w-3xl" onClick={(e) => e.stopPropagation()}>
          {lightbox.type === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lightbox.src} alt="Preview" className="max-h-[85vh] max-w-full rounded-lg object-contain" />
          ) : (
            <video src={lightbox.src} controls autoPlay playsInline
              className="max-h-[85vh] max-w-full rounded-lg" />
          )}
        </div>
      </div>
    )}
    </>
  );
}
