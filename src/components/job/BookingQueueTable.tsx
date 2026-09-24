'use client';

import * as React from 'react';
import { Eye, CalendarCheck, Send } from 'lucide-react';
import { CallHistoryButton } from '@/components/calls/CallHistoryButton';
import { SortHeader, type SortDir } from '@/lib/use-sort';
import { JOB_AGE_SORT_KEY } from '@/lib/job-age';
import { formatDate } from '@/lib/utils';
import { formatJobAge, jobAgeTitle, type JobAgeFields } from '@/lib/job-age';
import { displaySlot } from '@/lib/job-slots';
import { parseIstDateTime } from '@/lib/format';
import { StatusChip } from '@/components/ui/StatusChip';
import { IconButton } from '@/components/ui/icon-button';
import { CallableMobile } from '@/components/calls/CallButton';
import { MagicLinkActionPopup } from '@/components/job/MagicLinkActionPopup';

/*
 * BookingQueueTable — a DIFFERENT set of columns per bucket.
 *
 * ── ONE TABLE, TWO COLUMNS THAT CHANGE ───────────────────────────────────
 *
 * Ops reviewed every bucket's table and settled it (2026-09-24): the SAME
 * thirteen columns in the SAME order everywhere, and only BUCKET and NEXT
 * ACTION differ. That is a better answer than the per-bucket column sets this
 * file first carried — an executive moving between tiles keeps one layout and
 * reads the two cells that actually differ, instead of re-finding every column.
 *
 * So the per-bucket knowledge in here is now exactly two functions:
 *   bucketCell()     what this bucket is called, plus its own sub-line
 *                    (the day with the client, the kind of answer)
 *   nextActionCell() what to do about it, computed - never typed
 *
 *   New                 New                 -> Queued · next hourly run
 *   Response received   Rescheduled         -> reason, then the date asked for
 *                       Cancelled           -> reason
 *                       Ready for SKU       -> Book ticket
 *   No response         No response         -> Call - 1st / 2nd / final attempt
 *   Delivery failed     Delivery failed     -> the same call ladder: the link
 *                       (reason on hover)      never arrived, so the next step
 *                                              is a call either way
 *   Client queue        With client · Day N -> blank; it is not our move
 *
 * Every cell renderer is shared with the rest of the CRM — click-to-call, the
 * magic-link popup, the status chips, the age formatter — so this file decides
 * WHICH facts a bucket shows and nothing about how any of them behave.
 */

export type BookingQueueRow = JobAgeFields & {
  job_id: number;
  job_reference_id?: string | null;
  client_ref_id: string | null;
  client_name: string | null;
  city_name: string | null;
  ticket_created_date_time?: string | null;
  created_date_time: string;
  requested_date_time: string;
  time_slot?: string | null;
  customer_name: string | null;
  customer_mob_no: string | null;
  source_type: string | null;
  client_spoc?: string | null;
  client_spoc_name?: string | null;
  magic_link_sent_at?: string | null;
  magic_link_send_count?: number;
  magic_link_max_send_count?: number | null;
  magic_link_last_action?: 'first' | 'reminder' | 'resend' | null;
  magic_link_delivery_status?: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered' | null;
  magic_link_delivery_reason?: string | null;
  client_opted_in?: boolean | 0 | 1;
  customer_submitted_at?: string | null;
  pending_request_type?: 'cancel' | 'reschedule' | null;
  pending_request_reason?: string | null;
  pending_request_preferred_datetime?: string | null;
  /* The attempt ledger — see booking-queue.service.js attemptColumns(). */
  attempts_count?: number | null;
  last_attempt_at?: string | null;
  last_attempt_kind?: 'link' | 'sms' | 'call' | null;
  transferred_at?: string | null;
  /* The latest comment on the job — NOT tbl_job.remarks, which the next write
     overwrites. See attemptColumns() in booking-queue.service.js. */
  latest_comment?: string | null;
  /* Escalation, projected for the queue by job.service.js (wantsEscalation).
     A count rather than a flag on some rows, so both shapes are read. */
  is_escalated?: number | boolean | null;
  no_of_escalations?: number | null;
  escalated_comments?: string | null;
};

export type BucketKey =
  | 'new' | 'response_received' | 'no_response' | 'delivery_failed'
  | 'no_link_needed' | 'client_queue'
  | 'response_ready' | 'response_reschedule' | 'response_cancel';

type Col =
  | 'job' | 'age' | 'ticket' | 'client' | 'cityCoverage' | 'appt' | 'customer'
  | 'bucket' | 'nextAction' | 'remarks' | 'spoc' | 'source' | 'action';

/*
 * ONE order, every bucket. Sequence fixed by ops.
 */
