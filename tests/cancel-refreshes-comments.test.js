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
 *   · the MOUNTED readers — refetch only when JobModal bumps commentsRefreshKey;
 *   · a reader mounted LATER (confirm → view downgrade, a tab switched to,
 *     reopening the job from My Orders) — useFetch's 30s module cache would
 *     hand it the pre-cancel list, so the key is evicted too.
 *
 * Every mount of the dialog is enumerated, not the two known ones: a third
 * cancel surface added later is exactly where this would come back.
 *
 * ─── SECOND PASS, SAME DAY: THE SHARED STEP ────────────────────────────────
 *
 * The fix above lived in JobModal's CANCEL handler only, while reschedule,
 * check-in and Add Remarks write comment rows too — a reschedule's row stayed
 * missing from the Rescheduling History card on screen beside the button that
 * wrote it. JobModal now does the evict + bump inside refresh(), which every
 * action calls, so its cancel mount no longer carries the eviction INLINE: it
 * reaches it through refresh(). The eviction test below accepts that, and
 * only that — the delegate must itself evict, and it must still run after
 * the PATCH. ScheduleAssignModal's mount is untouched and still evicts inline.
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

const JM = path.join('components', 'job', 'JobModal.tsx');
const JM_SRC = fs.readFileSync(path.join(SRC_DIR, JM), 'utf8');
/* Comments out, so prose that NAMES a call can never satisfy a check for it. */
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const JM_CODE = strip(JM_SRC);
const EVICT = /invalidateFetch\(\(k\) => k\.startsWith\(`\/admin\/jobs\/\$\{\w+\}\/comments`\)\)/;

/* JobModal's `async function refresh() { … }` — the shared step. */
const refreshAt = JM_CODE.indexOf('  async function refresh() {');
const refreshBody = refreshAt > -1 ? JM_CODE.slice(refreshAt, JM_CODE.indexOf('\n  }\n', refreshAt)) : '';

test('the enumeration finds the cancel surfaces', () => {
  // Silence is the passing signal below, so first prove the scan saw them.
  assert.ok(mounts.length >= 2, `expected JobModal + ScheduleAssignModal, found ${mounts.length}`);
  for (const m of mounts) assert.match(m.body, /status: ST\.CANCELLED/, `${m.file}: not a cancel mount?`);
});

test('every cancel evicts the job\'s cached comments — after the PATCH, not before', () => {
  for (const { file, body } of mounts) {
    const patchAt = body.indexOf('await api.patch(');
    assert.ok(patchAt > -1, `${file}: the PATCH must be in onSubmit`);
    // Inline, or (JobModal) through the shared refresh() — see the header.
    const inlineAt = body.search(EVICT);
    const viaRefreshAt = file === JM ? body.search(/\brefresh\(\);/) : -1;
    const evictAt = inlineAt > -1 ? inlineAt : viaRefreshAt;
    assert.ok(evictAt > -1, `${file}: a cancel must evict /admin/jobs/:id/comments, or the next mount reads the pre-cancel list`);
    if (inlineAt === -1) {
      // Delegating to a refresh() that does not evict would just be deleting it.
      assert.match(refreshBody, EVICT, `${file}: its cancel relies on refresh(), so refresh() must evict`);
    }
    // Evicting first would let a refetch race the write and re-cache the old list.
    assert.ok(evictAt > patchAt, `${file}: evict only once the cancel has committed`);
  }
});

test('JobModal re-reads the comment thread in its shared refresh(), not per button', () => {
  assert.ok(refreshBody.length > 0, 'positive control: refresh() must be locatable');
  assert.match(refreshBody, EVICT, 'refresh() must evict, for a reader mounted after it runs');
  // invalidateFetch does not reach a mounted useFetch; this key is what does.
  assert.match(refreshBody, /setCommentsRefreshKey\(\(k\) => k \+ 1\);/,
    'without the bump the open tab keeps the pre-action list — the reported bug');
  // ONE bump site. A second is a per-button copy, and the next button added
  // will be the one without it.
  const bumps = JM_CODE.match(/setCommentsRefreshKey\(/g) || [];
  assert.equal(bumps.length, 1, `only refresh() may bump the key; found ${bumps.length} bump sites`);
  const jm = mounts.find((m) => m.file === JM);
  assert.ok(jm, 'JobModal must mount the cancel dialog');
  assert.match(jm.body, /\brefresh\(\);/, 'the cancel must go through refresh()');
});

test('every mounted reader of the thread in JobModal refetches on the key refresh() bumps', () => {
  // Enumerated from the one thing a reader cannot work without — the GET.
  const hits = [...JM_CODE.matchAll(/useFetch<[^(]*>\(`\/admin\/jobs\/\$\{\w+\}\/comments`\)/g)];
  // JobCommentsTab (Comments tab) + JobRescheduleHistory (Summary). Fewer
  // means the scan stopped finding them, not that they are fine.
  assert.ok(hits.length >= 2, `expected >= 2 comment readers in JobModal, found ${hits.length}`);
  for (const h of hits) {
    const heads = [...JM_CODE.slice(0, h.index).matchAll(/\nfunction (\w+)\(/g)];
    const name = heads.length ? heads[heads.length - 1][1] : null;
    assert.ok(name, 'a reader must live in a named function component');
    const fn = JM_CODE.slice(JM_CODE.lastIndexOf(`\nfunction ${name}(`, h.index), JM_CODE.indexOf('\n}\n', h.index));
    assert.match(fn, /\}, \[refreshKey\]\);/, `${name}: must re-read when refreshKey changes`);
    assert.match(fn, /\brefetch\(\);/, `${name}: via refetch() — invalidateFetch does not reach a mounted useFetch`);
    assert.match(JM_CODE, new RegExp(`<${name}\\b[^>]*\\brefreshKey=\\{commentsRefreshKey\\}`),
      `${name}: its mount must pass the key refresh() bumps`);
  }
});

test('JobRemarksView needs no key: refresh() never runs while JobForm is mounted', () => {
  /*
   * The third reader of the thread renders inside JobForm (Confirm & Schedule).
   * JobForm receives onRefresh but never calls it, and every other refresh()
   * caller — footer, ActionBar, the Cancel / Description / Add Remarks dialogs,
   * ViewBody — renders in view mode only. So there is no mounted JobRemarksView
   * for a bump to reach; refresh()'s eviction covers its next mount. If JobForm
   * starts calling onRefresh this goes red: key its JobRemarksView on
   * commentsRefreshKey in the same change.
   */
  const start = JM_CODE.indexOf('\nfunction JobForm(');
  const form = JM_CODE.slice(start, JM_CODE.indexOf('\nfunction ', start + 1));
  assert.ok(start > -1 && form.includes('<JobRemarksView'), 'positive control: JobRemarksView must mount inside JobForm');
  assert.doesNotMatch(form, /\bonRefresh\s*(\?\.)?\(|=\{onRefresh\}/,
    'JobForm now calls onRefresh — pass commentsRefreshKey down to its JobRemarksView');
});
