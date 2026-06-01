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
import { Plus, X, CalendarClock, Ban, CheckCircle2, LifeBuoy, ExternalLink } from 'lucide-react';
import * as React from 'react';
import type { PrefillResponse, SubmitPayload } from '@/lib/magic-link-types';
// Pure presentational chip — no auth dependency, safe on the public page.
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
// Shared presentational Button (cva-based, no auth dependency → safe on the
// public page). Used for every button on the page so size/font/padding match;
// colour is differentiated via `variant` + `className`, NOT by `size`.
import { Button } from '@/components/ui/button';

/*
 * Bare public-fetch helper. Mirrors the success envelope of `@/lib/api`
 * (`{ success, data }`) but:
 *   - never sends credentials/cookies (`credentials: 'omit'`)
 *   - never attaches Authorization header
 *   - throws a typed object exposing `{status, code, message}` so the page
 *     can dispatch on HTTP status (410/401) without ApiError class checks.
 */
async function publicFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
  const res = await fetch(`${apiBase}${url}`, { ...init, credentials: 'omit' });
  let body: { success?: boolean; data?: T; error?: string; code?: string } = {};
  try { body = await res.json(); } catch { /* defensive */ }
  if (!res.ok) {
    // eslint-disable-next-line no-throw-literal
    throw { status: res.status, code: body?.code, message: body?.error || 'Request failed' };
  }
  return body.data as T;
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PrefillResponse }
  | { kind: 'submitting'; data: PrefillResponse }
  | { kind: 'submitted' }
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

type ImageRow = { image_id: number; key: string };

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

/*
 * Map the legacy numeric job-status code (order_status) to a StatusChip
 * tone. We key on the human label first (resilient to code drift between
 * deploys) and fall back to the numeric code, then to slate. Mapping per
 * the spec: Unconfirmed→amber, Booked/Scheduled→sky, Completed→emerald,
 * Cancelled→red, else slate.
 */
