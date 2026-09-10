'use strict';
/*
 * Schedule & Assign must not re-derive the server's offer rule.
 *
 * ─── WHAT WENT WRONG (2026-09-10) ──────────────────────────────────────────
 *
 * The modal gated its commit button on `job_status !== 0`, read off a
 * `GET /admin/jobs/:id` probe. The server refused on `job_status !== BOOKED ||
 * fk_easyfixter_id != null`. A gate reading a strict SUBSET of a guard's inputs
 * is not a weaker gate, it is a DIFFERENT one, and the difference is exactly the
 * set of states in which the UI promises an action the server refuses.
 *
 * Production job 534947 sat in that set — BOOKED, but still owned by a legacy
 * direct assignment, a pair no writer in the current backend produces. The modal
 * opened, populated, let the operator pick a technician, and returned 409 "job
 * must be BOOKED and unassigned" on all 16 attempts by two operators, who then
 * gave up and left a comment on the job. Both fields were in the SAME response
 * the gate was already reading.
 *
 * ─── WHY A SOURCE-SHAPE GUARD ──────────────────────────────────────────────
 *
 * The suite mounts nothing (same constraint as offer-caption-regime.test.js).
 * These assertions are therefore about SHAPE, and each one names the specific
 * regression it blocks — a subset gate returning, the fail-open direction
 * inverting, or the bucket refetch being swallowed by the new flag.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODAL = path.join(ROOT, 'src/components/job/ScheduleAssignModal.tsx');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ─── the gate now belongs to the server ───────────────────────────────── */

test('the commit gate reads the server verdict, not a local status comparison', () => {
  const src = read(MODAL);
  assert.match(src, /const canCommit = hasAction\(me, 'isJobAssign'\) && offerable;/,
    'canCommit must be the permission AND the server verdict — nothing else');
  assert.match(src, /const offerable = topData\?\.offerable \?\? /,
    'offerable must come off the candidates payload');
});

test('the old subset gate is GONE, not merely unused', () => {
  /*
   * `statusIneligible` was the identifier that conflated three questions:
   * offerability, bucket staleness, and "this modal is read-only". Leaving it
   * declared invites the next reader to gate something on it again.
   */
  const src = read(MODAL);
  assert.doesNotMatch(src, /statusIneligible/,
    'the conflated gate must not exist at all — it is how the subset rule survived');
});

test('FAIL-OPEN on absence, never on presence', () => {
  /*
   * The direction matters in both places. A `=== true` / `!flag` shape would
   * read a not-yet-arrived payload as "not offerable" and grey the button out
   * on the first paint of every open — the same class of bug as gating on a
   * loading probe, and the reason the original code deliberately did not block
   * while its probe was in flight. A present `false` must still win.
   */
  const src = read(MODAL);
  assert.match(src, /topData\?\.offerable \?\? !notBookedPerProbe/,
    'absence falls back to the old local rule; presence (including false) wins');
  assert.doesNotMatch(src, /topData\?\.offerable === true/,
    'a === true test turns "not loaded yet" into "refused"');
  assert.doesNotMatch(src, /const canCommit[^;]*!topData\?\.offerable/,
    'same inversion, one line further down');
});

test('the BUCKET refetch stays local — it is a claim about the host query', () => {
  /*
   * Two different questions used to share one expression, and collapsing them
   * the other way loses the refetch: a row that is offerable but has left the
   * "Pending for Scheduling" bucket (lib/job-tabs.ts: status 0 AND assigned
   * false) would never signal the host, so the operator re-clicks the same row
   * — the exact loop the effect was written to stop.
   */
  const src = read(MODAL);
  const effect = src.match(/if \(!(\w+) \|\| jobId == null\) return;\s*\n\s*if \(staleBucketRef\.current === jobId\) return;/);
  assert.ok(effect, 'the once-per-job staleBucket effect must still be there');
  assert.equal(effect[1], 'notBookedPerProbe',
    `the effect is keyed on "${effect[1]}"; it must key on the LOCAL probe verdict, not the `
    + 'server offer flag — the server answers "may I offer", not "is this row in your bucket"');
  assert.match(src, /const notBookedPerProbe = probe\?\.job_status != null/,
    'and that verdict must still be derived from the job-detail probe');
});

