'use client';
import { useMemo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { useFetchOnce } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';

/*
 * ── Pending-for-Scheduling filter bar (shared) ──────────────────────────────
 *
 * ONE implementation used by BOTH lifecycle surfaces — /my-orders (user-scoped)
 * and /jobs (org-wide). The bar started life inlined in /my-orders; /jobs shares
 * the same bucket definition via lib/job-tabs.ts, so an inlined copy would have
 * left the two pages with different triage capability on the same bucket. Per
 * the repo's touch-it-migrate-it / no-duplication rules it lives here once, and
 * the URL parse/serialise/query helpers live here too so neither page hand-rolls
 * a second copy of the `ps*` param contract.
 *
 * Project managers triage this queue by Scheduling Status / Service Category /
 * City / Client / Zonal Manager. All five drive the SERVER query — the list is
 * server-paginated, so an in-memory filter would only narrow the rows on screen
 * and quietly lie about the rest.
 *
 * THE BUCKET PIN IS UNCONDITIONAL. This tab IS the bucket
 * `job_status = 0 AND fk_easyfixter_id IS NULL`, sent as status=0 +
 * assigned=false from the tab definition in lib/job-tabs.ts. Nothing on this bar
 * may override or drop either pin — the filters only ever NARROW what is already
 * inside the bucket. (An earlier revision shipped a "Job Status" multi-select
 * that REPLACED the pinned status and conditionally dropped `assigned=false`;
 * picking status 20 then listed jobs that are not in this bucket at all. It was
 * also meaningless by construction: every row here is job_status = 0.)
 *
 * The real sub-state inside the bucket is the OFFER lifecycle, so "Scheduling
 * Status" maps to the BE's `offerState` param on GET /admin/jobs:
 *   'pending' → NEVER OFFERED — no offer row has ever been written → "Pending to Scheduling"
 *              (rejected-only moved OUT of here on 2026-08-03; a declined
 *               offer is now 'expired', so this state means literally
 *               "nobody has been asked yet")
 *   'offered' → >= 1 EFFECTIVELY OPEN offer (within the 30-min TTL)  → "Offered to Tx"
 *   'expired' → none open, none accepted, >= 1 dead offer            → "Expired"
 *   ''        → param omitted ⇒ the whole bucket
 *
 * Controls are the SHARED pickers already used across the CRM (SearchMultiSelect
 * on the Pending-to-Start bar + the QuickSight filter bar, SearchSelect on the
 * Manage Jobs filter card); options come from the shared `useLookup()` hook, or
 * `useFetchOnce()` for Zonal Managers (see below) — no ad-hoc dropdowns, no raw
 * useEffect + api.get.
 *
 * Single vs multi is dictated by what the BE query validator accepts
 * (validators/job.validator.js):
 *   offerState     → one of 3 literals     ⇒ SearchSelect (the states are exclusive)
 *   cityId         → csvIds (id OR CSV)    ⇒ SearchMultiSelect
 *   clientId       → csvIds (id OR CSV)    ⇒ SearchMultiSelect
 *   categoryId     → single intId ONLY     ⇒ SearchSelect (a CSV here 400s)
 *   zonalManagerId → csvIds (id OR CSV)    ⇒ SearchMultiSelect
 *
 * ── What "Zonal Manager" means here (2026-09-15) ────────────────────────────
 * Replaced the Vertical control. A zonal manager is the tbl_user that owns the
 * job's CITY — `tbl_city.state_user`, reached through the job's address. GET
 * /admin/jobs?zonalManagerId= applies `ci.state_user IN (…)`, and the jobs
 * export applies the same predicate, so a /jobs export still mirrors the screen.
 * It is NOT `zonalId`, which the jobs list reads as a tbl_zone_master ZONE (see
 * ZONAL_ID_COLLISION in the BE's services/job-export.service.js).
 *
 * Options come from GET /shared/lookup/zonal-managers (users owning at least one
 * city), which is not in `useLookup()`. It is fetched with `useFetchOnce` under
 * the SAME key /jobs already uses for its Filter Job "Zonal" field, so hosting
 * the bar there costs no second request. The endpoint is role(['admin']) — the
 * same gate as the clients lookup this bar already depends on.
 *
 * A bookmarked `?psVertical=` from before the swap is scrubbed, not read — see
 * writePsFilterParams.
 */
export type PsFilters = {
  offerState: '' | 'pending' | 'offered' | 'expired';
  categoryId: string;
  cityId: number[];
  clientId: number[];
  zonalManagerId: number[];
};

export const EMPTY_PS_FILTERS: PsFilters = {
  offerState: '', categoryId: '', cityId: [], clientId: [], zonalManagerId: [],
};

type ManagerLite = { user_id: number; user_name: string };

/*
 * Scheduling Status options — the three offer sub-states within the bucket.
 * The empty value is deliberately NOT listed: "All" is the SearchSelect
 * placeholder, consistent with the Service Category field beside it.
 */
const PS_OFFER_STATE_OPTIONS: SearchOption[] = [
  { value: 'pending', label: 'Pending to Scheduling' },
  { value: 'offered', label: 'Offered to Tx' },
  { value: 'expired', label: 'Expired/Rejected' },
];

/*
 * URL → offerState. Anything outside the three literals resolves to '' — which
 * includes a leftover `?psStatus=20` from the retired Job Status filter, since
 * that param is no longer read at all. A stale bookmark must never silently
 * apply a filter that now means something different.
 */
export function toOfferState(raw: string | null): PsFilters['offerState'] {
  return raw === 'pending' || raw === 'offered' || raw === 'expired' ? raw : '';
}

/*
 * Parse a URL CSV of ids back into numbers (city / client / zonal manager).
 * Blank segments are dropped BEFORE Number() so an empty or trailing-comma param
 * can't inject a phantom 0 into the IN (…) list.
 */
export function csvNums(raw: string | null): number[] {
  return String(raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
}

/*
 * Hydrate the filter set from a URL query. Takes the structural `{ get() }`
 * shape so it accepts both `URLSearchParams` and Next's `ReadonlyURLSearchParams`.
 * Both pages call this from a useState initializer — useSearchParams() is stable
 * at first render in the App Router, so the FIRST fetch already carries the
 * bookmarked filters instead of firing an unfiltered request then correcting it.
 */
export function psFiltersFromParams(sp: { get(name: string): string | null }): PsFilters {
  return {
    offerState: toOfferState(sp.get('psOfferState')),
    categoryId: sp.get('psCategory') || '',
    cityId:     csvNums(sp.get('psCity')),
    clientId:   csvNums(sp.get('psClient')),
    zonalManagerId: csvNums(sp.get('psZonalManager')),
  };
}

/*
 * Serialise the filter set INTO an existing URLSearchParams (mutates). Both
 * pages seed `p` from the live searchParams so params they never write are
 * preserved — which is exactly why the retired `psStatus` and `psVertical` are
 * scrubbed here: a bookmarked `?psStatus=20` would otherwise linger in the URL
 * long after it stopped being read, reading like an applied filter that isn't.
 *
 * The `ps*` names are shared by both pages ON PURPOSE — a filtered link is
 * portable between /my-orders and /jobs.
 */
export function writePsFilterParams(p: URLSearchParams, f: PsFilters): void {
  const set = (name: string, value: string) => { if (value) p.set(name, value); else p.delete(name); };
  set('psOfferState', f.offerState);
  p.delete('psStatus');
  set('psCategory', f.categoryId);
  set('psCity',     f.cityId.join(','));
  set('psClient',   f.clientId.join(','));
  set('psZonalManager', f.zonalManagerId.join(','));
  p.delete('psVertical');
}

/*
 * Stable string signature of the filter set. Used as (a) part of each page's
 * result-cache key and (b) the refetch effect's dependency — a string beats an
 * object identity that changes on every setState. EVERY control must contribute
 * a segment: one that is left out silently shares a cache key (and skips the
 * page-1 reset) with a different filter set. `psAnyFilterSet` compares against
 * `psFilterKey(EMPTY_PS_FILTERS)`, so the segment count is free to grow.
 */
export function psFilterKey(f: PsFilters): string {
  return [
    f.offerState, f.categoryId, f.cityId.join(','), f.clientId.join(','), f.zonalManagerId.join(','),
  ].join('|');
}

const EMPTY_PS_FILTER_KEY = psFilterKey(EMPTY_PS_FILTERS);

/* True when at least one control is set — drives the Clear button + empty-state copy. */
export function psAnyFilterSet(f: PsFilters): boolean {
  return psFilterKey(f) !== EMPTY_PS_FILTER_KEY;
}

/*
 * The filter set as GET /admin/jobs query params. Returns ONLY the keys that
 * are actually set, so a caller can spread it over a base param object without
 * an unset control blanking a param the page already had (object spread lets a
 * later `undefined` win). Callers must send it ONLY while the
 * Pending-for-Scheduling tab is active.
 *
 * cityId / clientId / zonalManagerId ship as CSV (BE `csvIds` → IN (…));
 * categoryId is a single id (the BE accepts only `intId` there); offerState is
 * one of the three literals in PS_OFFER_STATE_OPTIONS.
 */
export function psQueryParams(f: PsFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.offerState)      out.offerState = f.offerState;
  if (f.categoryId)      out.categoryId = f.categoryId;
  if (f.cityId.length)   out.cityId     = f.cityId.join(',');
  if (f.clientId.length) out.clientId   = f.clientId.join(',');
  if (f.zonalManagerId.length) out.zonalManagerId = f.zonalManagerId.join(',');
  return out;
}

// The multi-select widget hands back (string|number)[]; normalise to numbers.
// Mirrors the same helper in PendingToStartView / the QuickSight filter bar.
function toNums(v: Array<string | number>): number[] {
  return v.map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n));
}

