'use strict';

/*
 * Approve on Client's Behalf — owner-approved design 2026-09-22, REVISED
 * same day: the next visit is never auto-computed any more. Ops picks the
 * day + free 1-hour slot off GET /admin/jobs/:id/visit-slots, plus an entry-
 * permission choice ('now' | 'later' | 'not_required'), alongside the
 * existing comment + proof documents. ClientApprovalOnBehalfModal.tsx
 * (status 15, isJobMaterialReview-gated) mirrors MaterialReviewModal's
 * shape; POST /admin/jobs/:id/client-approval-on-behalf is being built in
 * parallel against the contract in src/lib/api.ts's approveJobOnClientBehalf.
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 *   1. The pure client-side gates (comment length, file count/size/type, the
 *      visit-slot pick, the permission-file requirement, the status-15
 *      row-action predicate, the success-toast wording) drift from the
 *      backend contract silently — no compile error, just a wrong message
 *      or a request the server 400s.
 *   2. The "Approve on Client's Behalf" row action's visibility rule
 *      (isJobMaterialReview AND job_status 15) drifts loose on one of the
 *      three lists it was added to (my-orders, jobs, PendingToStartView),
 *      showing the action on a job that isn't Approval Pending, or hiding
 *      it from an operator who holds the permission.
 *   3. 'ClientApprovalProof' stops being a recognised job-document category,
 *      or its label drifts from "Client Approval Proof".
 *   4. The retired "Needs Scheduling" chip / needs_scheduling field creeps
 *      back onto one of the three list surfaces it was removed from — the
 *      backend contract no longer returns it at all.
 *
 * Pure bits are exercised directly (imported from the tsc-compiled
 * .test-build, same convention as job-stages.test.js / quotation-groups).
 * The gating invariant is source-scanned like material-review.test.js —
 * these are JSX/gating invariants with no pure function to import for #2
 * beyond the shared predicate itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const {
  APPROVAL_COMMENT_MIN, APPROVAL_COMMENT_MAX, APPROVAL_MAX_FILES, APPROVAL_MAX_FILE_SIZE,
  validateApprovalComment, validateApprovalFiles, canApproveOnClientsBehalf,
  validateVisitSlot, validatePermissionFile, buildVisitDateTime, approvalSuccessToast,
} = require('../.test-build/client-approval.js');

const apiSrc = read('src/lib/api.ts');
const modalSrc = read('src/components/job/ClientApprovalOnBehalfModal.tsx');
const myOrdersSrc = read('src/app/(authed)/my-orders/page.tsx');
const jobsSrc = read('src/app/(authed)/jobs/page.tsx');
const pendingStartSrc = read('src/components/job/PendingToStartView.tsx');

// ─── validateApprovalComment (10..1000 chars, trimmed) ─────────────────────

test('validateApprovalComment rejects under the minimum and reports the count', () => {
  assert.match(validateApprovalComment(''), /At Least 10 Characters \(0\/10\)/);
  assert.ok(validateApprovalComment('short')); // 5 chars, still short
  assert.ok(validateApprovalComment('   '), 'whitespace-only must count as 0 chars, not 3');
});

test('validateApprovalComment accepts exactly the boundary lengths', () => {
  assert.equal(validateApprovalComment('a'.repeat(APPROVAL_COMMENT_MIN)), null, '10 chars must pass');
  assert.ok(validateApprovalComment('a'.repeat(APPROVAL_COMMENT_MIN - 1)), '9 chars must fail');
  assert.equal(validateApprovalComment('a'.repeat(APPROVAL_COMMENT_MAX)), null, '1000 chars must pass');
  assert.ok(validateApprovalComment('a'.repeat(APPROVAL_COMMENT_MAX + 1)), '1001 chars must fail');
});

// ─── validateApprovalFiles (1..5, <=10MB, audio/image/pdf) ─────────────────

const mp3 = (name, size) => ({ name, size, type: 'audio/mpeg' });
const jpg = (name, size) => ({ name, size, type: 'image/jpeg' });

test('validateApprovalFiles requires at least one file', () => {
  assert.match(validateApprovalFiles([]), /At Least One File/);
});

test('validateApprovalFiles caps at 5 files', () => {
  const five = Array.from({ length: APPROVAL_MAX_FILES }, (_, i) => jpg(`f${i}.jpg`, 1024));
  assert.equal(validateApprovalFiles(five), null, '5 files must pass');
  const six = [...five, jpg('f6.jpg', 1024)];
  assert.match(validateApprovalFiles(six), /At Most 5 Files/);
});

test('validateApprovalFiles rejects a file over 10MB and names it', () => {
  const err = validateApprovalFiles([mp3('proof.mp3', APPROVAL_MAX_FILE_SIZE + 1)]);
  assert.match(err, /"proof\.mp3"/);
  assert.match(err, /Larger Than 10 MB/);
  assert.equal(validateApprovalFiles([mp3('proof.mp3', APPROVAL_MAX_FILE_SIZE)]), null, 'exactly 10MB must pass');
});

test('validateApprovalFiles rejects a disallowed MIME type', () => {
  const err = validateApprovalFiles([{ name: 'notes.txt', size: 100, type: 'text/plain' }]);
  assert.match(err, /"notes\.txt"/);
  assert.match(err, /Not An Accepted Audio, Image, Or PDF File/);
});

test('validateApprovalFiles accepts one of each contract-listed type', () => {
  const oneEach = [
    mp3('a.mp3', 100), jpg('b.jpg', 100),
    { name: 'c.pdf', size: 100, type: 'application/pdf' },
    { name: 'd.m4a', size: 100, type: 'audio/x-m4a' },
    { name: 'e.heic', size: 100, type: 'image/heic' },
  ];
  assert.equal(validateApprovalFiles(oneEach), null);
});

// ─── buildVisitDateTime (pure string concat — no Date object, ever) ───────

test('buildVisitDateTime produces the exact wire format, zero-padding the hour', () => {
  assert.equal(buildVisitDateTime('2026-09-25', 9), '2026-09-25 09:00:00');
  assert.equal(buildVisitDateTime('2026-09-25', 18), '2026-09-25 18:00:00');
});

// ─── validateVisitSlot (required — no auto-computed fallback any more) ────

test('validateVisitSlot requires a picked slot', () => {
  assert.match(validateVisitSlot(null), /Pick A Visit Date And Time Slot/);
  assert.match(validateVisitSlot(''), /Pick A Visit Date And Time Slot/);
  assert.equal(validateVisitSlot('2026-09-25 09:00:00'), null);
});

// ─── validatePermissionFile (required iff 'now', no audio) ────────────────

test('validatePermissionFile requires a file only when choice is "now"', () => {
  assert.equal(validatePermissionFile('later', null), null, '"later" needs no file');
  assert.equal(validatePermissionFile('not_required', null), null, '"not_required" needs no file');
  assert.match(validatePermissionFile('now', null), /Attach The Entry Permission File/);
});

test('validatePermissionFile enforces size and rejects audio (a document field, not proof-of-call)', () => {
  const pdf = { name: 'permission.pdf', size: 100, type: 'application/pdf' };
  assert.equal(validatePermissionFile('now', pdf), null);
  const tooBig = { name: 'permission.pdf', size: APPROVAL_MAX_FILE_SIZE + 1, type: 'application/pdf' };
  assert.match(validatePermissionFile('now', tooBig), /Larger Than 10 MB/);
  const audio = { name: 'call.mp3', size: 100, type: 'audio/mpeg' };
  assert.match(validatePermissionFile('now', audio), /Not An Accepted PDF Or Image File/);
});

// ─── canApproveOnClientsBehalf (status 15 AND isJobMaterialReview) ─────────

test('canApproveOnClientsBehalf gates on BOTH job_status === 15 and the permission', () => {
  assert.equal(canApproveOnClientsBehalf(15, true), true);
  assert.equal(canApproveOnClientsBehalf(15, false), false, 'permission missing must block even at 15');
  assert.equal(canApproveOnClientsBehalf(16, true), false, 'status 16 (Material Review, not this action) must not qualify');
  assert.equal(canApproveOnClientsBehalf(1, true), false);
});

// ─── approvalSuccessToast (always success — the visit is always known) ────

test('approvalSuccessToast names the picked date and slot and is always a success toast', () => {
  const t = approvalSuccessToast('25 Sep 2026', '10 AM - 11 AM');
  assert.equal(t.variant, 'success');
  assert.match(t.message, /Approved.*25 Sep 2026.*10 AM - 11 AM/);
});

// ─── wire contract: api.ts ──────────────────────────────────────────────

test('api.ts posts to the exact contract endpoint with comment + files + visit/permission multipart fields', () => {
  assert.match(apiSrc, /\/admin\/jobs\/\$\{jobId\}\/client-approval-on-behalf/);
  const fnStart = apiSrc.indexOf('approveJobOnClientBehalf:');
  assert.ok(fnStart > -1, 'approveJobOnClientBehalf must be exported from api');
  const fnSrc = apiSrc.slice(fnStart, fnStart + 800);
  assert.match(fnSrc, /fd\.append\('comment', comment\)/);
  assert.match(fnSrc, /fd\.append\('files', f\)/);
  assert.match(fnSrc, /fd\.append\('visit_date_time', visitDateTime\)/);
  assert.match(fnSrc, /fd\.append\('permission', permission\)/);
  assert.match(fnSrc, /fd\.append\('permission_file', permissionFile\)/);
});

test("api.ts recognises 'ClientApprovalProof' as a job-document category and labels it", () => {
  assert.match(apiSrc, /'JobSheet' \| 'PurchaseOrder' \| 'ClientApprovalProof'/);
  assert.match(apiSrc, /ClientApprovalProof: 'Client Approval Proof'/);
});

test('the retired schedule/needs_scheduling response shape is gone from the api.ts contract', () => {
  assert.ok(!/needs_scheduling/.test(apiSrc), 'needs_scheduling must not remain anywhere in api.ts');
  assert.ok(!/schedule:\s*{/.test(apiSrc), 'the old schedule: {...} response block must be removed');
});

// ─── ClientApprovalOnBehalfModal — self-gate + shared header + new fields ──

test('ClientApprovalOnBehalfModal self-gates on isJobMaterialReview, independent of the row action that opens it', () => {
  assert.ok(/export function ClientApprovalOnBehalfModal/.test(modalSrc));
  assert.ok(/actionFlags\(me, \['isJobMaterialReview'\]\)/.test(modalSrc));
});

test('ClientApprovalOnBehalfModal uses the shared DialogHeader (sidebar tokens), not a hand-rolled band', () => {
  assert.ok(/<DialogHeader>/.test(modalSrc));
});

test('ClientApprovalOnBehalfModal groups lines by quotation_no via the shared helper, filtered to approval_pending', () => {
  assert.ok(/groupByQuotationNo\(approvalRows\)/.test(modalSrc));
  assert.ok(/r\.state === 'approval_pending'/.test(modalSrc));
});

test('ClientApprovalOnBehalfModal fetches visit-slots and renders a Next Visit section', () => {
  assert.match(modalSrc, /\/admin\/jobs\/\$\{jobId\}\/visit-slots/);
  assert.match(modalSrc, /Next Visit/);
});

test('ClientApprovalOnBehalfModal renders all three Entry Permission choices', () => {
  assert.match(modalSrc, /Upload Now/);
  assert.match(modalSrc, /Upload Later/);
  assert.match(modalSrc, /Not Required/);
  assert.match(modalSrc, /The Client Can Upload It From The Client Dashboard/);
});

test('ClientApprovalOnBehalfModal clears the chosen slot and refetches on a 409', () => {
  const idx = modalSrc.indexOf('e.status === 409');
  assert.ok(idx > -1, 'must handle a 409 from the submit call');
  const after = modalSrc.slice(idx, idx + 200);
  assert.match(after, /setVisitHour\(null\)/);
  assert.match(after, /refetchSlots\(\)/);
});

test('ClientApprovalOnBehalfModal has no leftover needs_scheduling / rescheduled plumbing', () => {
  assert.ok(!/needs_scheduling/.test(modalSrc));
  assert.ok(!/\.rescheduled\b/.test(modalSrc));
});

// ─── Row-action gating — identical on both job lists ───────────────────────

for (const [label, src] of [['my-orders', myOrdersSrc], ['jobs (Manage Jobs)', jobsSrc]]) {
  test(`${label}: Approve on Client's Behalf icon is gated by canApproveOnClientsBehalf(job_status, isJobMaterialReview)`, () => {
    const idx = src.indexOf('setClientApprovalJobId(j.job_id)');
    assert.ok(idx > -1, `${label} must open ClientApprovalOnBehalfModal from a row action`);
    const gate = src.slice(Math.max(0, idx - 400), idx);
    assert.ok(/canApproveOnClientsBehalf\(j\.job_status, canJob\.isJobMaterialReview\)/.test(gate),
      'must use the shared pure predicate, not a restated inline condition');
  });
}

// ─── "Needs Scheduling" chip fully retired — my-orders, jobs, PendingToStartView ───

for (const [label, src] of [
  ['my-orders (generic table)', myOrdersSrc],
  ['my-orders Pending to Start (PendingToStartView)', pendingStartSrc],
  ['jobs (Manage Jobs)', jobsSrc],
]) {
  test(`${label}: no needs_scheduling field or "Needs Scheduling" chip remains`, () => {
    assert.ok(!/needs_scheduling/.test(src), `${label} must not reference needs_scheduling any more`);
    assert.ok(!/Needs Scheduling/.test(src), `${label} must not render a "Needs Scheduling" chip any more`);
  });
}
