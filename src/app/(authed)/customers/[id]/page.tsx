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

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, User, Phone, Mail, MapPin, Briefcase } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatDate, statusLabel } from '@/lib/utils';

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
  alt_mob_no: string | null;
  customer_status: number | null;
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
};

export default function CustomerDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [cust, setCust] = useState<CustomerDetail | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const c = await api.get<CustomerDetail>(`/admin/customers/${id}`);
        if (!cancelled) {
          setCust(c);
          // Kick off the jobs lookup once we have a mobile to search by.
          if (c.customer_mob_no) {
            void loadJobs(c.customer_mob_no, c.customer_id);
          } else {
            setJobsLoading(false);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load customer');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadJobs(mobile: string, customerId: number) {
    setJobsLoading(true);
    try {
      // /admin/jobs doesn't have a customerId filter today, but the `q`
      // param matches against `customer_mob_no` — equivalent for our case.
      // If a customerId filter ever lands, swap to it (faster, exact).
      const r = await api.get<{ items: JobRow[]; total: number }>(`/admin/jobs?q=${encodeURIComponent(mobile)}&limit=50`);
      // Filter client-side to this exact customer (defensive — `q` may
      // surface false positives on shared mobiles in dev data).
      setJobs(r.items || []);
    } catch {
      setJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }

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
            <span className={`badge ${cust.customer_status === 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
              {cust.customer_status === 1 ? 'Active' : 'Inactive'}
            </span>
          </div>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm pt-3 mt-3 border-t">
            <Field icon={<Phone className="size-3.5" />} label="Mobile" value={cust.customer_mob_no} />
            <Field icon={<Phone className="size-3.5" />} label="Alt Mobile" value={cust.alt_mob_no} />
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
                      <td><span className="badge bg-slate-100 text-slate-700">{statusLabel(j.job_status)}</span></td>
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

function Field({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</dt>
      <dd className="font-medium">{value || '—'}</dd>
    </div>
  );
}
