'use client';

/*
 * Zone city-mapping editor.
 *
 * Picks the canonical city list from the existing useLookup() hook (which
 * pulls /api/shared/lookup/cities). The current set of cities mapped to
 * THIS zone is what's checked initially. Saving submits the WHOLE city set
 * via PATCH /admin/zones/:id/cities — backend wipes + re-inserts, which
 * matches the multi-select UX (no diff tracking on the client).
 *
 * Pincode list is derived view-only — driven by the cities the zone owns.
 * No pincode-level CRUD yet (the legacy schema joins pincodes via
 * pincode_firefox_city_mapping → city_name; mutating that table is out of
 * scope for this iteration).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, MapPin, Building2, Search, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { useConfirm } from '@/components/ui/confirm-dialog';

type ZoneDetail = {
  zone_id: number;
  zone_name: string;
  zone_status: number | null;
  cities:   Array<{ city_id: number; city_name: string }>;
  pincodes: Array<{ pincode: string; city_name: string }>;
  orphanedEasyfixerCount?: number;
};

export default function ManageZoneDetail() {
  const router = useRouter();
  const params = useParams<{ zoneId: string }>();
  const zoneId = Number(params.zoneId);

  const lk = useLookup();
  const allCities = lk.cities;            // [{ city_id, city_name }]
  const [zone, setZone] = useState<ZoneDetail | null>(null);
  const [picked,  setPicked]  = useState<Set<number>>(new Set());
  const [filter,  setFilter]  = useState('');
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const confirmAction = useConfirm();

  async function load() {
    try {
      const z = await api.get<ZoneDetail>(`/admin/zones/${zoneId}`);
      setZone(z);
      setPicked(new Set(z.cities.map((c) => c.city_id)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load zone');
    }
  }
  useEffect(() => { if (Number.isFinite(zoneId)) load(); /* eslint-disable-next-line */ }, [zoneId]);

  const filteredCities = useMemo(() => {
    if (!filter) return allCities;
    const q = filter.toLowerCase();
    return allCities.filter((c) => c.city_name.toLowerCase().includes(q));
  }, [allCities, filter]);

  function toggle(cityId: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(cityId)) next.delete(cityId); else next.add(cityId);
      return next;
    });
  }

  /*
   * Save flow: if any city is being REMOVED (was in zone.cities, no longer
   * in `picked`), we warn how many active easyfixers will end up orphaned
   * (their efr_zone_city_id will dangle). The backend computes this number
   * inside the same transaction as the wipe-and-reinsert.
   */
  async function save() {
    if (!zone) return;
    const before = new Set(zone.cities.map((c) => c.city_id));
    const removing = [...before].filter((id) => !picked.has(id));
    if (removing.length > 0) {
      const ok = await confirmAction({
        title: `Remove ${removing.length} ${removing.length === 1 ? 'city' : 'cities'}?`,
        description: 'Easyfixers currently pinned to those cities under this zone will end up with a dangling zone-city reference. They will need to be reassigned manually.',
        variant: 'destructive',
        confirmLabel: 'Yes, save changes',
      });
      if (!ok) return;
    }
    setBusy(true); setErr(null); setSuccess(null);
    try {
      const updated = await api.patch<ZoneDetail>(`/admin/zones/${zoneId}/cities`, {
        city_ids: [...picked],
      });
      setZone(updated);
      setPicked(new Set(updated.cities.map((c) => c.city_id)));
      setSuccess(
        `Saved. ${updated.cities.length} cities mapped.` +
        (updated.orphanedEasyfixerCount && updated.orphanedEasyfixerCount > 0
          ? ` ${updated.orphanedEasyfixerCount} easyfixer${updated.orphanedEasyfixerCount === 1 ? '' : 's'} now have a dangling zone-city reference — please review.`
          : '')
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setBusy(false); }
  }

  if (!Number.isFinite(zoneId)) return <div className="p-4 text-sm text-destructive">Invalid zone id</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/settings/zones" className="text-sm text-muted-foreground hover:underline inline-flex items-center">
          <ChevronLeft className="h-4 w-4" /> Back to all zones
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold">{zone?.zone_name ?? 'Loading…'}</h1>
        <p className="text-sm text-muted-foreground">
          Tick cities to include them in this zone. Saving replaces the whole
          city set in one transaction.
        </p>
      </div>

      {err     && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}
      {success && <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{success}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── City picker (left, 2 cols) ─────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardContent className="p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                <Building2 className="inline h-4 w-4 mr-1 text-sky-700" />
                Cities ({picked.size}/{allCities.length} selected)
              </h2>
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Filter cities…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-[480px] overflow-y-auto border rounded p-2">
              {filteredCities.map((c) => (
                <label key={c.city_id} className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-muted/50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={picked.has(c.city_id)}
                    onChange={() => toggle(c.city_id)}
                    className="h-4 w-4 accent-sky-600"
                  />
                  <span className="truncate">{c.city_name}</span>
                </label>
              ))}
              {filteredCities.length === 0 && (
                <div className="col-span-full text-center text-muted-foreground text-sm py-4">No cities match filter</div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => router.push('/settings/zones')}>Cancel</Button>
              <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Pincode summary (right, 1 col) ─────────────────────── */}
        <Card>
          <CardContent className="p-3 space-y-2">
            {/*
              * Pincodes are filtered using the SAME `filter` text that scopes the
              * cities checkbox grid. Logic: a pincode row matches if its city
              * matches the filter OR the pincode itself contains the filter text.
              * This way typing a city name on the left automatically narrows the
              * pincodes shown on the right — and conversely typing a pincode
              * fragment (e.g. "1100") still finds it.
              */}
            {(() => {
              const q = filter.trim().toLowerCase();
              const all = zone?.pincodes ?? [];
              const visible = q
                ? all.filter((p) =>
                    (p.city_name ?? '').toLowerCase().includes(q) ||
                    String(p.pincode).toLowerCase().includes(q)
                  )
                : all;
              return (
                <>
                  <h2 className="text-sm font-semibold">
                    <MapPin className="inline h-4 w-4 mr-1 text-violet-700" />
                    Pincodes covered ({visible.length}{q && all.length !== visible.length ? ` of ${all.length}` : ''})
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Derived from <code>pincode_firefox_city_mapping</code>. Reflects the
                    SAVED state — refresh after saving to see new entries.
                    {q && <> Filter on the left also scopes this list.</>}
                  </p>
                  <div className="max-h-[480px] overflow-y-auto border rounded text-xs">
                    <table className="data-table">
                      <thead><tr><th>Pincode</th><th>City</th></tr></thead>
                      <tbody>
                        {visible.map((p, i) => (
                          <tr key={`${p.pincode}-${i}`}>
                            <td className="font-mono">{p.pincode}</td>
                            <td>{p.city_name}</td>
                          </tr>
                        ))}
                        {visible.length === 0 && (
                          <tr>
                            <td colSpan={2} className="text-center text-muted-foreground py-4">
                              {all.length === 0
                                ? 'No pincodes — add cities first.'
                                : `No pincodes match "${filter}".`}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {zone && zone.zone_status === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 inline-flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          This zone is currently <strong>inactive</strong> — auto-allocation will skip it. Reactivate from the zones list to use it again.
        </div>
      )}
    </div>
  );
}
