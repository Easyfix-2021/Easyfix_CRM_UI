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
 *   mp3/m4a/wav/aac/ogg, image jpeg/png/webp/heic, pdf), PLUS (owner change,
 *   2026-09-22 — the next visit is never auto-computed, the operator picks
 *   it):
 *     visit_date_time  'YYYY-MM-DD HH:00:00' IST wall clock, one of the free
 *                      hours GET /admin/jobs/:id/visit-slots offered.
 *     permission       'now' | 'later' | 'not_required'.
 *     permission_file  required iff permission === 'now'; pdf/jpeg/png/webp/
 *                      heic, <=10MB (no audio — this is a document, not the
 *                      approval proof).
 *   Response { job_status, visit_date_time, permission: { choice,
 *   request_id } }. 409 "That slot was just booked — pick another" on a slot
 *   race; 409 "This job is not waiting for client approval" when not at 15.
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

export type EntryPermissionChoice = 'now' | 'later' | 'not_required';

/*
 * validateVisitSlot — the day/hour picker is required; there is no
 * auto-computed fallback any more, so an empty pick must block submit.
 * Takes the already-built 'YYYY-MM-DD HH:00:00' string (or null/'' when
 * nothing is chosen yet) rather than the raw date+hour pair, so it can gate
 * the SAME value the modal is about to submit.
 */
export function validateVisitSlot(visitDateTime: string | null): string | null {
  return visitDateTime ? null : 'Pick A Visit Date And Time Slot.';
}

// Entry-permission proof is a DOCUMENT, not audio proof-of-call — no audio
// MIME types here, unlike APPROVAL_ALLOWED_MIME above.
export const PERMISSION_ALLOWED_MIME = new Set<string>([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf',
]);

/*
 * validatePermissionFile — required iff `choice === 'now'`; ignored (never an
 * error) for 'later'/'not_required' even if a stray file object is passed,
 * since the modal only ever builds one for the 'now' branch.
 */
export function validatePermissionFile(
  choice: EntryPermissionChoice,
  file: { name: string; size: number; type: string } | null,
): string | null {
  if (choice !== 'now') return null;
  if (!file) return 'Attach The Entry Permission File.';
  if (file.size > APPROVAL_MAX_FILE_SIZE) return `"${file.name}" Is Larger Than 10 MB.`;
  if (!PERMISSION_ALLOWED_MIME.has(file.type)) {
    return `"${file.name}" Is Not An Accepted PDF Or Image File.`;
  }
  return null;
}

/*
 * buildVisitDateTime — 'YYYY-MM-DD' + hour (9..18) → the exact
 * 'YYYY-MM-DD HH:00:00' IST wall-clock string the backend contract requires.
 * Pure string concatenation, deliberately: no Date object touches this value
 * anywhere in the flow, so it can never be shifted by a timezone.
 */
export function buildVisitDateTime(date: string, hour: number): string {
  return `${date} ${String(hour).padStart(2, '0')}:00:00`;
}

/*
 * approvalSuccessToast — the next visit is always known at submit time now
 * (the operator picked it), so this is a single deterministic message
 * instead of branching on a `schedule` the backend no longer returns.
 * `formattedDate` / `slotLabel` are the caller's own IST-safe rendering of
 * the SAME date/hour the modal just submitted (formatDate + the job-slots
 * hour-frame label live behind the `@/lib/...` alias this alias-free module
 * can't import — see header note).
 */
export function approvalSuccessToast(
  formattedDate: string,
  slotLabel: string,
  result?: { schedule_error?: string | null; permission_error?: string | null } | null,
): { variant: 'success' | 'warning'; message: string } {
  // The approval commits first; the reschedule and the permission request run
  // AFTER it and report failures here instead of failing the approval. Never
  // show plain success over one of them — that is a silent partial failure.
  const problems = [
    result?.schedule_error ? `the visit could not be scheduled (${result.schedule_error}) — reschedule it from Schedule & Assign` : null,
    result?.permission_error ? `the entry permission could not be saved (${result.permission_error})` : null,
  ].filter(Boolean);
  if (problems.length) return { variant: 'warning', message: `Approved, but ${problems.join('; and ')}.` };
  return { variant: 'success', message: `Approved — Visit On ${formattedDate}, ${slotLabel}.` };
}
