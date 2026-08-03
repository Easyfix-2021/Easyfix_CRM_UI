'use strict';

/*
 * job-age — the "how long has this ticket been alive" formatter, plus the sort
 * key that talks to the backend.
 *
 * TWO DISTINCT RISKS ARE PINNED HERE, and only one of them is cosmetic.
 *
 * 1. JOB_AGE_SORT_KEY is a CROSS-REPO WIRE STRING. It has to be byte-identical
 *    to a key of SORTABLE_COLUMNS in EasyFix_Backend/services/job.service.js,
 *    because the list validator derives its `sortBy` allow-list from those keys.
 *    An unknown literal is NOT a harmless no-op — Joi rejects it and
 *    GET /admin/jobs 400s the ENTIRE page. It shipped once as 'ageSecs' (the
 *    projection alias, which reads perfectly plausible) and every click on the
 *    Age header blanked the grid, permanently for anyone who had
 *    `?sort=ageSecs:asc` persisted in a bookmarked URL. See wire-contract.test.js
 *    for the fixture that ties this string to the backend's copy.
 *
 * 2. formatJobAge has a fallback path for OLDER BACKEND PAYLOADS (ageSecs
 *    absent). That branch cannot be reached in local dev — it only fires during
 *    a mid-deploy window when the FE is newer than the API — so it is exactly
 *    the kind of code that rots unnoticed. Tested explicitly below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../.test-build/job-age.js');

const DAY = 86_400;
const HOUR = 3_600;
const MIN = 60;

// ─── the cross-repo sort key ──────────────────────────────────────────────

test("JOB_AGE_SORT_KEY is 'age' — the backend's whitelist KEY, not the projection alias", () => {
  assert.equal(A.JOB_AGE_SORT_KEY, 'age');
  assert.notEqual(A.JOB_AGE_SORT_KEY, 'ageSecs', 'the alias that 400s the whole jobs list');
  assert.notEqual(A.JOB_AGE_SORT_KEY, 'ageDays');
});

// ─── formatJobAge: the display contract ───────────────────────────────────

test('formatJobAge renders days with the REMAINDER hours, never the total', () => {
  const cases = [
    [0,                       '<1m'],
    [12,                      '<1m'],
    [59,                      '<1m'],
    [MIN,                     '1m'],
    [12 * MIN,                '12m'],
    [59 * MIN + 59,           '59m'],
    [HOUR,                    '1h'],
    [5 * HOUR,                '5h'],
    [23 * HOUR + 59 * MIN,    '23h'],
    [DAY,                     '1d'],          // clean multiple: no noisy "1d 0h"
    [DAY + 2 * HOUR,          '1d 2h'],       // 26h is "1d 2h", NEVER "1d 26h"
    [2 * DAY,                 '2d'],
    [3 * DAY + HOUR,          '3d 1h'],
    [12 * DAY + 12 * HOUR,    '12d 12h'],
    [365 * DAY,               '365d'],
  ];
  for (const [secs, expected] of cases) {
    assert.equal(A.formatJobAge({ ageSecs: secs }), expected, `${secs}s`);
  }
});

test('formatJobAge derives from ageSecs even when ageDays disagrees', () => {
  /*
   * ageSecs is the precise field and wins. A stale/rounded ageDays riding along
   * must not change the reading, or two rows with identical ages could render
   * differently depending on which fields their payload happened to carry.
   */
  assert.equal(A.formatJobAge({ ageDays: 0, ageSecs: 3 * DAY + HOUR }), '3d 1h');
  assert.equal(A.formatJobAge({ ageDays: 99, ageSecs: 5 * HOUR }), '5h');
});

test('formatJobAge falls back to whole days when an older API omits ageSecs', () => {
  // The mid-deploy window: FE newer than API. Never fabricate an hours part.
  assert.equal(A.formatJobAge({ ageDays: 3 }), '3d');
  assert.equal(A.formatJobAge({ ageDays: 1 }), '1d');
  assert.equal(A.formatJobAge({ ageDays: 0 }), '0d');
});

test('formatJobAge renders an em-dash — never NaN, never a misleading 0', () => {
  for (const row of [{}, { ageDays: null, ageSecs: null }, { ageSecs: '' }, null, undefined, 'garbage', 42]) {
    assert.equal(A.formatJobAge(row), '—', JSON.stringify(row));
  }
  for (const bad of [NaN, Infinity, -Infinity, 'abc']) {
    assert.equal(A.formatJobAge({ ageSecs: bad }), '—', `ageSecs=${String(bad)}`);
  }
});

test('formatJobAge clamps a backdated correction to zero rather than rendering "-3d"', () => {
  assert.equal(A.formatJobAge({ ageSecs: -1 }), '<1m');
  assert.equal(A.formatJobAge({ ageSecs: -5 * DAY }), '<1m');
  assert.equal(A.formatJobAge({ ageDays: -3 }), '0d');
});

test('formatJobAge accepts numeric strings — API payloads are loosely typed', () => {
  assert.equal(A.formatJobAge({ ageSecs: '18000' }), '5h');
  assert.equal(A.formatJobAge({ ageDays: '3' }), '3d');
});

// ─── jobAgeTitle: the hover tooltip ───────────────────────────────────────

test('jobAgeTitle spells out the precision the cell floors away', () => {
  assert.match(A.jobAgeTitle({ ageSecs: 3 * DAY + 4 * HOUR + 12 * MIN }), /^Age: 3d 4h 12m\b/);
  assert.match(A.jobAgeTitle({ ageSecs: 0 }), /^Age: 0d 0h 0m\b/);
});

test('jobAgeTitle explains what the number measures', () => {
  // The definition is not obvious from "3d" alone: it stops at the job's
  // terminal event, so a job completed last year does NOT keep ageing.
  assert.match(A.jobAgeTitle({ ageSecs: DAY }), /ticket created → close, or now if still open/);
  assert.match(A.jobAgeTitle({ ageDays: 2 }), /ticket created → close, or now if still open/);
});

test('jobAgeTitle returns undefined when there is nothing to say', () => {
  // undefined, not '' — so React omits the attribute instead of rendering an
  // empty tooltip that swallows the cursor.
  assert.equal(A.jobAgeTitle({}), undefined);
  assert.equal(A.jobAgeTitle(null), undefined);
});

// ─── consistency between the two renderings ───────────────────────────────

test('the cell and its tooltip never disagree about the day count', () => {
  for (let secs = 0; secs < 8 * DAY; secs += 1_237) {
    const cell = A.formatJobAge({ ageSecs: secs });
    const title = A.jobAgeTitle({ ageSecs: secs });
    const cellDays = /^(\d+)d/.exec(cell);
    if (!cellDays) continue;           // sub-day readings carry no day count
    const titleDays = /^Age: (\d+)d/.exec(title);
    assert.equal(cellDays[1], titleDays[1], `${secs}s → cell ${cell} / title ${title}`);
  }
});
