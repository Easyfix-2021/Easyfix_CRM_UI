'use client';

/*
 * Client Profile → Branches.
 *
 * The client's store directory (tbl_client_store), which the platform already
 * relied on but no CRM screen showed: the client portal reads it to drive the
 * store-code picker on New Order, and every job booked through that picker
 * carries a store code an operator previously had no way to resolve.
 *
 * Backed by GET /admin/clients/:clientId/stores — read-only. Rows are loaded
 * by the client's own onboarding data feed, so an edit surface here would be
 * overwritten on the next load; the honest move is to show them, not to offer
 * an edit that does not stick.
 *
 * Retired branches are INCLUDED (the endpoint does not filter on status, unlike
 * the portal's picker) because the operator case is usually a job booked
 * against a branch that has since closed.
 */

import { useMemo, useState } from 'react';
import { MapPin, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import type { ClientStore } from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

export function BranchesSection({ clientId }: { clientId: number }) {
  const { data, loading, error } = useFetch<{ items: ClientStore[]; provisioned: boolean }>(
    `/admin/clients/${clientId}/stores`,
  );
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 250).trim().toLowerCase();

  const items = useMemo(() => {
    const rows = data?.items ?? [];
    if (!q) return rows;
    return rows.filter((s) => [s.store_code, s.store_name, s.city_name, s.contact_name, s.pin_code]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
  }, [data, q]);

  return (
    <SectionShell
      title="Branches"
      note="Store / site directory this client books against. Loaded from their onboarding feed — read-only here."
    >
      {error && <p className="text-sm text-urgent-strong">{error}</p>}

      <div className="relative max-w-sm">
        <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search code, name, city or pincode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="text-xs text-muted-foreground">
        {loading ? 'Loading…' : `${items.length} branch${items.length === 1 ? '' : 'es'}`}
        {data && !data.provisioned && ' · tbl_client_store is not provisioned on this environment.'}
      </div>

      {!loading && items.length === 0 && (
        <p className="text-sm text-muted-foreground italic flex items-center gap-1">
          <MapPin className="size-3.5" /> No branches on file for this client.
        </p>
      )}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Code</th>
                <th className="!text-left">Branch</th>
                <th className="!text-left">City</th>
                <th className="!text-left">Pincode</th>
                <th className="!text-left">Site Contact</th>
                <th className="!text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="!text-left font-mono text-xs">{s.store_code ?? '—'}</td>
                  <td className="!text-left">
                    <div className="font-medium">{s.store_name ?? '—'}</div>
                    {s.address && <div className="text-xs text-muted-foreground">{s.address}</div>}
                  </td>
                  <td className="!text-left text-xs">{s.city_name ?? '—'}</td>
                  <td className="!text-left text-xs font-mono">{s.pin_code ?? '—'}</td>
                  <td className="!text-left text-xs">
                    {s.contact_name ?? '—'}
                    {s.contact_no && <div className="text-muted-foreground">{s.contact_no}</div>}
                  </td>
                  <td className="!text-center">
                    <StatusChip tone={Number(s.status) === 1 ? 'success' : 'neutral'} size="sm">
                      {Number(s.status) === 1 ? 'Active' : 'Retired'}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}
