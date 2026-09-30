'use client';

/*
 * QuickSight — MTD Client Report: the PER-CLIENT DOCUMENT, v2's addition.
 *
 * WHAT THIS IS. The owner's MIS automation v2 (MTD Dashboard 2,
 * engine/template.html → `buildReport`) adds a one-client Word report beside
 * the all-clients dashboard: a document headed with the client's name and the
 * period, then seven KPIs, up to three ticked highlights, the two day-wise
 * blocks, the status-by-aging matrix cut to Completed and Open, and the open
 * orders split by tier. This section is that document, laid out natively.
 *
 * ⚠ THIS IS THE LAYOUT ONLY, ON PURPOSE. The owner asked to SEE the document
 * before deciding how it should be delivered, so none of the delivery exists:
 * no .docx is built, no .eml is written, nothing is emailed, and there is no
 * "Email to client" control at all. The "Download Word Report" button is
 * present and DISABLED, with a title saying why — an honest disabled control
 * beats a live one that silently does nothing, and beats hiding the button and
 * leaving the reviewer to guess whether it was considered.
 *
 * HOW IT IS SCOPED. It appears when exactly one client is ticked in the tab's
 * existing Client filter, which is how the MIS page scopes its own report —
 * the filter bar's Client selection is what turns the dashboard into a client
 * report. No client, or several, and the card says so and explains what to do,
 * rather than rendering a document about an unnamed party.
 *
 * ⚠ EVERY FIGURE ON THIS DOCUMENT IS WIRED. Nothing renders as a placeholder
 * any more — Tier was the last one, and /mtd/report now carries the export's
 * Tier column, so section 6 is a real matrix. If a figure with no backend is
 * ever added back, it is shown as an explicit "not wired yet" state naming the
 * missing field and NEVER as 0: a zero there would be a claim nobody has
 * measured, and it is the kind of number that survives a screenshot into a
 * client's inbox.
 *
 *   ⚠ SECTION 6 IS OPEN JOBS ONLY, AND ITS COPY HAS TO KEEP SAYING SO. Every
 *   other block on this document is counted over jobs in hand; the tier matrix
 *   is not. Its total is `tierAging.grand`, which the backend asserts equals
 *   `kpis.open` under every filter — that is what lets its subtitle claim
 *   "same open jobs as the tiles at the top". Any wording that lets it be read
 *   as all jobs by tier would overstate every row by the closures.
 *
 *   ESCALATED AND SDA % WERE PLACEHOLDERS TOO AND ARE MEASUREMENTS NOW:
 *   /mtd/report reads Is Escalated and SDA Status from the same export columns
 *   the MIS does. Two things about them must not drift — Escalated is divided
 *   by JOBS IN HAND and never by completed jobs (the template counts it across
 *   completed, cancelled and open alike, and its tile reads "of jobs in hand",
 *   so labelling it against completed would overstate it several times over),
 *   and SDA % is divided by completed, exactly as TAT % is.
 *
 *   THE FOURTH DIFFERENCE IS NOW SHOWN RATHER THAN CAVEATED. v2 counts
 *   COMPLETED on the App CheckIn Date and this report counts it on the closure
 *   date. Both counts are real and both are here. The TILE keeps the closure
 *   basis, because Completion %, TAT % and SDA % are all measured over that
 *   same set of closures and a tile disagreeing with its own row would be a
 *   worse fault than the mismatch it fixed; the check-in figure sits directly
 *   beneath it under its own label, as the number to compare against the
 *   owner's Word file, and says so when the window makes it only a floor.
 *
 * ⚠ THE AGING BANDS HERE ARE THE MATRIX'S SIX — 0–3 / 4–5 / 6–9 / 10–15 /
 * 16–30 / over 30 — and they are read from `statusAging.buckets`, never
 * written down. They are NOT the four bands of the tab's By Days Open card
 * (0–2 / 3–5 / 6–9 / over 9). The backend keeps the two splits as separate
 * constants on purpose and nothing here may borrow one for the other.
 *
 * This file fetches nothing. Every figure comes from the report response the
 * tab already holds, through ./derive.
 */

