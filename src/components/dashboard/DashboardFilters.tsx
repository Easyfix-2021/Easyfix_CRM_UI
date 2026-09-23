'use client';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import type { SearchOption } from '@/components/ui/search-select';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { useFetch } from '@/lib/hooks';

/*
 * ── THE DASHBOARD FILTER BAR (2026-09-23) ─────────────────────────────────
 *
 * Four filters — Client, City, Project Manager, Zonal Manager — sitting under
 * the Notice Board and driving BOTH rows of /dashboard: the eight funnel cards
 * and the six "Orders Needing Immediate Attention" tiles.
 *
 * FOUR, AND ONLY FOUR. The page is designed to put cards + rail + attention
 * above the fold on a 1080p monitor, which leaves roughly one filter row of
 * headroom; a fifth control wraps to a second row and pushes the tiles under
 * the fold, which is the row operators actually act on. The four are also the
 * four ways an EasyFix manager owns a queue — /jobs is where a twenty-field
 * filter panel belongs, and it already has one.
 *
 * NO DATE RANGE, deliberately. Both endpoints behind this bar count LIVE OPEN
 * STATE: "146 pending for scheduling" means right now, not booked-this-month.
 * A date control would quietly redefine every number on the page, and the
 * smaller number looks exactly like a real backlog drop. If ops asks for one it
 * needs its own treatment on the card subtitles, not a fifth picker here.
 *
 * ── WHY THIS WRAPS QuickSightFilterBar ─────────────────────────────────────
 * Four of these controls already existed there (clients / cities / zonal
 * managers / project managers), with the lookups, the label treatment and the
 * SearchMultiSelect wiring. This file adds what that component deliberately
 * does not have — the manager option fetches, a Clear Filters button, and the
 * URL contract — and forces a single 4-up row via className. Order on screen
 * follows the shared bar (Clients, Cities, Zonal Managers, Project Managers);
 * reordering the two manager pickers to match the original mock would have
 * shuffled the columns on six QuickSight reports for nothing.
 *
 * ── THE URL IS THE STATE ───────────────────────────────────────────────────
 * Parse / serialise / query-string helpers live HERE, beside the control that
 * owns the contract, exactly as PendingSchedulingFilters does for its `ps*`
 * params — so the page and AttentionSummary cannot hand-roll two different
 * spellings of the same filter. A zonal manager can bookmark their own view.
 */

export type DashFilters = {
  clientId: number[];
  cityId: number[];
  projectManagerId: number[];
  zonalManagerId: number[];
};

export const EMPTY_DASH_FILTERS: DashFilters = {
  clientId: [], cityId: [], projectManagerId: [], zonalManagerId: [],
};

/*
 * URL param names. Short, because four multi-selects of ids make a long query
 * string and browsers have opinions about that; distinct from the `ps*` set so
 * a bookmark from one surface can never be read as the other's.
 */
const PARAM: Record<keyof DashFilters, string> = {
  clientId: 'dfClient',
  cityId: 'dfCity',
  projectManagerId: 'dfPm',
  zonalManagerId: 'dfZm',
};

const KEYS = Object.keys(PARAM) as Array<keyof DashFilters>;

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

/** Read the bar's state out of a URLSearchParams (bookmark / back button). */
export function readDashFilterParams(sp: URLSearchParams): DashFilters {
  const out = { ...EMPTY_DASH_FILTERS };
  for (const key of KEYS) out[key] = parseIds(sp.get(PARAM[key]));
  return out;
}

/** Write the bar's state INTO a copy of the current params, dropping empties. */
export function writeDashFilterParams(sp: URLSearchParams, value: DashFilters): URLSearchParams {
  const next = new URLSearchParams(sp.toString());
  for (const key of KEYS) {
    const ids = value[key];
    if (ids.length) next.set(PARAM[key], ids.join(','));
    else next.delete(PARAM[key]);
  }
  return next;
}

/*
 * The API query string — the ONE serialiser both dashboard fetches use, so the
 * cards and the tiles can never describe different slices. CSV per key, which
 * is the shape the BE's csvIds validator takes (an id or a comma list).
 *
 * Empty when nothing is selected, and the callers append nothing in that case.
 * That matters: the unfiltered URL stays exactly `/admin/jobs/counts`, which is
 * the key the Navbar's identical call is cached under, so the default dashboard
 * still costs one request between the two of them.
 */
export function dashFilterQs(value: DashFilters): string {
  const qs = new URLSearchParams();
  for (const key of KEYS) {
    const ids = value[key];
    if (ids.length) qs.set(key, ids.join(','));
  }
  return qs.toString();
}

