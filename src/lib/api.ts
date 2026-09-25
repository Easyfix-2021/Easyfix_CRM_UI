/*
 * Fetch wrapper → EasyFix_Backend /api/admin/*.
 * Auth token is kept in an httpOnly cookie set by the backend on /api/auth/verify-otp;
 * browser includes it automatically via `credentials: 'include'`.
 * For explicit Bearer flow (non-cookie clients), read token from localStorage.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';

type Json = Record<string, unknown> | unknown[] | null;

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: Json | FormData; query?: Record<string, string | number | undefined> } = {}
): Promise<T> {
  const url = new URL(`${BASE}${path}`, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const headers: Record<string, string> = {};
  const isFormData = opts.body instanceof FormData;
  if (!isFormData && opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url.toString().replace(window?.location?.origin || '', ''), {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      credentials: 'include',
      headers,
      body: isFormData ? (opts.body as FormData) : opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError(0, 'Network error — please retry', e);
  }

  const text = await res.text();
  let json: { success?: boolean; data?: T; error?: string; details?: unknown } = {};
  let parsed = true;
  try { json = text ? JSON.parse(text) : {}; } catch { parsed = false; /* non-JSON body */ }

  if (!res.ok || json.success === false) {
    throw new ApiError(res.status, json.error || `HTTP ${res.status}`, json.details);
  }
  if (!parsed && text) {
    throw new ApiError(res.status, 'Invalid response from server', text.slice(0, 200));
  }
  return ((json && typeof json === 'object' && 'data' in json) ? json.data : json) as T;
}

