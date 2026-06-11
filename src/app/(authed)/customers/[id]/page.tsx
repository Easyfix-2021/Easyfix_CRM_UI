'use client';

/*
 * Customer detail — read-only inspection of a tbl_customer row + its
 * addresses + recent jobs. Mirrors the `/easyfixers/[id]` layout
 * (header card + tabbed body) so the navigation pattern is consistent.
 *
 * Backend:
 *   GET /admin/customers/:id   — customer row + addresses[]
 *   GET /admin/jobs?customerId=:id&limit=…  — recent jobs (best-effort:
 *     not all list endpoints filter by customerId; fallback uses /jobs
 *     with q=<mobile> if the filter is unsupported)
 */

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, User, Phone, Mail, MapPin, Briefcase } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetchOnce, useFetch } from '@/lib/hooks';
import { formatDate, statusLabel } from '@/lib/utils';
import { CallableMobile } from '@/components/calls/CallButton';

type Address = {
  address_id: number;
  address?: string | null;
  building?: string | null;
  city_id?: number | null;
  pin_code?: string | null;
  state?: string | null;
  gps_location?: string | null;
  insert_date?: string | null;
};

type CustomerDetail = {
  customer_id: number;
  customer_name: string | null;
  customer_mob_no: string | null;
  customer_email: string | null;
  is_active: number | null;
  insert_date: string | null;
  update_date: string | null;
  addresses: Address[];
};

type JobRow = {
  job_id: number;
  job_reference_id: string | null;
  client_ref_id: string | null;
  job_status: number;
  client_name: string | null;
  easyfixer_name: string | null;
  requested_date_time: string | null;
  scheduled_date_time: string | null;
  city_name: string | null;
  // service_count comes from the LIST projection (correlated subquery
  // counts only job_service_status = 1). Used here to render the
  // shared "No Services" pill on BOOKED rows with zero active services
  // — same anomaly indicator as /jobs and /my-orders.
  service_count?: number;
};

