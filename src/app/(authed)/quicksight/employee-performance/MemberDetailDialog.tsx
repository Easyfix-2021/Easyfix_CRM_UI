'use client';

/*
 * QuickSight — Employee Performance: the team-member dialog.
 *
 * The dashboard's "TEAM MEMBER — <name>" popup (dashboard.html, the
 * .team-member-btn click handler) in CRM styling: a Dialog with two tabs,
 *
 *   Productivity         — the member's own date-wise productivity rows
 *   Revenue Performance  — team daily target vs team revenue for a team lead,
 *                          personal target vs A&CO achieved for a member
 *
 * Both views arrive in ONE response: GET …/member?<filters>&name=<CRM name>
 * (aggregate.js memberDetail). Only Month and the date range change it; the
 * other filters are sent and ignored, exactly as the dashboard's dialog only
 * reads selectedDates().
 *
 * STALE-DATA GUARD. useFetch keeps the previous response in state when its key
 * changes or goes null, so a dialog that simply swapped `name` would show the
 * last member's rows under the new member's title until the request landed —
 * and keep them next to a 404. Two things stop that:
 *   1. MemberBody is keyed by the member's CRM name, so opening a different
 *      member mounts a fresh useFetch with no data in it;
 *   2. the body renders only when `data.key` is the open member and the hook is
 *      not refreshing.
 *
 * The fetch runs only while the dialog is open (`live`). While the close
 * animation plays the key goes null, which leaves the last response on screen
 * instead of firing a request for a dialog that is going away.
 */

import { useState, type ReactNode } from 'react';
import { AlertTriangle, IndianRupee, Inbox, Loader2, Percent, Target, TrendingDown } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { ALL, memberKey } from './api';
import {
  PRODUCTIVE_BAD_HOURS, PRODUCTIVE_GOOD_HOURS,
  fmtDay, hours2, money, num, pct1, productivityTone,
} from './format';
import { LocalTable, type Column } from './sections/shared';
import type {
  Filters, MemberDetail, MemberProductivityRow, MemberRevenueRow, ProductivityTone, TeamMemberChip,
} from './types';

type TabValue = 'prod' | 'rev';

const TONE_CHIP: Record<ProductivityTone, StatusChipTone> = {
  good: 'success',
  warn: 'warning',
  bad: 'urgent',
};

/* The backend's 404 for a name with no employee row (roster-only people). */
const NOT_FOUND_RE = /no employee performance data/i;