test('the job-detail probe is IDENTITY-GUARDED before anything reads it', () => {
  /*
   * useFetch retains the previous key's payload (it sets `refreshing`, not
   * `loading`, on a key change) and this modal never unmounts — both hosts
   * render it unconditionally with no `key`, and closing is a query-only
   * router.replace. So an unguarded read answers about the PREVIOUS job for the
   * whole of the next one's request, and this probe is the slowest read on the
   * page (the full getById).
   *
   * The durable half is what makes this a guard and not a nicety: the
   * once-per-job staleBucket effect would fire onChanged() for job B off job A's
   * status AND set staleBucketRef to B, permanently disarming B's own genuine
   * bucket signal for the life of the page. `topData` has carried this guard
   * since it was written; the probe did not.
   */
  const src = read(MODAL);
  assert.match(src, /const probe = statusGate\.data && Number\(statusGate\.data\.job_id\) === Number\(jobId\)/,
    'the probe payload must be checked against the CURRENT jobId, like topData is');
  /*
   * And nothing may BYPASS it. Asserted by removing the guard's own declaration
   * and requiring zero remaining mentions of the raw payload — a count would
   * have to be updated every time the guard is reformatted, and a wrong count is
   * how a check quietly stops testing anything.
   */
  const decl = src.match(/const probe = statusGate\.data && Number\(statusGate\.data\.job_id\) === Number\(jobId\)\n\s*\? statusGate\.data\n\s*: null;/);
  assert.ok(decl, 'the guard declaration must be present in its expected form');
  assert.doesNotMatch(src.replace(decl[0], ''), /statusGate\.data/,
    'a read of statusGate.data outside the guard — it can answer about the previous job');
});

/* ─── the banner may not restate a rule it does not own ────────────────── */

test('the banner no longer asserts the BUCKET as the reason', () => {
  const src = read(MODAL);
  assert.doesNotMatch(src, /only available for booked, unassigned orders/i,
    'that sentence is false now: a booked order WITH a stale owner is offerable — the server '
    + 'releases the owner first. It also described the host list bucket, not the offer rule.');
});

test('the banner is driven by the server reason code', () => {
  const src = read(MODAL);
  assert.match(src, /offerBlockReason === 'not_booked'/,
    'copy must branch on the code the server sent');
  assert.match(src, /const offerBlockReason = topData\?\.offerBlockReason \?\? null;/);
  // A reason the frontend does not recognise must still render something —
  // "unavailable" has more than one cause (past appointment, job-stage
  // transition), so an unmatched code must not fall through to a blank box.
  assert.match(src, /can’t be scheduled or offered right now/,
    'an unknown future reason code needs a fallback sentence');
});

test('offerable is declared AFTER the payload it reads', () => {
  // Plain temporal-dead-zone hygiene: canCommit moved down from the probe block
  // precisely because topData is declared further on. tests/hook-lazy-
  // initialiser-tdz.test.js covers the useState-closure variant; this covers the
  // straight-line one, which is what the move created the risk of.
  const src = read(MODAL);
  const at = (re) => src.search(re);
  const topDataAt = at(/const topData = top\.data &&/);
  const offerableAt = at(/const offerable = topData\?\.offerable/);
  const canCommitAt = at(/const canCommit = hasAction/);
  assert.ok(topDataAt > -1 && offerableAt > -1 && canCommitAt > -1, 'all three must exist');
  assert.ok(topDataAt < offerableAt, 'topData must be declared before offerable reads it');
  assert.ok(offerableAt < canCommitAt, 'offerable before canCommit');
});
