/*
 * Shared types for the Customer Magic-Link Completion flow.
 *
 * These mirror the BE shapes documented in the plan + the validator at
 * `EasyFix_Backend/validators/job-magic-link.validator.js`. Kept in one
 * file so the page component + any future helper can import from a single
 * source of truth.
 *
 * IMPORTANT: This flow is PUBLIC — no auth header. Do NOT import the `api`
 * wrapper from `@/lib/api` to consume these endpoints; it auto-attaches
 * `Authorization: Bearer <token>` from localStorage which the public
 * routes will reject. Use a plain `fetch` with `credentials: 'omit'`.
 */

export type PrefillResponse = {
  jobId: number;
  customer: { name: string; mobile: string; email: string | null };
  address: {
    address: string;
    building: string | null;
    landmark: string | null;
    city_id: number | null;
    pin_code: string | null;
    gps_location: string | null;
    address_instruction: string | null;
  };
  schedule: { requested_date_time: string | null; time_slot: string | null };
  jobDesc: string;
  additional: { name: string | null; number: string | null };
  client: { id: number; name: string };
  // Global map-clickability toggle (easyfix_properties ui.map.clickable).
  // Absent → clickable; false → the customer's map renders read-only.
  mapClickable?: boolean;
  cityOptions: { value: number; label: string }[];
  timeSlots: string[];
  services: {
    client_service_id: number;
    service_type_id: number;
    service_catg_id: number;
    charge_type: number | null;
    // Rate-card display label (crc_ratecard_name). Preferred primary name
    // for the picker; '' when the row has no rate_card_id mapped.
    service_name: string;
    service_type_name: string;
    service_catg_name: string;
    // Whether this service is billed to the customer ('Paid') or covered
    // ('Free'). Rendered as a small tag next to the service name. Optional
    // for backward compatibility with older BE deployments.
    billing_label?: 'Free' | 'Paid';
  }[];
  images: { image_id: number; key: string }[];
  // Customer-uploaded videos via the public Product Photos/Videos picker (or
  // the conversational chat flow). Probe-gated server-side; absent on older
  // BE deploys → FE defaults to [].
  videos?: { media_id: number; key: string }[];
  // Customer's currently-active service rows on this job. Populated by the BE
  // so that re-opening the magic link (token still valid, status still 9)
  // re-seeds the checkboxes — otherwise the bidirectional reconcile on submit
  // would soft-delete every active row when the customer re-submits without
  // re-ticking their previous picks. Optional for backward compatibility with
  // older BE deployments; FE defaults to [] when absent.
  selectedServices?: { client_service_id: number; quantity: number }[];
  // Per-client custom-property descriptors (sourced from
  // tbl_client_custom_properties; same shape the CRM Book-New-Call modal
  // already consumes). `name` is lower-cased by the BE for stable matching;
  // the FE then canonicalises common variants (branch / branch_details →
  // branch_details, etc.). Optional for backward compatibility with older
  // BE deployments; FE defaults to [] when absent.
  custom_properties?: { name: string; mandatory: boolean; label: string | null; value: string | null }[];

  // ── Full customer-facing order-page fields ──────────────────────────────
  // Added when the magic-link page was expanded from a bare completion form
  // into a full order view with Confirm / Reschedule / Cancel / Call actions.
  // All optional for backward compatibility with older BE deployments.

  // Job identity surfaced in the page header alongside the status chip.
  job_id?: number;
  // Numeric legacy job-status code (tbl_job.job_status) + a human label.
  // `order_status` drives the StatusChip tone; `order_status_label` is the
  // text shown inside the chip.
  order_status?: number | null;
  order_status_label?: string;
  // Client display name (duplicate of `client.name` but surfaced flat by the
  // expanded contract for header convenience).
  client_name?: string;
  // Deep link to the pinned location on Google Maps. Null when no GPS pin is
  // set — the "Open In Google Maps" button is hidden in that case.
  maps_link?: string | null;
  // EasyFix-side SPOC (internal CRM owner). `mobile_masked` is partially
  // masked for display; the actual dial is performed server-side by the
  // click-to-call endpoint, so the customer never sees the full number.
  // The whole SPOC block is hidden when `name` is null.
  spoc?: { name: string | null; mobile_masked: string | null };
  // The job OWNER — the customer's EasyFix coordinator. UNMASKED so the
  // customer can call directly once the booking is confirmed. Block hidden
  // when mobile is null.
  job_owner?: { name: string | null; mobile: string | null };
  // Reason option lists for the Cancel / Reschedule dialogs. Customer must
  // pick one before submitting the respective request.
  cancel_reasons?: string[];
  reschedule_reasons?: string[];
  // Customer's OWN phone number — shown UNMASKED and read-only (it's the
  // identity field bound to the magic-link JWT; not editable).
  customer_mob?: string;
  // Whether an EasyFix Support line is configured server-side (SUPPORT_PHONE
  // set). Gates the "Contact Support" affordance so it never opens a dead-end
  // dialog. Optional/absent → treated as unavailable (link hidden).
  support_available?: boolean;
};

export type SubmitPayload = {
  customer_name: string;
  customer_email?: string;
  address: string;
  building?: string;
  landmark?: string;
  city_id: number;
  pin_code: string;
  time_slot: string;
  requested_date_time: string;
  gps_location?: string;
  address_instruction?: string;
  additional_name?: string;
  additional_number?: string;
  job_desc?: string;
  services?: { client_service_id: number; quantity: number }[];
  // Per-client custom-property values. Surfaced by the BE prefill when the
  // client has the matching tbl_client_custom_properties row(s); the FE
  // only renders the input when the descriptor is present, and gates the
  // Submit button when `mandatory=true`.
  branch_details?: string;
  building_name?: string;
  product_code?: string;
  // Generic per-client custom-property values keyed by the property's
  // (lower-cased) name — every customer-facing field that ISN'T one of the
  // three canonical ones above. The BE validates mandatory ones dynamically
  // per-client and persists these inside customer_submitted_payload JSON.
  custom_properties?: Record<string, string>;
};

// Convenience aliases — easier-to-read names at call sites. The canonical
// shapes remain PrefillResponse / SubmitPayload above; these just re-export
// the same types under more page-component-friendly names.
export type MagicLinkPrefill = PrefillResponse;
export type MagicLinkSubmitPayload = SubmitPayload;
export type MagicLinkImage = PrefillResponse['images'][number];
export type MagicLinkServiceOption = PrefillResponse['services'][number];
export type MagicLinkCity = PrefillResponse['cityOptions'][number];

// Result envelope shapes used by the page when calling the public API.
// The BE responds with `{success, data, error}` from utils/response.js.
export type PublicApiOk<T>  = { success: true;  data: T; message?: string };
export type PublicApiErr    = { success: false; error: string; code?: string; details?: unknown };

// The "customer_submitted_at" marker is NOT included in the prefill payload
// today — we infer "already submitted" only from the BE returning a 200 on
// the resubmit. Keep this type around for the day the BE starts surfacing it.
export type MagicLinkSubmitState = 'idle' | 'submitting' | 'done';
