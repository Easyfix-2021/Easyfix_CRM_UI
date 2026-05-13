'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, Building2, Hash, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';

/*
 * Layout approach:
 *   Radix TabsContent alternates display:block/none, so nesting flex-1 inside
 *   breaks the expected flex-growth chain — content was collapsing to 0 height
 *   and the search bar visually drifted between tabs. Instead, we lift the tab
 *   state into React state, render ONE shared search input above a fixed-height
 *   scroll area, and manually swap the visible body by `activeTab`. This keeps
 *   the search bar in a stable DOM position regardless of tab, and gives the
 *   table a definite height so rows actually render.
 */

type ZoneDetail = {
  zone_id: number; zone_name: string; zone_status: number | null;
  cities: Array<{ city_id: number; city_name: string }>;
  pincodes: Array<{ pincode: string; city_name: string }>;
};
type Easyfixer = {
  efr_id: number; efr_name: string; efr_no: string; efr_email: string | null;
  is_technician_verified: boolean; efr_profile_perc: number | null;
  city_name: string | null;
};

type TabKey = 'easyfixers' | 'pincodes' | 'cities';

const TAB_META: Record<TabKey, { placeholder: string }> = {
  easyfixers: { placeholder: 'Search by name, mobile, email, city…' },
  pincodes:   { placeholder: 'Search pincode or city…' },
  cities:     { placeholder: 'Search city…' },
};

