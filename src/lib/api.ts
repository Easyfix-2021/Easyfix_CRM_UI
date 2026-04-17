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

  const res = await fetch(url.toString().replace(window?.location?.origin || '', ''), {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    credentials: 'include',
    headers,
    body: isFormData ? (opts.body as FormData) : opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });

  const text = await res.text();
  let json: { success?: boolean; data?: T; error?: string; details?: unknown } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }

  if (!res.ok || json.success === false) {
    throw new ApiError(res.status, json.error || `HTTP ${res.status}`, json.details);
  }
  return (json.data ?? (json as unknown)) as T;
}

export const api = {
  get:    <T>(p: string, query?: Record<string, string | number | undefined>) => request<T>(p, { method: 'GET', query }),
  post:   <T>(p: string, body?: Json | FormData) => request<T>(p, { method: 'POST', body }),
  put:    <T>(p: string, body?: Json) => request<T>(p, { method: 'PUT', body }),
  patch:  <T>(p: string, body?: Json) => request<T>(p, { method: 'PATCH', body }),
  delete: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};
