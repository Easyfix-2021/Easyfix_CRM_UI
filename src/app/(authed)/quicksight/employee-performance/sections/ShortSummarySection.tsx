'use client';

/*
 * 9. Short Summary (dashboard #summary). Same sentence as the dashboard, with
 * en-IN digit grouping. `aged` is the client table's 9+ day count, which can
 * differ from section 2's ">9 Days" tile (a different band, as on the page).
 */

import { money, num } from '../format';
import { SectionCard, type SummaryProps } from './shared';

export function ShortSummarySection({ summary }: SummaryProps) {
  const s = summary.shortSummary;
  return (
    <SectionCard title="9. Short Summary">
      <p className="text-sm leading-relaxed text-foreground">
        <span className="font-semibold">Selected Period Summary:</span>{' '}
        {num(s.completed)} jobs completed, {num(s.open)} open jobs and {money(s.revenue)} revenue against{' '}
        {money(s.target)} target.{' '}
        {s.aged ? `${num(s.aged)} open jobs are aged 9+ days.` : 'No 9+ day open backlog.'}{' '}
        {s.lowDays ? `${num(s.lowDays)} day(s) below 85% target.` : 'No reported day below 85% target.'}
      </p>
    </SectionCard>
  );
}
