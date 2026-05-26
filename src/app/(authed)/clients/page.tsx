'use client';

/*
 * Clients — Manage Clients page.
 *
 * Shared-component contract (touch-it-migrate-it rule, 2026-05-25):
 *   - DownloadButton (canonical emerald CTA) replaces ad-hoc Button
 *     for the list export.
 *   - TablePagination is the canonical footer — server-side paginated
 *     via `?limit=&offset=`.
 *   - SortHeader + cycleSort drive the 3-click sort cycle (refetches
 *     are NOT triggered; sort is applied client-side over the loaded
 *     page since the BE returns up to one page worth).
 *
 * Columns (matches legacy `filteredClientList.vm` ordering with light
 * relabeling for clarity):
 *   ID · Client Name · Email · City · Primary SPOC · Secondary SPOC · Status · Actions
 *
 * Primary/Secondary SPOC are INTERNAL CRM users assigned via
 * tbl_vertical_mapping (user_type=1, 2). Resolved server-side in one
 * bulk query; merged into the list payload.
 *
 * Permission gates (unchanged):
 *   - isClientAddNew  → Add New + Bulk Upload buttons
 *   - isClientEdit    → in-dialog mutations
 */

import { useMemo, useState } from 'react';
import { Building2, Search, AlertTriangle, Pencil, Plus, Upload, FileDown } from 'lucide-react';
import { RowActionsMenu } from '@/components/client/RowActionsMenu';
type ClientTab = 'overview' | 'contacts' | 'billing' | 'props' | 'services' | 'rate-cards' | 'tech-mapping' | 'verticals' | 'documents';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatDate } from '@/lib/utils';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { downloadXlsx } from '@/lib/download-xlsx';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import type { ClientRow, ClientDetail, ClientListResponse } from '@/lib/client-types';
import { ClientFormDialog } from '@/components/client/ClientFormDialog';
import { ContactsTab } from '@/components/client/ContactsTab';
import { BillingTab } from '@/components/client/BillingTab';
import { CustomPropsTab } from '@/components/client/CustomPropsTab';
import { VerticalsTab } from '@/components/client/VerticalsTab';
import { DocumentsTab } from '@/components/client/DocumentsTab';
import { ServicesTab } from '@/components/client/ServicesTab';
import { RateCardsTab } from '@/components/client/RateCardsTab';
import { TechMappingTab } from '@/components/client/TechMappingTab';
import { COLLECTED_BY_OPTIONS } from '@/lib/client-types';
import { useRef } from 'react';

type SortKey = keyof ClientRow;

