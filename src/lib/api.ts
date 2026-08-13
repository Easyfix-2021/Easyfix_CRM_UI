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
};

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
  total_charge: number | null;
  quantity: number | null;
  approval_by_client: number | boolean | null;
  is_approved_by_pm: number | boolean | null;
};

/** A Job Sheet / Purchase Order attachment. `url` is the (authenticated) fetch source. */
export type JobDocument = { image_id: number; url: string };
export type JobDocumentCategory = 'JobSheet' | 'PurchaseOrder';

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
  captured_at: string;
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
};

/*
 * POST /admin/jobs/:id/offer → result of pushing the offer to N technicians.
 * `offered` is how many tbl_job_offer rows were created (deduped BE-side).
 */
export type JobOfferResult = {
  offered: number;
};
