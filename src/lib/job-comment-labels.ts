/*
 * Labels for a tbl_job_comment row — shared by the two places that render the
 * job's remarks thread: JobModal's Comments tab and JobRemarksView (the panel
 * inside Schedule & Assign, Confirm & Schedule and Reassign Technician).
 *
 * They live here rather than in either component because both must answer the
 * same two questions the same way. When only the Comments tab knew how, the
 * Schedule & Assign panel showed a reschedule as an undifferentiated remark —
 * which is the gap this file closes.
 */
import { STAGES as JOB_STAGES, STAGE_KEYS } from '@/lib/job-stages';
import { statusLabel } from '@/lib/utils';

/*
 * "Remarks For" by comment_on — the legacy CRM's own map
 * (EasyFix_CRM jobCommentList.vm:15-28), mirroring the backend's REMARKS_FOR
 * in services/job-comment.service.js. Codes legacy left blank (0, 5, 7, 10)
 * are absent on purpose, so they render empty here too.
 *
 * Used as the FALLBACK for a backend older than the one that sends
 * `remarks_for`, and for an optimistic row that has not been round-tripped
 * yet — so a comment reads the same label before and after the refetch.
 */
export const LEGACY_REMARKS_FOR: Record<number, string> = {
  1: 'Scheduling', 2: 'CheckIn', 3: 'CheckOut', 4: 'Feedback', 6: 'Canceling',
  8: 'TX Reschedule', 9: 'TX cancelled', 15: 'Approval', 16: 'Unconfirmed', 17: 'Inquiry',
  18: 'TX Rejected', 19: 'Escalated', 20: 'Re-Opened Job', 21: 'ReScheduled',
};

/*
 * job_stage (a tbl_job.job_status code) → the BUCKET name.
 *
 * WHY THE BUCKET AND NOT statusLabel(). Ops asks this question in bucket words
 * — "it was rescheduled while it was in Pending to Close". statusLabel() calls
 * statuses 2 and 20 "In Progress", which is right for a status chip and wrong
 * here: the operator would read "In Progress" and not connect it to the tab
 * they were looking at.
 *
 * DERIVED from lib/job-stages, never hand-written — a fourth status map is
 * exactly what the backend's utils/job-status-label.js warns against, and
 * deriving it means this label and the job tabs cannot drift apart.
 *
 * Later keys win, which is what we want for status 15: it appears in
 * 'pending-material' [16, 15] and again in 'estimate-pending' [15], and the
 * single-status bucket is the more precise label for it.
 */
export const STAGE_LABEL_BY_STATUS: Record<number, string> = Object.fromEntries(
  STAGE_KEYS.flatMap((k) => JOB_STAGES[k].visibleStatuses.map((st) => [st, JOB_STAGES[k].label])),
);

/*
 * '' for a row with no recorded stage. Null is "not recorded" — every row
 * written before 2026-09-30 is one — and NOT status 0; rendering those as
 * "Pending for Scheduling" would be inventing history. statusLabel is the
 * fallback for a status no bucket claims (7 Enquiry, for instance), so an
 * unbucketed stage still reads as something.
 */
export function jobStageLabel(code: number | null | undefined): string {
  if (code === null || code === undefined) return '';
  return STAGE_LABEL_BY_STATUS[code] ?? statusLabel(code);
}
