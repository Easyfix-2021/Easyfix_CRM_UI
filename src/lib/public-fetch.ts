/*
 * Bare public-fetch helper for the unauthenticated /public/* pages. Mirrors the
 * `{ success, data }` success envelope of `@/lib/api` but:
 *   - never sends credentials/cookies (`credentials: 'omit'`)
 *   - never attaches an Authorization header
 *   - throws a typed `{ status, code, message }` so pages can dispatch on HTTP
 *     status (410/401) without ApiError class checks.
 *
 * Shared by the job-completion and shared-job public pages.
 */
export async function publicFetch<T>(url: string, init?: RequestInit): Promise<T> {
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
