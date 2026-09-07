/*
 * The QuickSight reports' URL contract — `?clientId=` and `?period=`.
 *
 * WHY THIS EXISTS. The client profile's Reports section links to six reports
 * "for this client", and not one of them read a client id from the URL. The
 * section said so honestly in its own UI rather than pretend, which is the
 * right call for a comment and the wrong end state: an operator on a client
 * page still had to re-pick that client in every report they opened.
 *
 * The reports hold their client filter in three different shapes — a
 * multi-select of ids, a draft object containing one, and a single required
 * string. So the SHAPES differ; the parsing must not. A per-page `Number(...)`
 * would drift, and the failure is silent: a report that misreads the param
 * shows the WHOLE book under a heading naming one client, which is worse than
 * ignoring it.
 *
 * Repeated params are supported (`?clientId=1&clientId=2`) because the
 * multi-selects genuinely are multi — that is also how each report already
 * serialises them onto its own API query.
 */

/** Every valid client id in the URL, de-duplicated, order preserved. */
export function clientIdsFromParams(getAll: (key: string) => string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of getAll('clientId') || []) {
    /*
     * PLAIN DIGITS ONLY, deliberately stricter than Number().
     *
     * `Number.isInteger(Number(x))` alone accepts '1e3' as 1000 and '0x10' as
     * 16 — both real client ids, reached by a spelling nobody would recognise
     * in a bookmark or a support ticket. A client id is a decimal integer; a
     * URL that says anything else is not one we should guess at.
     *
     * Rejected values simply do not seed, so the report opens unfiltered — its
     * existing behaviour — rather than sending clientId=NaN to its own API and
     * showing an empty result under a heading that claims a client.
     */
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * The FIRST valid client id, as a string, for reports whose filter is a single
 * required client rather than a multi-select (material-report).
 *
 * Returns '' when the URL carries none, which is exactly the "nothing picked"
 * value those pages already use — so a bare visit is unchanged.
 */
export function clientIdFromParams(getAll: (key: string) => string[]): string {
  const [first] = clientIdsFromParams(getAll);
  return first == null ? '' : String(first);
}


/* ─── ?period= ───────────────────────────────────────────────────────────── */

/**
 * The monthly/weekly window shared by the two performance reports.
 *
 * Both reports have always had this control; they just spelled it differently
 * — client-performance sent `period`, city-performance sent `flag`, the name
 * the legacy DTO used. One concept, two wire names, in sibling reports: a trap
 * for whoever writes the third. `period` is now canonical on both.
 *
 * Anything unrecognised falls back to 'monthly', which is what both reports
 * already defaulted to — so a stale or hand-edited link opens a working page
 * rather than an empty one.
 */
export type ReportPeriod = 'monthly' | 'weekly';

export function reportPeriodFromParams(get: (key: string) => string | null): ReportPeriod {
  const raw = get('period');
  return raw === 'weekly' || raw === 'monthly' ? raw : 'monthly';
}
