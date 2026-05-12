'use client';

import { useEffect, useMemo, useState } from 'react';
import { MapPin, Users, Search, Building2, Hash } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';
import { ZoneDetailModal } from '@/components/zones/ZoneDetailModal';

/*
 * Zone dashboard: shows all 25 zones with counts of cities, pincodes, and
 * active easyfixers per zone. Click a zone → detail modal with the city list,
 * pincode list, and a searchable table of assigned easyfixers. Separate
 * pincode-lookup box lets the user answer "which easyfixers serve this
 * pincode?" without drilling into zones.
 *
 * All data comes from existing legacy tables (tbl_zone_master,
 * tbl_zone_city_mapping, pincode_firefox_city_mapping, tbl_easyfixer) — no
 * schema changes. See services/zone.service.js for the join chain.
 */

type Zone = {
  zone_id: number;
  zone_name: string;
  zone_status: number | null;
  created_date: string | null;
  city_count: number;
  easyfixer_count: number;
  pincode_count: number;
};

type PincodeSearchResult = {
  pincode: string;
  easyfixers: Array<{
    efr_id: number; efr_name: string; efr_no: string; efr_email: string | null;
    is_technician_verified: boolean;
    city_name: string | null; zone_id: number; zone_name: string;
  }>;
};

export default function EasyfixerZonesPage() {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zoneSearch, setZoneSearch] = useState('');
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);

  const [pincode, setPincode] = useState('');
  const [pincodeResult, setPincodeResult] = useState<PincodeSearchResult | null>(null);
  const [pincodeLoading, setPincodeLoading] = useState(false);
  const [pincodeErr, setPincodeErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Zone[]>('/admin/zones').then(setZones).catch(() => setZones([]));
  }, []);

  const filteredZones = useMemo(() => {
    if (!zones) return [];
    if (!zoneSearch) return zones;
    const q = zoneSearch.toLowerCase();
    return zones.filter((z) => z.zone_name.toLowerCase().includes(q));
  }, [zones, zoneSearch]);

  async function lookupPincode(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(pincode)) {
      setPincodeErr('Enter a 6-digit Indian pincode');
      setPincodeResult(null);
      return;
    }
    setPincodeLoading(true); setPincodeErr(null);
    try {
      const r = await api.get<PincodeSearchResult>('/admin/zones/by-pincode', { pincode, limit: 100 });
      setPincodeResult(r);
    } catch {
      setPincodeErr('Lookup failed');
      setPincodeResult(null);
    } finally { setPincodeLoading(false); }
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Easyfixer Zones</h1>
        <p className="text-sm text-muted-foreground">
          Zones group cities + pincodes. Click a zone to see its pincodes and assigned technicians.
        </p>
      </div>

      {/* Pincode-first lookup — answers "which technicians cover pincode X?" */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <form onSubmit={lookupPincode} className="flex items-center gap-2">
            <div className="relative w-72">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Pincode (6 digits)"
                value={pincode}
                onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="pl-9"
              />
            </div>
            <button
              type="submit"
              disabled={pincodeLoading || pincode.length !== 6}
              className="rounded-md bg-primary text-primary-foreground text-sm px-3 h-9 disabled:opacity-50"
            >
              {pincodeLoading ? 'Searching…' : 'Find technicians'}
            </button>
            {pincodeErr && <span className="text-sm text-destructive">{pincodeErr}</span>}
            {pincodeResult && !pincodeErr && (
              <span className="text-sm text-muted-foreground">
                {pincodeResult.easyfixers.length} technician{pincodeResult.easyfixers.length === 1 ? '' : 's'} serve {pincodeResult.pincode}
              </span>
            )}
          </form>

          {pincodeResult && pincodeResult.easyfixers.length > 0 && (
            <div className="overflow-x-auto border rounded">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Mobile</th>
                    <th>City</th>
                    <th>Zone</th>
                    <th>Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {pincodeResult.easyfixers.map((e) => (
                    <tr key={e.efr_id}>
                      <td className="text-xs text-muted-foreground">{e.efr_id}</td>
                      <td className="font-medium">{formatEasyfixerName(e.efr_name)}</td>
                      <td>{e.efr_no}</td>
                      <td>{e.city_name ?? '—'}</td>
                      <td className="text-xs">{e.zone_name}</td>
                      <td>{e.is_technician_verified ? '✓' : <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Zone grid — one card per zone with counts */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">All Zones</h2>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter zones…"
                value={zoneSearch}
                onChange={(e) => setZoneSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {zones === null && <div className="text-sm text-muted-foreground py-8 text-center">Loading zones…</div>}
          {zones !== null && filteredZones.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">No zones match &quot;{zoneSearch}&quot;</div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {filteredZones.map((z) => (
              <button
                key={z.zone_id}
                onClick={() => setSelectedZoneId(z.zone_id)}
                className="text-left rounded-lg border bg-card p-3 transition-colors hover:border-primary hover:shadow-sm"
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-8 w-8 rounded-md bg-primary/10 text-primary grid place-items-center">
                    <MapPin className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{z.zone_name}</div>
                    <div className="text-[11px] text-muted-foreground">Zone #{z.zone_id}</div>
                  </div>
                </div>
                <dl className="text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="h-3 w-3" /> Cities</dt>
                    <dd className="font-medium tabular-nums">{Number(z.city_count ?? 0).toLocaleString()}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Hash className="h-3 w-3" /> Pincodes</dt>
                    <dd className="font-medium tabular-nums">{Number(z.pincode_count ?? 0).toLocaleString()}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Users className="h-3 w-3" /> Technicians</dt>
                    <dd className="font-medium tabular-nums">{Number(z.easyfixer_count ?? 0).toLocaleString()}</dd>
                  </div>
                </dl>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <ZoneDetailModal
        zoneId={selectedZoneId}
        open={selectedZoneId !== null}
        onClose={() => setSelectedZoneId(null)}
      />
    </div>
  );
}