import { useMemo } from 'react';
import { Download, Info, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import type { MtdReportResponse } from '../../types';
import { SectionCard, SubHeading, TableFrame, num, pct1, pctFraction } from '../shared';
import { ReconcileNote } from '../report-parts';
import {
  BASIS_LABEL,
  ESCALATED_DENOMINATOR,
  buildHighlights,
  clientAgingRows,
  completedBases,
  dayBlock,
  escalatedParts,
  metaParts,
  resolveClientScope,
} from './derive';
import {
  ClientKpiTile,
  CompletedBasisPanel,
  DayWiseBlock,
  DocHeading,
  EscalatedSplit,
  C_COMPLETED,
  C_COMPLETED_CHECKIN,
  C_COMPLETED_LINE,
  C_CREATED,
  C_CREATED_LINE,
} from './parts';

/** Why the download control is disabled, said in one place and shown as its tooltip. */
const DOWNLOAD_DISABLED_WHY =
  'The Word report is not built yet. This section is the layout only, for review — the document export and any emailing of it are still to be decided.';

export function ClientReportSection({
  report,
  clientIds,
  period,
}: {
  report: MtdReportResponse;
  /** The tab's Client multi-select. Exactly one id is what makes this a client report. */
  clientIds: readonly number[];
  /** The window, already formatted by the tab — '1 Sep – 25 Sep 2026'. */
  period: string;
}) {
  const scope = useMemo(
    () => resolveClientScope(clientIds, report.filters.clients),
    [clientIds, report.filters.clients],
  );

  /*
   * Anything other than one client is a state with an answer, not an empty
   * card: the reader is one click from the document and should be told which
   * click.
   */
  if (scope.kind !== 'one') {
    return (
      <SectionCard
        title="Client Report"
        subtitle="The one-client document the MIS v2 automation sends out, laid out here for review"
      >
        <div className="rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center">
          <Info className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium text-foreground">
            {scope.kind === 'none'
              ? 'Pick one client to see this report'
              : `${scope.count} clients are selected`}
          </p>
          <p className="mx-auto mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
            This document is written about a single client — it is headed with that client&rsquo;s name and every
            figure in it is theirs. Tick exactly one client in the{' '}
            <span className="font-medium text-foreground">Client</span> filter above and it will appear here.
            {scope.kind === 'many' && ' The eleven sections below already cover all of the clients selected.'}
          </p>
        </div>
      </SectionCard>
    );
  }

  return <ClientDocument report={report} clientName={scope.clientName} period={period} />;
}

/**
 * The document itself, rendered only when a client is named.
 *
 * Split out so the derivations below run against a client that exists, rather
 * than being computed and thrown away on every render where none is picked.
 */
function ClientDocument({
  report,
  clientName,
  period,
}: {
  report: MtdReportResponse;
  clientName: string;
  period: string;
}) {
  const k = report.kpis;
  const weekly = report.daily.granularity === 'week';

  const meta = useMemo(() => metaParts(report, report.filters.spocs), [report]);
  const highlights = useMemo(() => buildHighlights(report), [report]);
  const created = useMemo(() => dayBlock(report.daily, 'created'), [report.daily]);
  const completed = useMemo(() => dayBlock(report.daily, 'completed'), [report.daily]);
  const agingRows = useMemo(() => clientAgingRows(report.statusAging), [report.statusAging]);
  /*
   * The tier matrix, rendered exactly as it arrives. No useMemo and no derive
   * helper beside the others: there is nothing to compute — the backend has
   * already bucketed, totalled and SORTED it into the template's order — and
   * wrapping the response in a memo would only suggest there is.
   */
  const tier = report.tierAging;
  const escalated = useMemo(() => escalatedParts(report.escalatedBySet), [report.escalatedBySet]);
  const bases = useMemo(
    () => completedBases(k.completed, report.completedOnCheckin),
    [k.completed, report.completedOnCheckin],
  );

  /*
   * The disabled control. `title` carries the reason on hover and `aria-label`
   * carries it to a screen reader, because a disabled button announces nothing
   * else about why it cannot be pressed.
   */
  const tools = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="gap-1.5"
      disabled
      title={DOWNLOAD_DISABLED_WHY}
      aria-label={`Download Word Report. ${DOWNLOAD_DISABLED_WHY}`}
    >
      <Download className="size-4" />
      Download Word Report
    </Button>
  );

  return (
    <SectionCard
      title="Client Report"
      subtitle="The one-client document the MIS v2 automation sends out, laid out here for review"
      tools={tools}
    >
      {/* ── title block ─────────────────────────────────────────────────── */}
      <header className="space-y-1 border-b pb-3">
        <h3 className="text-lg font-semibold text-ink-900">
          {clientName} <span className="font-normal text-muted-foreground">· {period}</span>
        </h3>
        {/* One separator, joined in JS: consecutive spaces in JSX text collapse
            in the browser anyway, so spelling the gap out in the markup would
            only look wider in the source than it does on screen. */}
        <p className="text-xs text-muted-foreground">
          {[...meta, `Data as of ${formatDate(report.meta.readAt)}`].join('  ·  ')}
        </p>
        {/*
          * The reconciliation warning IN THE CARD, the way sections 5, 8 and 9
          * carry their own. The tab prints a banner at the very top when a check
          * fails, and that banner is exactly the part that does not travel: this
          * card is built to be screenshotted and sent to a client, so a figure
          * the server has already flagged as not adding up would otherwise
          * arrive in an inbox with nothing marking it.
          *
          * All four of the card's checks together, at the top rather than beside
          * the section each belongs to — a reader cannot be expected to know
          * which figure 'sda' refers to, and by the time they have scrolled to
          * section 6 they have already read the tiles.
          */}
        <ReconcileNote
          checks={report.checks}
          keys={['escalated', 'sda', 'completedOnCheckin', 'tierAging']}
        />
      </header>

      {/* ── 1. the seven KPIs ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <ClientKpiTile label="Orders Created" value={num(k.ordersCreated)} note="tickets raised in these dates" />
        <ClientKpiTile label="Completed" value={num(k.completed)} note={`by ${BASIS_LABEL.closure.toLowerCase()}`} />
        <ClientKpiTile label="Cancelled" value={num(k.cancelled)} note="by cancel date" />
        {/*
          * Escalated is a COUNT here, as it is in the Word file's KPI strip,
          * with the percentage underneath. The sub-line says "of jobs in hand"
          * and nothing else may be written there: the denominator is completed
          * + cancelled + open, so "of completed jobs" would overstate this by
          * roughly three to one. The wording comes from ./derive so it cannot
          * be retyped wrongly at this call site.
          */}
        <ClientKpiTile
          label="Escalated"
          value={num(k.escalated)}
          note={`${pct1(k.escalatedPct)} ${ESCALATED_DENOMINATOR}`}
        />
        <ClientKpiTile
          label="Completion %"
          value={pct1(k.completionPct)}
          note={`${pctFraction(k.completionPct)} completed or still open`}
        />
        <ClientKpiTile label="TAT %" value={pct1(k.tatPct)} note={`${pctFraction(k.tatPct)} completed in TAT`} />
        <ClientKpiTile label="SDA %" value={pct1(k.sdaPct)} note={`${pctFraction(k.sdaPct)} completed in SDA`} />
      </div>

      {/*
        * Said once, under the tiles: the three denominators, because three of
        * the seven are percentages of three different things and a reviewer
        * comparing this against the owner's Word file needs to know which.
        * The escalation split follows, which is what makes the Escalated
        * denominator self-evident rather than something to take on trust.
        */}
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">All seven figures are live.</span> Completion % is
          (completed + open) over the {num(k.inHand)} jobs in hand; TAT % and SDA % are both over the
          {' '}{num(k.completed)} completed, which is the rule the MIS uses for each of them. Escalated is
          counted across every job in hand — completed, cancelled and open alike — so its percentage is over
          those {num(k.inHand)} and not over the completed jobs.
        </p>
        <EscalatedSplit parts={escalated} total={k.escalated} />
      </div>

      {/* ── 1a. Completed, on both date bases ───────────────────────────── */}
      <CompletedBasisPanel bases={bases} />

      {/* ── 2. key highlights ───────────────────────────────────────────── */}
      <section className="space-y-2">
        <SubHeading>Key Highlights</SubHeading>
        {highlights.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            No highlight lines for this client and window. Each line is written to be sent to a client and is
            included only when its number reads well — 70% of finished jobs completed, 70% closed within TAT,
            and so on — so a quiet month produces a shorter list rather than bad news in a client&rsquo;s inbox.
            That is the MIS report&rsquo;s own rule, not a gap here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {highlights.map((h) => (
              <li key={h.id} className="flex items-start gap-2 text-sm text-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-success-strong" aria-hidden />
                <span>
                  <span className="font-semibold tabular-nums">{h.lead}</span>
                  {h.rest}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 3. orders created ───────────────────────────────────────────── */}
      <DayWiseBlock
        title="Orders Created"
        note={`${weekly ? 'Week-wise' : 'Day-wise'} · tickets raised, by ticket created date`}
        block={created}
        metricLabel="Created"
        barColor={C_CREATED}
        lineColor={C_CREATED_LINE}
        weekly={weekly}
      />

      {/*
        * ── 4. jobs completed, on both bases ──────────────────────────────
        *
        * TWO BARS PER DAY, the same jobs on two dates: the day each closure
        * was audited, and the day the technician checked in. v2 plots only the
        * second, so the sky bars are the ones that should line up with the
        * owner's chart; the emerald bars are what this tab has always drawn.
        * They are side by side, never stacked — every job is in both series,
        * so a stack would draw twice the month.
        */}
      <DayWiseBlock
        title="Jobs Completed"
        note={`${weekly ? 'Week-wise' : 'Day-wise'} · the same closures on both dates`}
        block={completed}
        metricLabel={BASIS_LABEL.closure}
        barColor={C_COMPLETED}
        lineColor={C_COMPLETED_LINE}
        weekly={weekly}
        compare={{
          label: BASIS_LABEL.checkin,
          color: C_COMPLETED_CHECKIN,
          total: completed.altTotal ?? 0,
          caveat: bases.floor
            ? 'The App CheckIn bars are a floor over this window, not a count: it ends in the past, and a job '
              + 'that checked in inside these dates but was audited after them was never read by this report. '
              + 'On the month-to-date view the two series cover exactly the same jobs.'
            : 'A job that checked in on one day and was audited on the next sits in a different bar on each '
              + 'basis, which is the whole of the difference between the two totals.',
        }}
      />

      {/* ── 5. jobs by status and aging ─────────────────────────────────── */}
      <section className="space-y-3">
        <DocHeading
          note={
            'Completed and open jobs split by days open — the six bands of the matrix further down the tab, '
            + 'not the four of By Days Open. Cancelled jobs are counted in the tiles above but are left out of '
            + 'this table, as they are in the MIS document.'
          }
        >
          Jobs By Status And Aging
        </DocHeading>
        <TableFrame label="Jobs by status and aging — scrollable">
          <caption className="sr-only">Jobs by status and aging</caption>
          <thead>
            <tr>
              <th className="stick-col-head stick-left !text-left">Status</th>
              {/* The bands are the response's, never a constant in this folder. */}
              {report.statusAging.buckets.map((b) => (
                <th key={b.key} className="!text-right" title={`${b.label} open`}>{b.short}</th>
              ))}
              <th className="!text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {agingRows.map((row) => (
              <tr key={row.status}>
                <td className="stick-col stick-left whitespace-nowrap font-medium">{row.label}</td>
                {row.counts.map((v, i) => (
                  <td key={report.statusAging.buckets[i]?.key ?? i} className="!text-right tabular-nums">
                    {num(v)}
                  </td>
                ))}
                <td className="!text-right tabular-nums font-semibold">{num(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Days open is the export&rsquo;s Aging column; for open jobs it is the days so far, so those bands keep
          filling as the window ages.
        </p>
      </section>

      {/* ── 6. open orders by tier and days open ────────────────────────── */}
      <section className="space-y-3">
        <DocHeading
          /*
           * The template's subtitle (template.html:1791), with its SECOND
           * CLAUSE RE-POINTED — deliberately, and this is the one place this
           * document does not quote the MIS word for word.
           *
           * The template says "…· same open jobs as the tiles at the top",
           * which is true on the MIS dashboard because an OPEN COUNT IS ONE OF
           * ITS TILES. It is not one of ours: the seven tiles on this card are
           * Orders Created, Completed, Cancelled, Escalated, Completion %,
           * TAT % and SDA %, and not one of them is an open figure. Shipping
           * the sentence unchanged would point a reader at a number that is not
           * on the page, on a card whose whole job is to be screenshotted into
           * a client's inbox.
           *
           * So it points instead at the figure that IS here and IS the same
           * jobs — the Open row of Jobs By Status And Aging directly above,
           * which prints `kpis.open`. The claim the template was making (this
           * matrix splits exactly the open jobs the document already showed) is
           * preserved; only the landmark changes. The backend asserts the
           * identity behind it — `tierAging.grand === kpis.open` under every
           * filter, as `checks.tierAging`.
           *
           * "OPEN jobs" in the first clause is load-bearing and stays verbatim:
           * this matrix is the only block on the document NOT counted over jobs
           * in hand, and reading it as all jobs by tier would overstate every
           * row by the closures — roughly three to one in an ordinary month.
           */
          note={
            `${num(tier.grand)} open jobs by tier and days open so far · the same open jobs as the Open row above`
          }
        >
          Open Orders By Tier And Days Open
        </DocHeading>
        <TableFrame label="Open orders by tier and days open — scrollable">
          <caption className="sr-only">Open orders by tier and days open</caption>
          <thead>
            <tr>
              <th className="stick-col-head stick-left !text-left">Tier</th>
              {/* The response's bands again — the same six, from the same place. */}
              {tier.buckets.map((b) => (
                <th key={b.key} className="!text-right" title={`${b.label} open`}>{b.short}</th>
              ))}
              <th className="!text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {tier.rows.length === 0 ? (
              <tr>
                <td className="text-muted-foreground" colSpan={tier.buckets.length + 2}>
                  No open jobs in this view.
                </td>
              </tr>
            ) : (
              /*
               * IN THE ORDER THE BACKEND SENT THEM. The rows arrive sorted the
               * template's way — real tiers by natural-numeric collation, so
               * 'Tier - 2' precedes 'Tier - 10', then the blank-tier row last.
               * Sorting here would be a second opinion, and a lexical one would
               * disagree with the owner's .docx on any client with ten tiers.
               *
               * The blank row is marked with the backend's `blank` FLAG and not
               * by matching its label: '(Tier not given)' is wording the owner
               * can change, and a string match would quietly stop pinning it.
               */
              tier.rows.map((row) => (
                <tr key={row.tier} className={row.blank ? 'text-muted-foreground' : undefined}>
                  <td className="stick-col stick-left whitespace-nowrap font-medium">{row.tier}</td>
                  {row.counts.map((v, i) => (
                    <td key={tier.buckets[i]?.key ?? i} className="!text-right tabular-nums">
                      {num(v)}
                    </td>
                  ))}
                  <td className="!text-right tabular-nums font-semibold">{num(row.total)}</td>
                </tr>
              ))
            )}
          </tbody>
          {/*
            * UNCONDITIONAL, an empty table included, because the template is
            * unconditional: sortableTable appends `foot` OUTSIDE its empty-rows
            * branch (template.html:1760-1768) and renderTierAging always passes
            * one, so the MIS document prints "No open jobs in this view." AND a
            * Total row of zeroes. Gating it here would put a row in the owner's
            * Word file that is missing from the screen, which is the first
            * difference anyone comparing the two would land on.
            */}
          <tfoot>
            <tr className="font-semibold">
              <td className="stick-col stick-left whitespace-nowrap">Total</td>
              {tier.columnTotals.map((v, i) => (
                <td key={tier.buckets[i]?.key ?? i} className="!text-right tabular-nums">
                  {num(v)}
                </td>
              ))}
              <td className="!text-right tabular-nums">{num(tier.grand)}</td>
            </tr>
          </tfoot>
        </TableFrame>
        {/*
          * Two things this paragraph deliberately does NOT do.
          *
          * It does not quote the blank row's own label: that is the backend's
          * wording, it is already printed in the row itself, and a second copy
          * in prose is a second thing to go stale the day the owner changes it.
          *
          * It does not say "the tiles", for the reason set out on the subtitle
          * above — there is no open figure among this card's seven tiles, so
          * the landmark is the Open row of the table above, which is on the
          * page and is the same count.
          *
          * And the number it prints is `tier.grand`, NOT `kpis.open`, even
          * though the whole sentence asserts they are equal. Printing the other
          * one would put two different figures on one screen the day the
          * identity breaks — subtitle and Total saying one thing, this line
          * saying another — instead of one visibly wrong claim with the
          * reconciliation warning already at the top of the card.
          */}
        {/*
          * ONLY WHEN THERE ARE ROWS. Every clause below describes furniture —
          * a blank-tier row, a Total — that an empty table does not have, and
          * on a client with nothing open it would be explaining a table that
          * says "No open jobs in this view." The empty state is already the
          * whole truth in that case.
          */}
        {tier.rows.length > 0 && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Tier is the tier of the job&rsquo;s city, and the bands are the same six as the table above. A job
            whose city carries no tier gets its own row at the foot rather than being dropped, so the Total is
            all {num(tier.grand)} open jobs — the same figure the Open row above shows. Completed and
            cancelled jobs are not in this table at all.
          </p>
        )}
      </section>
    </SectionCard>
  );
}
