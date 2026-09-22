'use strict';

/*
 * Approve on Client's Behalf — owner-approved design 2026-09-22.
 * ClientApprovalOnBehalfModal.tsx (status 15, isJobMaterialReview-gated)
 * mirrors MaterialReviewModal's shape; POST
 * /admin/jobs/:id/client-approval-on-behalf is being built in parallel
 * against the contract in src/lib/api.ts's approveJobOnClientBehalf.
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 *   1. The pure client-side gates (comment length, file count/size/type,
 *      the status-15 row-action predicate, the reschedule/needs-scheduling
 *      toast choice) drift from the backend contract silently — no compile
 *      error, just a wrong message or a request the server 400s.
 *   2. The "Approve on Client's Behalf" row action's visibility rule
 *      (isJobMaterialReview AND job_status 15) drifts loose on one of the
 *      three lists it was added to (my-orders, jobs, PendingToStartView),
 *      showing the action on a job that isn't Approval Pending, or hiding
 *      it from an operator who holds the permission.
 *   3. The "Needs Scheduling" chip goes missing from one of the three
 *      surfaces it was added to, and ops silently stops seeing jobs that
 *      need a manual Schedule & Assign.
 *   4. 'ClientApprovalProof' stops being a recognised job-document category,
 *      or its label drifts from "Client Approval Proof".
 *
 * Pure bits are exercised directly (imported from the tsc-compiled
 * .test-build, same convention as job-stages.test.js / quotation-groups).
 * The gating/chip invariants are source-scanned like material-review.test.js
 * — these are JSX/gating invariants with no pure function to import for #2/#3
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
  validateApprovalComment, validateApprovalFiles, canApproveOnClientsBehalf, approvalSuccessToast,
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

// ─── canApproveOnClientsBehalf (status 15 AND isJobMaterialReview) ─────────

test('canApproveOnClientsBehalf gates on BOTH job_status === 15 and the permission', () => {
  assert.equal(canApproveOnClientsBehalf(15, true), true);
  assert.equal(canApproveOnClientsBehalf(15, false), false, 'permission missing must block even at 15');
  assert.equal(canApproveOnClientsBehalf(16, true), false, 'status 16 (Material Review, not this action) must not qualify');
  assert.equal(canApproveOnClientsBehalf(1, true), false);
});

// ─── approvalSuccessToast (rescheduled / needs_scheduling / neither) ───────

test('approvalSuccessToast: rescheduled true names the new date/slot and is a success toast', () => {
  const t = approvalSuccessToast({ rescheduled: true, requested_date_time: '2026-09-25 10:00:00', needs_scheduling: false }, '25 Sep 2026, 10:00 AM (Morning)');
  assert.equal(t.variant, 'success');
  assert.match(t.message, /Rescheduled To 25 Sep 2026, 10:00 AM \(Morning\)/);
});

test('approvalSuccessToast: needs_scheduling true (no reschedule) is a warning toast naming the 7-day window', () => {
  const t = approvalSuccessToast({ rescheduled: false, requested_date_time: null, needs_scheduling: true }, '');
  assert.equal(t.variant, 'warning');
  assert.match(t.message, /No Free Slot In The Next 7 Days/);
  assert.match(t.message, /Flagged For Scheduling/);
});

test('approvalSuccessToast: neither flag set is a plain success toast', () => {
  const t = approvalSuccessToast({ rescheduled: false, requested_date_time: null, needs_scheduling: false }, '');
  assert.equal(t.variant, 'success');
  assert.equal(t.message, 'Approved.');
});

test('approvalSuccessToast: rescheduled wins over needs_scheduling if a future backend ever sets both', () => {
  const t = approvalSuccessToast({ rescheduled: true, requested_date_time: '2026-09-25 10:00:00', needs_scheduling: true }, 'X');
  assert.match(t.message, /Rescheduled To X/);
});

// ─── wire contract: api.ts ──────────────────────────────────────────────

test('api.ts posts to the exact contract endpoint with comment + files multipart fields', () => {
  assert.match(apiSrc, /\/admin\/jobs\/\$\{jobId\}\/client-approval-on-behalf/);
  const fnStart = apiSrc.indexOf('approveJobOnClientBehalf:');
  assert.ok(fnStart > -1, 'approveJobOnClientBehalf must be exported from api');
  const fnSrc = apiSrc.slice(fnStart, fnStart + 500);
  assert.match(fnSrc, /fd\.append\('comment', comment\)/);
  assert.match(fnSrc, /fd\.append\('files', f\)/);
});

test("api.ts recognises 'ClientApprovalProof' as a job-document category and labels it", () => {
  assert.match(apiSrc, /'JobSheet' \| 'PurchaseOrder' \| 'ClientApprovalProof'/);
  assert.match(apiSrc, /ClientApprovalProof: 'Client Approval Proof'/);
});

// ─── ClientApprovalOnBehalfModal — self-gate + shared header ───────────────

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

// ─── Needs Scheduling chip — my-orders (both surfaces) + jobs list ─────────

for (const [label, src] of [
  ['my-orders (generic table)', myOrdersSrc],
  ['my-orders Pending to Start (PendingToStartView)', pendingStartSrc],
  ['jobs (Manage Jobs)', jobsSrc],
]) {
  test(`${label}: Needs Scheduling chip renders on needs_scheduling===1 (Number()-normalised), warning tone`, () => {
    const idx = src.indexOf('Number(j.needs_scheduling) === 1');
    assert.ok(idx > -1, `${label} must gate a chip on Number(j.needs_scheduling) === 1`);
    const after = src.slice(idx, idx + 300);
    assert.ok(/tone="warning"/.test(after), `${label}'s chip must use the warning tone`);
    assert.ok(/Needs Scheduling/.test(after), `${label} must render the visible "Needs Scheduling" text`);
  });
}