export const api = {
  get:    <T>(p: string, query?: Record<string, string | number | undefined>) => request<T>(p, { method: 'GET', query }),
  post:   <T>(p: string, body?: Json | FormData) => request<T>(p, { method: 'POST', body }),
  put:    <T>(p: string, body?: Json) => request<T>(p, { method: 'PUT', body }),
  patch:  <T>(p: string, body?: Json) => request<T>(p, { method: 'PATCH', body }),
  delete: <T>(p: string) => request<T>(p, { method: 'DELETE' }),

  /*
   * Live-technician GPS location.
   *
   * Two BE endpoints share one envelope ({ success, data }) and the same
   * admin-JWT auth as every other /admin call:
   *   - getJobLocation(jobId)       → latest ping + breadcrumb track for the
   *                                    technician assigned to a specific job.
   *   - getEasyfixerLocation(efrId) → just the latest ping for a technician
   *                                    (no per-job track).
   * `latest` is null when the technician has sent no GPS ping yet (GPS off /
   * no active job). Both are typed against LiveLocation* below so the shared
   * LiveLocationPopover can render either source uniformly.
   */
  getJobLocation: (jobId: number) =>
    request<JobLocationResponse>(`/admin/jobs/${jobId}/location`, { method: 'GET' }),
  getEasyfixerLocation: (efrId: number) =>
    request<EasyfixerLocationResponse>(`/admin/easyfixers/${efrId}/location`, { method: 'GET' }),

  /*
   * Offer-pool model (multi-technician offer).
   *
   * offerJob(jobId, [efrId, …]) — POST /admin/jobs/:id/offer with the chosen
   *   technician ids. The job stays job_status=0 (BOOKED) with no single owner;
   *   each technician gets a tbl_job_offer row + an FCM push, and whoever
   *   accepts first on the app wins (race-safe first-wins on the BE).
   * getJobOffers(jobId) — GET /admin/jobs/:id/offers → the technicians the job
   *   is currently offered to (open offers), for the "Offered to" section with
   *   a live "offered <relativeTime>" label.
   */
  offerJob: (
    jobId: number,
    easyfixerIds: number[],
    opts?: CommitSchedule & { sourceByEfr?: Record<string, 'top10' | 'search'> },
  ) =>
    request<JobOfferResult>(`/admin/jobs/${jobId}/offer`, {
      method: 'POST',
      body: { easyfixerIds, ...(opts ?? {}) },
    }),
  getJobOffers: (jobId: number) =>
    request<JobOffersResponse>(`/admin/jobs/${jobId}/offers`, { method: 'GET' }),

  /*
   * Direct single-assign — used when the offer flow is DISABLED
   * (offerFlowEnabled=false in the candidates response). PATCH
   * /admin/jobs/:id/assign with one technician id; the BE immediately bumps the
   * job BOOKED → SCHEDULED (no tbl_job_offer row, no push). The optional schedule
   * edit (requestedDateTime + timeSlot) is applied in the same transaction,
   * exactly as offerJob carries it. The modal chooses offerJob vs assignJob from
   * the flag — the BE would degrade an offer to a direct-assign anyway, but
   * calling /assign keeps the UI and the BE action honest.
   */
  assignJob: (jobId: number, easyfixerId: number, schedule?: CommitSchedule) =>
    request<{ job_id: number }>(`/admin/jobs/${jobId}/assign`, {
      method: 'PATCH',
      body: { easyfixerId, ...(schedule ?? {}) },
    }),

  /*
   * Schedule & Assign → Reschedule. The modal's Date/Time fields are read-only;
   * this is the ONLY path that moves the appointment. All fields are mandatory:
   * the BE persists the new requested_date_time + derived slot columns, logs
   * reason + remarks to scheduling_history and a job comment, and expires any
   * open offers made for the old slot. `rescheduleReason` is the chosen reason's
   * label (mirrored into the audit trail alongside `reasonId`).
   */
  rescheduleJob: (
    jobId: number,
    body: { requestedDateTime: string; reasonId: number; rescheduleReason?: string; remarks: string },
  ) =>
    request<{ job_id: number }>(`/admin/jobs/${jobId}/reschedule`, {
      method: 'PATCH',
      body,
    }),

  /*
   * ─── Billing & Charges (job workspace tab) ───────────────────────────
   *
   * Replicates the legacy CheckIn-detail right-column actions. Every
   * endpoint is gated server-side by the same `canManageJobCharges`
   * feature flag surfaced on /auth/me — the FE only mirrors it for the
   * tab affordance. See BillingChargesTab.tsx.
   *
   * The GET returns the full Job-Summary matrix inputs in one payload:
   *   - materials  : Travel / Incentive / Penalty (and any Material-type)
   *                  charge line items (each carries tx + client charge).
   *   - services   : per-service rows for the client-approval toggles.
   *   - documents  : Job Sheet + Purchase Order attachments (image_id+url).
   */
  getJobCharges: (jobId: number) =>
    request<JobChargesResponse>(`/admin/jobs/${jobId}/charges`, { method: 'GET' }),

  addJobPenalty: (jobId: number, body: PenaltyChargeInput) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/penalty`, { method: 'POST', body }),
  addJobTravel: (jobId: number, body: TravelChargeInput) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/travel`, { method: 'POST', body }),
  addJobIncentive: (jobId: number, body: IncentiveChargeInput) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/incentive`, { method: 'POST', body }),

  // Edit a charge line item. Body shape matches the charge's own type
  // (penalty / travel / incentive) — same fields as the POST that created it.
  updateJobCharge: (
    jobId: number,
    chargeId: number,
    body: PenaltyChargeInput | TravelChargeInput | IncentiveChargeInput,
  ) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/charges/${chargeId}`, { method: 'PATCH', body }),

  // Client-approval toggle for a single charge line item.
  setJobChargeApproval: (jobId: number, chargeId: number, isClientApprovalNeeded: boolean) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/charges/${chargeId}/approval`, {
      method: 'PATCH',
      body: { isClientApprovalNeeded },
    }),

  deleteJobCharge: (jobId: number, chargeId: number) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/charges/${chargeId}`, { method: 'DELETE' }),

  // Job Sheet / Purchase Order upload (multipart) + delete. The FormData
  // path in `request` deliberately omits Content-Type so the browser sets
  // the multipart boundary.
  uploadJobDocument: (jobId: number, category: JobDocumentCategory, file: File) => {
    const fd = new FormData();
    fd.append('category', category);
    fd.append('file', file);
    return request<JobDocument>(`/admin/jobs/${jobId}/documents`, { method: 'POST', body: fd });
  },
  deleteJobDocument: (jobId: number, imageId: number) =>
    request<{ image_id: number }>(`/admin/jobs/${jobId}/documents/${imageId}`, { method: 'DELETE' }),

  /*
   * Approve on Client's Behalf — ops-initiated approval of the material
   * quote at status 15 (Approval Pending) when the client confirmed by
   * phone/WhatsApp rather than through their own portal. Multipart: a
   * required comment (10..1000 chars, validated client-side too — see
   * lib/client-approval.ts), 1..5 proof files (audio/image/pdf, <=10MB
   * each) stored as job documents under category 'ClientApprovalProof',
   * PLUS (owner change, 2026-09-22) the operator's own picks — there is no
   * auto-computed next visit any more:
   *   visit_date_time  'YYYY-MM-DD HH:00:00' IST wall clock, one of the free
   *                    hours GET /admin/jobs/:id/visit-slots offered.
   *   permission       'now' | 'later' | 'not_required'.
   *   permission_file  required iff permission === 'now'; pdf/jpeg/png/webp/
   *                    heic, <=10MB.
   * 409 "That slot was just booked — pick another" when the chosen hour lost
   * the race; 409 "This job is not waiting for client approval" when
   * job_status != 15 or isJobMaterialReview is missing. See
   * ClientApprovalOnBehalfModal.
   */
  approveJobOnClientBehalf: (
    jobId: number,
    comment: string,
    files: File[],
    visitDateTime: string,
    permission: 'now' | 'later' | 'not_required',
    permissionFile: File | null,
  ) => {
    const fd = new FormData();
    fd.append('comment', comment);
    for (const f of files) fd.append('files', f);
    fd.append('visit_date_time', visitDateTime);
    fd.append('permission', permission);
    if (permissionFile) fd.append('permission_file', permissionFile);
    return request<ClientApprovalOnBehalfResult>(`/admin/jobs/${jobId}/client-approval-on-behalf`, {
      method: 'POST',
      body: fd,
    });
  },

  // Per-service client-billing approval ("Approve Tx" data action).
  setJobServiceApproval: (jobId: number, jobServiceId: number, approvalByClient: 0 | 1) =>
    request<{ job_service_id: number }>(
      `/admin/jobs/${jobId}/services/${jobServiceId}/approval`,
      { method: 'PATCH', body: { approvalByClient } },
    ),

  // Advance requests scoped to a single job (list). Creation reuses the
  // existing POST /admin/advances (createAdvance below).
  getJobAdvances: (jobId: number) =>
    request<Advance[] | { items?: Advance[] }>(`/admin/advances`, { method: 'GET', query: { jobId } }),
  createAdvance: (body: CreateAdvanceInput) =>
    request<{ advance_id: number }>(`/admin/advances`, { method: 'POST', body }),

  /*
   * ─── Ops Desk (3.2) + Verification (3.6) ───────────────────────────────
   *
   * The list GETs (`/admin/ops-desk`, `/admin/verification`, `/admin/jobs/:id/chat`,
   * `/admin/jobs/:id/money`) are called straight through `useFetch` with an
   * inline URL, same as JobActivity / Quotations above — a plain bounded list
   * needs no bespoke wrapper. Only the MUTATIONS get typed helpers here,
   * matching offerJob/rescheduleJob's precedent.
   */

  // Price & Send Estimate — creates the client-approval line + moves the job
  // to 15 (Estimate Pending). txAmount<=clientAmount is enforced server-side;
  // the dialog re-validates so a bad value never round-trips.
  priceOpsDeskReport: (reportId: number, body: { clientAmount: number; txAmount: number; note?: string }) =>
    request<{ id: number }>(`/admin/ops-desk/reports/${reportId}/price`, { method: 'POST', body }),

  // Send Back To Him — additional-work report goes back to the technician
  // for a re-shoot / re-report, with a note stating what's missing.
  returnOpsDeskReport: (reportId: number, note: string) =>
    request<{ id: number }>(`/admin/ops-desk/reports/${reportId}/return`, { method: 'POST', body: { note } }),

  // Bench Picked Up (help reports, no body) / Verify-with-customer outcome
  // (cant_complete reports: revisit reschedules the job, cancel closes it).
  resolveOpsDeskReport: (
    reportId: number,
    body?: { outcome: 'revisit' | 'cancel'; revisitOn?: string },
  ) =>
    request<{ id: number }>(`/admin/ops-desk/reports/${reportId}/resolve`, { method: 'POST', body: body ?? {} }),

  // Verification queue → "Pass Audit". Does NOT post the ledger — money
  // reaches the wallet only after client QC (sheet 14 order).
  verifyJob: (jobId: number) =>
    request<{ job_id: number }>(`/admin/jobs/${jobId}/verify`, { method: 'POST', body: {} }),

  // Job chat (3.4) — the Activity tab's thread + reply box.
  postJobChat: (jobId: number, body: string) =>
    request<JobChatMessage>(`/admin/jobs/${jobId}/chat`, { method: 'POST', body: { body } }),

  /*
   * ─── V3 Phase 4 — job extras (Tools to Carry / Products at Site /
   * Signature / Schedule Visit 2) ──────────────────────────────────────
   *
   * GET /admin/jobs/:id/tools, GET /admin/tools, GET /admin/jobs/:id/
   * site-products and GET /admin/jobs/:id/signature are plain bounded reads
   * — called straight through `useFetch` with an inline URL, same
   * precedent as the Ops Desk/Verification GETs above. Only the
   * MUTATIONS get typed helpers here.
   *
   * All four are gated server-side on the same action key the CRM job
   * edit uses (isJobEdit) — see JobModal's ServicesTabBody `canEditJob`.
   */

  // Tools to Carry — replaces the WHOLE set (PHASE4-SPEC.md BACKEND-B).
  putJobTools: (jobId: number, toolIds: number[]) =>
    request<{ toolIds: number[] }>(`/admin/jobs/${jobId}/tools`, { method: 'PUT', body: { toolIds } }),

  // Products at Site — one row per POST; DELETE removes a single row by id.
  addJobSiteProduct: (jobId: number, body: JobSiteProductInput) =>
    request<JobSiteProduct>(`/admin/jobs/${jobId}/site-products`, { method: 'POST', body }),
  deleteJobSiteProduct: (jobId: number, rowId: number) =>
    request<{ id: number }>(`/admin/jobs/${jobId}/site-products/${rowId}`, { method: 'DELETE' }),

  // Schedule Visit 2 (D7) — status 10 -> 1, same technician, visit_number
  // bumped server-side. `visitOn` is IST wall-clock 'YYYY-MM-DDTHH:mm',
  // sent verbatim (matches rescheduleJob's convention — never convert to UTC).
  scheduleVisitTwo: (jobId: number, visitOn: string) =>
    request<{ job_id: number }>(`/admin/jobs/${jobId}/schedule-visit-two`, { method: 'POST', body: { visitOn } }),
};