export default function ClientsPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isClientAddNew', 'isClientEdit']);

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);

  // Server-side pagination state. Page is 0-indexed (offset = page * pageSize).
  // TablePagination's BE Joi cap on this endpoint is 500 per page — pass that
  // to pageSizeToLimit so 'All' resolves to a 500 ceiling, not 1000.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

  // Sort state — client-side over the loaded page. Mirrors what
  // Manage Users uses for the legacy-shape lookup tables.
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  function onSortToggle(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
  }

  // Compose the list key. Reset page on filter changes by tracking the
  // current search/inactive separately; if they change, snap page → 0.
  // This is simpler than a useEffect with deps because the key already
  // changes, and the FE re-fetches; we just need to ensure offset is
  // recomputed from the latest page.
  const limit = pageSizeToLimit(pageSize, 500);
  const listKey = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedSearch.trim()) p.set('q', debouncedSearch.trim());
    if (includeInactive) p.set('includeInactive', 'true');
    p.set('limit', String(limit));
    p.set('offset', String(page * (pageSize === 'all' ? limit : Number(pageSize))));
    return `/admin/clients?${p.toString()}`;
  }, [debouncedSearch, includeInactive, limit, page, pageSize]);

  const { data: list, loading, error } = useFetch<ClientListResponse>(listKey);

  // Sort the loaded page client-side. For a >500-row dataset, sort
  // should ultimately move server-side; today the BE returns ORDER BY
  // client_name and this hook lets the operator re-sort within the
  // page without a network round-trip.
  const items = useMemo(() => {
    const arr = (list?.items ?? []).slice();
    if (!sortBy) return arr;
    arr.sort((a, b) => {
      const av: unknown = (a as Record<string, unknown>)[sortBy as string];
      const bv: unknown = (b as Record<string, unknown>)[sortBy as string];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const na = Number(av), nb = Number(bv);
      const cmp = (!Number.isNaN(na) && !Number.isNaN(nb) && typeof av !== 'string')
        ? na - nb
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [list?.items, sortBy, sortDir]);

  const total = list?.total ?? 0;

  const [editingId, setEditingId] = useState<number | null>(null);
  // Deep-link target tab — set by the kebab menu so we can open the
  // manage modal directly on (say) "Rate Cards" instead of forcing
  // the operator to click Edit → tab. 'overview' is the default.
  const [editingTab, setEditingTab] = useState<ClientTab>('overview');
  const [creating, setCreating] = useState(false);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  function openClient(id: number, tab: ClientTab = 'overview') {
    setEditingTab(tab);
    setEditingId(id);
  }

  async function onExport() {
    setDownloading(true);
    try {
      const p = new URLSearchParams();
      if (debouncedSearch.trim()) p.set('q', debouncedSearch.trim());
      if (includeInactive) p.set('includeInactive', 'true');
      await downloadXlsx({
        url: `/admin/clients/export?${p.toString()}`,
        filename: `clients-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Export failed.' });
    } finally { setDownloading(false); }
  }

  return (
    <div className="space-y-4">
      {/* Header band — matches Manage Users layout: title+subtitle on
          the left, action cluster on the right, single horizontal row.
          items-center keeps the cluster vertically centred against the
          two-line title block. Subtitle kept short so the row doesn't
          flex-wrap on mid-width viewports. */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="size-6" /> Manage Clients
          </h1>
          <p className="text-sm text-muted-foreground">
            Tenants/clients (B2B) — contacts, billing, services, rate cards, and SPOC assignments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isClientAddNew && (
            <Button variant="outline" onClick={() => setBulkUploading(true)}>
              <Upload className="size-4 mr-1" /> Bulk Upload SPOCs
            </Button>
          )}
          <DownloadButton
            onClick={onExport}
            downloading={downloading}
            disabled={total === 0}
            title={total === 0 ? 'No rows to export' : 'Download visible rows as Xlsx'}
            label="Export"
          />
          {can.isClientAddNew && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4 mr-1" /> Add New Client
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by client name or SPOC name…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-8"
            />
          </div>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }}
            />
            Include Inactive
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
                <SortHeader col={'client_id'      as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>ID</SortHeader>
                <SortHeader col={'client_name'    as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Client Name</SortHeader>
                <SortHeader col={'client_email'   as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Email</SortHeader>
                <SortHeader col={'city_name'      as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>City</SortHeader>
                <th className="!text-left">Primary SPOC</th>
                <th className="!text-left">Secondary SPOC</th>
                <SortHeader col={'client_status'  as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Status</SortHeader>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No clients match the filter.</td></tr>
              )}
              {!loading && items.map((c) => (
                <tr key={c.client_id} className="cursor-pointer hover:bg-muted/30" onClick={() => openClient(c.client_id)}>
                  <td className="!text-center font-mono text-xs">{c.client_id}</td>
                  <td className="!text-left font-medium">{c.client_name}</td>
                  <td className="!text-left text-xs">{c.client_email ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left text-xs">{c.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left text-xs">
                    {c.primary_spoc?.name ? (
                      <>
                        <div>{c.primary_spoc.name}</div>
                        {c.primary_spoc.user_email && <div className="text-muted-foreground">{c.primary_spoc.user_email}</div>}
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left text-xs">
                    {c.secondary_spoc?.name ? (
                      <>
                        <div>{c.secondary_spoc.name}</div>
                        {c.secondary_spoc.user_email && <div className="text-muted-foreground">{c.secondary_spoc.user_email}</div>}
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center">
                    {c.client_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right">
                    {/* Row actions — pencil (Edit) for the most-common
                        action, kebab menu for tab-jumps (Services /
                        Rate Cards / Tech Mapping / Billing / Contacts)
                        + the direct Download Rate Card action. The
                        component stops row-click bubbling internally
                        so kebab clicks don't auto-open the modal. */}
                    <RowActionsMenu
                      clientId={c.client_id}
                      clientName={c.client_name}
                      isActive={c.client_status === 1}
                      canEdit={!!can.isClientEdit}
                      onOpen={(tab) => openClient(c.client_id, tab)}
                    />
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

      {editingId != null && (
        <ClientDetailDialog
          clientId={editingId}
          canEdit={!!can.isClientEdit}
          initialTab={editingTab}
          onClose={() => setEditingId(null)}
        />
      )}

      {creating && (
        <ClientFormDialog
          open={creating}
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setEditingId(id);
            invalidateFetch((k) => k.startsWith('/admin/clients'));
          }}
        />
      )}

      {bulkUploading && (
        <BulkSpocUploadDialog
          onClose={() => setBulkUploading(false)}
          onUploaded={() => {
            invalidateFetch((k) => k.startsWith('/admin/clients'));
          }}
        />
      )}
    </div>
  );
}

/* ─── Detail dialog (full-screen-ish, matches Book Call) ──────────── */

function ClientDetailDialog({
  clientId, canEdit, initialTab, onClose,
}: {
  clientId: number;
  canEdit: boolean;
  initialTab?: ClientTab;
  onClose: () => void;
}) {
  const { data: client, loading, error, refetch } = useFetch<ClientDetail>(`/admin/clients/${clientId}`);
  const [editing, setEditing] = useState(false);
  // Controlled tab so the kebab menu's deep-link works; operator can
  // still switch tabs by clicking the trigger, hence the onValueChange.
  const [tab, setTab] = useState<ClientTab>(initialTab ?? 'overview');

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden flex flex-col p-0 gap-0">
        {/*
         * Dark slate band — matches the global DialogHeader convention
         * (memory `feedback_easyfix_modal_header_color`). The default
         * shadcn DialogHeader applies this via negative margins; our
         * DialogContent uses `p-0` which disables that, so we recreate
         * the band inline with the same gradient + sky underline.
         * pr-12 keeps the Edit button from sliding under the X close.
         */}
        <DialogHeader className="px-5 py-3 bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900 text-white shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)] !mx-0 !mt-0 !mb-0">
          <div className="flex items-center justify-between pr-12">
            <DialogTitle className="text-white text-base font-semibold">
              {String(client?.client_name ?? `Client #${clientId}`)}
              {client?.client_status === 0 && (
                <span className="ml-2 text-xs font-normal text-slate-200/80 bg-slate-700/60 px-2 py-0.5 rounded">Inactive</span>
              )}
            </DialogTitle>
            {canEdit && client && (
              <Button
                size="sm"
                onClick={() => setEditing(true)}
                className="bg-white text-slate-900 hover:bg-slate-100"
              >
                <Pencil className="size-3.5 mr-1" /> Edit Basic Info
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 pb-4">
          {loading && <div className="text-sm text-muted-foreground pt-3">Loading…</div>}
          {error && <div className="text-sm text-red-600 pt-3">{error}</div>}
          {!loading && !error && client && (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as ClientTab)}
              className="pt-3"
            >
              <div className="overflow-x-auto pb-1 -mx-1 px-1">
                <TabsList className="!w-max">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="contacts">Contacts</TabsTrigger>
                  <TabsTrigger value="billing">Billing</TabsTrigger>
                  <TabsTrigger value="props">Custom Properties</TabsTrigger>
                  <TabsTrigger value="services">Services</TabsTrigger>
                  <TabsTrigger value="rate-cards">Rate Cards</TabsTrigger>
                  <TabsTrigger value="tech-mapping">Tech Mapping</TabsTrigger>
                  <TabsTrigger value="verticals">Verticals</TabsTrigger>
                  <TabsTrigger value="documents">Documents</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="overview">
                <OverviewPanel client={client} />
              </TabsContent>
              <TabsContent value="contacts">
                <ContactsTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="billing">
                <BillingTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="props">
                <CustomPropsTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="services">
                <ServicesTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="rate-cards">
                <RateCardsTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="tech-mapping">
                <TechMappingTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="verticals">
                <VerticalsTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="documents">
                <DocumentsTab clientId={clientId} canEdit={canEdit} />
              </TabsContent>
            </Tabs>
          )}
        </div>

        {editing && client && (
          <ClientFormDialog
            open={editing}
            mode="edit"
            initial={client}
            onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); refetch(); }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function OverviewPanel({ client }: { client: ClientDetail }) {
  const collectedByLabel = (() => {
    if (client.collected_by == null) return '—';
    const opt = COLLECTED_BY_OPTIONS.find((o) => o.value === Number(client.collected_by));
    return opt?.label ?? '—';
  })();

  const rows: { label: string; value: unknown; mono?: boolean }[] = [
    { label: 'Client ID',         value: client.client_id, mono: true },
    { label: 'Name',              value: client.client_name },
    { label: 'Type',              value: client.client_type },
    { label: 'Email',             value: client.client_email },
    { label: 'Reference',         value: client.reference_code, mono: true },
    { label: 'Status',            value: client.client_status === 1 ? 'Active' : 'Inactive' },
    { label: 'Address',           value: client.client_address },
    { label: 'Booking Cut-off',   value: client.booking_cut_off != null ? `${client.booking_cut_off} hr` : null },
    { label: 'Max Orders',        value: client.max_orders },
    { label: 'Travel Distance',   value: client.travel_distance != null ? `${client.travel_distance} km` : null },
    { label: 'Collected By',      value: collectedByLabel },
    { label: 'Created',           value: client.insert_date ? formatDate(String(client.insert_date)) : null },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3">
      {rows.map((r) => (
        <div key={r.label} className="rounded border bg-card px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.label}</div>
          <div className={`text-sm mt-0.5 ${r.mono ? 'font-mono' : ''}`}>
            {r.value == null || r.value === '' ? <span className="text-muted-foreground">—</span> : String(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Bulk SPOC Assignment Upload Dialog ──────────────────────────── */

type BulkSpocResult = {
  rowNumber: number;
  status: 'updated' | 'invalid' | 'skipped' | 'failed';
  errors?: string[];
  reason?: string;
  detail?: { primary?: string; secondary?: string };
};

function BulkSpocUploadDialog({
  onClose, onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{
    summary: { total: number; updated: number; invalid: number; skipped: number; failed: number };
    results: BulkSpocResult[];
  } | null>(null);

  async function downloadTemplate() {
    try {
      await downloadXlsx({
        url: '/admin/clients/bulk-spoc-template',
        filename: 'client-bulk-spoc-template.xlsx',
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' });
    }
  }

  async function onUpload() {
    if (!fileRef.current?.files?.[0]) {
      showToast({ variant: 'error', message: 'Choose an .xlsx file first.' });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', fileRef.current.files[0]);
      const res = await api.post<typeof result>(`/admin/clients/bulk-upload-spocs`, fd);
      setResult(res);
      if (res && res.summary.updated > 0) onUploaded();
      showToast({ variant: 'success', message: `${res?.summary.updated ?? 0} client SPOC pair(s) updated.` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Upload failed.' });
    } finally { setUploading(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !uploading && onClose()}>
      <DialogContent className="!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk Upload Primary/Secondary SPOCs</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 pt-1">
          <div className="text-xs text-muted-foreground">
            Upload an .xlsx with columns: <b>Client ID</b>, Client Name (for reference),{' '}
            <b>Primary SPOC User ID</b>, <b>Secondary SPOC User ID</b>. Existing assignments are updated;
            new ones are created automatically. Primary and Secondary must be different users.
          </div>
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-7">
              <label className="text-xs font-medium">File</label>
              <Input
                ref={fileRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              />
            </div>
            <div className="col-span-5 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={downloadTemplate} className="flex-1">
                <FileDown className="size-3.5 mr-1" /> Template
              </Button>
              <Button onClick={onUpload} disabled={uploading} className="flex-1">
                <Upload className="size-3.5 mr-1" /> {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </div>
          </div>

          {result && (
            <div className="mt-3 rounded border bg-card p-3 space-y-1">
              <div className="text-sm font-medium">
                Total {result.summary.total} · Updated {result.summary.updated} ·
                Invalid {result.summary.invalid} · Skipped {result.summary.skipped} ·
                Failed {result.summary.failed}
              </div>
              <div className="max-h-60 overflow-auto text-xs border rounded">
                <table className="w-full">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left px-2 py-1">Row</th>
                      <th className="text-left px-2 py-1">Status</th>
                      <th className="text-left px-2 py-1">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {result.results.map((r, i) => (
                      <tr key={i} className={
                        r.status === 'updated' ? 'bg-emerald-50/30'
                        : r.status === 'skipped' ? 'bg-amber-50/30'
                        : 'bg-red-50/30'
                      }>
                        <td className="px-2 py-1 font-mono">{r.rowNumber}</td>
                        <td className="px-2 py-1">{r.status}</td>
                        <td className="px-2 py-1">
                          {r.reason ?? r.errors?.join('; ')
                            ?? (r.detail ? `primary=${r.detail.primary}, secondary=${r.detail.secondary}` : '')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
