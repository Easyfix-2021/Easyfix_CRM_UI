'use client';
/*
 * Team tab — shown only when the technician leads a team (ef_account = Master).
 * Members come from the read-only app mirror (the technician app's own My Team
 * read, GET .../mirror/team/members), one IST month at a time. The mirror is
 * rate-limited and audited per call, so it is fetched only while this tab is open.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { istToday } from '@/lib/due-date';
import { Select } from '@/components/ui/select';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { fmtDate } from '@/components/profile/ProfileFields';
import { SectionCard, inr } from './ui';

type TeamMember = {
  efrId: number;
  name: string | null;
  mobileMasked: string | null;
  jobsDone: number;
  rating: number | null;
  onTime: number;
  earnings: number;
  metricAvailability: { recordedRevisitJobs: number };
};
type TeamMembersResp = { month: string; items: TeamMember[]; total: number; page: number; limit: number };

// The mobile route caps `limit` at 50, so 'All' is not offered.
const TEAM_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

function recentMonths(count: number): Array<{ value: string; label: string }> {
  const [y, m] = istToday().split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const ym = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
    return { value: ym, label: fmtDate(`${ym}-01`).slice(3) };
  });
}

export function TeamTab({ efrId: efrIdProp }: { efrId?: number } = {}) {
  const params = useParams<{ id: string }>();
  const efrId = efrIdProp ?? Number(params.id);

  const [months] = useState(() => recentMonths(6));
  const [month, setMonth] = useState(months[0].value);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);

  const { data, loading, refreshing, error } = useFetch<TeamMembersResp>(
    `/admin/easyfixers/${efrId}/mirror/team/members?month=${month}&page=${page + 1}&limit=${pageSize}`,
  );
  // useFetch keeps stale data across key changes and errors; show only the selected month/page.
  const current = data && data.month === month && data.page === page + 1 && data.limit === pageSize ? data : null;
  const items = current?.items ?? [];

  return (
    <SectionCard
      title="My team"
      icon={<span>👥</span>}
      right={(
        <Select
          aria-label="Month"
          className="h-8 w-32"
          value={month}
          options={months}
          onChange={(e) => { setMonth(e.target.value); setPage(0); }}
        />
      )}
    >
      <p className="mb-3 text-xs text-muted-foreground">
        Active members, with jobs, rating and earnings for the selected month — as the technician sees them in the app.
      </p>

      {error && !current && <p className="mb-2 text-sm text-urgent">{error}</p>}
      {!current ? (
        (loading || refreshing) && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active team members.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Member</th>
                <th className="!text-right">Jobs done</th>
                <th className="!text-right">On time</th>
                <th className="!text-right">Rating</th>
                <th className="!text-right">Revisits</th>
                <th className="!text-right">Earnings</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.efrId}>
                  <td className="!text-left">
                    <Link href={`/easyfixers/new-registration-2/${m.efrId}`} className="font-medium text-primary hover:underline">
                      {m.name || `EF ${m.efrId}`}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      EF {m.efrId}{m.mobileMasked ? ` · ${m.mobileMasked}` : ''}
                    </span>
                  </td>
                  <td className="!text-right tabular-nums">{m.jobsDone}</td>
                  <td className="!text-right tabular-nums">{m.onTime}</td>
                  <td className="!text-right tabular-nums">{m.rating != null ? `${m.rating.toFixed(1)}★` : '—'}</td>
                  <td className="!text-right tabular-nums">{m.metricAvailability?.recordedRevisitJobs ?? 0}</td>
                  <td className="!text-right tabular-nums">{inr(m.earnings)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="mt-3 border-t pt-3">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            loading={loading || refreshing}
            pageSizeOptions={TEAM_PAGE_SIZES}
            onPageChange={setPage}
            onPageSizeChange={(ps) => { setPageSize(ps); setPage(0); }}
          />
        </div>
      )}
    </SectionCard>
  );
}