export function ZoneDetailModal({ zoneId, open, onClose }: {
  zoneId: number | null; open: boolean; onClose: () => void;
}) {
  const [detail, setDetail] = useState<ZoneDetail | null>(null);
  const [easyfixers, setEasyfixers] = useState<Easyfixer[] | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('easyfixers');
  // One query per tab — swap in/out via activeTab.
  const [q, setQ] = useState<Record<TabKey, string>>({ easyfixers: '', pincodes: '', cities: '' });

  useEffect(() => {
    if (!open || !zoneId) {
      setDetail(null); setEasyfixers(null); setActiveTab('easyfixers');
      setQ({ easyfixers: '', pincodes: '', cities: '' });
      return;
    }
    // Stale-data fix: clear previously-loaded zone data BEFORE firing the
    // new requests. Without this, opening modal for zone B right after
    // closing zone A showed A's name/city list while B's fetches were in
    // flight. `null` for both → renderer falls through to the loading
    // skeleton (`!detail` / `!easyfixers` branches below).
    setDetail(null);
    setEasyfixers(null);
    api.get<ZoneDetail>(`/admin/zones/${zoneId}`).then(setDetail).catch(() => setDetail(null));
    api.get<Easyfixer[]>(`/admin/zones/${zoneId}/easyfixers`, { limit: 500 })
       .then(setEasyfixers).catch(() => setEasyfixers([]));
  }, [open, zoneId]);

  const filteredEfrs = useMemo(() => {
    if (!easyfixers) return [];
    const needle = q.easyfixers.toLowerCase();
    if (!needle) return easyfixers;
    return easyfixers.filter((e) =>
      String(e.efr_id).includes(needle) ||
      e.efr_name.toLowerCase().includes(needle) ||
      (e.efr_no ?? '').toLowerCase().includes(needle) ||
      (e.efr_email ?? '').toLowerCase().includes(needle) ||
      (e.city_name ?? '').toLowerCase().includes(needle)
    );
  }, [easyfixers, q.easyfixers]);

  const filteredPincodes = useMemo(() => {
    if (!detail) return [];
    const needle = q.pincodes.toLowerCase();
    if (!needle) return detail.pincodes;
    return detail.pincodes.filter((p) => p.pincode.includes(needle) || p.city_name.toLowerCase().includes(needle));
  }, [detail, q.pincodes]);

  const filteredCities = useMemo(() => {
    if (!detail) return [];
    const needle = q.cities.toLowerCase();
    if (!needle) return detail.cities;
    return detail.cities.filter((c) => c.city_name.toLowerCase().includes(needle));
  }, [detail, q.cities]);

  function setActiveQuery(v: string) {
    setQ((prev) => ({ ...prev, [activeTab]: v }));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose className="max-w-5xl w-[min(95vw,1100px)] h-[85vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <DialogTitle>{detail ? detail.zone_name : 'Zone'}</DialogTitle>
          {detail && (
            <DialogDescription className="mt-1">
              Zone #{detail.zone_id} · {detail.cities.length} cities · {detail.pincodes.length} pincodes · {easyfixers?.length ?? '…'} technicians
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-hidden px-6 py-4 flex flex-col gap-3 min-h-0">
          {/* Tabs (controlled) */}
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
            <TabsList>
              <TabsTrigger value="easyfixers" className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Technicians</TabsTrigger>
              <TabsTrigger value="pincodes"   className="flex items-center gap-1.5"><Hash className="h-3.5 w-3.5" /> Pincodes</TabsTrigger>
              <TabsTrigger value="cities"     className="flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> Cities</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Shared search bar — lives outside TabsContent so its DOM position
              is stable across tab changes. Placeholder adapts; value is stored
              per-tab so switching doesn't lose a typed query. */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={TAB_META[activeTab].placeholder}
              value={q[activeTab]}
              onChange={(e) => setActiveQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Scroll body — definite height via flex-1 + min-h-0; swap inner
              content by activeTab rather than by Radix TabsContent. */}
          <div className="flex-1 min-h-0 border rounded overflow-y-auto">
            {activeTab === 'easyfixers' && (
              easyfixers === null ? (
                <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
              ) : filteredEfrs.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground text-center">
                  {q.easyfixers ? `No technicians match "${q.easyfixers}"` : 'No technicians assigned to this zone'}
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr><th>ID</th><th>Name</th><th>Mobile</th><th>Email</th><th>City</th><th>Verified</th><th>Profile %</th></tr>
                  </thead>
                  <tbody>
                    {filteredEfrs.map((e) => (
                      <tr key={e.efr_id}>
                        <td className="text-xs text-muted-foreground">{e.efr_id}</td>
                        <td className="font-medium">{formatEasyfixerName(e.efr_name)}</td>
                        <td>{e.efr_no}</td>
                        <td className="text-xs">{e.efr_email ?? '—'}</td>
                        <td>{e.city_name ?? '—'}</td>
                        <td>{e.is_technician_verified ? '✓' : <span className="text-muted-foreground">—</span>}</td>
                        <td className="text-xs tabular-nums">{e.efr_profile_perc != null ? `${Math.round(Number(e.efr_profile_perc))}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {activeTab === 'pincodes' && (
              !detail ? (
                <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
              ) : filteredPincodes.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground text-center">
                  {q.pincodes ? 'No pincodes match' : 'No pincodes in this zone'}
                </div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Pincode</th><th>City</th></tr></thead>
                  <tbody>
                    {filteredPincodes.map((p) => (
                      <tr key={`${p.city_name}-${p.pincode}`}>
                        <td className="font-mono">{p.pincode}</td>
                        <td>{p.city_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {activeTab === 'cities' && (
              !detail ? (
                <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
              ) : filteredCities.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground text-center">No cities match</div>
              ) : (
                <ul className="p-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {filteredCities.map((c) => (
                    <li key={c.city_id} className="text-sm px-2 py-1.5 rounded border bg-card">
                      {c.city_name}
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          {/* Count strip — stable position below the scroll area */}
          <div className="text-xs text-muted-foreground">
            {activeTab === 'easyfixers' && easyfixers && `Showing ${filteredEfrs.length} of ${easyfixers.length} technicians`}
            {activeTab === 'pincodes'   && detail      && `Showing ${filteredPincodes.length} of ${detail.pincodes.length} pincodes`}
            {activeTab === 'cities'     && detail      && `Showing ${filteredCities.length} of ${detail.cities.length} cities`}
          </div>
        </div>

        <div className="px-6 py-3 border-t bg-muted/30 flex justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
