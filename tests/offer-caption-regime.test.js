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
 * The caption now branches on `offer_expiry_enabled` from
 * GET /admin/jobs/:id/offers. This is a source-shape guard because the suite
 * mounts nothing; it fails if the unconditional sentence returns, or if the
 * branch stops being driven by the backend's regime.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODAL = path.join(ROOT, 'src/components/job/ScheduleAssignModal.tsx');

test('the caption no longer promises a 30-minute window unconditionally', () => {
  const src = fs.readFileSync(MODAL, 'utf8');
  // The old sentence, in the shape it shipped: plain prose with no guard.
  assert.doesNotMatch(src, /is assigned; open offers expire after 30 minutes\./,
    'the unconditional claim is back — production has expiry OFF, so this sentence is false '
    + 'there and is what made a re-offer look like a technician ignoring the job');
});

test('it branches on the backend regime, not on a local constant', () => {
  const src = fs.readFileSync(MODAL, 'utf8');
  assert.match(src, /offers\.data\?\.offer_expiry_enabled === true/,
    'the "expires in 30 minutes" wording must be gated on the BACKEND flag');
  assert.match(src, /offers\.data\?\.offer_expiry_enabled === false/,
    'the "offers do not time out" wording must be gated on the same flag');
});

test('an unknown regime says neither — it does not guess', () => {
  /*
   * A backend that predates the field sends undefined. Defaulting that to
   * either branch would state a rule nobody confirmed: `=== true` and
   * `=== false` are both explicit, so undefined falls through to null.
   */
  const src = fs.readFileSync(MODAL, 'utf8');
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
