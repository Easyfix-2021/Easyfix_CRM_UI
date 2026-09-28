'use client';
/*
 * Activity tab — trainings (LMS assignments), rewards, attendance and
 * performance, plus activation/status notes (reuses the verification
 * activation comments thread).
 *
 * Reward claims, attendance and performance come from the read-only app mirror
 * (GET .../mirror/*), which is rate-limited and audited per call, so each card
 * fetches only while this tab is open and only for an activated Easyfixer.
 * Achievements and the activity log have no read endpoint → placeholders.
 */
import Link from 'next/link';
import { api } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { istToday } from '@/lib/due-date';
import { titleCaseLabel } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { fmtDate } from '@/components/profile/ProfileFields';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { SectionCard, EndpointPending, LockedBody, Tile } from './ui';
import type { VerificationPayload } from './types';

type Assignment = { id: number; course_name: string; due_date: string | null; completion_date: string | null };
type AssignmentsResp = { rows: Assignment[]; total: number };
type RewardClaim = { id: number; item_name: string; size: string | null; points_spent: number; status: string; created_at: string };
type ClaimsResp = { rows: RewardClaim[]; total: number };
type AttendanceResp = { days: Array<{ date: string; morningSlot: boolean; eveningSlot: boolean; isLeave: boolean }> };
type WeeklyPerformance = { ota: number; sda: number; grade: string | null; rating: number; acceptanceRate?: number; totalJobs: number };

const ATTENDANCE_MONTHS = 3;
const PERFORMANCE_DAYS = 84;

/** 'YYYY-MM-DD' for a calendar date; Date.UTC rolls month/day overflow over. */
function ymd(y: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(y, monthIndex, day)).toISOString().slice(0, 10);
}

function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <p className="text-sm text-urgent">{error}</p>;
  return loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null;
}

function TrainingsBody({ efrId }: { efrId: number }) {
  const { data, loading, error } = useFetch<AssignmentsResp>(`/admin/lms/assignments?easyfixerId=${efrId}&limit=100`);
  if (!data) return <LoadState loading={loading} error={error} />;
  if (!data.rows.length) return <p className="text-sm text-muted-foreground">No trainings assigned.</p>;

  const today = istToday();
  return (
    <div className="divide-y">
      {data.rows.map((a) => {
        const due = a.due_date ? String(a.due_date).slice(0, 10) : null;
        const state: { label: string; tone: StatusChipTone } = a.completion_date
          ? { label: 'Completed', tone: 'success' }
          : due && due < today ? { label: 'Overdue', tone: 'urgent' } : { label: 'Pending', tone: 'warning' };
        return (
          <div key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink-900">{a.course_name}</span>
              <span className="block text-xs text-muted-foreground">
                {a.completion_date ? `Completed ${fmtDate(a.completion_date)}` : due ? `Due ${fmtDate(due)}` : 'No due date'}
              </span>
            </span>
            <StatusChip tone={state.tone} size="sm">{state.label}</StatusChip>
          </div>
        );
      })}
      {data.total > data.rows.length && (
        <p className="pt-2 text-xs text-muted-foreground">Showing {data.rows.length} of {data.total}.</p>
      )}
    </div>
  );
}