/*
 * ─── Job extras contract types (PHASE4-SPEC.md "Data model" +
 * "Backend contracts" — BACKEND-B) ──────────────────────────────────────
 */

/** GET/PUT /admin/jobs/:id/tools — the job's current Tools to Carry set. */
/* GET/PUT /admin/jobs/:id/tools — the shape the backend really sends
 * (routes/admin/jobs-phase4.js): the job's tools as rows, not bare ids. */
export type JobToolsResponse = { items: { id: number; name: string }[] };

/** GET /admin/tools row (tbl_tools) — shared with settings/tools + service-types. */
export type ToolOption = { tool_id: number; tool_name: string; tool_desc?: string | null; tool_status?: number | string | null };

/** tbl_job_site_product row. */
export type JobSiteProduct = { id: number; name: string; qty: number; brand: string | null };
export type JobSiteProductInput = { name: string; qty: number; brand?: string };

/** GET /admin/jobs/:id/signature — null when no signature is on file. */
export type JobSignatureResponse = { svg: string; width: number; height: number; signedOn: string } | null;

/* ─── Billing & Charges contract types ──────────────────────────────────
 *
 * These mirror the BE contract for GET /admin/jobs/:id/charges and the
 * mutation endpoints exactly. Numeric charge columns arrive as `number`
 * but MySQL/JSON can surface them as strings, so the components coerce
 * with Number(); the types stay `number | null` per the wire contract.
 */