export default function CustomerDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  // Customer fetch — `useFetchOnce` deduplicates Strict-Mode double-mounts
  // and caches inside `@/lib/hooks` (see `feedback_crm_ui_fetch_hooks`).
  const { data: cust, loading, error: custError } = useFetchOnce<CustomerDetail>(
    `/admin/customers/${id}`,
  );

  // Dependent jobs fetch keyed on the customer's mobile. `useFetch(null)`
  // is a no-op until cust resolves; once mobile is in hand the URL becomes
  // the cache key and one request fires. `enabled` stays implicit via the
  // null key.
  // /admin/jobs doesn't have a customerId filter today, but `q` matches
  // against `customer_mob_no` — equivalent for our case. If a customerId
  // filter ever lands, swap to it (faster, exact).
  const jobsKey = cust?.customer_mob_no
    ? `/admin/jobs?q=${encodeURIComponent(cust.customer_mob_no)}&limit=50`
    : null;
  const { data: jobsResp, loading: jobsLoadingRaw } = useFetch<{
    items: JobRow[];
    total: number;
  }>(jobsKey);
  // Preserve the original observable shape: if customer has no mobile, we
  // treat jobs as "loaded with empty list" (not still spinning). The
  // useFetch hook returns loading=false when key=null, so this maps cleanly.
  const jobs: JobRow[] = jobsResp?.items ?? [];
  const jobsLoading = jobsKey ? jobsLoadingRaw : false;
  const error = custError;

  if (loading) return <div className="text-sm text-muted-foreground py-6">Loading…</div>;
  if (error || !cust) {
    return (
      <div className="space-y-3">
        <Link href="/customers" className="text-sm text-primary inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="size-4" /> Back to customers
        </Link>
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error || 'Customer not found'}
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <button onClick={() => router.back()} className="text-sm text-primary inline-flex items-center gap-1 hover:underline">
        <ArrowLeft className="size-4" /> Back
      </button>

      {/* Header card — customer identity */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2">
                <User className="size-5" /> {cust.customer_name || '—'}
              </h1>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">Customer #{cust.customer_id}</p>
            </div>
            <span className={`badge ${cust.is_active === 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
              {cust.is_active === 1 ? 'Active' : 'Inactive'}
            </span>
          </div>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm pt-3 mt-3 border-t">
            <Field
              icon={<Phone className="size-3.5" />}
              label="Mobile"
              value={<CallableMobile customerId={cust.customer_id} mobile={cust.customer_mob_no} />}
            />
            <Field icon={<Mail className="size-3.5" />}  label="Email"  value={cust.customer_email} />
            <Field label="Registered" value={formatDate(cust.insert_date)} />
            <Field label="Last Updated" value={formatDate(cust.update_date)} />
          </dl>
        </CardContent>
      </Card>

      {/* Addresses */}
      <Card>
        <CardContent className="p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><MapPin className="size-4" /> Addresses ({cust.addresses?.length || 0})</h2>
          {(!cust.addresses || cust.addresses.length === 0) ? (
            <p className="text-sm text-muted-foreground">No addresses on file.</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-3">
              {cust.addresses.map((a) => (
                <div key={a.address_id} className="rounded border p-3 text-sm">
                  {a.building && <div className="font-medium">{a.building}</div>}
                  <div className="text-muted-foreground">{a.address || '—'}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {a.pin_code ? `PIN ${a.pin_code}` : ''}{a.state ? ` · ${a.state}` : ''}
                  </div>
                  {a.gps_location && <div className="text-xs font-mono text-muted-foreground">GPS {a.gps_location}</div>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Jobs */}
      <Card>
        <CardContent className="p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><Briefcase className="size-4" /> Jobs ({jobs.length})</h2>
          {jobsLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!jobsLoading && jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs found for this customer.</p>}
          {!jobsLoading && jobs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Job</th><th>Reference</th><th>Status</th>
                    <th>Client</th><th>Easyfixer</th><th>Scheduled</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.job_id} className="hover:bg-slate-50">
                      <td>
                        <Link href={`/jobs/${j.job_id}`} className="text-primary hover:underline font-medium">
                          #{j.job_id}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">{j.job_reference_id || j.client_ref_id || '—'}</td>
                      <td>
                        <span className="badge bg-slate-100 text-slate-700">{statusLabel(j.job_status)}</span>
                        {/* "No Services" pill — same shape as /jobs +
                            /my-orders. Surfaces the legacy data-quality
                            gap where a BOOKED job has zero active
                            tbl_job_services rows (ref Job #482453). */}
                        {j.job_status === 0 && (j.service_count ?? 0) === 0 && (
                          /*
                           * Clickable deep-link to the job's Services tab.
                           * This page doesn't host JobModal, so we route
                           * to /jobs?... — the jobs page reads action=view
                           * + viewTab=services on mount and opens the
                           * modal pre-tabbed. Plain anchor (not Link) is
                           * fine here; nav is a full client-side push so
                           * the modal's `useFetchOnce` for getById gets
                           * to fire on the new page.
                           */
                          <Link
                            href={`/jobs?jobId=${j.job_id}&action=view&viewTab=services`}
                            className="ml-1 inline-flex items-center rounded-full bg-amber-100 hover:bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 whitespace-nowrap cursor-pointer transition-colors"
                            title="Booked but no services attached. Click to open the Services tab."
                          >
                            No Services
                          </Link>
                        )}
                      </td>
                      <td className="text-xs">{j.client_name || '—'}</td>
                      <td className="text-xs">{j.easyfixer_name || '—'}</td>
                      <td className="text-xs">{formatDate(j.scheduled_date_time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ icon, label, value }: { icon?: React.ReactNode; label: string; value: React.ReactNode }) {
  // `value` widened to ReactNode so callers can pass JSX (e.g. a
  // <CallableMobile/>) for live-interactive fields, while still
  // accepting plain strings/nulls for static fields. Empty-string and
  // null fallback to the em-dash placeholder.
  const empty = value == null || value === '' || value === false;
  return (
    <div>
      <dt className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</dt>
      <dd className="font-medium">{empty ? '—' : value}</dd>
    </div>
  );
}