function RewardsBody({ efrId }: { efrId: number }) {
  const balance = useFetch<{ balance: number }>(`/admin/rewards/balance/${efrId}`);
  const claims = useFetch<ClaimsResp>(`/admin/easyfixers/${efrId}/mirror/rewards/claims?limit=10`);
  const count = (n: number | undefined, err: string | null) => (n != null ? n.toLocaleString('en-IN') : err ? '—' : '…');

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Tile label="Points balance" value={count(balance.data?.balance, balance.error)} />
        <Tile label="Rewards claimed" value={count(claims.data?.total, claims.error)} />
      </div>
      {balance.error && <p className="text-sm text-urgent">{balance.error}</p>}
      {!claims.data ? (
        <LoadState loading={claims.loading} error={claims.error} />
      ) : claims.data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rewards claimed yet.</p>
      ) : (
        <div className="divide-y">
          {claims.data.rows.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink-900">{c.item_name}{c.size ? ` (${c.size})` : ''}</span>
                <span className="block text-xs text-muted-foreground">
                  {c.points_spent.toLocaleString('en-IN')} points · {fmtDate(c.created_at)}
                </span>
              </span>
              <StatusChip
                tone={c.status === 'REJECTED' ? 'urgent' : c.status === 'DELIVERED' ? 'success' : 'neutral'}
                size="sm"
              >
                {titleCaseLabel(c.status.toLowerCase())}
              </StatusChip>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AttendanceBody({ efrId }: { efrId: number }) {
  const today = istToday();
  const [y, m] = today.split('-').map(Number);
  const from = ymd(y, m - ATTENDANCE_MONTHS, 1);
  const { data, loading, error } = useFetch<AttendanceResp>(
    `/admin/easyfixers/${efrId}/mirror/attendance?from=${from}&to=${today}`,
  );
  if (!data) return <LoadState loading={loading} error={error} />;
  const days = data.days ?? [];
  if (!days.length) return <p className="text-sm text-muted-foreground">No attendance marked in the last {ATTENDANCE_MONTHS} months.</p>;

  const byMonth = new Map<string, { active: number; leave: number }>();
  for (let i = 0; i < ATTENDANCE_MONTHS; i++) byMonth.set(ymd(y, m - 1 - i, 1).slice(0, 7), { active: 0, leave: 0 });
  for (const d of days) {
    const bucket = byMonth.get(d.date.slice(0, 7));
    if (!bucket) continue;
    if (d.isLeave) bucket.leave += 1;
    else if (d.morningSlot || d.eveningSlot) bucket.active += 1;
  }

  return (
    <div className="divide-y">
      {[...byMonth].map(([ym, c]) => (
        <div key={ym} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span className="text-ink-700">{fmtDate(`${ym}-01`).slice(3)}</span>
          <span className="tabular-nums text-muted-foreground">
            <span className="font-semibold text-ink-900">{c.active}</span> days active{c.leave ? ` · ${c.leave} on leave` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function PerformanceBody({ efrId }: { efrId: number }) {
  const to = istToday();
  const [y, m, d] = to.split('-').map(Number);
  const from = ymd(y, m - 1, d - (PERFORMANCE_DAYS - 1));
  const { data, loading, error } = useFetch<WeeklyPerformance>(
    `/admin/easyfixers/${efrId}/mirror/performance/weekly?from=${from}&to=${to}`,
  );
  if (!data) return <LoadState loading={loading} error={error} />;

  const hasJobs = data.totalJobs > 0;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile small label="On time" value={hasJobs ? `${data.ota}%` : '—'} sub="arrival" />
        <Tile small label="Same day" value={hasJobs ? `${data.sda}%` : '—'} sub="attempted" />
        <Tile small label="Jobs" value={data.totalJobs.toLocaleString('en-IN')} sub="checked in" />
        <Tile small label="Avg rating" value={data.rating ? `${data.rating.toFixed(1)}★` : '—'} sub="last 90 days" />
        <Tile small label="Grade" value={data.grade || '—'} sub="A+ to E" />
        <Tile small label="Offer acceptance" value={data.acceptanceRate != null ? `${data.acceptanceRate}%` : '—'} sub="all offers" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Escalation counts have no endpoint yet.</p>
    </div>
  );
}

export function ActivityTab({
  efrId,
  v,
  active,
  onReload,
}: {
  efrId: number;
  v: VerificationPayload;
  active: boolean;
  onReload: () => Promise<void> | void;
}) {
  const addNote = async (text: string) => {
    await api.post(`/admin/easyfixers/${efrId}/verification/comments`, { text, section: 'Technician Activation Section' });
    await onReload();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Trainings" icon={<span>🎓</span>} right={<Button asChild size="sm" variant="outline"><Link href="/lms/assign-training">Assign training</Link></Button>}>
          <TrainingsBody efrId={efrId} />
        </SectionCard>
        <SectionCard title="Achievements" icon={<span>🏆</span>}>
          {active ? <EndpointPending what="Certificates / trophies / rewards counts need GET /admin/easyfixers/:id/achievements." /> : <LockedBody />}
        </SectionCard>
      </div>

      <SectionCard title="Rewards & points" icon={<span>🎁</span>} right={<span>balance &amp; claimed only</span>}>
        {active ? <RewardsBody efrId={efrId} /> : <LockedBody />}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Attendance" icon={<span>🗓️</span>} right={<span>days active / month</span>}>
          {active ? <AttendanceBody efrId={efrId} /> : <LockedBody />}
        </SectionCard>
        <SectionCard title="Performance" icon={<span>📈</span>} right={<span>last 12 weeks</span>}>
          {active ? <PerformanceBody efrId={efrId} /> : <LockedBody />}
        </SectionCard>
      </div>

      <SectionCard title="Activity log" icon={<span>🧾</span>}>
        <EndpointPending what="There is no endpoint to read the Easyfixer activity log yet. Showing it here needs a new read-only API, pending approval." />
      </SectionCard>

      <SectionCard title="Status change notes" icon={<span>🔁</span>} right={<span>activation / inactivation notes</span>}>
        <CommentsPanel entries={v.activation.comments as CommentEntry[]} onAdd={addNote} addLabel="Add a note" />
      </SectionCard>
    </div>
  );
}
