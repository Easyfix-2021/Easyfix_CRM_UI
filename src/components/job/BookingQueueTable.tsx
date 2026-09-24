'use client';

import * as React from 'react';
import { Eye, CalendarCheck, Send } from 'lucide-react';
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
 * ── WHY NOT ONE TABLE FOR ALL SIX ─────────────────────────────────────────
 *
 * The Unconfirmed tab has always shown one 14-column table to every bucket, so
 * most rows carry columns that are structurally empty for them: an order
 * waiting for its first link has no attempts, no delivery failure and no
 * customer answer, and an order sitting with the client has no next call. Ops
 * reads past the blanks to find the two facts that matter. Each bucket is a
 * different question, so each gets the columns that answer it:
 *
 *   new         when will the link go, and where did the order come from
 *   response    WHAT the customer asked for — it decides who picks it up
 *   no_response attempts so far, what the last one was, what today's is
 *   failed      why it failed and the number we hold — usually the fix
 *   no_link     attempts, minus everything about links (call-only client)
 *   client      who owes us something, and for how long
 *
 * Six columns are shared by every bucket (Job #, Age, Client, City,
 * Appointment, Action) so a reader's eye keeps its anchors when switching.
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
};

export type BucketKey =
  | 'new' | 'response_received' | 'no_response' | 'delivery_failed'
  | 'no_link_needed' | 'client_queue'
  | 'response_ready' | 'response_reschedule' | 'response_cancel';

type Col =
  | 'job' | 'age' | 'ticket' | 'client' | 'city' | 'appt' | 'customer' | 'action'
  | 'linkStatus' | 'source' | 'asked' | 'reason' | 'answeredAt'
  | 'attempts' | 'lastAttempt' | 'nextAction'
  | 'whyFailed' | 'mobileOnFile'
  | 'withClient' | 'blocker' | 'spoc' | 'attemptsMade';

/*
 * The column set per bucket. The three Response sub-filters are the same
 * table as their parent tile — a pill narrows the rows, it does not change
 * what a row is.
 */
const COLUMNS: Record<string, Col[]> = {
  new:               ['job', 'age', 'ticket', 'client', 'city', 'appt', 'customer', 'linkStatus', 'source', 'action'],
  response_received: ['job', 'age', 'client', 'city', 'appt', 'asked', 'reason', 'answeredAt', 'customer', 'action'],
  no_response:       ['job', 'age', 'client', 'city', 'appt', 'attempts', 'lastAttempt', 'nextAction', 'customer', 'action'],
  delivery_failed:   ['job', 'age', 'client', 'city', 'appt', 'whyFailed', 'mobileOnFile', 'attempts', 'nextAction', 'action'],
  no_link_needed:    ['job', 'age', 'client', 'city', 'appt', 'attempts', 'lastAttempt', 'nextAction', 'customer', 'action'],
  client_queue:      ['job', 'age', 'withClient', 'client', 'city', 'blocker', 'spoc', 'attemptsMade', 'lastAttempt', 'action'],
};

const HEAD: Record<Col, string> = {
  job: 'Job #', age: 'Age', ticket: 'Ticket created', client: 'Client', city: 'City',
  appt: 'Appointment · Slot', customer: 'Customer', action: 'Action',
  linkStatus: 'Link status', source: 'Source',
  asked: 'Customer asked for', reason: 'Reason', answeredAt: 'Answered at',
  attempts: 'Attempts', lastAttempt: 'Last attempt', nextAction: 'Next action',
  whyFailed: 'Why it failed', mobileOnFile: 'Mobile on file',
  withClient: 'With client', blocker: 'Blocker', spoc: 'Client SPOC', attemptsMade: 'Attempts made',
};

/** Three attempt-days and the order stops being ours. Mirrors the backend. */
const ATTEMPTS_TO_TRANSFER = 3;

/*
 * "Next action" is COMPUTED, never typed by anyone — the handover doc is
 * explicit about that. It is a function of the bucket and the attempts so far,
 * so two operators reading two rows are told the same thing about the same
 * situation.
 */
function nextActionText(bucket: string, attempts: number): string {
  if (bucket === 'new') return 'Link auto-sending';
  const n = attempts + 1;
  if (attempts >= ATTEMPTS_TO_TRANSFER) return 'Transferring to client';
  if (n >= ATTEMPTS_TO_TRANSFER) return 'Final attempt — transfers after this';
  return n === 1 ? 'Call — 1st attempt' : 'Call — 2nd attempt';
}

const KIND_LABEL: Record<string, string> = {
  link: 'WhatsApp link', sms: 'Unreachable SMS', call: 'Call, no answer',
};

/** Days between an IST date string and today — the "with client" clock. */
function daysSince(value?: string | null): number | null {
  if (!value) return null;
  const then = parseIstDateTime(value);
  if (!then) return null;
  const day = 24 * 60 * 60 * 1000;
  const diff = Math.floor((Date.now() - then.getTime()) / day);
  return diff < 0 ? 0 : diff;
}

