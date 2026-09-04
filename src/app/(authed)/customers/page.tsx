'use client';

/*
 * Customers — list view over tbl_customer.
 *
 * Backend: GET /admin/customers?q=&limit=&offset=&sortBy=&sortDir=
 *          GET /admin/customers/:id  (includes addresses[])
 *
 * Legacy CRM had a heavy multi-tab form for create/edit. In the new
 * platform, customers are auto-upserted via job creation (lookup by
 * customer_mob_no in jobService.create's upsertCustomer step). This page
 * is read-first — operators inspect existing rows and the linked address
 * + job count. Creating customers from this surface isn't typically
 * needed; if it becomes one, extend with a New Customer dialog later.
 */

import { useEffect, useRef, useState } from 'react';
import { Users, Search, AlertTriangle, Eye } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { formatDate } from '@/lib/utils';
import { formatServiceAddress } from '@/lib/format';
import { CallableMobile } from '@/components/calls/CallButton';

type CustomerRow = {
  customer_id: number;
  customer_name: string | null;
  customer_mob_no: string | null;
  customer_email: string | null;
  is_active: number | null;
  insert_date: string | null;
  update_date: string | null;
  job_count: number;
};
type ListResponse = { items: CustomerRow[]; total: number };
type CustomerDetail = CustomerRow & {
  addresses: Array<Record<string, unknown>>;
};

/*
 * 'All' is intentionally absent. /admin/customers caps `limit` at 500 and
 * tbl_customer is far larger than that, so "All" would fetch 500 rows under a
 * footer reading "Showing 1–<total> of <total>" and leave the operator with no
 * control to reach the rest. The other three sizes are all below the cap.
 */
const CUSTOMERS_LIMIT_CAP = 500; // BE Joi cap on /admin/customers `limit`.
const CUSTOMER_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];
/* Was `const PAGE = 50` behind a fixed footer — kept as the default so the
   first paint shows the same 50 rows it always did. */
const DEFAULT_PAGE_SIZE: TablePageSize = 50;

export default function CustomersPage() {
  const [items, setItems] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<CustomerDetail | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => { setPage(0); void load(); }, 300);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [page, pageSize]);

  async function load() {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      // 'all' is not offered here (see CUSTOMER_PAGE_SIZES), but the offset
      // expression stays size-agnostic so adding it later can't silently
      // multiply the page index by the wrong number.
      const limit = pageSizeToLimit(pageSize, CUSTOMERS_LIMIT_CAP);
      p.set('limit', String(limit));
      p.set('offset', String(page * (pageSize === 'all' ? limit : Number(pageSize))));
      const data = await api.get<ListResponse>(`/admin/customers?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load customers');
    } finally { setLoading(false); }
  }

  async function openDetail(id: number) {
    setViewLoading(true);
    try {
      const data = await api.get<CustomerDetail>(`/admin/customers/${id}`);
      setViewing(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load customer');
    } finally { setViewLoading(false); }
  }

  /*
   * The clamp + snap-back that used to live here now lives inside
   * TablePagination, which fires onPageChange once with the clamped index when
   * the parent's `page` overruns a shrunken result set. A second copy here
   * would fight it.
   */

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="size-6" /> Customers
        </h1>
        <p className="text-sm text-muted-foreground">
          Customers are auto-created when a job is booked. This is a read view of all customer
          rows + their addresses and job counts.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, mobile, or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">ID</th>
                <th className="!text-left">Name</th>
                <th className="!text-left">Mobile</th>
                <th className="!text-left">Email</th>
                <th className="!text-center">Jobs</th>
                <th className="!text-center">Status</th>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">No customers match the search.</td></tr>
              )}
              {!loading && items.map((c) => (
                <tr key={c.customer_id}>
                  <td className="!text-center font-mono text-xs">{c.customer_id}</td>
                  <td className="!text-left font-medium">{c.customer_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left font-mono text-xs">
                    {/* Click-to-call via Kaleyra; permission-gated, falls
                        back to non-clickable masked string if the operator
                        lacks isClickToCall. */}
                    <CallableMobile customerId={c.customer_id} mobile={c.customer_mob_no} />
                  </td>
                  <td className="!text-left text-xs">{c.customer_email ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-center font-mono text-xs">{c.job_count}</td>
                  <td className="!text-center">
                    {c.is_active === 1
                      ? <span className="text-success-strong text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right">
                    <Button size="sm" variant="ghost" onClick={() => openDetail(c.customer_id)}>
                      <Eye className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Always rendered, unlike the `totalPages > 1` footer it replaces — the
          page-size selector has to stay reachable on a single-page list. */}
      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        pageSizeOptions={CUSTOMER_PAGE_SIZES}
      />

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {viewing?.customer_name ?? `Customer #${viewing?.customer_id}`}
            </DialogTitle>
          </DialogHeader>
          {viewLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {viewing && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Mobile:</span>
                  {/* Mobile itself is the call trigger. Component never
                      receives the raw digits as an action target — only the
                      customer_id. BE looks up customer_mob_no server-side. */}
                  <CallableMobile customerId={viewing.customer_id} mobile={viewing.customer_mob_no} />
                </div>
                <div><span className="text-muted-foreground">Email:</span> {viewing.customer_email ?? '—'}</div>
                <div><span className="text-muted-foreground">Jobs:</span> <span className="font-mono">{viewing.job_count}</span></div>
                <div><span className="text-muted-foreground">Inserted:</span> {viewing.insert_date ? formatDate(viewing.insert_date) : '—'}</div>
                <div><span className="text-muted-foreground">Updated:</span> {viewing.update_date ? formatDate(viewing.update_date) : '—'}</div>
              </div>
              <div>
                <div className="font-medium mb-1">Addresses ({viewing.addresses.length})</div>
                {viewing.addresses.length === 0 && <div className="text-muted-foreground italic text-xs">No addresses on file.</div>}
                {viewing.addresses.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {viewing.addresses.map((a) => (
                      <li key={String(a.address_id)} className="rounded border bg-card px-2 py-1">
                        {formatServiceAddress(a, { fallback: `(address #${a.address_id})` })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
