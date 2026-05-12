'use client';

/*
 * Clients — list + detail modal with sub-tabs.
 *
 * Backend (verified in routes/admin/clients.js):
 *   GET  /admin/clients?q=&includeInactive=&limit=&offset=
 *   GET  /admin/clients/:id
 *   POST /admin/clients   (legacy create — not exposed here yet)
 *   PUT  /admin/clients/:id  (edit — not exposed here yet)
 *   GET  /admin/clients/:clientId/contacts
 *   GET  /admin/clients/:clientId/billing
 *   GET  /admin/clients/:clientId/custom-properties
 *
 * Legacy `EasyFix_CRM` had 24 client sub-screens (questionnaires, products,
 * services, EFR-mapping, etc.). The bigger ones (questionnaires, products,
 * services) are deferred — see migration_review_counter.md.
 *
 * This page ships the operational read view: list every client + click to see
 * full detail with Overview / Contacts / Billing / Custom Properties tabs.
 */

import { useEffect, useRef, useState } from 'react';
import { Building2, Search, AlertTriangle, Eye } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

type ClientRow = {
  client_id: number;
  client_name: string;
  client_email: string | null;
  client_status: number | null;
  client_type: string | null;
  reference_code: string | null;
  booking_cut_off: string | null;
};

type ClientContact = Record<string, unknown> & { id: number; contact_name?: string | null; contact_email?: string | null; contact_no?: string | null };
type ClientBilling = Record<string, unknown> & { id: number };
type ClientCustomProp = Record<string, unknown> & { id: number; property_name?: string | null; property_value?: string | null };

export default function ClientsPage() {
  const [items, setItems] = useState<ClientRow[]>([]);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<number | null>(null);

  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => { void load(); }, 300);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, includeInactive]);

  async function load() {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      if (includeInactive) p.set('includeInactive', 'true');
      p.set('limit', '500');
      const data = await api.get<ClientRow[]>(`/admin/clients?${p}`);
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load clients');
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="size-6" /> Clients
        </h1>
        <p className="text-sm text-muted-foreground">
          Tenants/clients (B2B). Click a row to view contacts, billing, and custom properties.
          Create + edit deferred — clients are typically onboarded by backend admin.
        </p>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by client name…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th>
                <th className="!text-left">Client Name</th>
                <th className="!text-left">Email</th>
                <th className="!text-left">Type</th>
                <th className="!text-left">Reference</th>
                <th className="!text-center">Status</th>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">No clients match the filter.</td></tr>
              )}
              {!loading && items.map((c) => (
                <tr key={c.client_id}>
                  <td className="!text-center font-mono text-xs">{c.client_id}</td>
                  <td className="!text-left font-medium">{c.client_name}</td>
                  <td className="!text-left text-xs">{c.client_email ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left text-xs">{c.client_type ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left font-mono text-xs">{c.reference_code ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-center">
                    {c.client_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right">
                    <Button size="sm" variant="ghost" onClick={() => setViewingId(c.client_id)}>
                      <Eye className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {viewingId != null && (
        <ClientDetailDialog clientId={viewingId} onClose={() => setViewingId(null)} />
      )}
    </div>
  );
}

function ClientDetailDialog({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const [client, setClient] = useState<Record<string, unknown> | null>(null);
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [billing, setBilling] = useState<ClientBilling[]>([]);
  const [props, setProps] = useState<ClientCustomProp[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        // Parallel fetch — each is cheap.
        const [c, ct, b, cp] = await Promise.all([
          api.get<Record<string, unknown>>(`/admin/clients/${clientId}`),
          api.get<ClientContact[]>(`/admin/clients/${clientId}/contacts`).catch(() => []),
          api.get<ClientBilling[]>(`/admin/clients/${clientId}/billing`).catch(() => []),
          api.get<ClientCustomProp[]>(`/admin/clients/${clientId}/custom-properties`).catch(() => []),
        ]);
        if (cancelled) return;
        setClient(c);
        setContacts(Array.isArray(ct) ? ct : []);
        setBilling(Array.isArray(b) ? b : []);
        setProps(Array.isArray(cp) ? cp : []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : 'Failed to load client detail');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientId]);

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-3xl">
        <DialogHeader>
          <DialogTitle>{String(client?.client_name ?? `Client #${clientId}`)}</DialogTitle>
        </DialogHeader>
        {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {err && <div className="text-sm text-red-600">{err}</div>}
        {!loading && !err && client && (
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="contacts">Contacts ({contacts.length})</TabsTrigger>
              <TabsTrigger value="billing">Billing ({billing.length})</TabsTrigger>
              <TabsTrigger value="props">Custom ({props.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <div className="grid grid-cols-2 gap-2 text-sm pt-2">
                {[
                  ['Client ID', client.client_id],
                  ['Name', client.client_name],
                  ['Email', client.client_email],
                  ['Type', client.client_type],
                  ['Reference', client.reference_code],
                  ['Booking cut-off', client.booking_cut_off],
                  ['Status', client.client_status === 1 ? 'Active' : 'Inactive'],
                  ['Created', client.insert_date ? formatDate(String(client.insert_date)) : null],
                ].map(([k, v]) => (
                  <div key={String(k)}>
                    <span className="text-muted-foreground">{String(k)}:</span>{' '}
                    <span>{v == null || v === '' ? '—' : String(v)}</span>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="contacts">
              {contacts.length === 0 ? <div className="text-sm text-muted-foreground italic pt-2">No contacts on file.</div> : (
                <ul className="space-y-1 pt-2 text-sm">
                  {contacts.map((c) => (
                    <li key={c.id} className="rounded border bg-card px-2 py-1">
                      <div className="font-medium">{String(c.contact_name ?? '—')}</div>
                      <div className="text-xs text-muted-foreground">{String(c.contact_email ?? '')} {c.contact_no ? `· ${c.contact_no}` : ''}</div>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="billing">
              {billing.length === 0 ? <div className="text-sm text-muted-foreground italic pt-2">No billing rows.</div> : (
                <pre className="text-xs bg-muted/30 rounded p-2 overflow-auto max-h-64">{JSON.stringify(billing, null, 2)}</pre>
              )}
            </TabsContent>
            <TabsContent value="props">
              {props.length === 0 ? <div className="text-sm text-muted-foreground italic pt-2">No custom properties.</div> : (
                <ul className="space-y-1 pt-2 text-sm">
                  {props.map((p) => (
                    <li key={p.id} className="flex gap-2">
                      <span className="font-medium min-w-[160px]">{String(p.property_name ?? '—')}:</span>
                      <span>{String(p.property_value ?? '—')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