const COLUMNS: Col[] = [
  'job', 'age', 'ticket', 'client', 'cityCoverage', 'appt', 'customer',
  'bucket', 'nextAction', 'remarks', 'spoc', 'source', 'action',
];

/*
 * The four columns ops sorts by. Sorting is SERVER-side (the key goes to
 * /admin/jobs), so it orders the whole bucket rather than the page on screen —
 * on a 106-row bucket at 10 a page, sorting only the visible rows would be a
 * different, and wrong, answer.
 */
const SORT_KEY: Partial<Record<Col, string>> = {
  job: 'job_id',
  age: JOB_AGE_SORT_KEY,
  ticket: 'created_date_time',
  appt: 'requested_date_time',
};

const HEAD: Record<Col, string> = {
  job: 'Job #', age: 'Age', ticket: 'Ticket created', client: 'Client',
  cityCoverage: 'City · Coverage', appt: 'Appointment · Slot', customer: 'Customer',
  bucket: 'Bucket', nextAction: 'Next action', remarks: 'Remarks',
  spoc: 'Client SPOC', source: 'Source', action: 'Action',
};

/** Three attempt-days and the order stops being ours. Mirrors the backend. */
const ATTEMPTS_TO_TRANSFER = 3;

/*
 * Escalation arrives as a flag on some rows and a count on others (the
 * projection reads the latest escalation row, and older ones carry only the
 * counter), so both shapes are accepted.
 */
function isEscalated(j: BookingQueueRow): boolean {
  return j.is_escalated === 1 || j.is_escalated === true || Number(j.no_of_escalations ?? 0) > 0;
}

/** What the customer asked for, when they answered the link. */
function answerKind(j: BookingQueueRow): 'reschedule' | 'cancel' | 'ready' {
  if (j.pending_request_type === 'reschedule') return 'reschedule';
  if (j.pending_request_type === 'cancel') return 'cancel';
  return 'ready';
}

/** Days between an IST date string and today — the "with client" clock. */
function daysSince(value?: string | null): number | null {
  if (!value) return null;
  const then = parseIstDateTime(value);
  if (!then) return null;
  const day = 24 * 60 * 60 * 1000;
  const diff = Math.floor((Date.now() - then.getTime()) / day);
  return diff < 0 ? 0 : diff;
}

const ANSWER_LABEL = { reschedule: 'Rescheduled', cancel: 'Cancelled', ready: 'Ready for SKU' } as const;
const ANSWER_TONE = { reschedule: 'amber', cancel: 'red', ready: 'emerald' } as const;

/*
 * BUCKET — what this order is, in its own words.
 *
 * One of the two cells that differ per tile. Response received names the
 * ANSWER rather than the tile, because "Rescheduled" and "Cancelled" need
 * different people and a row saying "Response received" tells neither of them
 * anything. Client queue names the day it has been with the client, which is
 * the only number on that tile that moves.
 */
function bucketCell(bucket: string, j: BookingQueueRow) {
  if (bucket === 'response_received') {
    const kind = answerKind(j);
    return <StatusChip tone={ANSWER_TONE[kind]} size="sm">{ANSWER_LABEL[kind]}</StatusChip>;
  }
  if (bucket === 'client_queue') {
    const d = daysSince(j.transferred_at);
    return (
      <>
        <StatusChip tone="slate" size="sm">With client</StatusChip>
        {d !== null && (
          <div className="text-xs text-muted-foreground">{d >= 3 ? 'Day 3+' : `Day ${d}`}</div>
        )}
      </>
    );
  }
  if (bucket === 'delivery_failed') {
    /* The failure reason has no column of its own in the shared layout, so it
       rides on the chip — the row still answers "why" without a column every
       other bucket would leave blank. */
    return (
      <StatusChip
        tone="red"
        size="sm"
        title={j.magic_link_delivery_reason || 'WhatsApp could not deliver this message'}
      >
        Delivery failed
      </StatusChip>
    );
  }
  if (bucket === 'no_link_needed') return <StatusChip tone="violet" size="sm">No link needed</StatusChip>;
  if (bucket === 'no_response') return <StatusChip tone="amber" size="sm">No response</StatusChip>;
  return <StatusChip tone="slate" size="sm">New</StatusChip>;
}

/*
 * NEXT ACTION — what to do about it. COMPUTED, never typed by anyone: the
 * handover doc is explicit, and two operators reading two identical rows must
 * be told the same thing.
 */
