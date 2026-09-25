'use strict';
/*
 * The "Offered To" caption may not assert an expiry rule that is not in force.
 *
 * ─── 2026-09-10 ────────────────────────────────────────────────────────────
 * Schedule & Assign said, unconditionally: "open offers expire after 30
 * minutes". Production runs `job.offer_expiry.enabled = 'false'`, so nothing
 * times an offer out. An operator looking at job 538177 saw two offers marked
 * EXPIRED after ~22 hours and reasonably concluded the technicians had ignored
 * them; in fact both were closed in the same second by a re-offer, six seconds
 * before a new offer went out.
 *
 * That is a claim about people, not just a wording bug — candidate-ranking
 * scores acceptance from these rows, and `offer_status = 3` is written by nine
 * backend paths of which only one is the 30-minute sweep.
 *
 * ─── 2026-09-25 ────────────────────────────────────────────────────────────
 * The Current/Uplifted switch was removed and Uplifted is the only layout, so
 * the caption this file was written about — the header of Current's "Offered
 * To" section — went with it. THE REQUIREMENT DID NOT GO WITH IT.
 *
 * Uplifted states the same thing in a better place: per offer row, under the
 * status chip, from `closed_reason_label` — so "Expired" is never left alone
 * to imply a technician ignored the job. The assertions below moved to that
 * component. Both halves are still guarded: the unconditional 30-minute
 * sentence must not return anywhere, and the reason must be shown beside the
 * status rather than assumed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODAL = path.join(ROOT, 'src/components/job/ScheduleAssignModal.tsx');
const UPLIFTED = path.join(ROOT, 'src/components/job/ScheduleAssignUplifted.tsx');

test('the caption no longer promises a 30-minute window unconditionally', () => {
  const src = fs.readFileSync(MODAL, 'utf8') + fs.readFileSync(UPLIFTED, 'utf8');
  // The old sentence, in the shape it shipped: plain prose with no guard.
  assert.doesNotMatch(src, /is assigned; open offers expire after 30 minutes\./,
    'the unconditional claim is back — production has expiry OFF, so this sentence is false '
    + 'there and is what made a re-offer look like a technician ignoring the job');
});

test('a closed offer says WHY, so "Expired" never stands alone', () => {
  /*
   * The replacement for the regime-branching caption. Uplifted does not need
   * to state the rule in prose because it shows the actual reason this offer
   * closed, per row — which is stronger: it is the truth about THAT offer
   * rather than a general claim about the setting.
   */
  const src = fs.readFileSync(UPLIFTED, 'utf8');
  assert.match(src, /closed_reason_label/,
    'the reason an offer closed must be rendered, or "Expired" reads as "the technician ignored it"');
  assert.match(src, /\(o\.offer_status \?\? 0\) !== 0 && o\.closed_reason_label/,
    'and only on a CLOSED offer — a waiting one has no reason yet');
});

test('an unknown regime says neither — it does not guess', () => {
  /*
   * A backend that predates the field sends undefined. Defaulting that to
   * either branch would state a rule nobody confirmed: `=== true` and
   * `=== false` are both explicit, so undefined falls through to null.
   */
  const src = fs.readFileSync(MODAL, 'utf8') + fs.readFileSync(UPLIFTED, 'utf8');
  assert.doesNotMatch(src, /offer_expiry_enabled \?\?/,
    'no ?? default — an unknown regime must render no promise at all');
  assert.doesNotMatch(src, /!offers\.data\?\.offer_expiry_enabled/,
    'a bare negation would fold undefined into the "does not time out" branch');
});

test('the response type carries the field', () => {
  const api = fs.readFileSync(path.join(ROOT, 'src/lib/api.ts'), 'utf8');
  const block = api.match(/export type JobOffersResponse = \{[\s\S]*?\n\};/);
  assert.ok(block, 'JobOffersResponse must still exist');
  assert.match(block[0], /offer_expiry_enabled\?: boolean/,
    'optional, so a frontend ahead of the backend still renders');
});
