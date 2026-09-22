'use strict';

/*
 * Pure helpers for "Approve on Client's Behalf" (ClientApprovalOnBehalfModal
 * — status 15 "Approval Pending", isJobMaterialReview-gated, mirrors
 * MaterialReviewModal's status-16 review flow). Kept ALIAS-FREE (no `@/...`
 * imports) on purpose: `npm run test:build` compiles a fixed file list
 * (see package.json) with plain `tsc` and no path-mapping, the same
 * constraint quotation-groups.ts already lives under.
 *
 * POST /admin/jobs/:id/client-approval-on-behalf, multipart/form-data:
 *   comment (required, 10..1000 chars), files (1..5, each <=10MB; audio
 *   mp3/m4a/wav/aac/ogg, image jpeg/png/webp/heic, pdf).
 *   Response { job_status: 1, schedule: { rescheduled, requested_date_time,
 *   needs_scheduling } }. 409 "This job is not waiting for client approval"
 *   when not at 15.
 */

export const APPROVAL_COMMENT_MIN = 10;
export const APPROVAL_COMMENT_MAX = 1000;

export const APPROVAL_MAX_FILES = 5;
export const APPROVAL_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// Matches the backend contract exactly: audio mp3/m4a/wav/aac/ogg, image
// jpeg/png/webp/heic, pdf. mp3/m4a in particular arrive under more than one
// MIME string depending on browser/OS, so both are listed.
export const APPROVAL_ALLOWED_MIME = new Set<string>([
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a',
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/aac', 'audio/x-aac',
  'audio/ogg',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf',
]);

/*
 * validateApprovalComment — same 10..1000 char rule the backend enforces,
 * checked client-side first so the operator gets an inline message instead
 * of a round-trip 400. Trimmed length, matching how the modal submits it.
 */
export function validateApprovalComment(comment: string): string | null {
  const len = comment.trim().length;
  if (len < APPROVAL_COMMENT_MIN) {
    return `Comment Must Be At Least ${APPROVAL_COMMENT_MIN} Characters (${len}/${APPROVAL_COMMENT_MIN}).`;
  }
  if (len > APPROVAL_COMMENT_MAX) {
    return `Comment Must Be ${APPROVAL_COMMENT_MAX} Characters Or Fewer.`;
  }
  return null;
}

/*
 * validateApprovalFiles — count (1..5), size (<=10MB each), and MIME type,
 * matching the backend's multer/Joi gate on `files`. Takes plain
 * {name,size,type} rather than the DOM `File` type so this stays importable
 * from a Node test without a browser lib.
 */
export function validateApprovalFiles(
  files: ReadonlyArray<{ name: string; size: number; type: string }>,
): string | null {
  if (files.length < 1) return 'Attach At Least One File.';
  if (files.length > APPROVAL_MAX_FILES) return `Attach At Most ${APPROVAL_MAX_FILES} Files.`;
  for (const f of files) {
    if (f.size > APPROVAL_MAX_FILE_SIZE) return `"${f.name}" Is Larger Than 10 MB.`;
    if (!APPROVAL_ALLOWED_MIME.has(f.type)) {
      return `"${f.name}" Is Not An Accepted Audio, Image, Or PDF File.`;
    }
  }
  return null;
}

/*
 * canApproveOnClientsBehalf — the row-action / modal self-gate predicate:
 * isJobMaterialReview AND job_status === 15 (Estimate/Approval Pending). A
 * pure function (rather than restating the JSX condition at every call
 * site) so the gate is unit-testable directly instead of by source-scan.
 */
export function canApproveOnClientsBehalf(jobStatus: number, canReview: boolean): boolean {
  return canReview && jobStatus === 15;
}

export type ApprovalSchedule = {
  rescheduled: boolean;
  requested_date_time: string | null;
  needs_scheduling: boolean;
};

/*
 * approvalSuccessToast — picks the post-submit toast off the response's
 * `schedule` block. `formattedDateTime` is the caller's own IST-safe
 * "date + slot" rendering (formatDate + displaySlot live behind the
 * `@/lib/...` alias this alias-free module can't import — see header note),
 * so this stays a pure string-in/string-out decision, easy to hit both
 * branches of in a test.
 */
export function approvalSuccessToast(
  schedule: ApprovalSchedule,
  formattedDateTime: string,
): { variant: 'success' | 'warning'; message: string } {
  if (schedule.rescheduled) {
    return { variant: 'success', message: `Approved. Rescheduled To ${formattedDateTime}.` };
  }
  if (schedule.needs_scheduling) {
    return {
      variant: 'warning',
      message: 'Approved. No Free Slot In The Next 7 Days — Flagged For Scheduling.',
    };
  }
  return { variant: 'success', message: 'Approved.' };
}