function nextActionCell(bucket: string, j: BookingQueueRow) {
  const attempts = Number(j.attempts_count ?? 0);

  if (bucket === 'new') {
    return <span className="text-xs font-semibold">Queued · next hourly run</span>;
  }

  if (bucket === 'response_received') {
    const kind = answerKind(j);
    if (kind === 'ready') return <span className="text-xs font-semibold">Book ticket</span>;
    return (
      <>
        {/* The customer's own words for why. For a reschedule the date they
            asked for sits underneath: without it the row still shows the OLD
            appointment and somebody re-books the time the customer rejected. */}
        <span className="text-xs font-semibold">{j.pending_request_reason || (kind === 'cancel' ? 'Cancellation requested' : 'Reschedule requested')}</span>
        {kind === 'reschedule' && j.pending_request_preferred_datetime && (
          <div className="text-xs text-warning-strong">
            asked for {formatDate(j.pending_request_preferred_datetime)}
          </div>
        )}
      </>
    );
  }

  /* Not our move — ops asked for this to stay blank until the client-queue
     rules are defined. An em dash, not an empty cell, so a reader can tell
     "nothing to do" from "nothing loaded". */
  if (bucket === 'client_queue') return <span className="text-xs text-muted-foreground">—</span>;

  /*
   * The call ladder, shared by No response, Delivery failed and No link
   * needed. Same rule for all three because the next step is a call in every
   * one of them; only how they arrived differs, and the attempt count already
   * carries that (an undelivered link never counted, so a Delivery-failed
   * order's first call really is attempt 1).
   */
  const n = attempts + 1;
  const label = attempts >= ATTEMPTS_TO_TRANSFER ? 'Transferring to client'
    : n >= ATTEMPTS_TO_TRANSFER ? 'Call — final attempt'
      : n === 1 ? 'Call — 1st attempt' : 'Call — 2nd attempt';
  return (
    <>
      <span className="text-xs font-semibold">{label}</span>
      <div className="text-xs text-muted-foreground">{attempts} of {ATTEMPTS_TO_TRANSFER} attempts</div>
    </>
  );
}

