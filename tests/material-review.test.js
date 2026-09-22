'use strict';

/*
 * Material Review — split out of JobModal's Summary tab into its own
 * MaterialReviewModal + row action (2026-09-21).
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 * Three ways this regresses silently, none of them a compile error:
 *   1. the old MaterialReviewPanel creeps back into JobModal's Summary tab
 *      (a merge, a copy-paste) — the View/Eye icon would stop opening the
 *      plain job viewer every other status gets.
 *   2. the "Appointment / Permission Required" checkbox's visible label is
 *      the ORIGINAL bug this modal fixed: the shared Checkbox only ever
 *      wires `label` to `aria-label`, never to visible text, so a bare
 *      `<Checkbox label="..."/>` with no sibling text renders an unlabelled
 *      box. Source-scanned because it is exactly the kind of thing a
 *      reformat silently undoes.
 *   3. the Material Review row-action icon's visibility rule (job_status 16
 *      AND material_sub_status 2 AND isJobMaterialReview) drifts loose on
 *      one of the two lists it was added to, showing the action on a job
 *      that isn't in Review Pending, or hiding it from an operator who
 *      holds the permission.
 *
 * Source-scanned like job-app-request.test.js / job-share.test.js — these
 * are JSX/gating invariants with no pure function to import and exercise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const jobModalSrc = read('src/components/job/JobModal.tsx');
const reviewModalSrc = read('src/components/job/MaterialReviewModal.tsx');
const myOrdersSrc = read('src/app/(authed)/my-orders/page.tsx');
const jobsSrc = read('src/app/(authed)/jobs/page.tsx');

test('MaterialReviewPanel is gone from JobModal — the Summary tab renders nothing material-review-specific', () => {
  assert.ok(!/MaterialReviewPanel/.test(jobModalSrc),
    'JobModal.tsx must not reference MaterialReviewPanel any more — it moved to MaterialReviewModal.tsx');
});

test('MaterialReviewModal exists, is gated on isJobMaterialReview, and posts the same decision contract', () => {
  assert.ok(/export function MaterialReviewModal/.test(reviewModalSrc));
  assert.ok(/actionFlags\(me, \['isJobMaterialReview'\]\)/.test(reviewModalSrc),
    'must self-gate on the isJobMaterialReview permission, independent of the row action that opens it');
  assert.ok(/\/admin\/jobs\/\$\{jobId\}\/material-review/.test(reviewModalSrc));
  assert.ok(/decision,/.test(reviewModalSrc) && /permission_required,/.test(reviewModalSrc));
});

test('the footer buttons are relabelled Reject Request / Send Request to Client, not the old Reject / Approve', () => {
  assert.ok(/>\s*Reject Request\s*</.test(reviewModalSrc), 'outline button must read "Reject Request"');
  assert.ok(/Send Request to Client/.test(reviewModalSrc), 'primary button must read "Send Request to Client"');
});

test('Send Request to Client confirms first, naming the client contact getting emailed/notified', () => {
  const confirmBlock = reviewModalSrc.slice(
    reviewModalSrc.indexOf("decision === 'approve') {\n      const ok = await confirm("),
  );
  assert.ok(/emailed and notified/i.test(confirmBlock.slice(0, 400)),
    'the pre-send confirm must tell the operator the client contact will be emailed and notified');
});

test('the Appointment / Permission Required checkbox has a VISIBLE label — the bug this modal fixed', () => {
  // The buggy shape (still valid elsewhere in the app, e.g. the per-row
  // Reject checkbox, which has a column header for context): a bare
  // Checkbox whose `label` prop only ever becomes aria-label, with no
  // adjacent visible text. This must NOT be how the permission checkbox
  // renders — it sits under the table with nothing else to name it.
  const start = reviewModalSrc.indexOf('permissionRequired}\n              onChange={setPermissionRequired}');
  assert.ok(start > -1, 'the permission checkbox must be found');
  const around = reviewModalSrc.slice(Math.max(0, start - 200), start + 400);
  assert.ok(/<label[^>]*>/.test(around), 'the checkbox must be wrapped in a <label>');
  assert.ok(/<span>Appointment \/ Permission Required<\/span>/.test(around),
    'a visible <span> naming the checkbox must sit beside it, not just the aria-label prop');
});

/*
 * Row-action gating — checked identically on both lists so the same
 * permission + status/sub-status rule decides whether an operator sees the
 * icon everywhere a Pending-for-Material job can appear.
 */
for (const [label, src] of [['my-orders', myOrdersSrc], ['jobs (Manage Jobs)', jobsSrc]]) {
  test(`${label}: Material Review icon is gated on status 16 AND sub-status 2 (Number()-normalised) AND isJobMaterialReview`, () => {
    const idx = src.indexOf('setMaterialReviewJobId(j.job_id)');
    assert.ok(idx > -1, `${label} must open MaterialReviewModal from a row action`);
    // The gate sits on the JSX line(s) immediately above the onClick — pull a
    // window back far enough to catch the `{cond && (` opener.
    const gate = src.slice(Math.max(0, idx - 400), idx);
    assert.ok(/j\.job_status === 16/.test(gate), 'must gate on job_status === 16');
    assert.ok(/Number\(j\.material_sub_status\) === 2/.test(gate),
      'must normalise material_sub_status with Number() — it is a TINYINT and can arrive as a boolean');
    assert.ok(/canJob\.isJobMaterialReview/.test(gate), 'must gate on the isJobMaterialReview permission');
  });

  test(`${label}: isJobMaterialReview is actually requested from actionFlags (an unrequested key is invisible to every operator)`, () => {
    assert.ok(/actionFlags\(me, \[[\s\S]*?'isJobMaterialReview'[\s\S]*?\]\)/.test(src),
      `${label} must request 'isJobMaterialReview' in its actionFlags(...) call`);
  });
}

test('a successful Reject/Send evicts the shared useFetch cache for /admin/jobs and /admin/quotations', () => {
  assert.ok(/invalidateFetch\(\(k\) => k\.startsWith\('\/admin\/jobs'\) \|\| k\.startsWith\('\/admin\/quotations'\)\)/.test(reviewModalSrc),
    'without this, a mounted useFetch reader (e.g. the Quotations tab) would keep serving pre-review rows for up to 30s');
});