/** One Travel / Incentive / Penalty (or Material) charge line item. */
export type JobCharge = {
  id: number;
  /** 'Travel' | 'Incentive' | 'Penalty' | 'Material' — matched case-insensitively. */
  type: string;
  tx_charge: number | null;
  client_charge: number | null;
  reason: string | null;
  from_city_name: string | null;
  to_city_name: string | null;
  total_distance: number | null;
  tx_unit: number | null;
  cx_unit: number | null;
  document_name: string | null;
  /** 1/true when the line item still needs client approval. */
  is_client_approval_needed: number | boolean | null;
};

/** Per-service row driving the client-approval ("Approve Tx") toggles. */
export type JobChargeService = {
  job_service_id: number;
  service_name: string | null;
  /**
   * PER-UNIT, despite the name — the writers store `Math.round(unitPrice)`
   * here. Multiplying it by `quantity` yourself is NOT the fix; use
   * `client_charge` below, which is the line total from the rate-card cascade
   * and also survives this column being 0, which it usually is on older rows.
   */
  total_charge: number | null;
  quantity: number | null;
  /**
   * Line totals (per-unit x quantity) from the rate-card cascade — the same
   * numbers the Services tab shows, computed by one shared backend helper so
   * the two tabs cannot disagree. `client_charge` is what the client is billed;
   * `tx_charge` is the technician's residual. tx <= client by construction.
   *
   * null (never 0) when the line's rate card could not be resolved: 0 is a
   * price, null is "not known", and they must render differently.
   */
  client_charge: number | null;
  tx_charge: number | null;
  approval_by_client: number | boolean | null;
  is_approved_by_pm: number | boolean | null;
};