/*
 * PsField — labelled wrapper for one filter control. Same shape as
 * PendingToStartView's `Field` / QuickSightFilterBar's, so the filter bars read
 * identically. Title Case labels per the project convention.
 */
function PsField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

/*
 * The bar itself. Fully controlled: the page owns the `PsFilters` value (it is
 * URL-persisted there) and receives a complete replacement object on every
 * change, so a page never has to know the internal shape of a control.
 *
 * `title` is optional chrome for surfaces that host other filter cards beside
 * this one (/jobs) — /my-orders omits it because its page heading already says
 * which bucket is on screen.
 */
export function PendingSchedulingFilters({
  value, onChange, title,
}: {
  value: PsFilters;
  onChange: (next: PsFilters) => void;
  title?: string;
}) {
  /*
   * Lookup-backed options. Shared `useLookup()` hook — session-cached +
   * request-deduped, so mounting this bar costs nothing extra when another
   * surface already warmed the cache. Sorted alphabetically, same treatment as
   * PendingToStartView's bar.
   */
  const lookup = useLookup();
  const clientOpts = useMemo<SearchOption[]>(
    () => [...lookup.toOpts.clients].sort((a, b) => String(a.label).localeCompare(String(b.label))),
    [lookup.toOpts.clients],
  );
  const cityOpts = useMemo<SearchOption[]>(
    () => [...lookup.toOpts.cities].sort((a, b) => String(a.label).localeCompare(String(b.label))),
    [lookup.toOpts.cities],
  );
  const categoryOpts = useMemo<SearchOption[]>(
    () => [...lookup.toOpts.serviceCategories].sort((a, b) => String(a.label).localeCompare(String(b.label))),
    [lookup.toOpts.serviceCategories],
  );
  // Already ordered by user_name server-side, so no client-side sort.
  const zonalManagersRes = useFetchOnce<ManagerLite[]>('/shared/lookup/zonal-managers');
  const zonalManagerOpts = useMemo<SearchOption[]>(
    () => (zonalManagersRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonalManagersRes.data],
  );

  const anySet = psAnyFilterSet(value);

  return (
    <div className="space-y-3">
      {title && (
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      )}
      {/* 5 controls: 2-up on small, 3-up on lg (the /jobs card is narrower than
          the viewport), 5-up on xl so the bar stays one row on a wide screen. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <PsField label="Scheduling Status">
          {/* Sub-state WITHIN the bucket, not a replacement for it: every row
              here is job_status = 0 by definition, so the only thing worth
              filtering on is the offer lifecycle. Single-select — the three
              states are mutually exclusive — and "All" is the placeholder. */}
          <SearchSelect
            value={value.offerState}
            onChange={(v) => onChange({ ...value, offerState: (v || '') as PsFilters['offerState'] })}
            options={PS_OFFER_STATE_OPTIONS}
            placeholder="All Scheduling Statuses"
          />
        </PsField>
        <PsField label="Service Category">
          {/* Single-select: the BE query validator types `categoryId` as a lone
              positive integer (unlike cityId / clientId, which accept a CSV),
              so a multi-select here would 400. */}
          <SearchSelect
            value={value.categoryId}
            onChange={(v) => onChange({ ...value, categoryId: v })}
            options={categoryOpts}
            placeholder="All Categories"
          />
        </PsField>
        <PsField label="City">
          <SearchMultiSelect
            value={value.cityId}
            onChange={(v) => onChange({ ...value, cityId: toNums(v) })}
            options={cityOpts}
            placeholder="All Cities"
            selectedLabel="cities"
          />
        </PsField>
        <PsField label="Client">
          <SearchMultiSelect
            value={value.clientId}
            onChange={(v) => onChange({ ...value, clientId: toNums(v) })}
            options={clientOpts}
            placeholder="All Clients"
            selectedLabel="clients"
          />
        </PsField>
        <PsField label="Zonal Manager">
          {/* Multi-select: the BE query validator types `zonalManagerId` as
              csvIds, like cityId / clientId. Matches the job's city owner
              (tbl_city.state_user) — see the header note. */}
          <SearchMultiSelect
            value={value.zonalManagerId}
            onChange={(v) => onChange({ ...value, zonalManagerId: toNums(v) })}
            options={zonalManagerOpts}
            placeholder="All Zonal Managers"
            selectedLabel="managers"
          />
        </PsField>
      </div>
      {anySet && (
        <div className="flex items-center justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(EMPTY_PS_FILTERS)}>
            Clear Filters
          </Button>
        </div>
      )}
    </div>
  );
}
