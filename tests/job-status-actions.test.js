/*
 * EVERY CRM STATUS-CHANGE ACTION MUST BE A LEGAL TRANSITION.
 *
 * THE BUG THIS EXISTS TO CATCH, stated as it happened: the Check-Out control on
 * Manage Jobs and My Orders sent job_status 3 from a job at 2 or 20. The stage
 * table says pending-close (statuses [2, 20]) has exactly three targets —
 * [10, 21, 6] — and 3 is not one of them. The real lifecycle is
 *
 *     2/20 → 10 Under Audit → 3 Pending for Feedback → 5 Completed
 *
 * so the button skipped the Under Audit queue outright.
 *
 * WHY NOTHING CAUGHT IT. Every call site already sat behind
 * `transitionAllowed(me?.allowedStages, source, target)` — and that returns
 * TRUE for an unrestricted operator, which is nearly everyone (a user with no
 * rows in tbl_user_allowed_stages is unrestricted by design). So the guard bit
 * only the handful of stage-restricted users, for whom the button silently
 * disappeared, while for everyone else it performed the forbidden move. A
 * control that is invisible to some users and wrong for the rest reads, from
 * any single account, as working correctly.
 *
 * WHAT THIS FILE PINS. Not the call sites' code — their (source → target)
 * pairs, checked against the stage table itself. The table is the authority and
 * it is mirrored from the backend (tests/job-stages-parity.test.js proves the
 * mirror), so an action that disagrees with it is wrong no matter which file it
 * lives in.
 *
 * THE COVERAGE ASSERTION IS THE LOAD-BEARING PART. A hand-written table of
 * actions has exactly the weakness that let this bug live: it only knows what
 * someone remembered to add. So the last test COUNTS the status-change call
 * sites in src/ and fails if that count and this table disagree — adding a new
 * action without describing it here is a failing build, not a silent gap.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const S = require('../.test-build/job-stages');

const SRC = path.join(__dirname, '..', 'src');

/*
 * Every place the CRM asks the server to change a job's status, with the
 * statuses the surrounding gate actually allows it to fire from.
 *
 * `sources` are read off the gate, not guessed: the row actions are fenced by
 * `j.job_status === 2 || j.job_status === 20`, and JobModal's by
 * `canComplete(s)`, which is `s === ST.IN_PROGRESS`.
 */
const ACTIONS = [
  {
    name: 'Manage Jobs · row Check-Out',
    file: 'app/(authed)/jobs/page.tsx',
    sources: [2, 20],
    target: 10,
  },
  {
    name: 'My Orders · row Check-Out',
    file: 'app/(authed)/my-orders/page.tsx',
    sources: [2, 20],
    target: 10,
  },
  {
    name: 'JobModal · Check Out',
    file: 'components/job/JobModal.tsx',
    sources: [2],
    target: 10,
  },
];

/** The stage that OWNS a status — visibleStatuses are disjoint across stages. */
function stageOf(status) {
  return S.STAGE_KEYS.find((k) => S.STAGES[k].visibleStatuses.includes(status));
}

test('every status-change action targets a status its source stage permits', () => {
  for (const a of ACTIONS) {
    for (const source of a.sources) {
      const stage = stageOf(source);
      assert.ok(stage, `${a.name}: status ${source} belongs to no stage at all`);
      const def = S.STAGES[stage];
      const legal = def.transitionTargets.includes(a.target)
        || def.visibleStatuses.includes(a.target); // a same-stage move is always legal
      assert.ok(
        legal,
        `${a.name} (${a.file}) sends ${source} → ${a.target}, but stage "${stage}" `
        + `permits only [${def.transitionTargets.join(', ')}] `
        + `(plus its own statuses [${def.visibleStatuses.join(', ')}]). `
        + 'Either the action is wrong or the stage table is — they cannot both be right.',
      );
    }
  }
});

test('the old Check-Out target is genuinely refused — the positive control', () => {
  /*
   * Without this, the test above would pass just as happily against a stage
   * table that permitted everything, or a `legal` expression that was always
   * true. This asserts the exact pair that shipped broken.
   */
  const def = S.STAGES[stageOf(2)];
  assert.equal(stageOf(2), 'pending-close');
  assert.ok(
    !def.transitionTargets.includes(3) && !def.visibleStatuses.includes(3),
    'positive control: 2 → 3 must be ILLEGAL, or this file proves nothing',
  );
});

test('a completed job is terminal, which is why Mark InComplete was removed', () => {
  /*
   * Pins the reasoning rather than the deletion. If someone later gives
   * `completed` a target, this test fails and points at the button that should
   * come back — better than a comment nobody re-reads.
   */
  assert.deepEqual(S.STAGES.completed.transitionTargets, [],
    'completed has gained a target — reconsider the Mark InComplete action removed on 2026-09-10');
  assert.ok(!S.STAGES['pending-feedback'].transitionTargets.includes(10),
    'pending-feedback has gained 10 as a target — same reconsideration applies');
});

test('ACTIONS covers every status-change call site in src/', () => {
  /*
   * THE DENOMINATOR. Counted from the two call shapes the CRM uses to change a
   * status: `quickStatusChange(j.job_id, …)` on the list rows and `doStatus(…)`
   * in JobModal. Both are function calls the code cannot work without, not a
   * naming convention — renaming either breaks the app long before it breaks
   * this count.
   */
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  }(SRC));
  assert.ok(files.length > 100, `expected the real src tree; walked only ${files.length} files`);

  const sites = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments — the removal note
      .replace(/^\s*\/\/.*$/gm, ' ');        // line comments
    for (const re of [/quickStatusChange\(\s*j\.job_id\s*,/g, /doStatus\(\s*'/g]) {
      const n = (src.match(re) || []).length;
      for (let i = 0; i < n; i += 1) sites.push(path.relative(SRC, f));
    }
  }

  assert.equal(
    sites.length, ACTIONS.length,
    `found ${sites.length} status-change call site(s) in src/ (${[...new Set(sites)].join(', ')}) `
    + `but ACTIONS describes ${ACTIONS.length}. Every one must be listed above with the statuses `
    + 'it can fire from, or this file silently stops covering it — which is exactly how the '
    + '2 → 3 Check-Out bug survived.',
  );
});