/** A Job Sheet / Purchase Order attachment. `url` is the (authenticated) fetch source. */
export type JobDocument = { image_id: number; url: string };
export type JobDocumentCategory = 'JobSheet' | 'PurchaseOrder' | 'ClientApprovalProof';

/*
 * Single source of truth for job-document category labels — wherever a
 * category code is shown to an operator, read it from here rather than
 * re-typing the string (JobDocumentsCard's two widget titles included).
 * 'ClientApprovalProof' is written by POST
 * /admin/jobs/:id/client-approval-on-behalf (see approveJobOnClientBehalf
 * below); nothing currently LISTS that category back, but the label lives
 * here so the first surface that does never has to invent one.
 */
export const JOB_DOCUMENT_CATEGORY_LABEL: Record<JobDocumentCategory, string> = {
  JobSheet: 'Job Sheet',
  PurchaseOrder: 'Purchase Order',
  ClientApprovalProof: 'Client Approval Proof',
};

/*
 * Response shape for approveJobOnClientBehalf — see its doc comment above.
 * The operator's own picks come straight back: `visit_date_time` is the
 * booked slot verbatim, and `permission.choice` echoes what was submitted.
 * `permission.request_id` is set only for 'later' (the client-facing upload
 * request the Client Dashboard will show); null for 'now' / 'not_required'.
 */
export type ClientApprovalOnBehalfResult = {
  job_status: number;
  visit_date_time: string;
  permission: {
    choice: 'now' | 'later' | 'not_required';
    request_id: number | string | null;
  };
  /** Post-commit step failures — the approval itself succeeded. */
  schedule_error?: string | null;
  permission_error?: string | null;
};

export type JobChargesResponse = {
  materials: JobCharge[];
  services: JobChargeService[];
  documents: { jobSheet: JobDocument[]; purchaseOrder: JobDocument[] };
};

export type PenaltyChargeInput = {
  txCharge: number;
  clientCharge: number;
  reason: string;
  isClientApprovalNeeded: boolean;
};
export type IncentiveChargeInput = {
  reason: string;
  txCharge: number;
  clientCharge: number;
  isClientApprovalNeeded: boolean;
  documentName?: string;
};
export type TravelChargeInput = {
  fromCityName: string;
  toCityName: string;
  totalDistance: number;
  txUnit: number;
  clientUnit: number;
  txCharge: number;
  clientCharge: number;
  isClientApprovalNeeded: boolean;
  documentName?: string;
};

