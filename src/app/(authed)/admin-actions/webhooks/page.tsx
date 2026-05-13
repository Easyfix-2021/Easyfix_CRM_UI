'use client';

/*
 * Webhook Manager — admin view over /api/admin/webhooks.
 *
 * Three tabs:
 *   - Events    : registry of dispatchable event types (webhook_events)
 *   - Mappings  : per-client callback URLs (webhook_client_url_mapping)
 *   - Logs      : delivery audit trail (webhook_logs)
 *
 * The dispatcher itself is wired in services/job.service.js auto-trigger
 * hooks (Phase 2); this page is purely admin/observability.
 */

import { useEffect, useState } from 'react';
import { Webhook, AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

/*
 * Field-name reality (verified 2026-05-13):
 *   The backend (services/webhook.service.js) returns rows with the legacy
 *   DB column names — `name`, `desc`, `status`, `call_back_url`, `insert_date`,
 *   `delivery_meta` (JSON-extracted from webhook_logs.job_data.__delivery).
 *   We keep the backend generic and adapt here at the consumer.
 */
type EventRow = {
  id: number;
  name: string | null;          // event identifier shown in the table
  desc: string | null;          // human description
  status: 'active' | 'inactive' | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};
type MappingRow = {
  id: number;
  client_id: number;
  client_name?: string | null;
  event_id: number;
  event_name?: string | null;
  call_back_url: string;
  authorization?: string | null;
  status?: 'active' | 'inactive' | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};
// delivery_meta arrives as the JSON value from `JSON_EXTRACT(job_data,
// '$.__delivery')` — could be a parsed object (mysql2 typecast) or a JSON
// string depending on driver settings. Handle both at render time.
type DeliveryMeta = { httpStatus?: number; error?: string; dlq?: boolean };
type LogRow = {
  id: number;
  client_id: number;
  event_id: number;
  job_id: number | null;
  call_back_url: string | null;
  insert_date: string | null;
  delivery_meta: DeliveryMeta | string | null;
};

// Normalise delivery_meta into a structured object regardless of how the
// driver hands it back — JSON_EXTRACT returns a JSON-string under some
// driver configs and a parsed object under others.
function parseDeliveryMeta(raw: LogRow['delivery_meta']): DeliveryMeta {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as DeliveryMeta; } catch { return {}; }
  }
  return raw;
}

