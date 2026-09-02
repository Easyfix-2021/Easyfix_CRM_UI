'use client';

/*
 * Manage Cities — Settings page.
 *
 * Operates on tbl_city via /api/admin/cities (services/city.service.js).
 * Columns: City ID | City Name | State | District | Tier | Status |
 *          Zones | Pincodes | Technicians.
 * Counts come from the backend computed at read time.
 *
 * Soft-delete only — see service comment for why.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Building2, Search, Plus, Pencil, XCircle,
  AlertTriangle, ChevronDown, ChevronRight, Info,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useSort, SortHeader } from '@/lib/use-sort';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type City = {
  city_id: number;
  city_name: string;
  state_id: number | null;
  state_name: string | null;
  district: string | null;
  tier: string | null;
  reference_pincode: string | null;
  city_status: number;
  zone_count: number;
  pincode_count: number;
  technician_count: number;
  created_by: number | null;
  created_by_type: 'technician' | 'user' | null;
  created_by_name: string | null;
  created_date: string | null;
};

type ListResponse = { items: City[]; total: number };

// Sorting is client-side over the loaded page via the shared useSort hook
// (3-state asc → desc → unsorted), matching Manage Zones / Pincodes.

// BE Joi cap on /admin/cities `limit` is 1000 (routes/admin/cities.js); pass
// it so the shared "All" page-size maps to the endpoint's true ceiling rather
// than relying on the pageSizeToLimit default (which is also 1000).
const CITIES_LIMIT_CAP = 1000;

export default function ManageCitiesPage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  const { me } = useMe();
  // Permission gating mirrors legacy CRM Constants.actionPermissions:
  //   - isCityAddNew : Add City button visibility.
  //   - isCityEdit   : Edit + Deactivate per-row buttons.
  // Legacy also has isCityUpload for the bulk upload screen; we don't have
  // a city upload page yet — gate that one when it ships.
  const can = actionFlags(me, ['isCityAddNew', 'isCityEdit']);

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [showTechCreated, setShowTechCreated] = useState(false);
  // Server-side pagination state. Page is 0-indexed (offset = page * size).
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  // Mutation-only error (deactivate). Fetch errors come from useFetch below.
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [editing, setEditing] = useState<City | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('cities-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('cities-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  // Debounced server-side search to keep payloads small as the catalog grows.
  const debouncedSearch = useDebouncedValue(search, 300);
  // Reset to page 0 whenever a filter changes (debouncedSearch self-delays).
  useEffect(() => { setPage(0); }, [debouncedSearch, stateFilter, includeInactive, showTechCreated]);

  // Build the list URL — every input that affects the result set is part of
  // the key, so useFetch re-fires automatically on search/filter/sort/page
  // changes (no manual fetchList()/useEffect orchestration). 'all' maps to
  // the endpoint's Joi cap; numeric sizes map 1:1.
  const limit = pageSizeToLimit(pageSize, CITIES_LIMIT_CAP);
  const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
  const params = new URLSearchParams();
  if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
  if (stateFilter)            params.set('stateId', String(stateFilter));
  if (includeInactive)        params.set('includeInactive', 'true');
  if (showTechCreated)        params.set('createdByTech', 'true');
  params.set('limit',   String(limit));
  params.set('offset',  String(offset));
  const listUrl = `/admin/cities?${params.toString()}`;

  const { data: listData, loading, error: fetchError, refetch } = useFetch<ListResponse>(listUrl);
  const items: City[] = listData?.items ?? [];
  const total = listData?.total ?? 0;

  // Client-side 3-state sort over the loaded page (asc → desc → unsorted),
  // same shared hook as Manage Zones / Pincodes. When unsorted, `sorted`
  // preserves the BE's default city_name-ASC order.
  const { sorted, sortKey, sortDir, toggle } = useSort<City>(items);

  // Invalidate the 30s module cache for ALL city list pages, then refetch.
  function refreshList() {
    invalidateFetch((k) => k.startsWith('/admin/cities'));
    refetch();
  }

  async function handleDeactivate(c: City) {
    const downstream = c.zone_count + c.pincode_count + c.technician_count;
    const ok = await confirm({
      title: 'Deactivate city?',
      description:
        `${c.city_name} will be marked inactive and hidden from default lists.` +
        (downstream > 0
          ? ` Note: ${c.zone_count} zone(s), ${c.pincode_count} pincode(s), and ${c.technician_count} technician(s) currently reference this city. Their records stay intact, but they won't be reachable through this city's default lists.`
          : ' No downstream records currently reference this city.') +
        ' You can reactivate by editing and toggling Active.',
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    });
    if (!ok) return;
    setMutationError(null);
    try {
      await api.delete(`/admin/cities/${c.city_id}`);
      refreshList();
    } catch (e) {
      setMutationError(e instanceof ApiError ? e.message : 'Deactivate failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="size-6" /> Manage Cities
          </h1>
          <p className="text-sm text-muted-foreground">
            City master with state, district, tier, and status. Zones, pincodes,
            and technicians anchor to cities.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isCityAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add City
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <button
            type="button"
            onClick={() => setHowOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            aria-expanded={howOpen}
          >
            {howOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <Info className="size-4 shrink-0 text-info" />
            <span className="font-medium">How City Management Works?</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-3 border-t">
              <section>
                <h3 className="font-semibold text-foreground mb-1">1. What a city row holds</h3>
                <p>
                  Each city row is keyed by City ID. It stores name, state, district (default
                  for pincodes in this city), tier (e.g. Tier 1 / Tier 2), and a reference
                  pincode used as a tie-breaker by some legacy reports. Status is a soft-delete
                  flag — never hard-delete because zones, pincodes, technicians, and historical
                  jobs reference cities by id.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">2. The counts column</h3>
                <p>
                  Zones / Pincodes / Technicians are computed live on every page load from the
                  related tables. Adding a zone or pincode under Manage Zones / Manage Pincodes
                  reflects here automatically — no sync step needed.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">3. Uniqueness</h3>
                <p>
                  A city name is unique <em>within a state</em>. Two cities named &ldquo;Hyderabad&rdquo;
                  in different states are allowed; two in the same state are not.
                </p>
              </section>
              <section>
                <h3 className="font-semibold text-foreground mb-1">4. Deactivating a city</h3>
                <p>
                  Soft-delete only. The city stays in the database; downstream rows keep their
                  reference. Default lists hide it; the &ldquo;Include inactive&rdquo; filter
                  brings it back so you can reactivate.
                </p>
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by city or district…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value ? Number(e.target.value) : '')}
            className="border rounded h-9 px-2 text-sm bg-background"
          >
            <option value="">All states</option>
            {lookup.states.map((s) => (
              <option key={s.state_id} value={s.state_id}>{s.state_name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={showTechCreated} onChange={(e) => setShowTechCreated(e.target.checked)} />
            Technician-Created Only
          </label>
        </CardContent>
      </Card>

      {(fetchError || mutationError) && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {fetchError || mutationError}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {/*
            * `table-fixed` + an explicit <colgroup> locks every column to a
            * known width regardless of cell content. Without this, the table
            * uses `auto` layout — column widths are recomputed based on the
            * widest cell in the *visible* page, so a sort that brings a long
            * district name into view (or a 4-digit technician count) snaps
            * the headers around.
            *
            * WIDTH PLAN — every number below is MEASURED, in a headless Chrome
            * driven against the compiled stylesheet (both chunks: the utility
            * chunk and the :root token chunk — with only the first, every
            * hsl(var(--x)) resolves to nothing and you measure fiction), in the
            * real authed shell: 240px sidebar + main's px-4 + the Card border.
            * That makes the table 906px at a 1180 viewport, 1006 at 1280,
            * 1166 at 1440, 1646 at 1920. 1180 is the binding case; anything
            * that fits there fits everywhere, because all eleven widths are
            * percentages and scale together.
            *
            * The old plan (7/14/12/17/6/7/8/10/12/8/11) claimed to sum to 100
            * and summed to 112, and six headers rendered cut off:
            *   City ID 7%, Pincodes 8%, Technicians 10% — cut with no arrow
            *   at 1180 AND 1280; Zones 7% and Status 8% at 1180; Tier 6%
            *   only once it became the active sort. The percentages never
            *   needed to total 100 (with no px column here the browser just
            *   normalises them, so each column gets pct/112 of the table) —
            *   but the TOTAL is kept at 112 so the ratios below can be read
            *   against the old ones, and so a future px column added to this
            *   group inherits the same remainder arithmetic manage-users
            *   documents.
            *
            * THE ARROW IS THE WHOLE PROBLEM. Header text needs 555px in total
            * and the eleven cells' px-3 padding eats another 264px, which fits
            * inside 906px with 87px to spare. But nine of these columns are
            * sortable, `<SortHeader>` adds a 12px arrow + 4px gap to whichever
            * one is active, and the widths are STATIC — so every one of the
            * nine has to reserve 16px for an arrow that only one of them ever
            * shows. That reservation is 144px against 87px of slack. On one
            * line, the eleven headers want 119.11% of a 112% budget: the table
            * is over-subscribed by 57px and NO reallocation can fix it.
            *
            * SO THREE HEADERS WRAP. City ID, City Name and Created By are the
            * only multi-word titles here, and a two-line header costs one row
            * of height, once — cheaper than the percentage it would take to
            * keep them on one line, and it keeps the full words (see
            * manage-users for the same trade). Wrapping them drops the demand
            * from 119.11% to 110.78%, which fits 112 with 9.9px to spare.
            * "Technicians", "Pincodes", "District" etc. are single words with
            * no break opportunity, so they can only be paid for in percent —
            * which is why they are the ones that grew.
            *
            * Width taken from CONTENT columns that truncate gracefully with a
            * title tooltip (City Name 14→9.8, State 12→9.3, District 17→11,
            * Created By 12→9.4) and given to the short identifier / count /
            * status columns, which have nowhere to put an overflow:
            *   City ID      7   → 8.2   (needs 8.09 at 1180, wrapped)
            *   City Name   14   → 9.8   (needs 9.66, wrapped)
            *   State       12   → 9.3   (needs 9.21)
            *   District    17   → 11    (needs 10.81)
            *   Tier         6   → 8.2   (needs 8.07)
            *   Zones        7   → 9.9   (needs 9.79)
            *   Pincodes     8   → 12.4  (needs 12.27)
            *   Technicians 10   → 14.5  (needs 14.42 — the widest single word)
            *   Created By  12   → 9.4   (needs 9.32, wrapped)
            *   Status       8   → 10.2  (needs 10.13)
            *   Actions     11   → 9.1   (needs 9.00: the "Actions" title is
            *                             wider than its two 20px icons)
            *
            * THE TENTHS ARE LOAD-BEARING — do not "tidy" them to integers.
            * Rounding each column up to a whole percent costs 117% against a
            * 112% budget; measured, the integer version puts State, Pincodes
            * and City ID back to clipping at 1180. Every column above clears
            * its requirement by 0.5–1.6px and no more; there is no headroom
            * left in this table to spend elsewhere.
            */}
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '8.2%'  }} />{/* City ID */}
              <col style={{ width: '9.8%'  }} />{/* City Name */}
              <col style={{ width: '9.3%'  }} />{/* State */}
              <col style={{ width: '11%'   }} />{/* District */}
              <col style={{ width: '8.2%'  }} />{/* Tier */}
              <col style={{ width: '9.9%'  }} />{/* Zones */}
              <col style={{ width: '12.4%' }} />{/* Pincodes */}
              <col style={{ width: '14.5%' }} />{/* Technicians */}
              <col style={{ width: '9.4%'  }} />{/* Created By */}
              <col style={{ width: '10.2%' }} />{/* Status */}
              <col style={{ width: '9.1%'  }} />{/* Actions */}
            </colgroup>
            <thead>
              <tr>
                {/*
                  * The inner `whitespace-normal` span is what lets these two
                  * titles fall onto a second line. `<SortHeader>` hard-codes
                  * `whitespace-nowrap` on BOTH the th and the inline-flex span
                  * it wraps children in, and only the th's copy goes through
                  * cn()/tailwind-merge — so a className on the header cannot
                  * reach the text. A span of our own inside it can: white-space
                  * inherits, and this one overrides it for its own content.
                  * Measured: at a 1180 viewport the label goes from a 82.9px
                  * single line overflowing a 55px cell to two 54.1px lines.
                  * It is a wrap, not a forced break — at 1920 both titles sit
                  * on one line and this costs nothing.
                  */}
                <SortHeader col={'city_id'          as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}><span className="whitespace-normal">City ID</span></SortHeader>
                <SortHeader col={'city_name'        as keyof City} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}><span className="whitespace-normal">City Name</span></SortHeader>
                <SortHeader col={'state_name'       as keyof City} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>State</SortHeader>
                <SortHeader col={'district'         as keyof City} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>District</SortHeader>
                <SortHeader col={'tier'             as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Tier</SortHeader>
                <SortHeader col={'zone_count'       as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Zones</SortHeader>
                <SortHeader col={'pincode_count'    as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Pincodes</SortHeader>
                <SortHeader col={'technician_count' as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Technicians</SortHeader>
                {/* Created By — technician (self-service) or CRM operator who
                    added the city. No `whitespace-nowrap` on the HEADER: the
                    title needs 71.2px and this column is 52px wide at 1180, so
                    it wraps to "Created / By" there and at 1280 rather than
                    losing its second word. The cell below keeps its nowrap +
                    truncate — a badge and a name have no break point worth
                    taking. */}
                <th className="!text-left">Created By</th>
                <SortHeader col={'city_status'      as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={11} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={11} className="!text-center text-muted-foreground py-6">No cities match the current filters.</td></tr>
              )}
              {!loading && sorted.map((c) => (
                <tr key={c.city_id}>
                  <td className="!text-center font-mono text-xs truncate">{c.city_id}</td>
                  <td className="!text-left font-medium truncate" title={c.city_name}>{c.city_name}</td>
                  <td className="!text-left truncate" title={c.state_name ?? ''}>
                    {c.state_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left truncate" title={c.district ?? ''}>
                    {c.district ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center truncate">{c.tier ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-center">{c.zone_count}</td>
                  <td className="!text-center">{c.pincode_count}</td>
                  <td className="!text-center">{c.technician_count}</td>
                  {/* Created By — Tech/CRM badge + name; — for legacy/seed cities. */}
                  <td className="!text-left whitespace-nowrap truncate">
                    {c.created_by_type ? (
                      <span className="inline-flex items-center gap-1" title={c.created_date ? String(c.created_date).replace('T', ' ').slice(0, 16) : undefined}>
                        <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${c.created_by_type === 'technician' ? 'bg-warning-tint text-warning-strong' : 'bg-ink-100 text-ink-700'}`}>
                          {c.created_by_type === 'technician' ? 'Tech' : 'CRM'}
                        </span>
                        {c.created_by_name || <span className="text-muted-foreground">#{c.created_by}</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {c.city_status === 1
                      ? <span className="text-success-strong text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    {/*
                      * Inline-flex with `justify-end` keeps the buttons on
                      * one row regardless of column width. Without this the
                      * default `Button` block-display can stack vertically
                      * when the cell is narrower than ~80px.
                      */}
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {can.isCityEdit && (
                        <IconButton
                          icon={Pencil}
                          label="Edit City"
                          intent="primary"
                          onClick={() => { setEditing(c); setModalOpen(true); }}
                        />
                      )}
                      {can.isCityEdit && c.city_status === 1 && (
                        <IconButton
                          icon={XCircle}
                          label="Deactivate City"
                          intent="danger"
                          onClick={() => handleDeactivate(c)}
                        />
                      )}
                      {!can.isCityEdit && (
                        <span className="text-xs text-muted-foreground">view-only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Pagination band — shared component, server-side paged. */}
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      <CityFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        states={lookup.states}
        onSaved={() => { setModalOpen(false); refreshList(); }}
      />
    </div>
  );
}

// ─── Add/Edit modal ─────────────────────────────────────────────────
function CityFormModal({
  open, onClose, editing, states, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: City | null;
  states: Array<{ state_id: number; state_name: string }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name,    setName]    = useState('');
  const [stateId, setStateId] = useState<number | ''>('');
  const [district, setDistrict] = useState('');
  const [tier,    setTier]    = useState('');
  const [refPin,  setRefPin]  = useState('');
  const [active,  setActive]  = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // State picker shares the click-list pattern from Manage Pincodes — same
  // browser-quirk-free behaviour, fully scrollable, search-filterable.
  const [stateQuery, setStateQuery] = useState('');
  const filteredStates = useMemo(() => {
    const q = stateQuery.trim().toLowerCase();
    if (!q) return states;
    return states.filter((s) => s.state_name.toLowerCase().includes(q));
  }, [states, stateQuery]);

  const selectedStateName = useMemo(
    () => states.find((s) => s.state_id === stateId)?.state_name ?? null,
    [states, stateId],
  );

  useEffect(() => {
    if (open) {
      setName(editing?.city_name ?? '');
      setStateId(editing?.state_id ?? '');
      setDistrict(editing?.district ?? '');
      setTier(editing?.tier ?? '');
      setRefPin(editing?.reference_pincode ?? '');
      setActive(editing ? editing.city_status === 1 : true);
      setStateQuery('');
      setError(null);
    }
  }, [open, editing]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('City name is required'); return; }
    if (!stateId)     { setError('State is required'); return; }
    if (refPin && !/^\d{6}$/.test(refPin)) { setError('Reference pincode must be 6 digits'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/cities/${editing!.city_id}`, {
          city_name: name,
          state_id:  Number(stateId),
          district:  district || null,
          tier:      tier || null,
          reference_pincode: refPin || null,
          is_active: active,
        });
      } else {
        await api.post('/admin/cities', {
          city_name: name,
          state_id:  Number(stateId),
          district:  district || null,
          tier:      tier || null,
          reference_pincode: refPin || null,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.city_name}"` : 'Add City'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="block mb-1" required>City Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "New Delhi", "Whitefield"'
            />
          </div>

          <div>
            <Label className="block mb-1" required>State</Label>
            <Input
              value={stateQuery}
              onChange={(e) => setStateQuery(e.target.value)}
              placeholder="Search states…"
              className="mb-1"
            />
            {selectedStateName && (
              <div className="text-xs text-muted-foreground mb-1">
                Selected: <span className="font-medium text-foreground">{selectedStateName}</span>
              </div>
            )}
            <div className="border rounded bg-background max-h-44 overflow-auto" role="listbox">
              {filteredStates.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No states match.</div>
              ) : filteredStates.map((s) => {
                const selected = s.state_id === stateId;
                return (
                  <button
                    type="button"
                    key={s.state_id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => setStateId(s.state_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 ${selected ? 'bg-primary/10 text-primary font-medium' : ''}`}
                  >
                    {s.state_name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label className="block mb-1">District (optional)</Label>
            <Input
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              placeholder="Default district for this city's pincodes"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1">Tier (optional)</Label>
              <Input
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                placeholder='e.g. "Tier 1"'
              />
            </div>
            <div>
              <Label className="block mb-1">Reference Pincode</Label>
              <Input
                value={refPin}
                onChange={(e) => setRefPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 digits — optional"
                className="font-mono"
              />
            </div>
          </div>

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Active</span>
            </label>
          )}

          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add City'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
