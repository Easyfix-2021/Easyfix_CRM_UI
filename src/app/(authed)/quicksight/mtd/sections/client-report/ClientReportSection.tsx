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
 * ⚠ THREE FIGURES ARE NOT WIRED AND THE DOCUMENT SAYS SO IN PLACE.
 *
 *   Escalated   no backend field (the MIS reads Is Escalated from the export)
 *   SDA %       no backend field (the MIS reads SDA Status)
 *   Tier        no backend field, so the whole tier matrix is a placeholder
 *
 *   They render as "Not wired yet" on a dashed tile, NEVER as 0. A zero in the
 *   Escalated tile would be a claim that nothing was escalated this month,
 *   which nobody has measured, and it is the kind of number that survives a
 *   screenshot into a client's inbox. See ./derive UNWIRED.
 *
 *   A fourth difference is subtler and is handled differently: v2 counts
 *   COMPLETED on the App CheckIn Date and /mtd/report counts it on the closure
 *   date. That count is REAL, so it keeps its number and carries a visible
 *   basis note instead of being blanked — deleting a true figure would be its
 *   own kind of dishonesty.
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
import { SectionCard, SubHeading, num, pct1 } from '../shared';
import {
  UNWIRED,
  COMPLETED_BASIS_NOTE,
  COMPLETED_BASIS_SHORT,
  buildHighlights,
  clientAgingRows,
  dayBlock,
  metaParts,
  resolveClientScope,
} from './derive';
import {
  BasisNote,
  ClientKpiTile,
  DayWiseBlock,
  DocHeading,
  UnwiredPanel,
  UnwiredValue,
  C_COMPLETED,
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
      </header>

      {/* ── 1. the seven KPIs ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <ClientKpiTile label="Orders Created" value={num(k.ordersCreated)} />
        <ClientKpiTile label="Completed" value={num(k.completed)} />
        <ClientKpiTile label="Cancelled" value={num(k.cancelled)} />
        <ClientKpiTile label="Escalated" unwired value={<UnwiredValue why={UNWIRED.escalated} />} />
        <ClientKpiTile label="Completion %" value={pct1(k.completionPct)} />
        <ClientKpiTile label="TAT %" value={pct1(k.tatPct)} />
        <ClientKpiTile label="SDA %" unwired value={<UnwiredValue why={UNWIRED.sdaPct} />} />
      </div>

      {/*
        * Said once, under the tiles: which two of the seven are placeholders,
        * and the one difference of basis. A reviewer comparing this against
        * the owner's Word file needs all three facts before the first figure
        * they check disagrees.
        */}
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Escalated and SDA % are not wired.</span> The MIS reads
          both from its export (Is Escalated, SDA Status) and this tab&rsquo;s report endpoint carries neither, so
          they are shown as placeholders rather than as zeroes. Everything else on this row is live.
          {' '}Completion % is (completed + open) over the {num(k.inHand)} jobs in hand, and TAT % is over the
          {' '}{num(k.completed)} completed — the same two definitions the tiles at the top of the tab use.
        </p>
        <BasisNote>{COMPLETED_BASIS_NOTE}</BasisNote>
      </div>

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

      {/* ── 4. jobs completed ───────────────────────────────────────────── */}
      <DayWiseBlock
        title="Jobs Completed"
        note={`${weekly ? 'Week-wise' : 'Day-wise'} · jobs closed, by closure date`}
        block={completed}
        metricLabel="Completed"
        barColor={C_COMPLETED}
        lineColor={C_COMPLETED_LINE}
        weekly={weekly}
      />
      <BasisNote>{COMPLETED_BASIS_SHORT}</BasisNote>

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
        <div className="overflow-x-auto rounded-md border">
          <table className="data-table w-full">
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
          </table>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Days open is the export&rsquo;s Aging column; for open jobs it is the days so far, so those bands keep
          filling as the window ages.
        </p>
      </section>

      {/* ── 6. open orders by tier and days open ────────────────────────── */}
      <section className="space-y-3">
        <DocHeading>Open Orders By Tier And Days Open</DocHeading>
        <UnwiredPanel title="Open orders by tier" why={UNWIRED.tierAging}>
          It will be the same six bands as the table above, one row per tier with a Total column and a Total
          row, over the {num(k.open)} jobs still open in this window. Those open jobs are already counted — only
          the tier they belong to is missing.
        </UnwiredPanel>
      </section>
    </SectionCard>
  );
}
