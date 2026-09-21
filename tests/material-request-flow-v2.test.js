'use strict';

/*
 * Material request flow v2 (2026-09-21, owner-approved design doc
 * EasyFix_Backend/docs/superpowers/specs/2026-09-21-material-request-flow-v2-
 * design.md) — the CRM half.
 *
 * ─── WHAT THIS PINS ─────────────────────────────────────────────────────────
 *
 *   1. JobModal's Materials tab is GONE, folded into Quotations. A stale
 *      `?tab=materials` deep link must fall back to Quotations, not Summary.
 *   2. The Quotations tab reads the BACKEND-derived `state` field (draft /
 *      review_pending / rejected / approval_pending / client_approved /
 *      client_rejected) for both the state chip AND the Approve/Reject gate —
 *      not the pre-v2 `action_on == null` heuristic, which could not tell a
 *      draft from a review_pending line (both have action_on NULL) and would
 *      have offered Approve/Reject on an unsent draft.
 *   3. Add Material is gated on isJobMaterialReview AND the job being in
 *      MATERIAL_ADD_JOB_STATUSES ([1,2,20,16,15] — the spec's CRM lock rule).
 *   4. MaterialReviewModal's review table ignores drafts (state !==
 *      review_pending), gets its OWN Add Material entry point sharing
 *      AddQuotationLineDialog (not a second dialog), and reloads its rows on
 *      a 409 from the review submit instead of just toasting and going stale.
 *   5. The 'pending-material' TAB/STAGE now spans 16 AND 15 (job-stages.ts /
 *      job-buckets.ts / job-tabs.ts), and the Status column on My Orders +
 *      Manage Jobs shows "Review Pending" / "Approval Pending" while ON that
 *      tab specifically — every other tab is unaffected.
 *
 * Source-scanned like job-app-request.test.js / material-review.test.js —
 * these are JSX/gating invariants with no pure function importable from
 * test-build (JobModal.tsx and lib/utils.ts are not part of the tsc test:build
 * target: JobModal.tsx is JSX, and utils.ts pulls in a JSX component
 * (StatusChip) for its tone table, so neither compiles standalone under
 * test:build's plain `--module commonjs` invocation).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const jobModalSrc = read('src/components/job/JobModal.tsx');
const reviewModalSrc = read('src/components/job/MaterialReviewModal.tsx');
const utilsSrc = read('src/lib/utils.ts');
const jobTabsSrc = read('src/lib/job-tabs.ts');
const jobStagesSrc = read('src/lib/job-stages.ts');
const jobBucketsSrc = read('src/lib/job-buckets.ts');
const myOrdersSrc = read('src/app/(authed)/my-orders/page.tsx');
const jobsSrc = read('src/app/(authed)/jobs/page.tsx');

// ─── 1. Materials tab is gone, folded into Quotations ──────────────────────

test('JobModal has no Materials TabsTrigger or Panel any more', () => {
  assert.ok(!/<TabsTrigger value="materials"/.test(jobModalSrc),
    'the Materials tab trigger must be removed — folded into Quotations');
  assert.ok(!/<Panel value="materials"/.test(jobModalSrc),
    'the Materials panel must be removed — folded into Quotations');
  // Positive control: Quotations must still be there, or this whole file is
  // asserting about a tab strip that no longer exists at all.
  assert.ok(/<TabsTrigger value="quotations">Quotations<\/TabsTrigger>/.test(jobModalSrc),
    'positive control: the Quotations tab must still be present');
});

test('a stale ?tab=materials deep link falls back to Quotations, not Summary', () => {
  const idx = jobModalSrc.indexOf("const startingTab = initialTab === 'materials'");
  assert.ok(idx > -1, "the 'materials' fallback branch must be found");
  const around = jobModalSrc.slice(idx, idx + 200);
  assert.match(around, /\?\s*'quotations'/, "'materials' must resolve to 'quotations'");
});

test('the Quotations panel is wired with jobStatus and onJobChanged, not jobId alone', () => {
  const idx = jobModalSrc.indexOf('<JobQuotationsTab');
  assert.ok(idx > -1, 'JobQuotationsTab must be mounted from the Quotations panel');
  const call = jobModalSrc.slice(idx, jobModalSrc.indexOf('/>', idx));
  assert.match(call, /jobStatus=\{Number\(job\.job_status\)\}/,
    'Add Material needs the job status to gate MATERIAL_ADD_JOB_STATUSES');
  assert.match(call, /onJobChanged=\{onRefresh\}/,
    'an Add Material line can move job_status (1/2/20 -> 15) — the parent job must refresh');
});

// ─── 2. State-derived chip + Approve/Reject gate ───────────────────────────

test('QUOTATION_LINE_STATE_META covers exactly the 6 backend states with the spec labels', () => {
  const idx = jobModalSrc.indexOf('const QUOTATION_LINE_STATE_META');
  assert.ok(idx > -1, 'the state->label/tone table must be found');
  const block = jobModalSrc.slice(idx, jobModalSrc.indexOf('};', idx) + 2);
  const expected = {
    draft: 'Draft',
    review_pending: 'Review Pending',
    approval_pending: 'Approval Pending',
    client_approved: 'Approved',
    rejected: 'Rejected',
    client_rejected: 'Client Rejected',
  };
  for (const [state, label] of Object.entries(expected)) {
    const re = new RegExp(`${state}:\\s*\\{\\s*label:\\s*'${label}'`);
    assert.ok(re.test(block), `state '${state}' must map to label '${label}'`);
  }
  // No 7th state quietly added or one of the 6 quietly dropped.
  const keys = [...block.matchAll(/^\s*(\w+):\s*\{ label:/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.keys(expected).sort());
});

test('Approve/Reject are gated on state === review_pending, not the pre-v2 action_on heuristic', () => {
  assert.ok(/const isReviewPending = r\.state === 'review_pending'/.test(jobModalSrc),
    "the gate must read the backend's derived state — a draft (sent_on NULL) and a "
    + 'review_pending line (sent_on set, action_on NULL) both have action_on NULL, '
    + 'so the old `!reviewed` check could not tell them apart');
  // The retired heuristic must not still be driving the button gate.
  assert.ok(!/isPending && can\.isQuotationApprove/.test(jobModalSrc),
    'the old isPending (=!reviewed) gate must be gone from the Approve/Reject cell');
});

// ─── 3. Add Material — gating, dialog, legacy block ────────────────────────

test('MATERIAL_ADD_JOB_STATUSES is exactly the spec lock-table set [1,2,20,16,15]', () => {
  const m = /export const MATERIAL_ADD_JOB_STATUSES: readonly number\[\] = \[([\d,\s]+)\]/.exec(jobModalSrc);
  assert.ok(m, 'MATERIAL_ADD_JOB_STATUSES must be exported');
  const ids = m[1].split(',').map((s) => Number(s.trim()));
  assert.deepEqual(ids, [1, 2, 20, 16, 15]);
});

test('Add Material on the Quotations tab is gated on isJobMaterialReview AND MATERIAL_ADD_JOB_STATUSES', () => {
  assert.ok(/const canAddMaterial = can\.isJobMaterialReview && MATERIAL_ADD_JOB_STATUSES\.includes\(jobStatus\)/.test(jobModalSrc),
    'the button must require both the permission and the job being in an addable status');
  assert.ok(/actionFlags\(me, \['isQuotationApprove', 'isJobMaterialReview'\]\)/.test(jobModalSrc),
    'isJobMaterialReview must actually be requested from actionFlags, or canAddMaterial is silently always false');
});

test('AddQuotationLineDialog is exported (shared, not duplicated) and posts the NEW quotation-lines endpoint', () => {
  assert.ok(/export function AddQuotationLineDialog/.test(jobModalSrc),
    'must be exported so MaterialReviewModal can reuse the SAME dialog');
  assert.ok(/api\.post\(`\/admin\/jobs\/\$\{jobId\}\/quotation-lines`, \{/.test(jobModalSrc));
  assert.ok(/materialId: Number\(materialId\)/.test(jobModalSrc) && /approvedAmount: an/.test(jobModalSrc),
    'body must carry materialId/quantity/approvedAmount per the contract');
});

test('the material search reuses /admin/materials — no second search endpoint invented', () => {
  assert.ok(/`\/admin\/materials\?status=active&limit=20/.test(jobModalSrc),
    'must reuse the same master-material list Settings > Manage Materials searches');
});

test('LegacyMaterialsBlock is read-only and renders nothing with zero rows', () => {
  const idx = jobModalSrc.indexOf('function LegacyMaterialsBlock');
  assert.ok(idx > -1, 'LegacyMaterialsBlock must exist');
  const block = jobModalSrc.slice(idx, jobModalSrc.indexOf('\n}', idx) + 2);
  assert.match(block, /if \(loading \|\| error \|\| items\.length === 0\) return null;/,
    'must render nothing (not even an empty-state card) when there is no legacy history');
  // Read-only: no delete affordance, no POST/DELETE against /admin/aux/materials.
  assert.ok(!/api\.delete\(`\/admin\/aux\/materials/.test(block));
  assert.ok(!/api\.post\('\/admin\/aux\/materials'/.test(block));
});

// ─── 4. MaterialReviewModal — drafts ignored, Add Material, 409 handling ───

test("MaterialReviewModal's review table ignores drafts (state !== review_pending), not action_on alone", () => {
  assert.ok(/String\(r\.type\) === 'material' && r\.state === 'review_pending'/.test(reviewModalSrc),
    'a draft (sent_on NULL) has action_on NULL too — the spec says "drafts are '
    + 'ignored by the review", which the state field encodes and action_on alone cannot');
});

test('MaterialReviewModal shares AddQuotationLineDialog rather than a second dialog', () => {
  assert.ok(/import \{ AddQuotationLineDialog, type QuotationRow \} from '\.\/JobModal';/.test(reviewModalSrc));
  assert.ok(/<AddQuotationLineDialog/.test(reviewModalSrc));
});

test('a 409 from the review submit shows the server message AND reloads the lines', () => {
  const idx = reviewModalSrc.indexOf("} catch (e) {\n      const msg = e instanceof Error");
  assert.ok(idx > -1, 'the submit() catch block must be found');
  const block = reviewModalSrc.slice(idx, idx + 500);
  assert.match(block, /showToast\(\{ variant: 'error', message: msg \}\)/, 'must surface the server message');
  assert.match(block, /e\.status === 409/, 'must distinguish a 409 (new lines arrived) from any other failure');
  assert.match(block, /refetchQuotes\(\)/, 'must reload the rows rather than leave them stale after a 409');
});

// ─── 5. Pending for Material stage now spans [16, 15] ──────────────────────

test("job-stages.ts: 'pending-material' visibleStatuses is [16, 15]", () => {
  assert.ok(/'pending-material':\s*\{ key: 'pending-material',\s*label: 'Pending for Material',\s*visibleStatuses: \[16, 15\]/.test(jobStagesSrc));
});

test("job-buckets.ts: the legacy 'material' stage filter resolves to [16, 15]", () => {
  assert.ok(/material:\s*\[16, 15\]/.test(jobBucketsSrc));
});

test("job-tabs.ts: the 'pending-material' TAB is statuses:[16,15], and 'estimate-pending' still stands alone at 15", () => {
  assert.ok(/\{ value: 'pending-material',\s*label: 'Pending for Material',\s*statuses: \[16, 15\] \}/.test(jobTabsSrc));
  assert.ok(/\{ value: 'estimate-pending',\s*label: 'Estimate Pending',\s*status: 15 \}/.test(jobTabsSrc));
});

test('materialStageStatusLabel: 16 pairs with sub-status 2, 15 stands alone, everything else is null', () => {
  const idx = utilsSrc.indexOf('export function materialStageStatusLabel');
  assert.ok(idx > -1, 'materialStageStatusLabel must be exported from lib/utils.ts');
  const block = utilsSrc.slice(idx, utilsSrc.indexOf('\n}', idx) + 2);
  assert.match(block, /jobStatus === 16 && Number\(materialSubStatus\) === 2\) return 'Review Pending'/);
  assert.match(block, /jobStatus === 15\) return 'Approval Pending'/);
  assert.match(block, /return null;/);
});

for (const [label, src] of [['my-orders', myOrdersSrc], ['jobs (Manage Jobs)', jobsSrc]]) {
  test(`${label}: the Status column uses materialStageStatusLabel only while ON the pending-material tab`, () => {
    assert.ok(/materialStageStatusLabel/.test(src),
      `${label} must import/use materialStageStatusLabel`);
    assert.ok(/tab === 'pending-material' && materialStageStatusLabel\(/.test(src),
      `${label}: the override must be gated on the active tab, or every OTHER tab's `
      + '16/15 rows (e.g. the "all" tab, or a job at 15 under Estimate Pending) would '
      + 'also flip to Review/Approval Pending');
  });

  test(`${label}: the Material Review row-action icon is UNCHANGED — still 16-only, not widened to 15`, () => {
    const idx = src.indexOf('setMaterialReviewJobId(j.job_id)');
    assert.ok(idx > -1, `${label} must still open MaterialReviewModal from a row action`);
    const gate = src.slice(Math.max(0, idx - 400), idx);
    assert.ok(/j\.job_status === 16/.test(gate), 'the review action stays 16-only per the spec');
    assert.ok(!/j\.job_status === 15/.test(gate), 'the review action must NOT be offered at 15 (Approval Pending is client-side, not a CRM review step)');
  });
}
