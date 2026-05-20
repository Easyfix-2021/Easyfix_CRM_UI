/*
 * Shared fetch-blob-anchor XLSX download helper.
 *
 * Why this exists: four call sites (jobs/page.tsx, reports/page.tsx,
 * EscalatedJobsModal, CallInfoModal) used to inline the same recipe —
 * fetch with Bearer header, error-JSON parsing, blob → object URL,
 * synthetic <a download> click, then URL.revokeObjectURL. The
 * implementations had drifted on details (revoke timing, error-text
 * extraction, fallback filenames). Consolidating here makes "what
 * happens when an export fails" a single decision instead of four.
 *
 * Auth model: the CRM_UI stores its JWT in localStorage under
 * `crm_auth_token` (set by the login flow). We attach it as a Bearer
 * header AND send credentials so the cookie-based session also flows
 * — same posture as `lib/api.ts`'s `api.get` wrapper.
 *
 * Why not just `lib/api.ts`'s helper? That wrapper assumes JSON
 * responses and parses the body — fine for the modern `{success,
 * data}` shape, fatal for an XLSX byte stream. The streaming endpoints
 * intentionally bypass the JSON envelope; we need a parallel helper
 * that knows the response is bytes.
 */

export interface DownloadXlsxOptions {
  /*
   * Absolute or relative URL path. If it starts with a slash and no
   * scheme, we prepend `NEXT_PUBLIC_API_URL` (or `/api`). The query
   * string is the caller's responsibility — build it with
   * `URLSearchParams` and append before passing in.
   */
  url: string;
  /*
   * Suggested download filename. Operators see this in the Save dialog
   * and as the saved file's name. We don't enforce an extension —
   * call sites that want `.xlsx` should include it.
   */
  filename: string;
}

/**
 * Fetch an XLSX byte stream and trigger a browser download.
 *
 * Throws a plain `Error` with a human-readable message on:
 *   - non-2xx response (extracts `data.error` from JSON body if
 *     present, else "HTTP <status>")
 *   - network failure (rethrows the fetch error)
 *
 * Resolves once the synthetic anchor has been clicked. The object URL
 * is revoked 500ms later — enough headroom for the browser to start
 * the download stream while the anchor is still alive.
 */
export async function downloadXlsx({ url, filename }: DownloadXlsxOptions): Promise<void> {
  const base = process.env.NEXT_PUBLIC_API_URL || '/api';
  // Absolute URLs (https://…) or already-prefixed (/api/…) pass
  // through unchanged. A bare path like `/admin/jobs/export.xlsx?…`
  // gets the API base prepended.
  const finalUrl = /^https?:\/\//i.test(url) || url.startsWith(base)
    ? url
    : `${base}${url.startsWith('/') ? url : `/${url}`}`;

  const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const resp = await fetch(finalUrl, {
    method: 'GET',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) msg = String(j.error);
    } catch { /* not JSON body, keep the HTTP code */ }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revocation — some browsers race the click → download path
  // and a too-eager revoke aborts the in-flight stream.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
}
