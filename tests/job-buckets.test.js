/*
 * Bucket Status ↔ Job Status coupling.
 *
 * THE TWO BUGS (reported 2026-08-18):
 *   1. Job Status offered every status regardless of the chosen bucket, so an
 *      operator could assemble "Closed" + "Booked" — which the backend ANDs
 *      into a guaranteed-empty result with nothing on screen explaining the
 *      emptiness.
 *   2. Clearing Bucket Status left Job Status set, so a narrowing chosen FROM
 *      a bucket's list outlived the bucket, hiding under a filter that now
 *      read "--All--".
 *
 * The derivation is tested here rather than in the page because a page
 * component drags React and the Next runtime into any test that imports it —
 * which is exactly why this rule had no coverage while it lived there.
 *
 * Runner: `node --test` (via `npm test`, which compiles src/lib first).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('../.test-build/job-buckets.js');

const values = (opts) => opts.map((o) => o.value);

test('no bucket → every status, exactly as before', () => {
  assert.deepEqual(values(B.jobStatusOptionsFor('')), values(B.JOB_STATUS_OPTIONS));
  assert.equal(B.jobStatusOptionsFor('').length, 11);
});

test('a bucket narrows the list to its own statuses', () => {
  assert.deepEqual(values(B.jobStatusOptionsFor('closed')), ['3']);       // 5 has no dropdown entry
  assert.deepEqual(values(B.jobStatusOptionsFor('cancelled')), ['6', '7']);
  assert.deepEqual(
    values(B.jobStatusOptionsFor('open')),
    ['0', '1', '2', '9', '10', '15', '20', '21'],
  );
});

test('the contradictory combination is now unconstructable', () => {
  /*
   * The reported bug, stated as the invariant it broke: a status from one
   * bucket must never be offered while a different bucket is selected. That
   * pair ANDs to zero rows on the backend and reads as "the filter is broken".
   */
  for (const [bucket, ids] of Object.entries(B.BUCKET_STATUS_MAP)) {
    for (const opt of B.jobStatusOptionsFor(bucket)) {
      assert.ok(ids.includes(Number(opt.value)),
        `"${opt.label}" is offered under "${bucket}" but is not in that bucket`);
    }
  }
});

test('an unknown bucket falls back to every status, never to none', () => {
  // Fail OPEN: a stale URL param must not present an empty dropdown.
  assert.equal(B.jobStatusOptionsFor('nonsense').length, B.JOB_STATUS_OPTIONS.length);
});

test('the buckets partition without overlap — one status, one bucket', () => {
  /*
   * If a status appeared in two buckets the derived list would be ambiguous
   * and the AND could still produce an empty set. Pins the map's shape, not
   * just the function reading it.
   */
  const seen = new Map();
  for (const [bucket, ids] of Object.entries(B.BUCKET_STATUS_MAP)) {
    for (const id of ids) {
      assert.equal(seen.has(id), false, `status ${id} is in both ${seen.get(id)} and ${bucket}`);
      seen.set(id, bucket);
    }
  }
});

test('every dropdown status belongs to some bucket', () => {
  /*
   * The complement of the test above: a status the dropdown offers but no
   * bucket claims would VANISH the moment any bucket is picked, with no way
   * to reach it. Adding a status to JOB_STATUS_OPTIONS without adding it to
   * BUCKET_STATUS_MAP fails here.
   */
  const all = new Set(Object.values(B.BUCKET_STATUS_MAP).flat());
  for (const o of B.JOB_STATUS_OPTIONS) {
    assert.ok(all.has(Number(o.value)),
      `"${o.label}" (${o.value}) is in the dropdown but in no bucket — it disappears whenever a bucket is set`);
  }
});
