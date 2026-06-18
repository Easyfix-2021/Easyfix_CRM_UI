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
  useEffect(() => { setPage(0); }, [debouncedSearch, stateFilter, includeInactive]);

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
          <h1 className="text-2xl font-bold flex items-center gap-2">
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
            <Info className="size-4 shrink-0 text-blue-600" />
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
        </CardContent>
      </Card>

      {(fetchError || mutationError) && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
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
            * the headers around. Sums to 100% so the table fills the card.
            *
            * Sort-arrow icons are an extra ~12px in active headers; widths
            * include enough padding that the arrow doesn't push text onto
            * a second line on the narrowest column (City ID).
            */}
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '7%'  }} /> {/* City ID */}
              <col style={{ width: '14%' }} /> {/* City Name */}
              <col style={{ width: '12%' }} /> {/* State */}
              <col style={{ width: '17%' }} /> {/* District */}
              <col style={{ width: '6%'  }} /> {/* Tier */}
              <col style={{ width: '7%'  }} /> {/* Zones */}
              <col style={{ width: '8%'  }} /> {/* Pincodes */}
              <col style={{ width: '10%' }} /> {/* Technicians */}
              <col style={{ width: '8%'  }} /> {/* Status */}
              <col style={{ width: '11%' }} /> {/* Actions */}
            </colgroup>
            <thead>
              <tr>
                <SortHeader col={'city_id'          as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City ID</SortHeader>
                <SortHeader col={'city_name'        as keyof City} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City Name</SortHeader>
                <SortHeader col={'state_name'       as keyof City} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>State</SortHeader>
                <SortHeader col={'district'         as keyof City} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>District</SortHeader>
                <SortHeader col={'tier'             as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Tier</SortHeader>
                <SortHeader col={'zone_count'       as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Zones</SortHeader>
                <SortHeader col={'pincode_count'    as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Pincodes</SortHeader>
                <SortHeader col={'technician_count' as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Technicians</SortHeader>
                <SortHeader col={'city_status'      as keyof City} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={10} className="!text-center text-muted-foreground py-6">No cities match the current filters.</td></tr>
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
                  <td className="!text-center whitespace-nowrap">
                    {c.city_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
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
                        <span className="text-[10px] text-muted-foreground">view-only</span>
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
            <label className="text-sm font-medium block mb-1">City Name *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "New Delhi", "Whitefield"'
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">State *</label>
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
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 ${selected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                  >
                    {s.state_name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">District (optional)</label>
            <Input
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              placeholder="Default district for this city's pincodes"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium block mb-1">Tier (optional)</label>
              <Input
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                placeholder='e.g. "Tier 1"'
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Reference Pincode</label>
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
            <div className="text-sm text-red-600 flex items-center gap-1">
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
