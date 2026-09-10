/*
 * Job delegation ("share") — the wire shape and the chip vocabulary.
 *
 * ─── WHAT A SHARE IS ──────────────────────────────────────────────────────
 *
 * A technician hands a job he still OWNS to somebody else. `fk_easyfixter_id`
 * never moves, so nothing in the jobs list's own columns changes: the row still
 * reads as assigned to the original technician while a completely different
 * person is doing the work. That is precisely why an operator needs a chip —
 * without it the CRM shows a job "assigned to Ravi" that Ravi is locked out of.
 *
 * While a share is LIVE the original technician is refused every mutating
 * /jobs/ route (409 `{ code: "job_shared" }`) and the delegate gets them
 * instead. So "is there a live share" is not decoration; it is the answer to
 * "why can't this technician start his own job".
 *
 * ─── WHY THE LOGIC IS HERE AND NOT IN THE COMPONENT ───────────────────────
 *
 * `src/lib/*` is what `npm run test:build` compiles, so a rule that lives here
 * gets a real behavioural test rather than a source scanner. The status→tone
 * and status→label decisions are the part worth testing; the JSX around them
 * is one line.
 *
 * No imports: this module is compiled with `--rootDir src/lib`, so reaching
 * into `@/components/**` would break `test:build`. The tone strings below are
 * deliberately a subset of `StatusChipTone` (see components/ui/StatusChip.tsx)
 * — structurally assignable, so call sites type-check without the import.
 */

/*
 * Exact strings shared with EasyFix_Backend and EasyFixer_App. Any spelling
 * drift here silently downgrades a live share to "no chip".
 */
export type JobShareStatus =
  /* LIVE — the lock is on */
  | 'pending'      // shared; the delegate has not answered yet
  | 'accepted'     // delegate accepted; work has not begun
  | 'started'      // delegate began work — the sharer's cancel window is CLOSED
  /* TERMINAL — the lock is off, the job is the original technician's again */
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'completed'
  | 'handed_back'  // delegate marked Can't Complete Today
  | 'released';    // ops force-released it from the CRM

export type JobShare = {
  id: number;
  jobId: number;
  status: JobShareStatus;
  sharedByEfrId: number | null;
  sharedByName: string | null;
  delegateEfrId: number | null;
  delegateName: string | null;
  delegateNumber: string | null;
  createdOn: string | null;
  respondedOn: string | null;
  startedOn: string | null;
  endedOn: string | null;
  endReason: string | null;
  /* Viewer is the sharer AND status is pending|accepted. Technician-app
   * concern; the CRM never renders a cancel, only the ops release. */
  canCancel: boolean;
};

/*
 * The three states in which the job is out of its owner's hands. Everything
 * else is history — the job behaves normally again, so a chip would be noise
 * on a row whose status column already tells the whole story.
 */
export const LIVE_SHARE_STATUSES: readonly JobShareStatus[] = ['pending', 'accepted', 'started'];

export function isShareLive(share: JobShare | null | undefined): boolean {
  return !!share && LIVE_SHARE_STATUSES.indexOf(share.status) !== -1;
}

/*
 * Who the job is actually with. `delegateName` when the delegate is an EasyFix
 * technician (the built path), the bare number for the contact-only path the
 * share row already stores for a later slice. Never "someone" — a chip that
 * cannot name the delegate is exactly the bare "Shared" this replaces.
 */
export function shareDelegateLabel(share: JobShare): string {
  const name = (share.delegateName || '').trim();
  if (name) return name;
  const number = (share.delegateNumber || '').trim();
  if (number) return number;
  return 'Unnamed Delegate';
}

/*
 * Tone follows StatusChip's meaning families, not a per-status palette:
 *   pending  → warning  (work in flight, nobody has picked it up)
 *   accepted → info     (informational / neutral-positive, same as Scheduled)
 *   started  → warning  (someone else is mid-job — the In Progress family)
 * A terminal share resolves to no chip at all.
 */
const TONE: Record<string, 'warning' | 'info'> = {
  pending: 'warning',
  accepted: 'info',
  started: 'warning',
};

/* Title Case, per the estate label rule. `State · Who` in every case so a
 * column of chips scans down the state and across to the name. */
const STATE_LABEL: Record<string, string> = {
  pending: 'Share Pending',
  accepted: 'Share Accepted',
  started: 'Shared · Working',
};

export type ShareChipSpec = {
  tone: 'warning' | 'info';
  label: string;
  /* Native tooltip — the sentence an operator needs before deciding to
   * release, which is more than fits in a pill. */
  title: string;
};

/*
 * The whole chip decision. Returns null for a missing or terminal share so a
 * call site is `const chip = shareChip(j.share)` + `{chip && <StatusChip …>}`.
 */
export function shareChip(share: JobShare | null | undefined): ShareChipSpec | null {
  if (!isShareLive(share)) return null;
  const s = share as JobShare;
  const who = shareDelegateLabel(s);
  const sharer = (s.sharedByName || '').trim();
  const tail = sharer ? ` by ${sharer}` : '';
  const title =
    s.status === 'pending'
      ? `Delegated${tail} to ${who} — not accepted yet. ${sharer || 'The original technician'} cannot work this job while the share is live.`
      : s.status === 'accepted'
        ? `Delegated${tail} to ${who} — accepted, work not started. Still cancellable by the technician.`
        : `${who} is working this job on behalf of ${sharer || 'the assigned technician'}. Past the cancel window — only an ops release ends it.`;
  return { tone: TONE[s.status], label: `${STATE_LABEL[s.status]} · ${who}`, title };
}
