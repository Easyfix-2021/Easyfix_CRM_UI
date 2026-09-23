'use client';

/*
 * 1. Revenue Performance — the daily revenue table and, beside it, the small
 * Productivity table (dashboard #revtable / #revProd). Both are date-wise and
 * bounded by the snapshot's dates, so they scroll instead of paging.
 *
 * Side by side from md (owner's call): reading the two date-wise tables against
 * each other IS the section, so they pair well before either is roomy. Revenue
 * takes 3/5 and Productivity 2/5, because Revenue carries six columns to
 * Productivity's four. Below md they stack. Each table keeps its own
 * horizontal scroll, so a tight pairing crops the far columns rather than
 * squeezing every number.
 *
 * ─── DAILY REVENUE COLUMNS ─────────────────────────────────────────────────
 *
 * The current dashboard's #revtable is Date · Target · Revenue and then the
 * day's closed jobs split three ways by vertical. The three headers are its
 * own wording, reproduced verbatim rather than shortened, because operators
 * read this table beside the MIS dashboard and a renamed column is a column
 * they have to re-learn:
 *
 *   "Closed Jobs — OEM (Furniture, Sports)"  compOem
 *   "Closed Jobs — Retail Maintenance"       compRet
 *   "Closed Jobs — Relocation"               compRel
 *
 * The three are NOT a breakdown of a total — a closed job in any other
 * vertical is in none of them (see DailyRevenueRow in ../types.ts) — so there
 * is deliberately no total column and no "Other" derived by subtraction.
 *
 * WHAT WENT. The one "Closed Jobs" column (`completed`) became those three,
 * and "% Achieved" / "Due" left with the redesign; the dashboard's table no
 * longer carries them. Both are still on every row, so either is one line to
 * put back — but a day's achievement against target is already the section 8
 * Performance card and the KPI tiles, and the per-member version of it is the
 * team-member dialog's Revenue Performance tab.
 *
 * WIDTH. Those three headers are long and `SortHeader` keeps every header on
 * one line, so the table is wider than its 3/5 column at most widths and the
 * frame scrolls sideways — the intended behaviour, not an overflow bug. Date
 * is frozen (`sticky`) so the row you are reading stays identified while the
 * closed-job columns scroll under it, the same treatment section 7 and the
 * member dialog give their wide date-wise tables.
 */

import type { DailyRevenueRow, ProductivityRow } from '../types';
import { fmtDay, hours2, money, num } from '../format';
import { LocalTable, SectionCard, SubHeading, emptyTableText, type Column, type SummaryProps } from './shared';

const REVENUE_COLUMNS: ReadonlyArray<Column<DailyRevenueRow>> = [
  { key: 'date', label: 'Date', sticky: true, render: (r) => fmtDay(r.date) },
  { key: 'target', label: 'Target', align: 'right', render: (r) => money(r.target) },
  { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
  { key: 'compOem', label: 'Closed Jobs — OEM (Furniture, Sports)', align: 'right', render: (r) => num(r.compOem) },
  { key: 'compRet', label: 'Closed Jobs — Retail Maintenance', align: 'right', render: (r) => num(r.compRet) },
  { key: 'compRel', label: 'Closed Jobs — Relocation', align: 'right', render: (r) => num(r.compRel) },
];

const PRODUCTIVITY_COLUMNS: ReadonlyArray<Column<ProductivityRow>> = [
  { key: 'date', label: 'Date', render: (r) => fmtDay(r.date) },
  { key: 'working', label: 'Working Hrs', align: 'right', render: (r) => hours2(r.working) },
  { key: 'productive', label: 'Productive Hrs', align: 'right', render: (r) => hours2(r.productive) },
  { key: 'positive', label: 'Positive Productivity', align: 'right', render: (r) => num(r.positive) },
];

export function RevenuePerformanceSection({ summary }: SummaryProps) {
  return (
    <SectionCard title="1. Revenue Performance">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="min-w-0 space-y-2 md:col-span-3">
          <SubHeading>Daily Revenue</SubHeading>
          <LocalTable
            rows={summary.daily}
            columns={REVENUE_COLUMNS}
            rowKey={(r) => r.date}
            emptyText={emptyTableText(summary, 'No Data For The Selected Filters')}
            scroll
          />
        </div>
        <div className="min-w-0 space-y-2 md:col-span-2">
          <SubHeading>Productivity</SubHeading>
          <LocalTable
            rows={summary.productivity}
            columns={PRODUCTIVITY_COLUMNS}
            rowKey={(r) => r.date}
            emptyText={emptyTableText(summary, 'No Data For The Selected Filters')}
            scroll
          />
        </div>
      </div>
    </SectionCard>
  );
}
