import { api } from '@/lib/api';

/*
 * Shared reason-dropdown cache for the job action dialogs (Add Remarks +
 * Cancel + JobOutcomeDialog). Extracted from JobModal.tsx so the
 * AddRemarksDialog / CancelWithReasonDialog components can live in their
 * own modules and still share ONE module-level cache.
 *
 * Module-level cache for the reason dropdowns (Add Remarks +
 * JobOutcomeDialog). Keyed by `${endpoint}|${type}|${dueTo}` so each popup +
 * radio combination caches independently. 60s TTL — the
 * `action_taken_reason` table is admin-edited maybe-once-a-month so
 * stale data for up to a minute is well within tolerance, and the
 * cache kills the "fetch every time the radio changes" pattern ops
 * flagged on 2026-06-05.
 *
 * Reusing one shared map across both dialogs means switching radios
 * back-and-forth (Customer → Client → Customer) returns the second
 * Customer fetch instantly from cache. Module scope persists for the
 * tab's lifetime; refresh clears it.
 */
export type CachedReasonRow = { id: number | null; label: string };
const _reasonsCache = new Map<string, { rows: CachedReasonRow[]; expires: number }>();
const REASONS_TTL_MS = 60_000;

export async function fetchReasonsCached(
  endpoint: string,
  params: Record<string, string>,
): Promise<CachedReasonRow[]> {
  // Stable cache key — endpoint distinguishes Add Remarks (`comment-reasons`)
  // from Outcome (`action-reasons`); `type` distinguishes
  // unreachable vs enquiry on the outcome side; `dueTo` is the radio.
  const cacheKey = `${endpoint}|${params.type || '-'}|${params.dueTo || '-'}`;
  const now = Date.now();
  const hit = _reasonsCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.rows;
  try {
    const rows = (await api.get<CachedReasonRow[]>(endpoint, params)) || [];
    _reasonsCache.set(cacheKey, { rows, expires: now + REASONS_TTL_MS });
    return rows;
  } catch {
    // Don't poison the cache on a network error — let the next call retry.
    return [];
  }
}
