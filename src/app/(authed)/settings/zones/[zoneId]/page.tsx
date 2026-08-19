'use client';

/*
 * Zone detail — pincode-mapping editor (many-to-many).
 *
 * The editor lets the operator SEARCH the ENTIRE active pincode catalog
 * (any city — the old zone-city restriction is gone) and tick which ones
 * belong to THIS zone. Membership is many-to-many via
 * tbl_zone_pincode_mapping — a pincode may belong to several zones at once.
 *
 * The current membership is seeded from getZoneDetail().pincodes into a
 * `selected` Set<pincode_id>. The search box queries listAssignablePincodes
 * (debounced, server-side, paginated); each result row is checked iff its id
 * is in `selected`. Ticking/unticking mutates `selected` and PERSISTS across
 * searches — so the operator can search "110", tick a few, search "560", tick
 * more, and Save sends the FULL accumulated set.
 *
 * Save calls PATCH /admin/zones/:id/pincodes with the WHOLE pincode set this
 * zone should own. It only affects THIS zone's mappings — other zones'
 * membership of the same pincodes is untouched (wipe + re-insert scoped to
 * this zone). Works even when the zone has "No City".
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, MapPin, Building2, Search, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useSort, SortHeader } from '@/lib/use-sort';

type ZoneDetail = {
  zone_id: number;
  zone_name: string;
  zone_status: number | null;
  city_id: number | null;
  city_name: string | null;
  pincode_count: number;
  technician_count: number;
  pincodes: Array<{
    pincode_id: number;
    pincode: string;
    location: string | null;
    district: string | null;
    pincode_status: number;
  }>;
};

type Assignable = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  district: string | null;
  city_name: string | null;
  in_this_zone: boolean;
};

type AssignableResponse = {
  items: Assignable[];
  total: number;
};

export default function ManageZoneDetail() {
  const router = useRouter();
  const params = useParams<{ zoneId: string }>();
  const zoneId = Number(params.zoneId);
  const validZone = Number.isFinite(zoneId);

  const {
    data: zone,
    error: zoneErr,
  } = useFetch<ZoneDetail>(validZone ? `/admin/zones/${zoneId}` : null);

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [filter, setFilter] = useState('');
  // "Show In Zone Only" filter — server-backed via inZoneOnly so it surfaces
  // ALL pincodes currently mapped to this zone (with city), not just those
  // matching the search box.
  const [showInZoneOnly, setShowInZoneOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ pincode_id: number; pincode?: string; reason: string }>>([]);

  // Seed the editable selection from the zone's CURRENT pincodes (the source
  // of truth) once the detail loads. The search result list is paginated, so
  // it can't be the seed — only getZoneDetail().pincodes has the full set.
  useEffect(() => {
    if (zone && !seeded) {
      setPicked(new Set(zone.pincodes.map((p) => p.pincode_id)));
      setSeeded(true);
    }
  }, [zone, seeded]);

  // Debounced server-side search across the WHOLE active pincode catalog.
  const debouncedFilter = useDebouncedValue(filter, 300);
  // Server-side pagination for the pincode pool (BE caps `limit` at 200).
  // Selection lives in `picked` (independent of the visible page), so paging
  // never loses ticks.
  const [poolPage, setPoolPage] = useState(0);
  const [poolPageSize, setPoolPageSize] = useState<TablePageSize>(50);
  // Any query change resets to the first page.
  useEffect(() => { setPoolPage(0); }, [debouncedFilter, showInZoneOnly]);
  const poolLimit = pageSizeToLimit(poolPageSize, 200);
  const searchUrl = useMemo(() => {
    if (!validZone) return null;
    const p = new URLSearchParams();
    if (debouncedFilter.trim()) p.set('q', debouncedFilter.trim());
    if (showInZoneOnly) p.set('inZoneOnly', 'true');
    p.set('limit', String(poolLimit));
    p.set('offset', String(poolPage * (poolPageSize === 'all' ? poolLimit : Number(poolPageSize))));
    return `/admin/zones/${zoneId}/assignable-pincodes?${p.toString()}`;
  }, [validZone, zoneId, debouncedFilter, showInZoneOnly, poolPage, poolPageSize, poolLimit]);

  const {
    data: poolData,
    error: poolErr,
    loading: poolLoading,
  } = useFetch<AssignableResponse>(searchUrl);

  const results = poolData?.items ?? [];
  const resultTotal = poolData?.total ?? 0;
  const loadErr = zoneErr ?? poolErr;

  // Augment each row with the live `selected` flag (from `picked` — the
  // EDITABLE selection, which can differ from the server's in_this_zone once
  // the operator ticks/unticks). Default order floats SELECTED pincodes to the
  // top; the client-side useSort (3-state) overrides this when a column header
  // is clicked. Sorting "Status" sorts by `selected`.
  type Row = Assignable & { selected: boolean };
  const orderedRows = useMemo<Row[]>(() => {
    const base: Row[] = results.map((r) => ({ ...r, selected: picked.has(r.pincode_id) }));
    base.sort((a, b) =>
      (Number(b.selected) - Number(a.selected)) ||
      String(a.pincode).localeCompare(String(b.pincode), undefined, { numeric: true })
    );
    return base;
  }, [results, picked]);
  const { sorted, sortKey, sortDir, toggle: toggleSort } = useSort<Row>(orderedRows);

  function toggle(pincodeId: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(pincodeId)) next.delete(pincodeId); else next.add(pincodeId);
      return next;
    });
  }

  async function save() {
    if (!zone) return;
    setBusy(true); setErr(null); setSuccess(null); setRejected([]);
    try {
      type SaveResp = ZoneDetail & { rejected: Array<{ pincode_id: number; pincode?: string; reason: string }> };
      const updated = await api.patch<SaveResp>(`/admin/zones/${zoneId}/pincodes`, {
        pincode_ids: [...picked],
      });
      setRejected(updated.rejected ?? []);
      const okCount = updated.pincodes.length;
      const rejCount = (updated.rejected ?? []).length;
      setSuccess(
        `Saved. ${okCount} Pincode${okCount === 1 ? '' : 's'} Mapped To This Zone.` +
        (rejCount > 0 ? ` ${rejCount} Row${rejCount === 1 ? '' : 's'} Rejected — See Below.` : '')
      );
      // Re-seed `picked` from the server's authoritative post-save set, and
      // invalidate the zone-detail + assignable caches so the next read is fresh.
      setPicked(new Set(updated.pincodes.map((p) => p.pincode_id)));
      invalidateFetch((k) => k.startsWith(`/admin/zones/${zoneId}`));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setBusy(false); }
  }

  if (!validZone) return <div className="p-4 text-sm text-destructive">Invalid Zone Id</div>;
  if (loadErr) return <div className="p-4 text-sm text-urgent">{loadErr}</div>;
  if (!zone) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/settings/zones" className="text-sm text-muted-foreground hover:underline inline-flex items-center">
          <ChevronLeft className="h-4 w-4" /> Back To Zones
        </Link>
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{zone.zone_name}</h1>
          <div className="text-sm text-muted-foreground mt-0.5">
            <Building2 className="inline h-4 w-4 mr-1 text-info" />
            {zone.city_name ?? 'No City'} · ID {zone.zone_id}
            {zone.zone_status
              ? <span className="ml-3 text-success-strong text-xs">● Active</span>
              : <span className="ml-3 text-muted-foreground text-xs">○ Inactive</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push('/settings/zones')}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Mapping'}</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryCard icon={<MapPin className="h-4 w-4 text-gold-strong" />} label="Pincodes In Zone" value={picked.size} />
        <SummaryCard icon={<Search className="h-4 w-4 text-warning" />}  label="Matching Search"  value={resultTotal} />
        <SummaryCard icon={<Building2 className="h-4 w-4 text-info" />} label="Technicians"      value={zone.technician_count} />
      </div>

      {err     && <Card><CardContent className="p-3 text-sm text-urgent    flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {err}</CardContent></Card>}
      {success && <Card><CardContent className="p-3 text-sm text-success-strong flex items-center gap-2"><CheckCircle2  className="h-4 w-4" /> {success}</CardContent></Card>}

      {rejected.length > 0 && (
        <Card>
          <CardContent className="p-3 text-sm space-y-1">
            <div className="font-medium text-warning-strong">Rejected Rows ({rejected.length})</div>
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {rejected.slice(0, 20).map((r, i) => (
                <li key={i}>
                  {r.pincode ? <span className="font-mono">{r.pincode}</span> : <span>id {r.pincode_id}</span>} — {r.reason}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <strong>Add Pincodes To This Zone</strong>
              <span className="text-xs text-muted-foreground ml-2">
                Search Any Pincode (Any City) And Tick The Ones That Belong To This Zone — A Pincode May Also Belong To Other Zones
              </span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInZoneOnly}
                  onChange={(e) => setShowInZoneOnly(e.target.checked)}
                />
                Show In Zone Pincodes Only
              </label>
              <div className="relative w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search Pincodes By Code / City To Add…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
          </div>

          {poolLoading ? (
            <div className="text-sm text-muted-foreground p-4 text-center">Searching…</div>
          ) : results.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4 text-center">
              {showInZoneOnly
                ? (debouncedFilter.trim()
                    ? 'No In-Zone Pincodes Match Your Search.'
                    : 'No Pincodes Are Mapped To This Zone Yet.')
                : (debouncedFilter.trim()
                    ? 'No Pincodes Match Your Search.'
                    : 'Search Pincodes By Code / City To Add…')}
            </div>
          ) : (
            <>
              <div className="border rounded max-h-[28rem] overflow-auto">
                <table className="data-table w-full">
                  <thead className="sticky top-0 bg-background z-10">
                    <tr>
                      <th className="!text-center w-10"></th>
                      <SortHeader col={'pincode'   as keyof Row} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggleSort}>Pincode</SortHeader>
                      <SortHeader col={'location'  as keyof Row} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggleSort}>Location</SortHeader>
                      <SortHeader col={'city_name' as keyof Row} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggleSort}>City</SortHeader>
                      <SortHeader col={'district'  as keyof Row} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggleSort}>District</SortHeader>
                      <SortHeader col={'selected'  as keyof Row} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggleSort}>Status</SortHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((p) => {
                      const checked = p.selected;
                      return (
                        <tr key={p.pincode_id} className="hover:bg-muted/40 cursor-pointer" onClick={() => toggle(p.pincode_id)}>
                          <td className="!text-center">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggle(p.pincode_id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className="!text-left font-mono">{p.pincode}</td>
                          <td className="!text-left">{p.location ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="!text-left">{p.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="!text-left">{p.district ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="!text-center text-xs">
                            {checked
                              ? <span className="text-success-strong">In This Zone</span>
                              : <span className="text-muted-foreground">Not In This Zone</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pt-1">
                <TablePagination
                  page={poolPage}
                  pageSize={poolPageSize}
                  total={resultTotal}
                  onPageChange={setPoolPage}
                  onPageSizeChange={(s) => { setPoolPage(0); setPoolPageSize(s); }}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground flex items-center gap-1">{icon} {label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}
