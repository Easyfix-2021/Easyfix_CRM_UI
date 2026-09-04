/*
 * buildJobsKey — serialise a params object into a stable '/admin/jobs?…' key
 * for useFetch, dropping empty values.
 *
 * Shared rather than owned by a component because TWO views now build the same
 * request: PendingToStartView's three appointment buckets and
 * UnconfirmedSections' five. Both page independently against the SAME endpoint,
 * so a change to how a param is serialised has to reach both — a second copy
 * would drift silently, and the failure mode is a section quietly querying a
 * different filter set than the one next to it.
 *
 * URLSearchParams encodes '+' in an IST offset as %2B (and ':' as %3A), which
 * the backend decodes before Joi parses it.
 */
export function buildJobsKey(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  return `/admin/jobs?${qs.toString()}`;
}