export default function WebhookManagerPage() {
  const [tab, setTab] = useState<'events' | 'mappings' | 'logs'>('events');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Webhook className="size-6" /> Webhook Manager
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage event registry, per-client callback mappings, and delivery audit trail.
        </p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'events' | 'mappings' | 'logs')}>
        <TabsList>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="mappings">Client Mappings</TabsTrigger>
          <TabsTrigger value="logs">Delivery Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="events"><EventsTab /></TabsContent>
        <TabsContent value="mappings"><MappingsTab /></TabsContent>
        <TabsContent value="logs"><LogsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function EventsTab() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError(null);
    try { setRows(await api.get<EventRow[]>('/admin/webhooks/events')); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  if (loading) return <Loading />;
  if (error) return <Err msg={error} />;
  if (rows.length === 0) return <Empty msg="No webhook events registered." />;
  return (
    <div className="rounded-lg border bg-card overflow-x-auto mt-2">
      <table className="data-table w-full">
        <thead>
          <tr><th className="!text-center">ID</th><th>Event</th><th>Description</th><th className="!text-center">Status</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="!text-center font-mono text-xs">{r.id}</td>
              <td className="font-medium">{r.name || <span className="text-muted-foreground">—</span>}</td>
              <td className="text-xs text-muted-foreground">{r.desc || '—'}</td>
              <td className="!text-center text-xs">
                {r.status === 'active'
                  ? <span className="badge bg-emerald-50 text-emerald-700">Active</span>
                  : <span className="badge bg-slate-100 text-slate-600">Inactive</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MappingsTab() {
  const [clientId, setClientId] = useState('');
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (clientId) params.set('clientId', clientId);
      setRows(await api.get<MappingRow[]>(`/admin/webhooks/mappings?${params}`));
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          className="max-w-[200px] font-mono"
          placeholder="Filter by client_id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value.replace(/\D/g, ''))}
        />
        <Button onClick={load} variant="outline">
          <RefreshCw className="size-4 mr-1" /> Reload
        </Button>
      </div>
      {loading && <Loading />}
      {error && <Err msg={error} />}
      {!loading && !error && rows.length === 0 && <Empty msg="No mappings found." />}
      {!loading && !error && rows.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th>
                <th>Client</th>
                <th>Event</th>
                <th>Callback URL</th>
                <th className="!text-center">Auth</th>
                <th className="!text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="!text-center font-mono text-xs">{r.id}</td>
                  <td className="text-xs">{r.client_name || `#${r.client_id}`}</td>
                  <td className="text-xs">{r.event_name || `#${r.event_id}`}</td>
                  <td className="font-mono text-xs truncate max-w-[300px]" title={r.call_back_url}>{r.call_back_url}</td>
                  <td className="!text-center text-xs">{r.authorization ? '🔑' : '—'}</td>
                  <td className="!text-center text-xs">
                    {r.status === 'active'
                      ? <span className="badge bg-emerald-50 text-emerald-700">Active</span>
                      : <span className="badge bg-slate-100 text-slate-600">Off</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogsTab() {
  const [filters, setFilters] = useState({ clientId: '', eventId: '', jobId: '' });
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.clientId) params.set('clientId', filters.clientId);
      if (filters.eventId)  params.set('eventId',  filters.eventId);
      if (filters.jobId)    params.set('jobId',    filters.jobId);
      params.set('limit', '200');
      setRows(await api.get<LogRow[]>(`/admin/webhooks/logs?${params}`));
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Input className="max-w-[140px] font-mono" placeholder="client_id" value={filters.clientId}
          onChange={(e) => setFilters((f) => ({ ...f, clientId: e.target.value.replace(/\D/g, '') }))} />
        <Input className="max-w-[140px] font-mono" placeholder="event_id" value={filters.eventId}
          onChange={(e) => setFilters((f) => ({ ...f, eventId: e.target.value.replace(/\D/g, '') }))} />
        <Input className="max-w-[140px] font-mono" placeholder="job_id" value={filters.jobId}
          onChange={(e) => setFilters((f) => ({ ...f, jobId: e.target.value.replace(/\D/g, '') }))} />
        <Button onClick={load} variant="outline">
          <RefreshCw className="size-4 mr-1" /> Apply
        </Button>
      </div>
      {loading && <Loading />}
      {error && <Err msg={error} />}
      {!loading && !error && rows.length === 0 && <Empty msg="No delivery logs match." />}
      {!loading && !error && rows.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th>
                <th className="!text-center">Client</th>
                <th className="!text-center">Event</th>
                <th className="!text-center">Job</th>
                <th className="!text-center">Status</th>
                <th>Response</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = parseDeliveryMeta(r.delivery_meta);
                const code = meta.httpStatus ?? null;
                const summary = meta.error ?? (code != null ? `HTTP ${code}` : null);
                return (
                  <tr key={r.id}>
                    <td className="!text-center font-mono text-xs">{r.id}</td>
                    <td className="!text-center font-mono text-xs">{r.client_id}</td>
                    <td className="!text-center font-mono text-xs">{r.event_id}</td>
                    <td className="!text-center font-mono text-xs">{r.job_id ?? '—'}</td>
                    <td className="!text-center text-xs">
                      {code == null
                        ? <span className="badge bg-slate-100 text-slate-600">{meta.error ? 'err' : '—'}</span>
                        : code >= 200 && code < 300
                          ? <span className="badge bg-emerald-50 text-emerald-700">{code}</span>
                          : <span className="badge bg-rose-50 text-rose-700">{code}</span>}
                      {meta.dlq && <span className="ml-1 badge bg-amber-50 text-amber-700">DLQ</span>}
                    </td>
                    <td className="font-mono text-xs truncate max-w-[300px]" title={summary || ''}>
                      {summary ? summary.slice(0, 80) : '—'}
                    </td>
                    <td className="text-xs">{formatDate(r.insert_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Loading() { return <div className="text-sm text-muted-foreground py-6 text-center mt-2">Loading…</div>; }
function Err({ msg }: { msg: string }) {
  return (
    <Card className="mt-2"><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
      <AlertTriangle className="size-4" /> {msg}
    </CardContent></Card>
  );
}
function Empty({ msg }: { msg: string }) {
  return <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground mt-2">{msg}</div>;
}
