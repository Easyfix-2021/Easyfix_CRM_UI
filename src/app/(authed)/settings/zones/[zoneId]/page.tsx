'use client';

/*
 * Zone detail — pincode-mapping editor (many-to-many).
 *
 * Each zone belongs to one city. The editor lists ALL assignable pincodes
 * in that city (from tbl_pincode) and lets the operator tick which ones
 * belong to THIS zone. Membership is many-to-many via
 * tbl_zone_pincode_mapping — a pincode may belong to several zones at once,
 * so every row carries an `in_this_zone` flag reflecting whether it is
 * currently mapped to the zone being edited. See backend
 * services/zone.service.js::listAssignablePincodes for the source query.
 *
 * Save calls PATCH /admin/zones/:id/pincodes with the WHOLE pincode set
 * this zone should own. It only affects THIS zone's mappings — other zones'
 * membership of the same pincodes is untouched (wipe + re-insert scoped to
 * this zone, matching the multi-select UX).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, MapPin, Building2, Search, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';

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
  in_this_zone: boolean;
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
  const {
    data: pool,
    error: poolErr,
    refetch: refetchPool,
  } = useFetch<Assignable[]>(validZone ? `/admin/zones/${zoneId}/assignable-pincodes` : null);

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ pincode_id: number; pincode?: string; reason: string }>>([]);

  // Seed the editable selection from the membership flag whenever the pool
  // (re)loads. `in_this_zone` is the source of truth for current membership.
  useEffect(() => {
    if (pool) setPicked(new Set(pool.filter((p) => p.in_this_zone).map((p) => p.pincode_id)));
  }, [pool]);

  const loadErr = zoneErr ?? poolErr;

  const filteredPool = useMemo(() => {
    const list = pool ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      p.pincode.includes(q) ||
      (p.location ?? '').toLowerCase().includes(q) ||
      (p.district ?? '').toLowerCase().includes(q)
    );
  }, [pool, filter]);

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
      // Refetch the assignable list; the effect above re-seeds `picked`
      // from the fresh `in_this_zone` flags.
      refetchPool();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setBusy(false); }
  }

  if (!validZone) return <div className="p-4 text-sm text-destructive">Invalid Zone Id</div>;
  if (loadErr) return <div className="p-4 text-sm text-red-600">{loadErr}</div>;
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
            <Building2 className="inline h-4 w-4 mr-1 text-sky-700" />
            {zone.city_name ?? 'No City'} · ID {zone.zone_id}
            {zone.zone_status
              ? <span className="ml-3 text-emerald-700 text-xs">● Active</span>
              : <span className="ml-3 text-muted-foreground text-xs">○ Inactive</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push('/settings/zones')}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Mapping'}</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryCard icon={<MapPin className="h-4 w-4 text-violet-700" />} label="Pincodes In Zone" value={picked.size} />
        <SummaryCard icon={<MapPin className="h-4 w-4 text-amber-600" />}  label="Not In This Zone" value={(pool ?? []).filter((p) => !picked.has(p.pincode_id)).length} />
        <SummaryCard icon={<Building2 className="h-4 w-4 text-sky-700" />} label="Technicians"      value={zone.technician_count} />
      </div>

      {err     && <Card><CardContent className="p-3 text-sm text-red-600    flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {err}</CardContent></Card>}
      {success && <Card><CardContent className="p-3 text-sm text-emerald-700 flex items-center gap-2"><CheckCircle2  className="h-4 w-4" /> {success}</CardContent></Card>}

      {rejected.length > 0 && (
        <Card>
          <CardContent className="p-3 text-sm space-y-1">
            <div className="font-medium text-amber-700">Rejected Rows ({rejected.length})</div>
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
              <strong>Pincodes In {zone.city_name ?? 'This City'}</strong>
              <span className="text-xs text-muted-foreground ml-2">
                Tick The Pincodes That Belong To This Zone — A Pincode May Also Belong To Other Zones
              </span>
            </div>
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter By Pincode, Location, District…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {(pool ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground p-4 text-center">
              No Pincodes Available For This Zone&apos;s City. Add Pincodes Via Settings → Manage Pincodes First.
            </div>
          ) : (
            <div className="border rounded max-h-[28rem] overflow-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th className="!text-center w-10"></th>
                    <th className="!text-left">Pincode</th>
                    <th className="!text-left">Location</th>
                    <th className="!text-left">District</th>
                    <th className="!text-center">In This Zone</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPool.map((p) => {
                    const checked = picked.has(p.pincode_id);
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
                        <td className="!text-left">{p.district ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="!text-center text-xs">
                          {checked
                            ? <span className="text-emerald-700">In This Zone</span>
                            : <span className="text-muted-foreground">Not In This Zone</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
