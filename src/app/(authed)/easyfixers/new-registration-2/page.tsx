'use client';

/*
 * New Registration 2 — revamped Easyfixer LIST (feature/new-registration-2).
 *
 * A leaner sibling of the full Manage Easyfixers roster (../page.tsx). It
 * reuses the SAME backend contract — GET /admin/easyfixers for the page and
 * GET /admin/easyfixers/status-counts for the clickable status strip — but
 * presents a List → Profile experience: every row links to the tabbed
 * profile at /easyfixers/new-registration-2/<efr_id> instead of opening the
 * legacy detail modal. Additive only; the original roster is untouched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { EasyfixerLifecycleChip } from '@/components/easyfixer/EasyfixerLifecycleChip';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { cn, formatEasyfixerName } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { type LifecycleRowFields } from '@/lib/easyfixer-lifecycle';

type EfStatusLabel =
  | 'Active' | 'Inactive' | 'Idle' | 'Not Eligible' | 'Not Suitable' | 'Registration In Progress';

type EfRow = LifecycleRowFields & {
  efr_id: number;
  efr_name: string;
  efr_first_name: string | null;
  efr_last_name: string | null;
  efr_no: string;
  city_name: string | null;
  state_name: string | null;
  efr_service_category: string | null;
  efr_profile_perc: number | null;
  efr_status_label: EfStatusLabel;
  job_count?: number;
};
type ListResp = { items: EfRow[]; total: number; limit: number; offset: number };

type StatusCounts = {
  active: number; inactive: number; idle: number;
  not_eligible: number; not_suitable: number; reg_in_progress: number;
  training_pending: number; status_drift: number; total: number;
};

function statusTone(v: EfStatusLabel): StatusChipTone {
  switch (v) {
    case 'Active': return 'emerald';
    case 'Inactive': return 'slate';
    case 'Idle': return 'slate';
    case 'Registration In Progress': return 'sky';
    case 'Not Eligible': return 'red';
    case 'Not Suitable': return 'amber';
    default: return 'slate';
  }
}

// Each strip entry drives exactly one filter dimension (legacy `status`
// bucket 1..6, or `lifecycleStatus`). Mirrors the roster's counts strip.
const STRIP: Array<{ key: keyof StatusCounts; label: string; status: string; lifecycleStatus: string; dot: string }> = [
  { key: 'active', label: 'Active', status: '1', lifecycleStatus: '', dot: 'bg-success' },
  { key: 'inactive', label: 'Inactive', status: '2', lifecycleStatus: '', dot: 'bg-ink-500' },
  { key: 'idle', label: 'Idle', status: '3', lifecycleStatus: '', dot: 'bg-ink-300' },
  { key: 'not_eligible', label: 'Not Eligible', status: '4', lifecycleStatus: '', dot: 'bg-destructive' },
  { key: 'not_suitable', label: 'Not Suitable', status: '5', lifecycleStatus: '', dot: 'bg-warning' },
  { key: 'reg_in_progress', label: 'Registration In Progress', status: '6', lifecycleStatus: '', dot: 'bg-info' },
  { key: 'training_pending', label: 'Training Pending', status: '', lifecycleStatus: 'TRAINING_PENDING', dot: 'bg-gold' },
];

const EF_COLS = 8;

export default function NewRegistration2ListPage() {
  const [rows, setRows] = useState<EfRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search box (id / name / mobile) + which status bucket is active.
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('1'); // Active default, matches roster
  const [lifecycleStatus, setLifecycleStatus] = useState('');

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);

  const seqRef = useRef(0);

  const buildQuery = useCallback(() => {
    const q: Record<string, string | number | undefined> = {};
    const term = search.trim();
    if (term) {
      // An id search is an identity lookup — no bucket narrows it (roster rule).
      if (/^\d{1,7}$/.test(term)) { q.easyfixerId = term; q.status = 0; }
      else if (/^\d{6,}$/.test(term)) q.mobileNo = term;
      else q.name = term;
    }
    if (!q.easyfixerId) {
      if (lifecycleStatus) q.lifecycleStatus = lifecycleStatus;
      else if (status !== '') q.status = status;
    }
    return q;
  }, [search, status, lifecycleStatus]);

  const load = useCallback(async (resetPage = false) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const pg = resetPage ? 0 : page;
    const limit = pageSizeToLimit(pageSize, 500);
    const offset = pg * (pageSize === 'all' ? 0 : Number(pageSize));
    try {
      const [r, c] = await Promise.all([
        api.get<ListResp>('/admin/easyfixers', { limit, offset, ...buildQuery() }),
        api.get<StatusCounts>('/admin/easyfixers/status-counts').catch(() => null),
      ]);
      if (seq !== seqRef.current) return;
      setRows(r.items);
      setTotal(r.total);
      if (c) setCounts(c);
      if (resetPage) setPage(0);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load easyfixers');
      setRows([]);
      setTotal(0);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [page, pageSize, buildQuery]);

  // Reload on mount + whenever pagination changes.
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);

  const onPickStatus = (next: { status: string; lifecycleStatus: string }) => {
    setStatus(next.status);
    setLifecycleStatus(next.lifecycleStatus);
    setPage(0);
    // load() reads state on next tick via the effect below.
  };
  // When the status filter changes, reset to page 0 and reload.
  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, lifecycleStatus]);

  const activeStrip = useMemo(() => {
    return STRIP.map((it) => ({
      ...it,
      isActive: it.lifecycleStatus ? lifecycleStatus === it.lifecycleStatus : status === it.status && !lifecycleStatus,
    }));
  }, [status, lifecycleStatus]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink-900">Easyfixers</h1>
        {counts && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => onPickStatus({ status: '', lifecycleStatus: '' })}
              className={cn('inline-flex items-center gap-1.5', !status && !lifecycleStatus ? 'font-semibold text-foreground' : 'hover:text-foreground')}
            >
              <span className="tabular-nums">{counts.total.toLocaleString('en-IN')}</span> All
            </button>
            {activeStrip.map((it) => (
              <span key={it.key} className="inline-flex items-center gap-2">
                <span className="text-muted-foreground/50">·</span>
                <button
                  type="button"
                  onClick={() => onPickStatus({ status: it.status, lifecycleStatus: it.lifecycleStatus })}
                  className={cn('group inline-flex items-center gap-1.5', it.isActive ? 'font-semibold text-foreground' : 'hover:text-foreground')}
                  aria-pressed={it.isActive}
                >
                  <span className={cn('inline-block size-1.5 rounded-full', it.dot)} />
                  <span className="tabular-nums">{Number(counts[it.key]).toLocaleString('en-IN')}</span>
                  <span className={cn(!it.isActive && 'group-hover:underline')}>{it.label}</span>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[240px] flex-1 items-center gap-2 rounded-lg border bg-card px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-ink-300" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(true); }}
            placeholder="Search by EF ID, name or mobile…"
            aria-label="Search easyfixers"
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>
        <Button onClick={() => load(true)} disabled={loading}>Search</Button>
        <Button
          variant="outline"
          onClick={() => { setSearch(''); setStatus('1'); setLifecycleStatus(''); setPage(0); }}
          disabled={loading}
        >
          Reset
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="data-table head-sticky w-full">
              <thead>
                <tr>
                  <th className="!text-left">EF ID</th>
                  <th className="!text-left">Name</th>
                  <th className="!text-left">Mobile</th>
                  <th className="!text-left">State / City</th>
                  <th className="!text-left">Service Category</th>
                  <th className="!text-left">Profile</th>
                  <th className="!text-center">Status</th>
                  <th className="!text-right" />
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={EF_COLS} className="!text-center py-6 text-muted-foreground">Loading…</td></tr>
                )}
                {!loading && error && (
                  <tr><td colSpan={EF_COLS} className="!text-center py-6 text-urgent">{error}</td></tr>
                )}
                {!loading && !error && rows.length === 0 && (
                  <tr><td colSpan={EF_COLS} className="!text-center py-6 text-muted-foreground">No easyfixers match the current filters.</td></tr>
                )}
                {!loading && !error && rows.map((e) => {
                  const name = formatEasyfixerName(e.efr_name) || `${e.efr_first_name ?? ''} ${e.efr_last_name ?? ''}`.trim() || '—';
                  const pct = e.efr_profile_perc ?? 0;
                  const fresher = typeof e.job_count === 'number' && e.job_count < 5;
                  return (
                    <tr key={e.efr_id} className="group">
                      <td className="font-mono tabular-nums text-ink-700">{e.efr_id}</td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 font-semibold text-brand-700">
                            {name.charAt(0).toUpperCase()}
                          </span>
                          <span className="flex items-center gap-2 font-medium text-ink-900">
                            {name}
                            {fresher && <StatusChip tone="info" size="sm">Fresher</StatusChip>}
                          </span>
                        </div>
                      </td>
                      <td className="font-mono text-muted-foreground">{maskMobile(e.efr_no)}</td>
                      <td>
                        <div>{e.city_name ?? '—'}</div>
                        <div className="text-xs text-ink-300">{e.state_name ?? ''}</div>
                      </td>
                      <td>{e.efr_service_category ?? '—'}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                          </span>
                          <span className="w-9 text-right font-mono text-xs text-muted-foreground">{pct}%</span>
                        </div>
                      </td>
                      <td className="!text-center">
                        <EasyfixerLifecycleChip
                          value={e.lifecycle_status}
                          fallbackLabel={e.efr_status_label}
                          fallbackTone={statusTone(e.efr_status_label)}
                        />
                      </td>
                      <td className="!text-right whitespace-nowrap">
                        <Link
                          href={`/easyfixers/new-registration-2/${e.efr_id}`}
                          className="text-sm font-semibold text-primary hover:underline"
                        >
                          View Profile →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > 0 && (
            <div className="border-t p-3">
              <TablePagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(ps) => { setPageSize(ps); setPage(0); }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
