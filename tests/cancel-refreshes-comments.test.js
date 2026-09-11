'use strict';
/*
 * A cancel's remark shows up in the job's Comments table without a reload.
 *
 * ─── THE REPORT (2026-09-11) ───────────────────────────────────────────────
 *
 * "Cancelled remarks not added in comments table." They were: the backend's
 * setStatus() writes a tbl_job_comment row on every cancel, and all 8 Prod
 * cancels that day logged "Comment created · id=… · job_id=…". What never
 * happened was a RE-READ — 0 of those 8 were followed by a GET of the job's
 * comments. The Comments tab stays mounted across refresh(), and useFetch only
 * refetches on its key or a refetch() call, so the operator kept looking at
 * the pre-cancel list and concluded the remark was lost.
 *
 * Two holes, both closed here:
 *   · the MOUNTED tab — refetches only when JobModal bumps commentsRefreshKey,
 *     the trigger Add Remarks already uses;
 *   · a tab mounted LATER (confirm → view downgrade, or reopening the job from
 *     My Orders) — useFetch's 30s module cache would hand it the pre-cancel
 *     list, so the key is evicted too.
 *
 * Every mount of the dialog is enumerated, not the two known ones: a third
 * cancel surface added later is exactly where this would come back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx$/.test(e.name) ? [p] : [];
  });
}

/* Every `<CancelWithReasonDialog … />` mount, with its onSubmit body. */
const mounts = walk(SRC_DIR).flatMap((file) => {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/<CancelWithReasonDialog\b[\s\S]*?\n\s*\/>/g)]
    .map((m) => ({ file: path.relative(SRC_DIR, file), body: m[0] }));
});

test('the enumeration finds the cancel surfaces', () => {
  // Silence is the passing signal below, so first prove the scan saw them.
  assert.ok(mounts.length >= 2, `expected JobModal + ScheduleAssignModal, found ${mounts.length}`);
  for (const m of mounts) assert.match(m.body, /status: ST\.CANCELLED/, `${m.file}: not a cancel mount?`);
});

test('every cancel evicts the job\'s cached comments — after the PATCH, not before', () => {
  for (const { file, body } of mounts) {
    const patchAt = body.indexOf('await api.patch(');
    const evictAt = body.search(/invalidateFetch\(\(k\) => k\.startsWith\(`\/admin\/jobs\/\$\{\w+\}\/comments`\)\)/);
    assert.ok(patchAt > -1, `${file}: the PATCH must be in onSubmit`);
    assert.ok(evictAt > -1, `${file}: a cancel must evict /admin/jobs/:id/comments, or the next mount reads the pre-cancel list`);
    // Evicting first would let a refetch race the write and re-cache the old list.
    assert.ok(evictAt > patchAt, `${file}: evict only once the cancel has committed`);
  }
});

test('JobModal also refetches the Comments tab it is showing', () => {
  const jm = mounts.find((m) => m.file === path.join('components', 'job', 'JobModal.tsx'));
  assert.ok(jm, 'JobModal must mount the cancel dialog');
  // invalidateFetch does not reach a mounted useFetch; this key is what does.
  assert.match(jm.body, /setCommentsRefreshKey\(\(k\) => k \+ 1\);/,
    'without the bump the open tab keeps the pre-cancel list — the reported bug');
});
