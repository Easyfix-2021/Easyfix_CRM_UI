/*
 * Bucket Status — the legacy CRM's 3-way categorical view over job_status
 * (Open / Closed / Cancelled), and the Job Status dropdown derived from it.
 *
 * WHY THESE TWO LIVE TOGETHER. They describe the SAME column at different
 * granularities, and the backend ANDs whatever both filters send. Held apart,
 * a status added to one silently fails to appear in the other — so the map is
 * the single source and the option list is derived from it, not maintained
 * beside it.
 *
 * Lifted out of app/(authed)/jobs/page.tsx (2026-08-18) so the derivation is
 * testable: a page component drags React and the Next runtime into any test
 * that imports it, which is why the rule it encodes had no coverage before.
 */

/*
 * The mapping (rule verified 2026-05-19):
 *   closed    → 3 (COMPLETED), 5 (COMPLETED_ALT)
 *   cancelled → 6 (CANCELLED), 7 (ENQUIRY)
 *   open      → everything else valid (0,1,2,9,10,15,20,21)
 * `open` is the complement, so adding a new active status only requires
 * adding it here.
 */
export const BUCKET_STATUS_MAP: Record<string, number[]> = {
  open:      [0, 1, 2, 9, 10, 15, 20, 21],
  closed:    [3, 5],
  cancelled: [6, 7],
};

export type StatusOption = { value: string; label: string };

/* The full Job Status dropdown, ungated. */
export const JOB_STATUS_OPTIONS: StatusOption[] = [
  { value: '0',  label: 'Booked' },
  { value: '1',  label: 'Scheduled' },
  { value: '2',  label: 'In Progress' },
  { value: '3',  label: 'Completed' },
  { value: '6',  label: 'Cancelled' },
  { value: '7',  label: 'Enquiry' },
  { value: '9',  label: 'Unconfirmed' },
  { value: '10', label: 'Revisit' },
  { value: '15', label: 'Estimate Pending' },
  { value: '20', label: 'Pending to Close' },
  { value: '21', label: 'Followup' },
];

/*
 * Job Status offers ONLY the statuses inside the chosen bucket.
 *
 * Bucket Status and Job Status filter the same column and the backend ANDs
 * them, so "Closed" + "Booked" is a guaranteed-empty result the UI was happy
 * to let an operator assemble, with nothing on screen explaining the emptiness.
 * Narrowing the options makes the contradiction unconstructable rather than
 * merely wrong.
 *
 * No bucket selected → every status, which is the previous behaviour.
 */
export function jobStatusOptionsFor(bucketStatus: string): StatusOption[] {
  const ids = bucketStatus ? BUCKET_STATUS_MAP[bucketStatus] : null;
  if (!ids) return JOB_STATUS_OPTIONS;
  return JOB_STATUS_OPTIONS.filter((o) => ids.includes(Number(o.value)));
}