/* ─── Advance requests ──────────────────────────────────────────────────
 * Mirrors `tbl_efr_advance_payment` (see finance/advances page). adv_status:
 *   0 Pending · 1 Ops Approved · 2 Finance Approved · 3 Rejected.
 */
export type Advance = {
  advance_id: number;
  client_id: number | null;
  job_id: number | null;
  efr_id: number;
  adv_status: number;
  job_total_amt: number | null;
  advance_amt: number | null;
  initiated_on: string | null;
  initiated_by: number | null;
  pm_remarks: string | null;
  ops_action_on: string | null;
  ops_remarks: string | null;
  fin_action_on: string | null;
  fin_remarks: string | null;
  transaction_id: string | null;
  efr_name: string | null;
  efr_no: string | null;
  client_name: string | null;
};

export type CreateAdvanceInput = {
  jobId: number;
  efrId: number;
  clientId: number;
  advanceAmt: number;
  jobTotalAmt: number;
  pmRemarks: string;
};

export const ADVANCE_STATUS_LABEL: Record<number, string> = {
  0: 'Pending',
  1: 'Ops Approved',
  2: 'Finance Approved',
  3: 'Rejected',
};

/* Optional proposed-schedule edit carried alongside an offer/assign commit. */
export type CommitSchedule = { requestedDateTime?: string; timeSlot?: string };

/*
 * One GPS ping. `captured_at` is a server datetime string (the popover renders
 * it as a "last updated" relative time). `job_id` / `efr_id` are present on the
 * job-location payload; the easyfixer-location latest carries the same shape.
 */
export type LiveLocationPing = {
  id: number;
  job_id: number | null;
  efr_id: number | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  /*
   * NULLABLE since the legacy fallback landed.
   *
   * A ping from tbl_job_location_track (source 'job_track') always carries a
   * real timestamp. A row recovered from the legacy `location` table has no
   * timestamp column at all — only an auto-increment id — so its age is
   * genuinely unknown and this is null.
   *
   * Do NOT substitute Date.now() for a missing value. That would make a
   * position of unknown age render as "just now", which is the one failure
   * worse than showing nothing.
   */
  captured_at: string | null;
  /*
   * Which store the position came from. The CRM branches its freshness
   * messaging on this rather than inferring it from the shape of the payload.
   */
  source?: 'job_track' | 'legacy' | null;
};

/* GET /admin/jobs/:id/location → latest ping + recent breadcrumb track. */
export type JobLocationResponse = {
  latest: LiveLocationPing | null;
  track: Array<Pick<LiveLocationPing, 'id' | 'latitude' | 'longitude' | 'accuracy' | 'captured_at'>>;
};

/* GET /admin/easyfixers/:id/location → latest ping only (no track). */
export type EasyfixerLocationResponse = {
  latest: LiveLocationPing | null;
};

/*
 * One technician this job is currently offered to. `offered_at` is a server
 * datetime string rendered via relativeTime() as a live "offered N min ago".
 */
export type JobOffer = {
  efr_id: number;
  efr_name: string;
  offered_at: string;
  /** Server datetime the tech responded (rejected/accepted) or the offer expired. */
  responded_at?: string | null;
  /** Raw offer_status code: 0 OFFERED · 1 ACCEPTED · 2 REJECTED · 3 EXPIRED. */
  offer_status?: number | null;
  /** Human-readable offer_status (OFFERED / REJECTED / EXPIRED). */
  offer_status_label?: string | null;
  /** Reason the technician gave when rejecting (offer_status 2 only). */
  reject_reason?: string | null;
  /** How many times this tech has been (re)offered this job. */
  offer_count?: number | null;
  /** Where the offer was made from: Top-10 list, Search, or auto-assign. */
  offer_source?: 'top10' | 'search' | 'auto' | null;
  /*
   * WHY a closed offer closed — tbl_job_offer.closed_reason and its label.
   * "Expired" reads as "nobody answered", but an offer also closes when the job
   * is rescheduled, reoffered, or taken by a sibling, and an operator deciding
   * whether to chase that technician needs to know which. Optional: the column
   * post-dates some rows, and NULL there means "closed before it existed".
   */
  closed_reason?: string | null;
  closed_reason_label?: string | null;
  /**
   * Technician's mobile, masked in transit by the BE middleware. Display only —
   * click-to-call re-resolves the real number server-side from `efr_id`, so the
   * CRM never holds the clear digits.
   */
  mobile?: string | null;
  /** Who made the offer. NULL for auto-assign and for pre-column offers. */
  offered_by_user_id?: number | null;
  offered_by_name?: string | null;
};

