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
  cityOptions: { value: number; label: string }[];
  timeSlots: string[];
  services: {
    client_service_id: number;
    service_type_id: number;
    service_catg_id: number;
    charge_type: number | null;
    service_type_name: string;
    service_catg_name: string;
  }[];
  images: { image_id: number; key: string }[];
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
