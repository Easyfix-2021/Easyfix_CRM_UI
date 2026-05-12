'use client';

/*
 * Search — quick phone-call lookup.
 *
 * CRM staff (call centre, ops, finance) need to punch in a mobile or efr_no
 * mid-call and immediately see who the caller is and what they owe / are
 * working on. The legacy menu URL is `checkBalance`; this page is the modern
 * equivalent. Read-only, no mutations.
 *
 * Backend wiring (all real, GET only):
 *   /admin/easyfixers?q=<term>&limit=10  → list  (no balance in projection)
 *   /admin/easyfixers/:id                → detail with current_balance
 *   /admin/customers?q=<term>&limit=10   → list (includes lifetime job_count)
 *   /admin/jobs?easyfixerId=&statuses=0,1,2&limit=1 → use `total` as active count
 *
 * No customerId filter exists on /admin/jobs, so for customers we surface the
 * lifetime job_count already computed by the customers list endpoint instead
 * of a true "active" count. EasyFixer rows get the proper active count.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, AlertTriangle, User, Wrench } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useDebounce } from '@/lib/use-debounce';
import { formatEasyfixerName } from '@/lib/utils';

type EfListRow = {
  efr_id: number;
  efr_name: string | null;
  efr_first_name: string | null;
  efr_last_name: string | null;
  efr_no: string | null;
  efr_email: string | null;
  efr_status: number | null;
  city_name: string | null;
};

type EfDetail = EfListRow & {
  current_balance: number | string | null;
};

type CustomerRow = {
  customer_id: number;
  customer_name: string | null;
  customer_mob_no: string | null;
  customer_email: string | null;
  is_active: number | null;
  job_count: number | string | null;
};

type EfHit = {
  efr_id: number;
  name: string;
  mobile: string | null;
  city: string | null;
  balance: number | null;
  activeJobs: number | null;
  loading: boolean;
};

export default function SearchPage() {
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q.trim(), 350);

  const [efs, setEfs] = useState<EfHit[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only fire when the operator has typed enough to be meaningful — saves a
    // round-trip on every single character while still feeling responsive.
    if (!debouncedQ || debouncedQ.length < 3) {
      setEfs([]);
      setCustomers([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [efList, custList] = await Promise.all([
          api.get<{ items: EfListRow[]; total: number }>('/admin/easyfixers', {
            q: debouncedQ,
            limit: 10,
          }),
          api.get<{ items: CustomerRow[]; total: number }>('/admin/customers', {
            q: debouncedQ,
            limit: 10,
          }),
        ]);
        if (cancelled) return;

        // Seed EFR rows immediately with what the list gave us, then fan out
        // detail+active-job lookups in parallel. The UI shows the row right
        // away with a "…" placeholder for balance/active count and fills them
        // in as each per-row fetch resolves.
        const initial: EfHit[] = efList.items.map((e) => ({
          efr_id: e.efr_id,
          name: formatEasyfixerName(e.efr_name) || `#${e.efr_id}`,
          mobile: e.efr_no,
          city: e.city_name,
          balance: null,
          activeJobs: null,
          loading: true,
        }));
        setEfs(initial);
        setCustomers(custList.items);
        setLoading(false);

        // Enrichment phase — parallel detail + active-job-count for each EFR.
        // Failures degrade gracefully: row shows '—' instead of disappearing.
        await Promise.all(
          efList.items.map(async (e, idx) => {
            try {
              const [detail, jobs] = await Promise.all([
                api.get<EfDetail>(`/admin/easyfixers/${e.efr_id}`),
                api.get<{ items: unknown[]; total: number }>('/admin/jobs', {
                  easyfixerId: e.efr_id,
                  statuses: '0,1,2',
                  limit: 1,
                }),
              ]);
              if (cancelled) return;
              setEfs((prev) => {
                if (prev.length <= idx || prev[idx].efr_id !== e.efr_id) return prev;
                const next = prev.slice();
                next[idx] = {
                  ...next[idx],
                  balance: detail?.current_balance != null ? Number(detail.current_balance) : null,
                  activeJobs: typeof jobs?.total === 'number' ? jobs.total : 0,
                  loading: false,
                };
                return next;
              });
            } catch {
              if (cancelled) return;
              setEfs((prev) => {
                if (prev.length <= idx || prev[idx].efr_id !== e.efr_id) return prev;
                const next = prev.slice();
                next[idx] = { ...next[idx], loading: false };
                return next;
              });
            }
          })
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Search failed');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ]);

  const hasQuery = debouncedQ.length >= 3;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Search className="h-6 w-6" /> Search
        </h1>
        <p className="text-sm text-muted-foreground">
          Look up an Easyfixer or Customer by 10-digit mobile, EFR no, or name.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Type a mobile number, EFR no, or name (min 3 chars)…"
              className="pl-9"
            />
          </div>
          {q && q.trim().length > 0 && q.trim().length < 3 && (
            <p className="text-xs text-muted-foreground mt-2">Keep typing — at least 3 characters.</p>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4" /> {error}
          </CardContent>
        </Card>
      )}

      {/* ─── EasyFixer matches ───────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5 text-slate-700">
          <Wrench className="h-4 w-4" /> EasyFixer matches
          {hasQuery && !loading && <span className="text-xs text-muted-foreground font-normal">({efs.length})</span>}
        </h2>
        {!hasQuery && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
            Enter a search term above to begin.
          </div>
        )}
        {hasQuery && loading && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">Loading…</div>
        )}
        {hasQuery && !loading && efs.length === 0 && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
            No easyfixers matched.
          </div>
        )}
        {hasQuery && !loading && efs.length > 0 && (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-center">ID</th>
                  <th>Name</th>
                  <th>Mobile</th>
                  <th>City</th>
                  <th className="!text-right">Balance ₹</th>
                  <th className="!text-center">Active Jobs</th>
                  <th className="!text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {efs.map((e) => (
                  <tr key={e.efr_id} className="hover:bg-slate-50">
                    <td className="!text-center font-mono text-xs">{e.efr_id}</td>
                    <td className="font-medium whitespace-nowrap">{e.name}</td>
                    <td className="font-mono text-xs">{e.mobile ?? '—'}</td>
                    <td className="text-xs">{e.city ?? '—'}</td>
                    <td className="!text-right font-mono">
                      {e.loading ? <span className="text-muted-foreground">…</span> :
                        e.balance != null ? e.balance.toFixed(2) : '—'}
                    </td>
                    <td className="!text-center">
                      {e.loading ? <span className="text-muted-foreground">…</span> :
                        e.activeJobs != null ? (
                          e.activeJobs > 0 ? (
                            <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium">
                              {e.activeJobs}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">0</span>
                          )
                        ) : '—'}
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <Link
                        href={`/easyfixers?view=${e.efr_id}`}
                        className="text-primary text-xs hover:underline"
                      >Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Customer matches ────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5 text-slate-700">
          <User className="h-4 w-4" /> Customer matches
          {hasQuery && !loading && (
            <span className="text-xs text-muted-foreground font-normal">({customers.length})</span>
          )}
        </h2>
        {hasQuery && loading && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">Loading…</div>
        )}
        {hasQuery && !loading && customers.length === 0 && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
            No customers matched.
          </div>
        )}
        {hasQuery && !loading && customers.length > 0 && (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-center">ID</th>
                  <th>Name</th>
                  <th>Mobile</th>
                  <th>Email</th>
                  <th className="!text-center">Total Jobs</th>
                  <th className="!text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => {
                  const jc = c.job_count != null ? Number(c.job_count) : 0;
                  return (
                    <tr key={c.customer_id} className="hover:bg-slate-50">
                      <td className="!text-center font-mono text-xs">{c.customer_id}</td>
                      <td className="font-medium whitespace-nowrap">{c.customer_name || '—'}</td>
                      <td className="font-mono text-xs">{c.customer_mob_no ?? '—'}</td>
                      <td className="text-xs">{c.customer_email ?? '—'}</td>
                      <td className="!text-center text-xs">
                        {jc > 0 ? (
                          <span className="inline-flex items-center rounded-full bg-sky-100 text-sky-700 px-2 py-0.5 text-xs font-medium">
                            {jc}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="!text-right whitespace-nowrap">
                        <Link
                          href={`/customers/${c.customer_id}`}
                          className="text-primary text-xs hover:underline"
                        >Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
