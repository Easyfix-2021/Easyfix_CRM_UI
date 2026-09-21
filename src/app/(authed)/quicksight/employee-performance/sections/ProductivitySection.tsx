'use client';

/*
 * 7. Productivity — Date Wise (dashboard #prodtable).
 *
 * The dashboard tints the whole row by productive hours; the CRM has no row
 * tint (`.data-table tr:hover td` would override it), so the same rule is a
 * tone pill on the Productive Hrs cell, via productivityTone(). The legend
 * describes the rule the code applies (productive hours only). Rows are summed
 * across the selected SPOCs, so with several employees the bands (per-person
 * hours) are applied to a sum — the dashboard does the same.
 */

import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import type { ProductivityRow, ProductivityTone } from '../types';
import {
  PRODUCTIVE_BAD_HOURS,
  PRODUCTIVE_GOOD_HOURS,
  fmtDay,
  hours2,
  num,
  pct1,
  productivityTone,
} from '../format';
import { LocalTable, SectionCard, type Column, type SummaryProps } from './shared';

const TONE_CHIP: Record<ProductivityTone, StatusChipTone> = {
  good: 'success',
  warn: 'warning',
  bad: 'urgent',
};

const PRODUCTIVITY_COLUMNS: ReadonlyArray<Column<ProductivityRow>> = [
  { key: 'date', label: 'Date', sticky: true, render: (r) => fmtDay(r.date) },
  { key: 'working', label: 'Working Hrs', align: 'right', render: (r) => hours2(r.working) },
  {
    key: 'productive',
    label: 'Productive Hrs',
    align: 'right',
    render: (r) => (
      <StatusChip tone={TONE_CHIP[productivityTone(r.productive)]} size="sm" className="tabular-nums">
        {hours2(r.productive)}
      </StatusChip>
    ),
  },
  { key: 'pct', label: 'Productivity %', align: 'right', render: (r) => pct1(r.pct) },
  { key: 'openJobs', label: 'Open Jobs', align: 'right', render: (r) => num(r.openJobs) },
  { key: 'closed', label: 'CRM Closed', align: 'right', render: (r) => num(r.closed) },
  { key: 'cancelled', label: 'Cancelled', align: 'right', render: (r) => num(r.cancelled) },
  { key: 'positive', label: 'Positive Productivity', align: 'right', render: (r) => num(r.positive) },
  { key: 'incoming', label: 'Incoming', align: 'right', render: (r) => num(r.incoming) },
  { key: 'outgoing', label: 'Outgoing', align: 'right', render: (r) => num(r.outgoing) },
  { key: 'missed', label: 'Missed', align: 'right', render: (r) => num(r.missed) },
  { key: 'missedPct', label: 'Missed %', align: 'right', render: (r) => pct1(r.missedPct) },
];

export function ProductivitySection({ summary }: SummaryProps) {
  return (
    <SectionCard title="7. Productivity — Date Wise">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="success" size="sm">Productive ≥ {PRODUCTIVE_GOOD_HOURS} Hrs</StatusChip>
        <StatusChip tone="warning" size="sm">Productive {PRODUCTIVE_BAD_HOURS} – {PRODUCTIVE_GOOD_HOURS} Hrs</StatusChip>
        <StatusChip tone="urgent" size="sm">Productive &lt; {PRODUCTIVE_BAD_HOURS} Hrs</StatusChip>
        <span className="text-xs text-muted-foreground">
          Hours are summed across the selected employees; the bands are per person.
        </span>
      </div>
      <LocalTable
        rows={summary.productivity}
        columns={PRODUCTIVITY_COLUMNS}
        rowKey={(r) => r.date}
        emptyText="No Data For The Selected Filters"
        scroll
      />
    </SectionCard>
  );
}
