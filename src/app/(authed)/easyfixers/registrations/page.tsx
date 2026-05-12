'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';

/*
 * Registered EasyFixer — Pending Verification
 *
 * Legacy CRM menu URL: `efer-registration`. Shows easyfixers awaiting the
 * technician-verification step (`is_technician_verified = 0`).
 *
 * Reuses the existing `GET /api/admin/easyfixers` endpoint with two query
 * params (both validated in the backend Joi schema):
 *   - isVerified=false        → main filter
 *   - includeInactive=true    → newly-registered rows can be in either
 *                                efr_status=1 OR 0 before approval, so we
 *                                want both buckets in this queue.
 *
 * Filter chips are client-side over the page payload. Two of the four chips
 * requested by spec (Newly Onboarded `new_easy_fixer`, Profile Complete
 * `final_submission`) are not returned by the list projection
 * (LIST_COLUMNS in services/easyfixer.service.js). To stay within the
 * "do not add a backend endpoint" constraint, we approximate:
 *   - Profile Complete   → efr_profile_perc >= 100 AND !is_technician_verified
 *   - Profile Incomplete → efr_profile_perc <  100 AND !is_technician_verified
 *   - Newly Onboarded    → insert_date within the last 30 days
 * The approximations are documented in the page summary so reviewers know
 * the difference vs the literal column meaning. A future backend change
 * could add `final_submission` and `new_easy_fixer` to LIST_COLUMNS for an
 * exact match.
 */

type Ef = {
  efr_id: number;
  efr_name: string;
  efr_first_name: string | null;
  efr_last_name: string | null;
  efr_no: string;
  efr_email: string | null;
  efr_cityId: number | null;
  city_name: string | null;
  efr_service_category: string | null;
  efr_service_type: string | null;
  efr_profile_perc: number | null;
  is_technician_verified: boolean | number | null;
  efr_status: number;
  efr_manager_id: number | null;
  insert_date: string;
  update_date: string | null;
  // Optional — not in LIST_COLUMNS today, present here so a future backend
  // bump that adds them flows through without any frontend change.
  final_submission?: boolean | number | null;
  new_easy_fixer?: boolean | number | null;
};

type Resp = { items: Ef[]; total: number };

type ChipKey = 'all' | 'new' | 'complete' | 'incomplete';

const PAGE_SIZE = 50;
const NEW_WINDOW_DAYS = 30;

export default function RegisteredEasyfixersPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<ChipKey>('all');

  async function load(reset = false) {
    setLoading(true);
    const off = reset ? 0 : offset;
    try {
      const r = await api.get<Resp>('/admin/easyfixers', {
        limit: PAGE_SIZE,
        offset: off,
        isVerified: 'false',
        includeInactive: 'true',
      });
      setData(r);
      if (reset) setOffset(0);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset]);
  useEffect(() => { load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const items = data?.items ?? [];

  // Client-side chip filtering. See header comment for why these are
  // approximations of new_easy_fixer / final_submission.
  const now = Date.now();
  const filtered = useMemo(() => {
    return items.filter((e) => {
      const verified = !!e.is_technician_verified;
      // Verified rows should never appear in this queue, but guard anyway.
      if (verified) return false;

      // Prefer the real columns if the backend ever returns them; otherwise
      // fall back to the proxies described in the header comment.
      const finalSub = e.final_submission == null ? null : !!e.final_submission;
      const newFlag = e.new_easy_fixer == null ? null : !!e.new_easy_fixer;
      const pct = e.efr_profile_perc == null ? 0 : Number(e.efr_profile_perc);

      if (chip === 'new') {
        if (newFlag != null) return newFlag;
        const inserted = e.insert_date ? new Date(e.insert_date).getTime() : 0;
        if (!inserted) return false;
        return now - inserted <= NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      }
      if (chip === 'complete') {
        if (finalSub != null) return finalSub;
        return pct >= 100;
      }
      if (chip === 'incomplete') {
        if (finalSub != null) return !finalSub;
        return pct < 100;
      }
      return true; // 'all'
    });
  }, [items, chip, now]);

  const searched = useMemo(() => {
    if (!q) return filtered;
    const needle = q.toLowerCase();
    return filtered.filter((e) => {
      const haystacks: Array<string | number | null> = [
        e.efr_id, e.efr_name, e.efr_no, e.efr_email, e.city_name,
      ];
      return haystacks.some((h) => h != null && String(h).toLowerCase().includes(needle));
    });
  }, [filtered, q]);

  const chipDef: Array<{ key: ChipKey; label: string }> = [
    { key: 'all',        label: 'All' },
    { key: 'new',        label: 'Newly Onboarded' },
    { key: 'complete',   label: 'Profile Complete' },
    { key: 'incomplete', label: 'Profile Incomplete' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Registered EasyFixers — Pending Verification</h1>
          <p className="text-sm text-muted-foreground">
            {loading ? '…' : `${searched.length.toLocaleString()} of ${(data?.total ?? 0).toLocaleString()} pending`}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {chipDef.map((c) => {
              const active = chip === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setChip(c.key)}
                  className={
                    'rounded-full px-3 py-1 text-xs font-medium border transition-colors ' +
                    (active
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-input hover:bg-muted')
                  }
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name, mobile, email, city…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="stick-col-head stick-left">ID</th>
                <th>Name</th>
                <th>Mobile</th>
                <th>City</th>
                <th className="text-right">Profile %</th>
                <th className="text-center">Submitted?</th>
                <th className="text-center">Verified?</th>
                <th className="stick-col-head stick-right text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && searched.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">No registrations match this filter.</td></tr>
              )}
              {!loading && searched.map((e) => {
                const pct = e.efr_profile_perc == null ? null : Math.round(Number(e.efr_profile_perc));
                // Submitted? prefers the real column; otherwise treats 100%
                // profile completion as the submission proxy (see header).
                const submitted = e.final_submission == null
                  ? (pct != null && pct >= 100)
                  : !!e.final_submission;
                const verified = !!e.is_technician_verified;
                return (
                  <tr key={e.efr_id}>
                    <td className="text-xs text-muted-foreground stick-col stick-left">{e.efr_id}</td>
                    <td className="font-medium whitespace-nowrap">{formatEasyfixerName(e.efr_name)}</td>
                    <td>{e.efr_no}</td>
                    <td>{e.city_name ?? '—'}</td>
                    <td className="text-xs tabular-nums text-right">{pct != null ? `${pct}%` : '—'}</td>
                    <td className="text-center">
                      {submitted ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium">Yes</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-xs font-medium">No</span>
                      )}
                    </td>
                    <td className="text-center">
                      {verified ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium">Yes</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium">Pending</span>
                      )}
                    </td>
                    <td className="stick-col stick-right text-right">
                      <Link
                        href={`/easyfixers/${e.efr_id}`}
                        className="text-primary text-xs hover:underline whitespace-nowrap"
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