export function dashAnyFilterSet(value: DashFilters): boolean {
  return KEYS.some((k) => value[k].length > 0);
}

type ManagerLite = { user_id: number; user_name: string };

export function DashboardFilters({
  value,
  onChange,
  disabled,
}: {
  value: DashFilters;
  onChange: (next: DashFilters) => void;
  disabled?: boolean;
}) {
  /*
   * Manager options are NOT in useLookup, so they are fetched here — the same
   * two endpoints and the same `userType=1` (Primary SPOC) the QuickSight
   * reports use, narrowed by the client selection so picking a client prunes
   * the manager lists to the ones who actually own its work.
   *
   * Both endpoints are gated on the `admin` ROLE GROUP, not the Admin role —
   * and Project Manager (role 13) and Zonal Field Team (role 12) are both in
   * that group (services/role.service.js ROLE_ID_TO_GROUP). So the managers
   * this bar exists for can load their own dropdowns.
   */
  const clientScopeQs = useMemo(() => {
    const qs = new URLSearchParams();
    value.clientId.forEach((v) => qs.append('clientId', String(v)));
    return qs.toString();
  }, [value.clientId]);

  const zmRes = useFetch<ManagerLite[]>(
    clientScopeQs ? `/shared/lookup/zonal-managers?${clientScopeQs}` : '/shared/lookup/zonal-managers',
  );
  const pmRes = useFetch<ManagerLite[]>(
    `/shared/lookup/project-managers?userType=1${clientScopeQs ? `&${clientScopeQs}` : ''}`,
  );

  const zonalManagerOptions = useMemo<SearchOption[]>(
    () => (zmRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zmRes.data],
  );
  const projectManagerOptions = useMemo<SearchOption[]>(
    () => (pmRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [pmRes.data],
  );

  /*
   * Keep the selection honest as the scoped option sets change: narrowing by
   * client can remove a manager the operator had already picked, and a filter
   * whose chip names someone no longer in the list silently subtracts rows
   * nobody asked to subtract. Prune rather than leave it dangling.
   *
   * Guarded on `data` (not the memo) so the first render's empty array — the
   * list has not arrived yet — never clears a selection restored from the URL.
   */
  useEffect(() => {
    if (!zmRes.data) return;
    const valid = new Set(zonalManagerOptions.map((o) => Number(o.value)));
    const next = value.zonalManagerId.filter((v) => valid.has(Number(v)));
    if (next.length !== value.zonalManagerId.length) onChange({ ...value, zonalManagerId: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zmRes.data, zonalManagerOptions]);

  useEffect(() => {
    if (!pmRes.data) return;
    const valid = new Set(projectManagerOptions.map((o) => Number(o.value)));
    const next = value.projectManagerId.filter((v) => valid.has(Number(v)));
    if (next.length !== value.projectManagerId.length) onChange({ ...value, projectManagerId: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pmRes.data, projectManagerOptions]);

  const anySet = dashAnyFilterSet(value);

  const asNumbers = (next: Array<string | number>) =>
    next.map((v) => Number(v)).filter((n) => Number.isFinite(n));

  return (
    /*
     * `items-end` keeps Clear Filters on the CONTROLS' baseline rather than the
     * labels', so the button costs no extra row — the same fix the
     * Pending-for-Scheduling bar took on 2026-09-16, and the whole reason four
     * filters plus a button still fit in one row's worth of headroom.
     */
    <div className="flex flex-wrap items-end gap-3">
      <QuickSightFilterBar
        className="min-w-0 flex-1 lg:grid-cols-4"
        show={{ clients: true, cities: true, zonalManagers: true, projectManagers: true }}
        disabled={disabled}
        clients={value.clientId}
        onClientsChange={(v) => onChange({ ...value, clientId: asNumbers(v) })}
        cities={value.cityId}
        onCitiesChange={(v) => onChange({ ...value, cityId: asNumbers(v) })}
        zonalManagers={value.zonalManagerId}
        onZonalManagersChange={(v) => onChange({ ...value, zonalManagerId: asNumbers(v) })}
        zonalManagerOptions={zonalManagerOptions}
        projectManagers={value.projectManagerId}
        onProjectManagersChange={(v) => onChange({ ...value, projectManagerId: asNumbers(v) })}
        projectManagerOptions={projectManagerOptions}
      />

      {/*
        * Rendered only when something is set — its presence IS the active-filter
        * indicator, which is how every other filter bar in this CRM signals the
        * same thing. No badge, no count chip, nothing new to learn.
        */}
      {anySet && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => onChange({ ...EMPTY_DASH_FILTERS })}
        >
          Clear Filters
        </Button>
      )}
    </div>
  );
}
