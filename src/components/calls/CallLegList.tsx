'use client';

/*
 * CallLegList — the ONE way a conference's people are drawn in call history.
 *
 * Three surfaces show per-call detail: the ⓘ call-history tooltip on a Job #
 * (also inlined in the job modal's Calling History), the Call Info modal's
 * Click To Call tab, and the QuickSight Call Tracking drill-down. All three
 * needed the same new thing — "this call had three people on it, here they
 * are" — and all three render it from here rather than from three near-copies
 * that drift on a label or a colour.
 *
 * ─── The reading rule this component exists to enforce ───────────────────
 *
 * A 3-party conference is ONE call. So the legs are never rendered as sibling
 * rows in the call table: they are an indented detail block BELOW the call's own
 * row, introduced by a badge that says how many people were on it. Nothing about
 * the layout invites you to count them as calls, and the badge count is derived
 * from the legs actually listed, so the two cannot disagree.
 *
 * ─── PRIVACY ─────────────────────────────────────────────────────────────
 *
 * `masked_number` is the only number-shaped field on a leg and the only one
 * rendered here. There is no unmasked form on this wire — see the note on
 * `CallLeg` in lib/call-legs.ts.
 */

import * as React from 'react';
import { StatusChip } from '@/components/ui/StatusChip';
import { cn } from '@/lib/utils';
import {
  callLegName,
  callLegRoleLabel,
  callLegStatusLabel,
  callLegStatusTone,
  callPartyCount,
  fmtLegDuration,
  isConferenceCall,
  partyTone,
  type CallLeg,
  type CallRowWithLegs,
} from '@/lib/call-legs';
import { targetKindIcon } from './conference-types';

/*
 * ConferenceBadge — the "this row is more than a 1:1 call" marker.
 *
 * Rendered wherever a call's counterparty is named, so a reader scanning the
 * "With" / "Customer" column sees at a glance that the row summarises a call
 * with several people rather than mislabelling it as a call with one.
 */
export function ConferenceBadge({
  row,
  className,
}: {
  row: CallRowWithLegs | null | undefined;
  className?: string;
}) {
  if (!isConferenceCall(row)) return null;
  const n = callPartyCount(row);
  return (
    <StatusChip
      tone="violet"
      size="sm"
      title={`This was one call with ${n} people on it, including the ops agent.`}
      className={className}
    >
      Conference · {n} People
    </StatusChip>
  );
}

/*
 * The legs themselves. `dense` is the tooltip/modal variant (a compact stack
 * that sits inside a table cell spanning the row); the default has a little
 * more air for the QuickSight drill-down's wider table.
 */
export function CallLegList({
  legs,
  className,
  dense = false,
}: {
  legs: readonly CallLeg[] | null | undefined;
  className?: string;
  dense?: boolean;
}) {
  if (!legs || legs.length === 0) return null;
  return (
    <ul
      className={cn('space-y-1', className)}
      aria-label="People on this call"
    >
      {legs.map((leg) => {
        const Icon = targetKindIcon(leg.target_kind);
        const roleLabel = callLegRoleLabel(leg.target_kind);
        const name = callLegName(leg);
        return (
          <li
            key={leg.id}
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1',
              dense ? 'text-[11px]' : 'text-xs',
            )}
          >
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            {/* Role first: on a conference the ROLE is the thing being added
                back — a name alone is what the pre-conference surfaces already
                showed, and it is the role that was missing. */}
            <StatusChip tone={partyTone(leg.target_kind)} size="sm">
              {roleLabel}
            </StatusChip>
            {/* Suppress the name when it IS the role label (callLegName falls
                back to it), so a leg with no name on file doesn't print
                "Customer Customer". */}
            {name !== roleLabel && <span className="font-medium">{name}</span>}
            {leg.masked_number && (
              <span className="font-mono text-[10px] text-muted-foreground">{leg.masked_number}</span>
            )}
            <StatusChip tone={callLegStatusTone(leg.status)} size="sm" title={leg.hangup_cause ?? undefined}>
              {callLegStatusLabel(leg.status)}
            </StatusChip>
            {/* A leg that never connected has no meaningful duration, and a
                bare "0s" next to "No Answer" reads as a stopwatch bug. */}
            {leg.duration != null && leg.duration > 0 && (
              <span className="tabular-nums text-muted-foreground">{fmtLegDuration(leg.duration)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/*
 * CallLegsRow — the legs as a full-width detail row underneath a call's row in
 * a <table>. `colSpan` must cover the parent table's whole width; the indent
 * rail is what visually subordinates it to the call above.
 *
 * Renders nothing for an ordinary 1:1 call: every ops call now carries a
 * conference id (see `isConferenceCall`), so gating on the leg COUNT rather
 * than on the id is what keeps this from appending an empty block to every row
 * in the table.
 */
export function CallLegsRow({
  row,
  colSpan,
  label = 'On This Call',
}: {
  row: CallRowWithLegs | null | undefined;
  colSpan: number;
  label?: string;
}) {
  if (!isConferenceCall(row)) return null;
  return (
    <tr className="border-b border-border/60 bg-muted/20">
      <td colSpan={colSpan} className="py-1.5 pl-6 pr-3">
        <div className="border-l-2 border-violet-200 pl-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <CallLegList legs={row?.legs} dense />
        </div>
      </td>
    </tr>
  );
}