export function BookingQueueTable({
  rows, loading, bucket, canConfirm, canSendMagicLink, userIsAdmin,
  openView, openConfirm, onMagicLinkSent, sortBy, sortDir, onSort,
}: {
  rows: BookingQueueRow[];
  loading?: boolean;
  bucket: BucketKey;
  canConfirm?: boolean;
  canSendMagicLink?: boolean;
  userIsAdmin?: boolean;
  openView: (id: number) => void;
  openConfirm: (id: number) => void;
  onMagicLinkSent?: () => void;
  sortBy?: string | null;
  sortDir?: SortDir;
  onSort?: (col: string) => void;
}) {
  const key = bucket.startsWith('response') ? 'response_received' : bucket;
  const cols = COLUMNS;
  /*
   * The popup is controlled and renders ONCE, outside the table — mounting one
   * per row would build a dialog for every order on screen. Null closes it and
   * drops the row state, so the next open re-mounts with fresh props.
   */
  const [linkRow, setLinkRow] = React.useState<BookingQueueRow | null>(null);

  function cell(c: Col, j: BookingQueueRow) {
    switch (c) {
      case 'job':
        return (
          <div className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="font-semibold">#{j.job_id}</span>
            {/* Escalated orders are the ones that must not be scrolled past, so
                the mark sits ON the job number rather than in a column an eye
                has to travel to. Title carries the reason when there is one. */}
            {isEscalated(j) && (
              <span
                aria-label="Escalated"
                title={j.escalated_comments || 'Escalated'}
                className="text-destructive"
              >
                🔥
              </span>
            )}
            {/* Call history + recordings, the same control Manage Jobs carries.
                Next to the job number because that is where an operator looks
                first when they want to know what was already said. */}
            <CallHistoryButton jobId={j.job_id} />
          </div>
        );
      case 'age':
        return <span title={jobAgeTitle(j)}>{formatJobAge(j)}</span>;
      case 'ticket':
        return <span className="text-xs">{formatDate(j.ticket_created_date_time ?? j.created_date_time)}</span>;
      case 'client':
        return j.client_name ?? '—';
      case 'cityCoverage':
        return (
          <>
            <div>{j.city_name ?? '—'}</div>
            {/* Coverage is not computed yet (ops: "keep all local for now"), so
                it is labelled as a placeholder rather than dressed up as an
                answer — a chip that is always LOCAL should not look measured. */}
            <StatusChip tone="emerald" size="sm" title="Coverage is not computed yet — every order shows LOCAL">
              LOCAL
            </StatusChip>
          </>
        );
      case 'appt':
        return (
          <>
            <div>{formatDate(j.requested_date_time)}</div>
            {displaySlot(j.requested_date_time, j.time_slot) && (
              <div className="text-xs text-muted-foreground">{displaySlot(j.requested_date_time, j.time_slot)}</div>
            )}
          </>
        );
      case 'customer':
        return (
          <>
            <div>{j.customer_name ?? '—'}</div>
            <CallableMobile jobId={j.job_id} mobile={j.customer_mob_no} />
          </>
        );
      case 'bucket':
        return bucketCell(key, j);
      case 'nextAction':
        return nextActionCell(key, j);
      case 'remarks':
        return (
          <span className="block max-w-[15rem] truncate text-xs text-muted-foreground" title={j.latest_comment ?? undefined}>
            {j.latest_comment || '—'}
          </span>
        );
      case 'spoc':
        return (
          <>
            <div className="text-xs">{j.client_spoc_name ?? '—'}</div>
            {/* spocJobId dials the SPOC recorded on THIS job, through the same
                click-to-call flow as the customer number — so a SPOC call is
                logged and auditable exactly like a customer call. */}
            <CallableMobile spocJobId={j.job_id} mobile={j.client_spoc} />
          </>
        );
      case 'source':
        return <span className="text-xs text-muted-foreground">{j.source_type ?? '—'}</span>;
      case 'action':
        return (
          <div className="inline-flex items-center justify-end gap-0.5">
            {canConfirm && key !== 'client_queue' && (
              <IconButton icon={CalendarCheck} intent="default" label="Confirm & schedule" onClick={() => openConfirm(j.job_id)} />
            )}
            {/* Send / re-send the link by hand. Offered wherever a link could
                still help: nothing sent yet, the last one failed, the customer
                has not answered — and on call-only clients, where the cron
                will never send one but an executive may still want to. */}
            {canSendMagicLink && key !== 'client_queue' && key !== 'response_received' && (
              <IconButton
                icon={Send}
                intent="default"
                label={j.magic_link_sent_at ? 'Re-send link' : 'Send link now'}
                onClick={() => setLinkRow(j)}
              />
            )}
            <IconButton icon={Eye} intent="default" label="View details" onClick={() => openView(j.job_id)} />
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <>
    {/* Denser than the shared .data-table, but ONLY here: that utility sets the
        rhythm for every table in the CRM, and the booking queue's rows are two
        short lines where other tables carry one. Arbitrary variants keep the
        override local instead of re-tuning the whole app to fit one screen. */}
    <table className="data-table w-full [&_td]:py-1 [&_th]:py-1.5">
      <thead>
        <tr>
          {cols.map((c) => {
            // Job # is pinned left in every bucket so it stays put while the
            // rest scrolls — it is the one cell a reader navigates by.
            const cls = c === 'job' ? 'stick-col-head stick-left whitespace-nowrap'
              : c === 'action' ? 'stick-col-head stick-right text-right whitespace-nowrap'
                : 'whitespace-nowrap';
            const key = SORT_KEY[c];
            if (key && onSort) {
              return (
                <SortHeader<string> key={c} col={key} sortBy={sortBy ?? null} sortDir={sortDir ?? 'asc'} onSort={onSort} className={cls}>
                  {HEAD[c]}
                </SortHeader>
              );
            }
            return <th key={c} className={cls}>{HEAD[c]}</th>;
          })}
        </tr>
      </thead>
      <tbody>
        {loading && (
          <tr><td colSpan={cols.length} className="py-6 text-center text-xs text-muted-foreground">Loading…</td></tr>
        )}
        {!loading && rows.length === 0 && (
          <tr><td colSpan={cols.length} className="py-6 text-center text-xs text-muted-foreground">No orders in this bucket.</td></tr>
        )}
        {!loading && rows.map((j) => (
          <tr key={j.job_id}>
            {cols.map((c) => (
              <td
                key={c}
                className={c === 'job' ? 'stick-col stick-left whitespace-nowrap'
                  : c === 'action' ? 'stick-col stick-right text-right whitespace-nowrap' : ''}
              >
                {cell(c, j)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    {linkRow && (
      <MagicLinkActionPopup
        open
        onClose={() => setLinkRow(null)}
        jobId={linkRow.job_id}
        magicLinkSentAt={linkRow.magic_link_sent_at ?? null}
        magicLinkSendCount={linkRow.magic_link_send_count ?? 0}
        magicLinkMaxSendCount={linkRow.magic_link_max_send_count ?? 3}
        magicLinkLastAction={linkRow.magic_link_last_action ?? null}
        customerSubmittedAt={linkRow.customer_submitted_at ?? null}
        customerName={linkRow.customer_name}
        customerMobileMasked={linkRow.customer_mob_no ?? '—'}
        userIsAdmin={!!userIsAdmin}
        onSent={() => { setLinkRow(null); onMagicLinkSent?.(); }}
      />
    )}
    </>
  );
}
