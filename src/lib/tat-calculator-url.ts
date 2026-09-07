/*
 * The TAT Calculator's URL contract — deep-link in, query key out.
 *
 * WHY THIS IS A LIB AND NOT INLINE. The client profile links to
 * `/admin-actions/tat-calculator?mode=client&clientId=N`, and the page never
 * read a single search param — it imported no `useSearchParams` at all. So the
 * link landed on the calculator in JOB mode with nothing selected, and the
 * profile's own Reports section told the operator this was "the one genuinely
 * client-scoped link". It was decorative.
 *
 * Both halves are pure functions here so the contract can be tested without a
 * browser: what a URL seeds, and what key a selection produces.
 */

/** The four modes that share one id box; they differ only in which lookup feeds them. */
export const TAT_DIMENSION_MODES = ['city', 'category', 'project-manager', 'vertical'] as const;

/** Every mode the calculator understands. Anything else in the URL is ignored. */
export const TAT_MODES = ['job', 'client', 'technician', ...TAT_DIMENSION_MODES] as const;

export type TatSelection = {
  mode: string;
  jobId?: string;
  clientId?: number | '';
  techId?: number | null;
  dimId?: string;
  days?: string;
};

const DEFAULT_DAYS = '90';

/**
 * The API key a selection computes to, or null when the selection is incomplete.
 *
 * ONE definition, used by the Compute button AND by the deep-link seed — a
 * second copy would let a link compute a different query than the form it
 * populates, which is precisely the kind of drift nobody notices.
 */
export function tatKeyFor(s: TatSelection): string | null {
  const days = s.days || DEFAULT_DAYS;
  if (s.mode === 'job' && s.jobId?.trim()) return `/admin/tat/job/${s.jobId.trim()}`;
  if (s.mode === 'client' && s.clientId) return `/admin/tat/client/${s.clientId}?days=${days}`;
  if (s.mode === 'technician' && s.techId) return `/admin/tat/technician/${s.techId}`;
  if ((TAT_DIMENSION_MODES as readonly string[]).includes(s.mode) && s.dimId?.trim()) {
    return `/admin/tat/${s.mode}/${s.dimId.trim()}?days=${days}`;
  }
  return null;
}

export type TatSeed = {
  mode: string;
  jobId: string;
  clientId: number | '';
  dimId: string;
  days: string;
  /** Non-null when the URL carried a COMPLETE selection — the page computes on arrival. */
  key: string | null;
};

/**
 * Read a deep link into initial page state.
 *
 * Every value is validated rather than trusted: a URL is user input, an
 * unknown `mode` would render a tab that does not exist, and a non-numeric
 * `clientId` would build `/admin/tat/client/NaN`. Anything unrecognised falls
 * back to the page's own defaults, so a stale or hand-edited bookmark opens a
 * working page instead of a broken one.
 *
 * `technician` mode is deliberately NOT seeded: its picker holds a whole
 * easyfixer row, not an id, so a URL cannot supply one without a lookup the
 * page would have to await before first paint.
 */
export function tatSeedFromParams(get: (k: string) => string | null): TatSeed {
  const rawMode = get('mode');
  const mode = rawMode && (TAT_MODES as readonly string[]).includes(rawMode) ? rawMode : 'job';

  const nClient = Number(get('clientId'));
  const clientId: number | '' = Number.isInteger(nClient) && nClient > 0 ? nClient : '';

  const jobId = (get('jobId') || '').trim();
  const dimId = (get('dimId') || '').trim();

  // Bounded: the endpoint scans per day, so an unbounded `days` from a URL is a
  // free way to ask the database for everything.
  const nDays = Number(get('days'));
  const days = Number.isInteger(nDays) && nDays > 0 && nDays <= 1825 ? String(nDays) : DEFAULT_DAYS;

  return { mode, jobId, clientId, dimId, days, key: tatKeyFor({ mode, jobId, clientId, dimId, days }) };
}
