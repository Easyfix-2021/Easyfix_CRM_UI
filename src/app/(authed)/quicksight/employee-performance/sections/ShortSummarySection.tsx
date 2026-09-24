'use client';

/*
 * 9. Short Summary (dashboard #summary). Same sentence as the dashboard, with
 * en-IN digit grouping. `aged` is the client table's 9+ day count, which can
 * differ from section 2's ">9 Days" tile (a different band, as on the page).
 *
 * The figures are the selected SPOCs', and an Unattributed bucket is a selected
 * SPOC like any other (compose.js), so the jobs and the revenue stay complete
 * even when the window can name nobody. What goes missing then is the
 * attribution and the TARGET: targets are uploaded per employee, so with no
 * employee listed the sentence reads "against ₹0 target" — and reading ₹R
 * revenue against ₹0 target with no explanation is exactly the contradiction
 * that makes a report look broken. A second line says why.
 */

import { money, num } from '../format';
import { rosterGap, rosterReason } from '../visibility';
import { SectionCard, type SummaryProps } from './shared';

export function ShortSummarySection({ summary }: SummaryProps) {
  const s = summary.shortSummary;
  const reason = rosterReason(rosterGap(summary.meta, summary.team.members.length));
  return (
    <SectionCard title="9. Short Summary">
      <p className="text-sm leading-relaxed text-foreground">
        <span className="font-semibold">Selected Period Summary:</span>{' '}
        {num(s.completed)} jobs completed, {num(s.open)} open jobs and {money(s.revenue)} revenue against{' '}
        {money(s.target)} target.{' '}
        {s.aged ? `${num(s.aged)} open jobs are aged 9+ days.` : 'No 9+ day open backlog.'}{' '}
        {s.lowDays ? `${num(s.lowDays)} day(s) below 85% target.` : 'No reported day below 85% target.'}
      </p>
      {reason && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          This selection lists no employee, so nothing above is attributed to a person: those jobs and that revenue
          are counted under Unattributed.{s.target === 0 ? ' Targets are uploaded per employee, so the target reads ₹0.' : ''}{' '}
          {reason}
        </p>
      )}
    </SectionCard>
  );
}