export function BookingQueueTable({
  rows, loading, bucket, canConfirm, canSendMagicLink, userIsAdmin,
  openView, openConfirm, onMagicLinkSent,
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
}) {
  const key = bucket.startsWith('response') ? 'response_received' : bucket;
  const cols = COLUMNS[key] ?? COLUMNS.no_response;
  /*
   * The popup is controlled and renders ONCE, outside the table — mounting one
   * per row would build a dialog for every order on screen. Null closes it and
   * drops the row state, so the next open re-mounts with fresh props.
   */
  const [linkRow, setLinkRow] = React.useState<BookingQueueRow | null>(null);

  function cell(c: Col, j: BookingQueueRow) {
    const attempts = Number(j.attempts_count ?? 0);
    switch (c) {
      case 'job':
        return (
          <>
            <div className="font-semibold">#{j.job_id}</div>
            {j.client_ref_id && <div className="text-xs text-muted-foreground">{j.client_ref_id}</div>}
          </>
        );
      case 'age':
        return <span title={jobAgeTitle(j)}>{formatJobAge(j)}</span>;
      case 'ticket':
        return <span className="text-xs">{formatDate(j.ticket_created_date_time ?? j.created_date_time)}</span>;
      case 'client':
        return j.client_name ?? '—';
      case 'city':
        return j.city_name ?? '—';
      case 'appt':
        return (
          <>
            <div>{formatDate(j.requested_date_time)}</div>
            {displaySlot(j.requested_date_time, j.time_slot) && (
              <div className="text-xs text-muted-foreground">{displaySlot(j.requested_date_time, j.time_slot)}</div>
            )}
            {/* A reschedule REQUEST does not move the live slot, so the date the
                customer asked for rides underneath it — without this the row
                looks unchanged and somebody re-books the old time. */}
            {j.pending_request_type === 'reschedule' && j.pending_request_preferred_datetime && (
              <div className="text-xs font-semibold text-warning-strong">
                asked: {formatDate(j.pending_request_preferred_datetime)}
              </div>
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
      case 'linkStatus':
        return j.magic_link_sent_at
          ? <StatusChip tone="sky" size="sm">Sent {formatDate(j.magic_link_sent_at)}</StatusChip>
          : <StatusChip tone="slate" size="sm">Queued · next hourly run</StatusChip>;
      case 'source':
        return <span className="text-xs text-muted-foreground">{j.source_type ?? '—'}</span>;
      case 'asked':
        if (j.pending_request_type === 'cancel') return <StatusChip tone="red" size="sm">Cancel</StatusChip>;
        if (j.pending_request_type === 'reschedule') return <StatusChip tone="amber" size="sm">Reschedule</StatusChip>;
        return <StatusChip tone="emerald" size="sm">Ready for SKU</StatusChip>;
      case 'reason':
        return <span className="text-xs text-muted-foreground">{j.pending_request_reason ?? '—'}</span>;
      case 'answeredAt':
        return <span className="text-xs">{j.customer_submitted_at ? formatDate(j.customer_submitted_at) : '—'}</span>;
      case 'attempts':
      case 'attemptsMade':
        return (
          <StatusChip tone={attempts >= ATTEMPTS_TO_TRANSFER ? 'red' : attempts === 2 ? 'amber' : 'slate'} size="sm">
            {attempts} of {ATTEMPTS_TO_TRANSFER}
          </StatusChip>
        );
      case 'lastAttempt':
        return j.last_attempt_at ? (
          <>
            <div className="text-xs">{KIND_LABEL[j.last_attempt_kind ?? ''] ?? '—'}</div>
            <div className="text-xs text-muted-foreground">{formatDate(j.last_attempt_at)}</div>
          </>
        ) : <span className="text-xs text-muted-foreground">—</span>;
      case 'nextAction':
        return <span className="text-xs font-semibold">{nextActionText(key, attempts)}</span>;
      case 'whyFailed':
        return (
          <span className="text-xs text-destructive">
            {j.magic_link_delivery_reason || 'WhatsApp could not deliver this message'}
          </span>
        );
      case 'mobileOnFile':
        return <CallableMobile jobId={j.job_id} mobile={j.customer_mob_no} />;
      case 'withClient': {
        const d = daysSince(j.transferred_at);
        return (
          <StatusChip tone={d !== null && d >= 3 ? 'red' : 'slate'} size="sm">
            {d === null ? '—' : d >= 3 ? 'Day 3+' : `Day ${d}`}
          </StatusChip>
        );
      }
      case 'blocker':
        /* The only blocker the system can state today. The other five from the
           handover doc (PO required, site not ready, entry permission, product
           return, credit hold) are not recorded anywhere yet — showing a
           dropdown of them would be inventing data. */
        return <StatusChip tone="amber" size="sm">Customer unreachable</StatusChip>;
      case 'spoc':
        return (
          <>
            <div className="text-xs">{j.client_spoc_name ?? '—'}</div>
            {j.client_spoc && <div className="text-xs text-muted-foreground">{j.client_spoc}</div>}
          </>
        );
      case 'action':
        return (
          <div className="inline-flex items-center justify-end gap-0.5">
            {/* Confirm & Schedule is where booking AND the Unreachable outcome
                live, so the calling buckets reach both through it rather than
                this table growing its own copy of either. */}
            {canConfirm && key !== 'client_queue' && (
              <IconButton icon={CalendarCheck} intent="default" label="Confirm & schedule" onClick={() => openConfirm(j.job_id)} />
            )}
            {/* Send / re-send the link. Opens the SAME popup the Old view uses
                (cap, override, masked number and all) — this table owns the
                button, never the sending rules. Offered where sending is the
                actual next step: nothing has gone out yet, or the last one
                could not be delivered and somebody has fixed the number. */}
            {canSendMagicLink && (key === 'new' || key === 'delivery_failed') && (
              <IconButton
                icon={Send}
                intent="default"
                label={key === 'new' ? 'Send link now' : 'Re-send link'}
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
    <table className="data-table w-full">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c} className={c === 'action' ? 'text-right whitespace-nowrap' : 'whitespace-nowrap'}>
              {HEAD[c]}
            </th>
          ))}
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
              <td key={c} className={c === 'action' ? 'text-right whitespace-nowrap' : ''}>{cell(c, j)}</td>
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
