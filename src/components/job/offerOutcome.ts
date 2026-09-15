import type { JobOffer, OfferOutcome } from '@/lib/api';

/*
 * Status word + colour for one row of GET /admin/jobs/:id/offers, shared by the
 * Schedule & Assign "Offered To" table and the My Orders OfferHoverCard so the
 * two surfaces cannot drift apart.
 *
 * Colour as TEXT, not a chip: inside a table the chip competed with the row's
 * own status pills and made the column read as an action.
 *
 * WHY THIS MOVED OFF offer_status. Both surfaces used to colour 2 rose, 3 slate
 * and everything else amber — so an ACCEPTED offer fell through to amber and
 * read as still pending. Job 540158 went further: the endpoint dropped the
 * ACCEPTED row entirely, and the modal showed only the other technician's
 * closed offer, never the one who took the job. The backend now sends every
 * status plus an `outcome` it derives against who holds the job today.
 *
 *   accepted / assigned   success-strong — the technician holding the job, the
 *                         same green CandidateTable uses for a positive fact.
 *   accepted_released /   ink-500 — they did accept, but the job has since
 *   accepted_reassigned   been released or moved, so the row no longer holds it
 *                         and must not look like the live assignment.
 *   expired / closed      ink-500 — muted: no longer in play.
 *   rejected              urgent-strong, unchanged.
 *   offered               warning-strong, unchanged.
 *
 * The reason wording is NOT copied here: the backend sends outcome_label and
 * outcome_detail and this module only picks a colour. A backend without those
 * fields gets today's offer_status mapping, which is why the fallback below is
 * kept rather than deleted.
 *
 * Record<OfferOutcome, …> so tsc rejects an outcome added to the type without a
 * colour.
 */
const OUTCOME_TEXT: Record<OfferOutcome, string> = {
  offered: 'text-warning-strong',
  accepted: 'text-success-strong',
  assigned: 'text-success-strong',
  accepted_released: 'text-ink-500',
  accepted_reassigned: 'text-ink-500',
  rejected: 'text-urgent-strong',
  expired: 'text-ink-500',
  closed: 'text-ink-500',
};

/*
 * Whether the rows came from a backend that derives `outcome`. It sends the key
 * on every row (null when nothing matched), so absence means an older backend:
 * the CRM ships first, and a backend rollback lands here too. That backend
 * still drops ACCEPTED rows and labels every closed offer EXPIRED, so prose
 * describing the outcome rows (the holder listed first, Expired meaning a
 * timeout) would be false about its data. The Schedule & Assign caption keys on
 * this.
 */
export function offersCarryOutcome(items: readonly JobOffer[] | undefined): boolean {
  return !!items?.some((o) => o.outcome !== undefined);
}

export function offerStatusLabel(o: JobOffer): string | null {
  return o.outcome_label ?? o.offer_status_label ?? null;
}

export function offerStatusTextClass(o: JobOffer): string {
  return (o.outcome && OUTCOME_TEXT[o.outcome])
    || (o.offer_status === 2 ? 'text-urgent-strong' : o.offer_status === 3 ? 'text-ink-500' : 'text-warning-strong');
}

/*
 * The decline quote belongs to a REJECTED outcome, not to a status-2 row: the
 * job's holder can sit on an old REJECTED row (assigned directly afterwards),
 * and quoting their decline under ASSIGNED would contradict the status word.
 * Only a backend without `outcome` falls back to the raw status.
 */
export function showsRejectReason(o: JobOffer): boolean {
  return o.outcome ? o.outcome === 'rejected' : o.offer_status === 2;
}

/*
 * Hover text on an outcome_detail the backend inferred from timing (the offer
 * closed within a second of a sibling's accept) rather than read from a stored
 * reason — so an operator can tell a recorded cause from a deduced one.
 */
export const INFERRED_OUTCOME_TITLE = 'Inferred, not recorded: this offer closed within a second of another technician accepting';
