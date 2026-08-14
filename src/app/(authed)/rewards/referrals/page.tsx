'use client';

/*
 * Referral Qualifications — a read-only operational audit of technician
 * referrals. Qualification is owned by the backend and happens only after the
 * referred technician completes all three canonical profile sections. This
 * page intentionally exposes no correction or override action.
 *
 * Performance contract:
 *   - the backend owns filtering and cursor pagination;
 *   - search is capped in the browser and debounced before it becomes a key;
 *   - cursor state is tied to the active filter key, avoiding a throw-away
 *     request with a stale cursor when filters change;
 *   - there is no polling or per-row request.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Search,
  UserRoundCheck,
} from 'lucide-react';
import { RewardsPausedNotice } from '@/components/rewards/RewardsPausedNotice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { StatusChip } from '@/components/ui/StatusChip';
import { useDebouncedValue, useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';

type ReferralStatus = 'pending' | 'qualified';

type ReferralTechnician = {
  efrId: number;
  name: string | null;
  mobileMasked: string | null;
};

type ReferralProfile = {
  skillsComplete: boolean;
  identityComplete: boolean;
  workAreaComplete: boolean;
  complete: boolean;
};

type ReferralRow = {
  id: number;
  code: string;
  joinedAt: string;
  qualifiedAt: string | null;
  status: ReferralStatus;
  referrer: ReferralTechnician;
  referred: ReferralTechnician;
  profile: ReferralProfile;
};

type ReferralListResponse = {
  items: ReferralRow[];
  nextCursor: string | null;
};

type CursorState = {
  filterKey: string;
  current: string | null;
  previous: Array<string | null>;
};

const SEARCH_MAX_LENGTH = 80;
const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = typeof PAGE_SIZES[number];

function technicianName(technician: ReferralTechnician): string {
  const name = technician.name?.trim();
  return name || `Technician #${technician.efrId}`;
}

function technicianHref(efrId: number): string {
  const from = encodeURIComponent('/rewards/referrals');
  return `/easyfixers/${efrId}/verification?from=${from}`;
}

function TechnicianCell({ technician }: { technician: ReferralTechnician }) {
  const label = technicianName(technician);
  return (
    <div className="min-w-0">
      <Link
        href={technicianHref(technician.efrId)}
        className="font-semibold text-primary hover:underline underline-offset-2"
        title={`Open verification for ${label}`}
      >
        {label}
      </Link>
      <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
        EFR ID {technician.efrId}
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        {technician.mobileMasked || '—'}
      </div>
    </div>
  );
}

function ProfileFlag({ label, complete }: { label: string; complete: boolean }) {
  const Icon = complete ? CheckCircle2 : CircleDashed;
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium whitespace-nowrap',
        complete
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
          : 'border-slate-300 bg-slate-50 text-slate-600',
      ].join(' ')}
      aria-label={`${label}: ${complete ? 'complete' : 'pending'}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

export default function RewardReferralsPage() {
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<ReferralStatus | ''>('');
  const [limit, setLimit] = React.useState<PageSize>(20);
  const debouncedSearch = useDebouncedValue(search, 300).trim();

  /*
   * The cursor belongs to a specific filter set. Comparing it with filterKey
   * synchronously means a changed filter immediately falls back to the first
   * page without an effect-driven second request.
   */
  const filterKey = `${status}|${debouncedSearch}|${limit}`;
  const [cursorState, setCursorState] = React.useState<CursorState>({
    filterKey,
    current: null,
    previous: [],
  });
  const cursorMatchesFilters = cursorState.filterKey === filterKey;
  const currentCursor = cursorMatchesFilters ? cursorState.current : null;
  const previousCursors = cursorMatchesFilters ? cursorState.previous : [];

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (debouncedSearch) query.set('search', debouncedSearch.slice(0, SEARCH_MAX_LENGTH));
  if (currentCursor) query.set('cursor', currentCursor);
  query.set('limit', String(limit));

  const listFetch = useFetch<ReferralListResponse>(`/admin/rewards/referrals?${query.toString()}`);
  const rows = listFetch.data?.items ?? [];
  const nextCursor = listFetch.data?.nextCursor ?? null;
  const pageNumber = previousCursors.length + 1;

  function goNext() {
    if (!nextCursor || listFetch.loading || listFetch.refreshing) return;
    setCursorState({
      filterKey,
      current: nextCursor,
      previous: [...previousCursors, currentCursor],
    });
  }

  function goPrevious() {
    if (previousCursors.length === 0 || listFetch.loading || listFetch.refreshing) return;
    setCursorState({
      filterKey,
      current: previousCursors[previousCursors.length - 1] ?? null,
      previous: previousCursors.slice(0, -1),
    });
  }

  return (
    <div className="space-y-4">
      <RewardsPausedNotice />

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <UserRoundCheck className="size-6" /> Referral Qualifications
        </h1>
        <p className="text-sm text-muted-foreground">
          Review referral attribution and profile-completion qualification. A referral qualifies
          only after Skills, Identity and Work Area are all complete.
        </p>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[260px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value.slice(0, SEARCH_MAX_LENGTH))}
              maxLength={SEARCH_MAX_LENGTH}
              placeholder="Search by code, technician name, ID, or mobile…"
              className="pl-8"
              aria-label="Search Referrals"
              autoComplete="off"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ReferralStatus | '')}
              className="h-9 rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus-visible:border-foreground/40"
              aria-label="Referral Status"
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="qualified">Qualified</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Show</span>
            <select
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value) as PageSize)}
              className="h-9 rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus-visible:border-foreground/40"
              aria-label="Referrals Per Page"
            >
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center justify-between gap-3 text-sm text-red-700">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              {listFetch.error}
            </span>
            <Button variant="outline" size="sm" onClick={listFetch.refetch}>Retry</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="data-table min-w-[1120px]" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '10%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '9%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left">Code</th>
                <th className="!text-left">Referrer</th>
                <th className="!text-left">Referred Technician</th>
                <th className="!text-left whitespace-nowrap">Joined</th>
                <th className="!text-left">Profile Completion</th>
                <th className="!text-left whitespace-nowrap">Qualified</th>
                <th className="!text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && (
                <tr>
                  <td colSpan={7} className="!text-center text-muted-foreground py-8">Loading referrals…</td>
                </tr>
              )}
              {!listFetch.loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="!text-center text-muted-foreground py-8">
                    No referrals match the current filters.
                  </td>
                </tr>
              )}
              {!listFetch.loading && rows.map((referral) => (
                <tr key={referral.id}>
                  <td className="!text-left">
                    <span className="font-mono text-xs font-semibold tracking-wide">{referral.code}</span>
                  </td>
                  <td className="!text-left"><TechnicianCell technician={referral.referrer} /></td>
                  <td className="!text-left"><TechnicianCell technician={referral.referred} /></td>
                  <td className="!text-left whitespace-nowrap text-xs">{formatDate(referral.joinedAt)}</td>
                  <td className="!text-left">
                    <div className="flex flex-wrap gap-1.5">
                      <ProfileFlag label="Skills" complete={referral.profile.skillsComplete} />
                      <ProfileFlag label="Identity" complete={referral.profile.identityComplete} />
                      <ProfileFlag label="Work Area" complete={referral.profile.workAreaComplete} />
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted-foreground">
                      {referral.profile.complete ? 'All profile sections complete' : 'Waiting for profile completion'}
                    </div>
                  </td>
                  <td className="!text-left whitespace-nowrap text-xs">
                    {referral.qualifiedAt ? formatDate(referral.qualifiedAt) : '—'}
                  </td>
                  <td className="!text-center">
                    <StatusChip tone={referral.status === 'qualified' ? 'emerald' : 'amber'} size="sm">
                      {referral.status === 'qualified' ? 'Qualified' : 'Pending'}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
        <span className="text-xs text-muted-foreground">
          Page {pageNumber.toLocaleString('en-IN')} · Showing {rows.length.toLocaleString('en-IN')} referral{rows.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={goPrevious}
            disabled={previousCursors.length === 0 || listFetch.loading || listFetch.refreshing}
          >
            <ChevronLeft className="size-4 mr-1" aria-hidden="true" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={goNext}
            disabled={!nextCursor || listFetch.loading || listFetch.refreshing}
          >
            Next <ChevronRight className="size-4 ml-1" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