/*
 * GET /admin/jobs/:id/offers → the job's offer history: live offers PLUS the
 * technicians who declined (REJECTED) or timed out (EXPIRED). One row per tech
 * (latest offer), ordered live → rejected → expired.
 */
export type JobOffersResponse = {
  items: JobOffer[];
  /*
   * Which expiry regime the BACKEND is in — `job.offer_expiry.enabled` in
   * easyfix_properties. Optional so a frontend ahead of the backend still
   * renders; treat `undefined` as "unknown" rather than as either regime,
   * because the caption's whole job is to stop asserting a rule that may not
   * be in force.
   */
  offer_expiry_enabled?: boolean;
};

/*
 * POST /admin/jobs/:id/offer → result of pushing the offer to N technicians.
 * `offered` is how many tbl_job_offer rows were created (deduped BE-side).
 */
export type JobOfferResult = {
  offered: number;
};

/* ─── Ops Desk (3.2) + Verification (3.6) contract types ────────────────
 *
 * Mirror PHASE3-SPEC.md's Admin API contracts (GET /admin/ops-desk,
 * GET /admin/verification, GET/POST /admin/jobs/:id/chat,
 * GET /admin/jobs/:id/money) exactly — the backend is being built in
 * parallel against this same spec, so these are typed to the CONTRACT,
 * not to a running endpoint.
 */

export type OpsDeskBand = 'A' | 'B' | 'C' | 'D';
export type OpsDeskPendingOn = 'technician' | 'easyfix' | 'client';
export type OpsDeskStartProof = 'pin' | 'pin_late' | 'photos' | null;

export type OpsDeskItem = {
  jobId: number;
  title: string;
  clientName: string | null;
  locality: string | null;
  technician: { efrId: number; name: string | null } | null;
  jobStatus: number;
  band: OpsDeskBand;
  situation: string;
  pendingOn: OpsDeskPendingOn;
  waitingFor: string;
  startProof: OpsDeskStartProof;
  money: { client: number | null; tx: number | null };
  /** Minutes-at-door, or null when there's nothing to wait for. */
  needsMeIn: number | null;
  report?: {
    id: number;
    kind: 'additional_work' | 'cant_complete' | 'cancel' | 'help';
    status: string;
    reasonText?: string | null;
    proofImageIds?: number[];
  } | null;
  helpReason?: string | null;
  leftSite?: boolean;
};

export type OpsDeskResponse = {
  counts: Record<OpsDeskBand, number>;
  items: OpsDeskItem[];
  total: number;
};

export type VerificationItem = {
  jobId: number;
  title: string | null;
  clientName: string | null;
  technician: { efrId: number; name: string | null } | null;
  jobStatus: number;
  /** Present when this row is a claim (cant_complete / cancel) rather than a plain completed-job audit row. */
  report?: OpsDeskItem['report'];
  submittedOn: string | null;
  /** A cancel ask with no claim row — resolved from the job, not the claim endpoint. */
  legacyCancelAsk?: boolean;
};

export type {
  VerificationAuditItem, VerificationClaimItem, VerificationResponse,
} from './ops-desk';

export type JobChatMessage = {
  id: number;
  senderKind: 'tx' | 'desk';
  efrId: number | null;
  userId: number | null;
  senderName: string | null;
  body: string;
  sentOn: string;
};

export type JobChatResponse = {
  items: JobChatMessage[];
};

export type JobMoneyResponse = {
  client: number | null;
  tx: number | null;
  margin: number | null;
};
