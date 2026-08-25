'use client';

/*
 * Clients — Manage Clients page.
 *
 * Shared-component contract (touch-it-migrate-it rule, 2026-05-25):
 *   - DownloadButton (canonical emerald CTA) replaces ad-hoc Button
 *     for the list export.
 *   - TablePagination is the canonical footer — server-side paginated
 *     via `?limit=&offset=`.
 *   - SortHeader + cycleSort drive the 3-click sort cycle; sortBy/sortDir
 *     are sent to the BE so it ORDER-BYs the COMPLETE list (not just the
 *     loaded page). A header click resets to page 0 and refetches.
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
import { useRouter } from 'next/navigation';
import { Building2, Search, AlertTriangle, Plus, Upload } from 'lucide-react';
import { RowActionsMenu } from '@/components/client/RowActionsMenu';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { downloadXlsx } from '@/lib/download-xlsx';
import { showToast } from '@/components/ui/toast';
import { StatusChip } from '@/components/ui/StatusChip';
import { RefreshBar } from '@/components/ui/refresh-bar';
import type { ClientRow, ClientListResponse, ClientTab } from '@/lib/client-types';
import { ClientFormDialog } from '@/components/client/ClientFormDialog';

type SortKey = keyof ClientRow;

export default function ClientsPage() {
  const { me } = useMe();
  const can = actionFlags(me, ['isClientAddNew', 'isClientEdit']);
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);

  // Server-side pagination state. Page is 0-indexed (offset = page * pageSize).
  // TablePagination's BE Joi cap on this endpoint is 500 per page — pass that
  // to pageSizeToLimit so 'All' resolves to a 500 ceiling, not 1000.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

  // Sort state — SERVER-SIDE. sortBy/sortDir ride the list query so the BE
  // orders the COMPLETE list (not just the loaded page); a header click
  // resets to page 0 and refetches.
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  function onSortToggle(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
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
    if (sortBy) { p.set('sortBy', String(sortBy)); p.set('sortDir', sortDir); }
    return `/admin/clients?${p.toString()}`;
  }, [debouncedSearch, includeInactive, limit, page, pageSize, sortBy, sortDir]);

  // Refreshes on action (the save flow calls refetch()); now SILENT + flicker-
  // free since `loading` only gates first paint. `refreshing` drives the top bar.
  const { data: list, loading, refreshing, error } = useFetch<ClientListResponse>(listKey);

  // Server-side sorted + paginated — render the page exactly as the BE
  // returns it (ordering is applied over the complete list, not here).
  const items = list?.items ?? [];

  const total = list?.total ?? 0;

  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState(false);

  /*
   * Opening a client is now a NAVIGATION, not a modal. The tab rides in the
   * query string, so the kebab menu's deep links (Services, Rate Cards, …) are
   * shareable URLs and the browser Back button returns to this list — neither
   * of which the old ClientDetailDialog could do.
   */
  function openClient(id: number, tab: ClientTab = 'overview') {
    router.push(tab === 'overview' ? `/clients/${id}` : `/clients/${id}?tab=${tab}`);
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
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="size-6" /> Manage Clients
          </h1>
          <p className="text-sm text-muted-foreground">
            Tenants/clients (B2B) — contacts, billing, services, rate cards, and SPOC assignments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isClientAddNew && (
            <Button variant="outline" onClick={() => router.push('/clients/bulk-upload')}>
              <Upload className="size-4 mr-1" /> Bulk Upload
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
              placeholder="Search by name, email, city, ref code, ID or SPOC…"
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
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <RefreshBar active={refreshing} />
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
                <th className="!text-center">Magic Link</th>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && (
                <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">No clients match the filter.</td></tr>
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
                      ? <span className="text-success-strong text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-center">
                    {c.magic_link_enabled
                      ? <StatusChip tone="emerald" size="sm">Enabled</StatusChip>
                      : <StatusChip tone="red" size="sm">Disabled</StatusChip>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
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

      {creating && (
        <ClientFormDialog
          open={creating}
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            invalidateFetch((k) => k.startsWith('/admin/clients'));
            // Straight into the new client's profile — creating one is always
            // followed by filling in contacts, services and rate cards.
            openClient(id);
          }}
        />
      )}
    </div>
  );
}