export function MemberDetailDialog({
  v,
  filters,
  member,
  period,
  onClose,
}: {
  /** meta.uploadedAt — the cache-buster in every data key. */
  v: string | null;
  filters: Filters;
  /** The open member, or null when the dialog is closed. */
  member: TeamMemberChip | null;
  /** Human label of the selected date range, e.g. '01 Aug 2026 – 13 Sep 2026'. */
  period: string;
  onClose: () => void;
}) {
  const open = member != null;

  /*
   * Keep the last member while the dialog animates closed, so the title and
   * rows don't blank out mid-fade. Adjusting state during render is React's
   * documented pattern for "remember the previous prop" (no effect needed).
   */
  const [shown, setShown] = useState<TeamMemberChip | null>(member);
  if (member && member.key !== shown?.key) setShown(member);

  // Pure display dialog: nothing to discard, so every close path closes at once.
  const handleOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Pinned pattern: header and tab list stay put; the scroller is the active
          TabsContent (`min-h-0 flex-1 overflow-y-auto`) inside MemberBody, a child
          component the rule cannot see. */}
      {/* eslint-disable-next-line local/no-unscrollable-dialog-content */}
      <DialogContent className="max-w-6xl flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Team Member — {shown?.label ?? ''}</DialogTitle>
          <DialogDescription>
            {shown && shown.label !== shown.key ? `CRM Name: ${shown.key} · ` : ''}
            {period}
          </DialogDescription>
        </DialogHeader>
        {shown && (
          <MemberBody key={shown.key} v={v} filters={filters} member={shown} live={open} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberBody({
  v,
  filters,
  member,
  live,
}: {
  v: string | null;
  filters: Filters;
  member: TeamMemberChip;
  live: boolean;
}) {
  const [tab, setTab] = useState<TabValue>('prod');
  const res = useFetch<MemberDetail>(live ? memberKey(v, filters, member.key) : null);
  const detail = res.data && res.data.key === member.key && !res.refreshing ? res.data : null;

  if (!detail) {
    if (res.error) {
      const notFound = NOT_FOUND_RE.test(res.error);
      return (
        <StateMessage
          icon={notFound
            ? <Inbox className="size-7 text-muted-foreground" />
            : <AlertTriangle className="size-7 text-urgent-strong" />}
          title={notFound ? 'No Data For This Person' : 'Couldn’t Load This Member'}
          message={res.error}
        />
      );
    }
    return (
      <StateMessage
        icon={<Loader2 className="size-7 animate-spin text-muted-foreground" />}
        title="Loading…"
      />
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next === 'rev' ? 'rev' : 'prod')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList className="shrink-0 self-start">
        <TabsTrigger value="prod">Productivity</TabsTrigger>
        <TabsTrigger value="rev">Revenue Performance</TabsTrigger>
      </TabsList>
      <TabsContent value="prod" className="mt-3 min-h-0 flex-1 overflow-y-auto">
        <ProductivityView rows={detail.productivity} />
      </TabsContent>
      <TabsContent value="rev" className="mt-3 min-h-0 flex-1 overflow-y-auto">
        <RevenueView detail={detail} zmSelected={!!filters.zm && filters.zm !== ALL} />
      </TabsContent>
    </Tabs>
  );
}

function StateMessage({ icon, title, message }: { icon: ReactNode; title: string; message?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon}
      <div className="text-sm font-semibold">{title}</div>
      {message && <p className="max-w-md text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}

/* ── Productivity tab ─────────────────────────────────────────────────────── */

/* The dashboard's 13 columns, in its order. */
const PROD_COLUMNS: ReadonlyArray<Column<MemberProductivityRow>> = [
  { key: 'date', label: 'Date', sticky: true, render: (r) => fmtDay(r.date) },
  { key: 'working', label: 'Working Hrs', align: 'right', render: (r) => hours2(r.working) },
  { key: 'productive', label: 'Productive Hrs', align: 'right', render: (r) => <ProductiveHours value={r.productive} /> },
  { key: 'pct', label: 'Productivity %', align: 'right', render: (r) => pct1(r.pct) },
  { key: 'openJobs', label: 'Open Jobs', align: 'right', render: (r) => num(r.openJobs) },
  { key: 'away', label: 'Away Hrs', align: 'right', render: (r) => hours2(r.away) },
  { key: 'closed', label: 'CRM Closed', align: 'right', render: (r) => num(r.closed) },
  { key: 'cancelled', label: 'Cancelled', align: 'right', render: (r) => num(r.cancelled) },
  { key: 'positive', label: 'Positive Productivity', align: 'right', render: (r) => num(r.positive) },
  { key: 'incoming', label: 'Incoming', align: 'right', render: (r) => num(r.incoming) },
  { key: 'outgoing', label: 'Outgoing', align: 'right', render: (r) => num(r.outgoing) },
  { key: 'missed', label: 'Missed', align: 'right', render: (r) => num(r.missed) },
  { key: 'missedPct', label: 'Missed %', align: 'right', render: (r) => pct1(r.missedPct) },
];

const rowKeyByDate = (r: { date: string }, i: number) => r.date || `row-${i}`;

/* Same rule as section 7: productive hours only (format.ts productivityTone). */
function ProductiveHours({ value }: { value: number | null | undefined }) {
  return (
    <StatusChip tone={TONE_CHIP[productivityTone(value)]} size="sm" className="tabular-nums">
      {hours2(value)}
    </StatusChip>
  );
}

function ProductivityView({ rows }: { rows: MemberProductivityRow[] }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="success" size="sm">Productive ≥ {PRODUCTIVE_GOOD_HOURS} Hrs</StatusChip>
        <StatusChip tone="warning" size="sm">Productive {PRODUCTIVE_BAD_HOURS} – {PRODUCTIVE_GOOD_HOURS} Hrs</StatusChip>
        <StatusChip tone="urgent" size="sm">Productive &lt; {PRODUCTIVE_BAD_HOURS} Hrs</StatusChip>
      </div>
      <LocalTable
        rows={rows}
        columns={PROD_COLUMNS}
        rowKey={rowKeyByDate}
        emptyText="No Productivity Data For The Selected Date Range"
      />
    </div>
  );
}

/* ── Revenue Performance tab ──────────────────────────────────────────────── */

function RevenueView({ detail, zmSelected }: { detail: MemberDetail; zmSelected: boolean }) {
  const isLead = detail.view === 'team';
  const { rows, totals } = detail.revenue;

  const columns: ReadonlyArray<Column<MemberRevenueRow>> = [
    { key: 'date', label: 'Date', render: (r) => fmtDay(r.date) },
    { key: 'target', label: 'Daily Target', align: 'right', render: (r) => money(r.target) },
    { key: 'achieved', label: isLead ? 'Achieved (Team)' : 'Achieved (A&CO)', align: 'right', render: (r) => money(r.achieved) },
    { key: 'pct', label: 'Achieved %', align: 'right', render: (r) => pct1(r.pct) },
    { key: 'due', label: 'Shortfall', align: 'right', render: (r) => money(r.due) },
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground">
          {isLead
            ? 'Team-Lead View — Team Daily Target Vs Team Revenue.'
            : 'Member View — Personal Target (Total Target ÷ 26) Vs A&CO Achieved.'}
        </p>
        {isLead && zmSelected && (
          <p className="text-xs text-muted-foreground">
            Team Revenue Here Is Not Split By Zonal Manager — Only Month And Date Range Apply.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QsKpiTile label="Total Target" value={money(totals.target)} accent={QS_COLORS[0]} icon={<Target className="size-5" />} />
        <QsKpiTile
          label={isLead ? 'Total Achieved' : 'Total Achieved (A&CO)'}
          value={money(totals.achieved)}
          accent={QS_COLORS[2]}
          icon={<IndianRupee className="size-5" />}
        />
        <QsKpiTile label="Achieved %" value={pct1(totals.pct)} accent={QS_SEMANTIC.info} icon={<Percent className="size-5" />} />
        <QsKpiTile label="Total Shortfall" value={money(totals.shortfall)} accent={QS_SEMANTIC.bad} icon={<TrendingDown className="size-5" />} />
      </div>

      <LocalTable
        rows={rows}
        columns={columns}
        rowKey={rowKeyByDate}
        emptyText="No Revenue Performance Data For The Selected Date Range"
      />
    </div>
  );
}
