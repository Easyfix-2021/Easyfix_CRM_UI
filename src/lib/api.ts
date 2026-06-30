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
  offerJob: (jobId: number, easyfixerIds: number[], schedule?: CommitSchedule) =>
    request<JobOfferResult>(`/admin/jobs/${jobId}/offer`, {
      method: 'POST',
      body: { easyfixerIds, ...(schedule ?? {}) },
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
};

/* GET /admin/jobs/:id/offers → technicians the job is currently offered to. */
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
