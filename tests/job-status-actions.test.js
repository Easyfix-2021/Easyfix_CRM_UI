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
 * `sources` are read off the gate, not guessed, and `gates` quotes that gate
 * from its file (whitespace aside, verbatim). Editing a gate fails the gate
 * test below until someone re-reads it and brings `sources` along.
 *
 * 2026-09-11: the three entries this table used to hold (the Manage Jobs and
 * My Orders row Check-Outs and JobModal's Check Out, all 2/20 → 10) went with
 * the buttons, per ops: Pending to Close on App jobs are closed by the
 * technician from the app (tests/no-crm-checkout.test.js). The coverage test
 * then counted only THEIR call shapes, `quickStatusChange(j.job_id, …)` and
 * `doStatus('…')`. With both gone it compared 0 with an empty table and passed,
 * while the three PATCHes below had never been listed at all. It now counts the
 * URL, which no status change can do without.
 */
const ACTIONS = [
  {
    name: 'JobModal · Cancel',
    file: 'components/job/JobModal.tsx',
    // The footer Cancel: canCancel(s) && isJobCancel && transitionAllowed(…, s, 6).
    gates: [
      ['components/job/JobModal.tsx', 'canCancel(Number(job.job_status)) && footerCan.isJobCancel'],
      ['components/job/JobModal.tsx',
        'const canCancel = (s: number) => [ST.BOOKED, ST.SCHEDULED, ST.IN_PROGRESS, ST.ENQUIRY, ST.REVISIT]'],
    ],
    sources: [0, 1, 2, 7, 10],
    targets: [6],
  },
  {
    name: 'JobModal · Confirm & Schedule',
    file: 'components/job/JobModal.tsx',
    // Confirm mode exists only for an Unconfirmed job (any other status is
    // downgraded to view), and its footer picks Book Call / Enquiry / Unreachable.
    gates: [
      ['components/job/JobModal.tsx', "(mode === 'confirm' && job && Number(job.job_status) !== 9) ? 'view'"],
      ['components/job/JobModal.tsx', "submitVariant === 'enquiry' ? 7 : submitVariant === 'unreachable' ? 9 : 0;"],
    ],
    sources: [9],
    targets: [0, 7, 9],
  },
  {
    name: 'Schedule & Assign · Cancel',
    file: 'components/job/ScheduleAssignModal.tsx',
    // The button itself checks only isJobCancel. The status is fenced where the
    // modal opens: the status-0 row icons below, the Pending for Scheduling tab
    // and the Book New Call hand-off. 1 is the race the modal documents (a
    // technician accepts while it is open, and it stays open).
    gates: [
      ['components/job/ScheduleAssignModal.tsx', "const canCancel = hasAction(me, 'isJobCancel');"],
      ['app/(authed)/jobs/page.tsx', 'j.job_status === 0 && canJob.isJobAssign && transitionAllowed(me?.allowedStages, j.job_status, 1)'],
      ['app/(authed)/my-orders/page.tsx', 'j.job_status === 0 && canJob.isJobAssign && transitionAllowed(me?.allowedStages, j.job_status, 1)'],
    ],
    sources: [0, 1],
    targets: [6],
  },
];

/*
 * PAIRS THE STAGE TABLE CANNOT EXPRESS: recorded here, not waved through.
 * Both involve 7 ENQUIRY, which belongs to no stage (the backend says so in
 * lib/job-stages.js), yet 57,013 QA jobs sat at 7 on 2026-09-11. Only an
 * UNRESTRICTED operator can make either move; transitionAllowed refuses both
 * for every stage-restricted user, client and server alike. That is the split
 * this file warns about, so each line is an open product question (give 7 a
 * stage, or retire the move), not a pass. The first test fails when a line
 * stops disagreeing (delete it) or a new disagreement appears.
 */
const OFF_TABLE = [
  // Hidden from restricted users: the footer Cancel checks transitionAllowed.
  'JobModal · Cancel: 7 → 6',
  // SHOWN to restricted users (canOutcomeButtons is `true`). Their field PATCH
  // lands, then the status PATCH is refused with a 403.
  'JobModal · Confirm & Schedule: 9 → 7',
];

/** The stage that OWNS a status — visibleStatuses are disjoint across stages. */
function stageOf(status) {
  return S.STAGE_KEYS.find((k) => S.STAGES[k].visibleStatuses.includes(status));
}

test('every status-change action targets a status its source stage permits', () => {
  const off = [];
  for (const a of ACTIONS) {
    for (const source of a.sources) {
      for (const target of a.targets) {
        const def = S.STAGES[stageOf(source)];
        const legal = !!def && (def.transitionTargets.includes(target)
          || def.visibleStatuses.includes(target)); // a same-stage move is always legal
        if (!legal) {
          off.push({
            pair: `${a.name}: ${source} → ${target}`,
            why: def ? `stage "${def.key}" permits only [${def.transitionTargets.join(', ')}] `
              + `(plus its own statuses [${def.visibleStatuses.join(', ')}])`
              : `status ${source} belongs to no stage at all`,
          });
        }
      }
    }
  }
  assert.deepEqual(
    off.map((o) => o.pair).sort(), [...OFF_TABLE].sort(),
    `disagreements with the stage table: ${off.map((o) => `${o.pair} (${o.why})`).join('; ') || 'none'}. `
    + 'Either the action is wrong or the stage table is — they cannot both be right. '
    + 'A line in OFF_TABLE that no longer disagrees was fixed: delete it.',
  );
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

test('each ACTIONS entry still matches the gate its sources were read off', () => {
  const squash = (t) => t.replace(/\s+/g, ' ');
  for (const a of ACTIONS) {
    for (const [file, gate] of a.gates) {
      assert.ok(
        squash(fs.readFileSync(path.join(SRC, file), 'utf8')).includes(squash(gate)),
        `${a.name}: this gate is gone from ${file}. Re-read what now fences the action `
        + `and update its sources [${a.sources.join(', ')}] with it: ${gate}`,
      );
    }
  }
});

test('ACTIONS covers every status-change call site in src/', () => {
  /*
   * THE DENOMINATOR. Counted from the URL every status change has to address,
   * `/admin/jobs/${…}/status`: PATCH /admin/jobs/:id/status is the only route
   * that sets a status. The helper around the call can be renamed or deleted;
   * the URL cannot. This used to count two helper call shapes
   * (`quickStatusChange(j.job_id, …)`, `doStatus('…')`), and when the Check Out
   * removal deleted both, it counted 0 against an empty table and passed.
   * Compared per FILE, so a site dropped in one file and added in another
   * cannot cancel out. (A '/status' built by string concatenation would slip
   * past; none exists, and the template literal is the house style.)
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
    const n = (src.match(/`\/admin\/jobs\/\$\{[^}`]+\}\/status[`?]/g) || []).length;
    for (let i = 0; i < n; i += 1) sites.push(path.relative(SRC, f));
  }

  assert.ok(sites.length > 0, 'found no `/admin/jobs/${…}/status` call at all: the matcher is broken, not the code');
  assert.deepEqual(
    sites.sort(), ACTIONS.map((a) => a.file).sort(),
    `found ${sites.length} status-change call site(s) in src/ (${sites.join(', ')}) `
    + `but ACTIONS describes ${ACTIONS.length}. Every one must be listed above with the statuses `
    + 'it can fire from, or this file silently stops covering it — which is exactly how the '
    + '2 → 3 Check-Out bug survived.',
  );
});