function statusTone(label: string | undefined, code: number | null | undefined): StatusChipTone {
  const l = (label || '').toLowerCase();
  if (l.includes('cancel')) return 'red';
  if (l.includes('complete')) return 'emerald';
  if (l.includes('book') || l.includes('schedul')) return 'sky';
  if (l.includes('unconfirm')) return 'amber';
  // Numeric fallback for deploys that don't send a label: 9=Unconfirmed.
  if (code === 9) return 'amber';
  return 'slate';
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
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [missingFields, setMissingFields] = React.useState<string[]>([]);
  const [customProps, setCustomProps] = React.useState<Map<string, CustomProp>>(new Map());

  // ── Customer-facing order-page additions ────────────────────────────────
  // Toast: a single ephemeral status line for the click-to-call / request
  // actions (auto-dismisses). Kept lightweight — no toast library on the
  // public bundle.
  const [toast, setToast] = React.useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = React.useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  React.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Which secondary action is mid-flight (disables its button + shows a
  // spinner-ish label). Calling actions hit click-to-call endpoints.
  const [actionBusy, setActionBusy] = React.useState<null | 'spoc' | 'reschedule' | 'cancel'>(null);
  // Inline overlay dialogs (no CRM Dialog import — plain styled overlays).
  // `spoc_confirm` is the "Need Help" → Call EasyFix SPOC confirmation step
  // (reuses OverlayShell; on confirm it runs handleSpocCall).
  const [dialog, setDialog] = React.useState<null | 'reschedule' | 'cancel' | 'spoc_confirm'>(null);

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
          services: seededServices,
        });
        setCustomProps(props);
        setImages(data.images.map((i) => ({ image_id: i.image_id, key: i.key })));
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
  if (state.kind === 'submitted') return (
    <FullPageMessage title="Thank You" message="Order Confirmed — Our Team Will Finalise The Schedule Shortly. You Can Close This Page." />
  );

  const data = state.data;
  const isSubmitting = state.kind === 'submitting';
  if (!form) return null;

  // Per-client custom-prop convenience flags. `branchProp`/etc. are present
  // only when the client has the matching row in tbl_client_custom_properties;
  // when absent we skip rendering the input AND skip gating on it.
  const branchProp   = customProps.get('branch_details');
  const buildingProp = customProps.get('building_name');
  const productProp  = customProps.get('product_code');

  // Submit-button gate mirror of `section1Complete` in JobModal.tsx
  // (CRM Book-New-Call). Disables Submit when ANY mandatory custom-prop
  // input is empty so the customer can't bypass the requirement by
  // clicking through; the missing-fields banner above still catches the
  // case where they manage to submit anyway (e.g. older browser
  // ignoring `required`).
  const mandatoryCustomPropsComplete =
    (!branchProp   || !branchProp.mandatory   || !!form.branch_details.trim()) &&
    (!buildingProp || !buildingProp.mandatory || !!form.building_name.trim()) &&
    (!productProp  || !productProp.mandatory  || !!form.product_code.trim());

  const patch = (p: Partial<FormState>) => setForm((f) => (f ? { ...f, ...p } : f));

  const toggleService = (id: number) => {
    setForm((f) => {
      if (!f) return f;
      const next = new Map(f.services);
      if (next.has(id)) next.delete(id); else next.set(id, 1);
      return { ...f, services: next };
    });
  };
  const setServiceQty = (id: number, qty: number) => {
    setForm((f) => {
      if (!f) return f;
      const next = new Map(f.services);
      if (next.has(id)) next.set(id, Math.max(1, Math.min(99, qty || 1)));
      return { ...f, services: next };
    });
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const missing: string[] = [];
    if (!form.customer_name.trim()) missing.push('Customer Name');
    if (!form.address.trim()) missing.push('Address');
    if (!form.city_id) missing.push('City');
    if (!/^\d{6}$/.test(form.pin_code)) missing.push('PIN Code (6 digits)');
    if (!form.time_slot) missing.push('Time Slot');
    if (!form.requested_date_time) missing.push('Requested Date & Time');
    // Mirror JobModal `section1Complete`: only enforce when the client has
    // the prop AND it's marked mandatory. Reuse the BE-provided label when
    // present so the missing-fields banner reads in the client's own
    // wording where they've customised it.
    if (branchProp?.mandatory && !form.branch_details.trim()) {
      missing.push(branchProp.label || 'Branch Details');
    }
    if (buildingProp?.mandatory && !form.building_name.trim()) {
      missing.push(buildingProp.label || 'Property / Building Name');
    }
    if (productProp?.mandatory && !form.product_code.trim()) {
      missing.push(productProp.label || 'Product Code');
    }
    if (missing.length) {
      setMissingFields(missing);
      setSubmitError(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setMissingFields([]);
    setSubmitError(null);

    const payload: SubmitPayload = {
      customer_name: form.customer_name.trim(),
      customer_email: form.customer_email.trim() || undefined,
      address: form.address.trim(),
      building: form.building.trim() || undefined,
      landmark: form.landmark.trim() || undefined,
      city_id: Number(form.city_id),
      pin_code: form.pin_code,
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
      branch_details: branchProp && form.branch_details.trim()
        ? form.branch_details.trim() : undefined,
      building_name: buildingProp && form.building_name.trim()
        ? form.building_name.trim() : undefined,
      product_code: productProp && form.product_code.trim()
        ? form.product_code.trim() : undefined,
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

  // (Contact Support click-to-call removed — the header "Need Help" affordance
  // now routes through the SPOC-call confirmation flow instead. The BE
  // /support-call endpoint remains but is no longer invoked from this page.)

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
      showToast('Reschedule Requested — Our Team Will Get Back To You.', 'ok');
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
      showToast('Cancellation Requested — Our Team Will Reach Out.', 'ok');
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
  const orderStatusLabel = data.order_status_label || 'Order';
  const tone = statusTone(data.order_status_label, data.order_status);
  const jobId = data.job_id ?? data.jobId;
  const clientName = data.client_name || data.client.name;
  const spoc = data.spoc;
  const mapsLink = data.maps_link || null;
  const cancelReasons = data.cancel_reasons ?? [];
  const rescheduleReasons = data.reschedule_reasons ?? [];
  const customerMob = data.customer_mob || data.customer.mobile;

  return (
    <div className="space-y-4">
      {/* Order header: logo + status chip + Job ID + client name, plus the
          relocated SPOC contact block on the right. The "Need Help?…" line is
          the clickable affordance that opens the Call-EasyFix-SPOC
          confirmation flow; the SPOC name + masked number sit beneath it. The
          old standalone "Your EasyFix Point Of Contact" section was removed —
          its identity + Need-Help wiring now live entirely in the header. */}
      <OrderHeader
        clientName={clientName}
        jobId={jobId}
        statusLabel={orderStatusLabel}
        tone={tone}
        spocName={spoc?.name || null}
        spocMobileMasked={spoc?.mobile_masked || null}
        onNeedHelp={() => setDialog('spoc_confirm')}
        needHelpBusy={actionBusy === 'spoc'}
      />

      {/* Ephemeral toast for the click-to-call / request actions. */}
      {toast && (
        <div
          role="status"
          className={`rounded-md px-4 py-3 text-sm border ${
            toast.tone === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          {toast.text}
        </div>
      )}

      {missingFields.length > 0 && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">
          <div className="font-semibold mb-1">Please fill the following before submitting:</div>
          <ul className="list-disc list-inside">
            {missingFields.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
      {submitError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">{submitError}</div>
      )}

      {/* (The Reschedule / Cancel cluster that used to sit here near the top
          order summary was MOVED to the bottom action row, alongside the
          primary Confirm Order button — see the foot of the form.) */}

      <form id="order-form" onSubmit={handleSubmit} className="space-y-6">
        {/* Short single-line fields: 1-col mobile → 2-col md → 3-col lg so the
            wide desktop container fills cleanly; mobile stays single column. */}
        <Section title="Customer Details" cols={3}>
          {/* Mobile-keyboard hints (autoComplete + inputMode) on every
              field with a clear semantic match — pops the right keyboard
              and triggers browser autofill where the customer has saved
              contact info. autoComplete="name" / "email" / "tel"
              correspond to the WHATWG autofill tokens. */}
          <Field label="Name" required>
            <input type="text" required value={form.customer_name}
              autoComplete="name"
              onChange={(e) => patch({ customer_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Customer Phone">
            {/* Read-only — the customer's OWN number is the identity field on
                the magic-link JWT and changing it would break the link's
                binding to the job. Shown UNMASKED (it's their own number).
                Promoted to text-base (16px) for legibility on small screens;
                the slate-100 background distinguishes "not editable" from
                the white-bg editable inputs above/below. */}
            <div className="px-3 py-2 rounded-md bg-slate-100 text-slate-700 text-base font-mono">
              {customerMob}
            </div>
          </Field>
          <Field label="Email">
            <input type="email" value={form.customer_email}
              autoComplete="email" inputMode="email"
              onChange={(e) => patch({ customer_email: e.target.value })} className={inputClass} placeholder="you@example.com" />
          </Field>
          <Field label="Alternate Contact Name">
            <input type="text" value={form.additional_name}
              autoComplete="name"
              onChange={(e) => patch({ additional_name: e.target.value })} className={inputClass} placeholder="Optional" />
          </Field>
          <Field label="Alternate Contact Number">
            <input type="tel" value={form.additional_number}
              autoComplete="tel" inputMode="numeric"
              onChange={(e) => patch({ additional_number: e.target.value.replace(/\D/g, '').slice(0, 10) })}
              className={inputClass} pattern="[0-9]{10}" placeholder="10 digits" />
          </Field>
        </Section>

        {/* The standalone "Your EasyFix Point Of Contact" section was REMOVED —
            the SPOC identity + Need-Help/Call affordance now live in the page
            header (see OrderHeader's right-aligned contact block). */}

        {/* Address + map. The address + map are editable inline (autocomplete
            + draggable marker), so no separate "Update Location" shortcut is
            needed. Saving location is part of the Confirm/submit flow. */}
        <Section title="Address">
          {/* "Open In Google Maps" deep link — hidden when no GPS pin set. */}
          {mapsLink && (
            <a
              href={mapsLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-sky-600 hover:text-sky-700 hover:underline mb-1"
            >
              <ExternalLink className="h-4 w-4" />
              Open In Google Maps
            </a>
          )}
          <AddressMapWidget token={token} cityOptions={data.cityOptions} form={form} patch={patch} />
        </Section>

        {/* Per-client custom-property inputs. Mirrors the CRM Book-New-Call
            flow (JobModal.tsx → Branch Details / Property or Building Name /
            Product Code). Renders ONLY the inputs the client has configured
            in tbl_client_custom_properties; mandatory flag drives both the
            red asterisk + native `required` attribute + the Submit-button
            gate above. Placed adjacent to Address since these fields are
            typically address-context (which branch / which property / which
            product line is the service for). */}
        {(branchProp || buildingProp || productProp) && (
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
          </Section>
        )}

        {/* 2-col on md+: Requested Date & Time on the left, the auto-derived
            Time Slot indicator on the right. Both stack to full width on
            mobile. The customer picks date+time ONCE via the single
            datetime-local control; the slot is computed from that pick. */}
        <Section title="Appointment Date & Time" cols={2}>
          <Field label="Requested Date & Time" required>
            {/* Single datetime picker — the only control here. Picking a value
                also AUTO-derives the Time Slot (deriveTimeSlot), so the slot
                indicator on the right and the submitted time_slot always
                follow the picked time. The old read-only echo line was
                removed (the picker itself shows the value). */}
            <input type="datetime-local" required value={form.requested_date_time}
              onChange={(e) => patch({
                requested_date_time: e.target.value,
                time_slot: deriveTimeSlot(e.target.value),
              })} className={inputClass} />
          </Field>
          <Field label="Time Slot" required>
            {/* DISPLAY-ONLY slot indicators — the derived slot is highlighted;
                the buttons are disabled (no onClick), so the customer cannot
                pick a slot directly. The slot is set purely from the picked
                date+time above. */}
            <div className="flex flex-wrap gap-2">
              {data.timeSlots.length === 0 ? (
                <div className="text-xs text-slate-500">No time slots available. Please contact support.</div>
              ) : data.timeSlots.map((slot) => (
                <span key={slot} className={`px-3 py-2 rounded-md border text-sm select-none ${
                  form.time_slot === slot
                    ? 'bg-sky-600 text-white border-sky-600'
                    : 'bg-slate-50 text-slate-400 border-slate-200'
                }`}>
                  {slot}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              Auto-Selected From The Date &amp; Time You Pick.
            </p>
          </Field>
        </Section>

        <Section title="Services">
          {/* Customer-facing service picker, rendered as a proper TABLE with
              distinct columns (Action | Service Name | Category | Type | Qty)
              rather than cards with the qty + Free/Paid tag inline after the
              name. Form-state wiring is unchanged: `form.services` is a
              Map<client_service_id, qty>; toggleService adds/removes,
              setServiceQty updates. The submit-payload mapping is untouched —
              only the LAYOUT changed.

              Columns:
                - Action: green "+" to add; once added, a rose "×" to remove.
                - Service Name: service_name ?? service_type_name ?? "Service #<id>".
                - Category: service_catg_name.
                - Type: the Free/Paid value as a small chip (billing_label).
                - Qty: numeric input ONLY when added (else "—"); min 1, max 100.

              The table is wrapped in an overflow-x-auto container so it stays
              usable on narrow phones (horizontal scroll fallback) while
              reading as a clean compact table on wider screens. */}
          {data.services.length === 0 ? (
            <div className="text-xs text-slate-500">No Services Available For This Client.</div>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
                    <th className="px-2 py-2 w-10"><span className="sr-only">Add or remove</span></th>
                    <th className="px-2 py-2">Service Name</th>
                    <th className="px-2 py-2">Category</th>
                    <th className="px-2 py-2">Type</th>
                    <th className="px-2 py-2 w-24">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {data.services.map((s) => {
                    const selected = form.services.has(s.client_service_id);
                    const qty = form.services.get(s.client_service_id) ?? 1;
                    // Name resolution: prefer the rate-card label, fall back to
                    // the service-type name, then never render blank.
                    const primaryName =
                      (s.service_name && s.service_name.trim()) ||
                      (s.service_type_name && s.service_type_name.trim()) ||
                      `Service #${s.client_service_id}`;
                    return (
                      <tr
                        key={s.client_service_id}
                        className={`border-b border-slate-100 transition-colors ${
                          selected ? 'bg-sky-50/60' : 'hover:bg-slate-50'
                        }`}
                      >
                        {/* Action column: green "+" → rose "×" once added. */}
                        <td className="px-2 py-2 align-middle">
                          {selected ? (
                            <button
                              type="button"
                              onClick={() => toggleService(s.client_service_id)}
                              aria-label={`Remove ${primaryName}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-600 hover:bg-rose-50 hover:text-rose-700 transition-colors"
                            >
                              <X className="h-5 w-5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleService(s.client_service_id)}
                              aria-label={`Add ${primaryName}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-emerald-300 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                            >
                              <Plus className="h-5 w-5" />
                            </button>
                          )}
                        </td>
                        {/* Service Name column. */}
                        <td className="px-2 py-2 align-middle font-medium text-slate-800">
                          {primaryName}
                        </td>
                        {/* Category column. */}
                        <td className="px-2 py-2 align-middle text-slate-600">
                          {s.service_catg_name || '—'}
                        </td>
                        {/* Type column — Free (emerald) / Paid (amber) chip. */}
                        <td className="px-2 py-2 align-middle">
                          {s.billing_label ? (
                            <StatusChip tone={s.billing_label === 'Free' ? 'emerald' : 'amber'} size="sm">
                              {s.billing_label}
                            </StatusChip>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        {/* Qty column — numeric input only when added. */}
                        <td className="px-2 py-2 align-middle">
                          {selected ? (
                            <input
                              type="number"
                              min={1}
                              max={99}
                              value={qty}
                              inputMode="numeric"
                              onChange={(e) => setServiceQty(s.client_service_id, Number(e.target.value))}
                              className={`w-16 ${inputClass} text-center px-2`}
                              aria-label={`Quantity for ${primaryName}`}
                            />
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* Intentionally NO prices — public flow per spec. */}
        </Section>

        {/* Product Photos. The inline "+ Add" tile already opens the file
            picker, so the redundant header-level "Upload Product Photo"
            trigger has been removed. */}
        <Section
          title="Product Photos"
          subtitle={`Up to 5 images (${images.length}/5)`}
        >
          <ImageUploader
            token={token}
            images={images}
            setImages={setImages}
          />
        </Section>

        <Section title="Product Details / Notes">
          <Field label="Product Details / Description / Remarks">
            <textarea value={form.job_desc} onChange={(e) => patch({ job_desc: e.target.value })}
              rows={3} className={`${inputClass} resize-y`}
              placeholder="Anything else our technician should know?" />
          </Field>
        </Section>

        {/* Bottom action row — the FOOT-of-form action cluster, restyled into
            a clear THREE-TIER visual hierarchy (most → least prominent) so the
            three actions read as distinct weights, no two alike:
              - Confirm Order   → PRIMARY: solid emerald filled CTA (unchanged).
              - Reschedule Order → SECONDARY: SOFT-FILLED amber (tinted bg, not
                a plain white-outline) — a real but lower-weight action.
              - Cancel Order     → TERTIARY / destructive-exit: a rose GHOST/
                text button (no solid border) — the rarest, most destructive
                action, so it invites the least and is visually unlike the
                amber soft-fill.
              Desktop (sm+): single right-aligned row, ordered Cancel ·
                Reschedule · Confirm so the primary emerald button reads last
                (rightmost / most prominent).
              Mobile (default): stack full-width with Confirm on TOP (primary
                first), then Reschedule, then Cancel — achieved via
                flex-col-reverse over the DOM order (Cancel, Reschedule,
                Confirm) so desktop keeps Confirm rightmost while mobile puts
                Confirm topmost. All three keep min ~44px tap height on mobile
                (py-2.5/py-3) so the ghost Cancel is still obviously tappable. */}
        {/* All three now use the shared <Button> at size="lg" (same h-10
            height + text-sm font + padding) so they're dimensionally
            identical; only COLOUR differs (variant + className), giving a
            clean three-tier read without size mismatch. DOM order is
            Cancel · Reschedule · Confirm; flex-col-reverse puts Confirm on
            TOP on mobile (full-width stack) while desktop keeps it rightmost. */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:items-center">
          {/* TERTIARY — rose outline on white (proper border + bg, not bare ghost). */}
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => setDialog('cancel')}
            className="w-full sm:w-auto gap-2 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
          >
            <Ban className="h-4 w-4" />
            Cancel Order
          </Button>
          {/* SECONDARY — amber outline-tint. */}
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => setDialog('reschedule')}
            className="w-full sm:w-auto gap-2 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:text-amber-900"
          >
            <CalendarClock className="h-4 w-4" />
            Reschedule Order
          </Button>
          {/* PRIMARY — solid emerald CTA (override the default blue). */}
          <Button
            type="submit"
            size="lg"
            disabled={isSubmitting || !mandatoryCustomPropsComplete}
            className="w-full sm:w-auto gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <CheckCircle2 className="h-5 w-5" />
            {isSubmitting ? 'Confirming…' : 'Confirm Order'}
          </Button>
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
 * Order header band — dark-slate brand band carrying the EasyFix logo,
 * order status chip, Job ID and Client Name. The StatusChip tone is computed
 * by the caller from order_status_label / order_status.
 *
 * The logo replaces the old "EASYFIX" wordmark with the same `/logo-full.png`
 * asset the login screen uses (cyan-on-transparent), giving brand consistency.
 * The band is itself dark-slate so the logo doesn't need its own pill — it
 * reads directly on the band (login wraps it in a pill only because that card
 * is white).
 *
 * Right-aligned SPOC contact block: the "Need Help?…" line is the clickable
 * affordance that opens the Call-EasyFix-SPOC confirmation dialog; the SPOC
 * name + masked number sit muted/smaller beneath it. The WHOLE block is
 * hidden when no SPOC is mapped (spocName == null) so we never show a dangling
 * Need-Help line with no contact. On mobile the block stacks below the
 * logo/status (flex-col → sm:flex-row) and the text aligns left; on desktop it
 * right-aligns.
 */
function OrderHeader({
  clientName, jobId, statusLabel, tone, spocName, spocMobileMasked, onNeedHelp, needHelpBusy,
}: {
  clientName: string;
  jobId: number | undefined;
  statusLabel: string;
  tone: StatusChipTone;
  spocName: string | null;
  spocMobileMasked: string | null;
  onNeedHelp: () => void;
  needHelpBusy: boolean;
}) {
  return (
    <div className="bg-slate-900 text-white rounded-lg px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3 min-w-0">
        {/* Same logo asset as the login screen (next/image, unoptimized). */}
        <Image
          src="/logo-full.png" alt="EasyFix"
          width={139} height={34} priority unoptimized
          className="h-8 w-auto shrink-0"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusChip tone={tone}>{statusLabel}</StatusChip>
            {jobId != null && (
              <span className="text-xs text-slate-300">Order #{jobId}</span>
            )}
          </div>
          <div className="font-semibold text-base mt-1 truncate">{clientName}</div>
        </div>
      </div>
      {/* Right-aligned SPOC contact block — relocated from the old standalone
          section. Hidden entirely when no SPOC is mapped. The "Need Help?…"
          line opens the Call-EasyFix-SPOC confirmation dialog; the identity
          line below shows name · masked number. */}
      {/* Responsive guard: on mobile this block sits full-width below the
          logo/status and aligns LEFT; on sm+ it shrinks and right-aligns.
          The long "Need Help?" label wraps (items-start + text-left) instead
          of overflowing the 360px band, and the SPOC identity line breaks
          words so a long name/number can't push the layout sideways. */}
      {spocName && (
        <div className="w-full sm:w-auto shrink-0 text-left sm:text-right">
          <button
            type="button"
            onClick={onNeedHelp}
            disabled={needHelpBusy}
            className="inline-flex items-start sm:items-center gap-1.5 text-sm font-medium text-sky-300 hover:text-sky-200 disabled:opacity-50 text-left"
          >
            <LifeBuoy className="h-4 w-4 shrink-0 mt-0.5 sm:mt-0" />
            <span>{needHelpBusy ? 'Connecting…' : 'Need Help? Connect With Your EasyFix Point Of Contact'}</span>
          </button>
          <div className="text-xs text-slate-400 mt-0.5 break-words">
            {spocName}
            {spocMobileMasked && (
              <span className="font-mono"> · {spocMobileMasked}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/*
 * Shared overlay shell for the Reschedule / Cancel dialogs. Plain fixed
 * overlay + centered card — deliberately NOT the CRM `Dialog` (which would
 * drag in auth-coupled shared code). Mobile-friendly: full-width card with
 * generous padding, click-outside to dismiss.
 */
function OverlayShell({
  title, onClose, busy, children,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      {/* Responsive card: bottom-sheet on mobile (full-width, rounded top,
          no side gap because the sheet hugs the screen edge), centered
          max-w-md card on desktop. max-h-[90vh] + overflow-y-auto keeps it
          scrollable on short viewports; overflow-x-hidden + the w-full body
          inputs (inputClass = `flex w-full text-base`) guarantee no
          horizontal overflow at ~360px. */}
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        {/* Header band matches the sidebar dark-slate convention. */}
        <div className="bg-slate-900 text-white px-5 py-3 flex items-center justify-between rounded-t-2xl sm:rounded-t-lg">
          <h2 className="font-semibold text-base">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy}
            className="text-slate-300 hover:text-white disabled:opacity-50" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

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
          onChange={(e) => setPreferred(e.target.value)} className={inputClass} />
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

function FullPageMessage({
  title, message, helpline, retry,
}: { title: string; message: string; helpline?: boolean; retry?: boolean }) {
  return (
    <div className="bg-white rounded-lg border p-8 text-center space-y-4">
      <h1 className="text-xl font-semibold text-slate-800">{title}</h1>
      <p className="text-sm text-slate-600 leading-relaxed">{message}</p>
      {helpline && (
        <p className="text-sm text-slate-500">
          Need help? Call <a href="tel:+911800000000" className="text-sky-600 hover:underline">+91-1800-000-000</a>.
        </p>
      )}
      {retry && (
        <button type="button" onClick={() => window.location.reload()}
          className="bg-sky-600 hover:bg-sky-700 text-white font-medium px-4 py-2 rounded-md text-sm">
          Try Again
        </button>
      )}
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
  token, cityOptions, form, patch,
}: {
  token: string;
  cityOptions: { value: number; label: string }[];
  form: FormState;
  patch: (p: Partial<FormState>) => void;
}) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstance = React.useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markerInstance = React.useRef<any>(null);
  const [mapsError, setMapsError] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<Array<{ place_id: string; description: string }>>([]);
  const [showSuggestions, setShowSuggestions] = React.useState(false);

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
        });
        mapInstance.current = map;
        const marker = new maps.Marker({ position: initial, map, draggable: true });
        marker.addListener('dragend', () => {
          const pos = marker.getPosition();
          if (!pos) return;
          void reverseGeocode(pos.lat(), pos.lng());
        });
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
    const q = form.address.trim();
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
  }, [form.address]);

  async function reverseGeocode(lat: number, lng: number) {
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
    patch({ address: description });
    try {
      const r = await publicFetch<{
        lat?: number; lng?: number;
        formatted_address?: string;
        address_components?: { postal_code?: string; city?: string };
      }>(`/public/maps/geocode?token=${encodeURIComponent(token)}&place_id=${encodeURIComponent(place_id)}`);
      const next: Partial<FormState> = {};
      if (r.formatted_address) next.address = r.formatted_address;
      if (r.lat != null && r.lng != null) {
        next.gps_location = `${r.lat.toFixed(6)},${r.lng.toFixed(6)}`;
        if (markerInstance.current) markerInstance.current.setPosition({ lat: r.lat, lng: r.lng });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (mapInstance.current) { (mapInstance.current as any).panTo({ lat: r.lat, lng: r.lng }); (mapInstance.current as any).setZoom(16); }
      }
      const comps = r.address_components || {};
      if (comps.postal_code) next.pin_code = comps.postal_code;
      if (comps.city) {
        const match = cityByName.get(comps.city.toLowerCase());
        if (match) next.city_id = String(match);
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
      <Field label="Complete Address" required>
        <div className="relative">
          <textarea
            value={form.address}
            onChange={(e) => { patch({ address: e.target.value }); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); }}
            rows={2} required
            className={`${inputClass} resize-y`}
            placeholder="Start typing — we'll suggest matches"
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
          <select value={form.city_id} required
            onChange={(e) => patch({ city_id: e.target.value })} className={inputClass}>
            <option value="">— Select city —</option>
            {cityOptions.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
          </select>
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
            Drag the marker to drop a new pin. Address, PIN and City update automatically.
          </p>
        )}
      </div>
    </div>
  );
}

/*
 * 5-tile image grid with an "Add" tile when count < 5. We deliberately
 * don't try to thumbnail the S3 keys — the file-download endpoint is
 * auth-gated and would 401 in the customer's browser. The seq stamp +
 * "uploaded" badge is enough confirmation for the customer.
 */
function ImageUploader({
  token, images, setImages,
}: {
  token: string;
  images: ImageRow[];
  setImages: React.Dispatch<React.SetStateAction<ImageRow[]>>;
}) {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  async function handleFile(file: File) {
    setUploadError(null);
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('File too large — maximum size is 5MB.');
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
      const { image_id, image } = body.data as { image_id: number; image: string };
      setImages((prev) => [...prev, { image_id, key: image }]);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDelete(imageId: number) {
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

  const atCap = images.length >= 5;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((img, idx) => (
          <div key={img.image_id}
            className="relative w-[72px] h-[72px] rounded-md border bg-slate-100 flex items-center justify-center">
            <div className="text-center">
              <div className="text-[10px] text-slate-500">Image</div>
              <div className="text-xs font-semibold text-slate-700">#{idx + 1}</div>
              <div className="text-[9px] text-emerald-600 font-medium">uploaded</div>
            </div>
            <button type="button" onClick={() => handleDelete(img.image_id)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold leading-none flex items-center justify-center hover:bg-red-600"
              aria-label="Remove image">×</button>
          </div>
        ))}
        {!atCap && (
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}
            className="w-[72px] h-[72px] rounded-md border-2 border-dashed border-slate-300 text-slate-500 hover:border-sky-400 hover:text-sky-600 transition flex items-center justify-center text-xs">
            {uploading ? '…' : '+ Add'}
          </button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
      {atCap && <p className="text-xs text-slate-500">Maximum 5 images reached.</p>}
      {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
    </div>
  );
}
