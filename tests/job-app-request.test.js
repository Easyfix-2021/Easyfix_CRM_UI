'use strict';

/*
 * Technician app requests on Pending to Start — the invariants that decide
 * whether an operator ever sees the ask.
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 * A technician asking for a job to be cancelled or moved does not change
 * job_status, so the row keeps sitting in whichever appointment bucket its
 * CURRENT appointment puts it in. The requests section is the ONLY surface in
 * the CRM that answers "who is waiting on me". Four ways it can go wrong, all
 * of them silent — nothing throws, nothing fails to compile, the page just
 * renders a table with the wrong rows in it:
 *
 *   1. the status test is dropped, and every request ops has ALREADY actioned
 *      comes back forever — the section has no "handled" flag of its own, the
 *      status IS the handled flag;
 *   2. the flag test accepts a stringified '0', which is a non-empty string
 *      and therefore truthy in JS — every pending order in the queue becomes a
 *      "request" and the section is noise;
 *   3. a row carrying BOTH flags renders as a reschedule, hiding the fact that
 *      somebody is asking to kill the order;
 *   4. a cancellation acquires a requested-new-appointment line, so the row
 *      claims a time nobody asked for.
 *
 * The predicate lives in `src/lib/job-app-request.ts`, which `npm run
 * test:build` compiles, so these are real behavioural imports. The rendering
 * invariants that cannot be expressed there — that the section renders FIRST,
 * that it disappears when empty, and that its colour pair is theme-correct —
 * live in a .tsx and are source-scanned, the same way resend-pin-action.test.js
 * and job-share.test.js do it.
 *
 * NOTE ON REGEXES: every pattern below is non-global, or used via `.match()`.
 * A /g regex reused with `.test()` carries `lastIndex` between calls and
 * silently returns false on the next string — a scanner that reports CLEAN
 * because it started halfway through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../.test-build/job-app-request.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/*
 * Comments are stripped before every structural scan below, and this is not a
 * precaution — it is a bug this suite already caught. The view documents the
 * ShareChip call site by QUOTING it verbatim in the prose above the row type,
 * so a scan of the raw source stayed green with the actual `<ShareChip/>`
 * deleted from the table: the explanation was answering for the code. Blocks
 * are blanked rather than deleted (and blanked BEFORE line comments) so
 * nothing merges across a removed span. Proven by the positive control at the
 * end of the file — a stripper that quietly stopped working would put every
 * scan below back to matching prose.
 */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const VIEW = 'src/components/job/PendingToStartView.tsx';
const view = () => strip(read(VIEW));

/* A plain pending order: in the section's population, but not a request. */
const plain = () => ({
  job_id: 1,
  job_status: 1,
  is_cancelled_by_app: 0,
  is_rescheduled_by_app: 0,
  requested_date_time: '2026-05-06 11:00',
});

// ─── The population the predicate runs over ─────────────────────────────
//
// POSITIVE CONTROL FIRST. Every assertion below about a row NOT matching is
// indistinguishable from a predicate that matches nothing at all, so the suite
// starts by proving the matching half actually fires.

test('a pending order with the cancellation flag IS a request', () => {
  const req = R.appRequestOf({ ...plain(), is_cancelled_by_app: 1 });
  assert.ok(req, 'is_cancelled_by_app = 1 on a status-1 row must match');
  assert.equal(req.kind, 'cancel');
});

test('a pending order with the reschedule flag IS a request', () => {
  const req = R.appRequestOf({ ...plain(), is_rescheduled_by_app: 1 });
  assert.ok(req, 'is_rescheduled_by_app = 1 on a status-1 row must match');
  assert.equal(req.kind, 'reschedule');
});

test('a pending order with neither flag is NOT a request', () => {
  assert.equal(R.appRequestOf(plain()), null);
});

// ─── The status test is the handled test ────────────────────────────────

test('an ACTIONED request (job has left status 1) is no longer pending', () => {
  /* A granted cancellation lands on job_status 6. The flag is a sticky audit
   * column and stays 1 forever, so if the status test goes, so does the only
   * thing that ever empties this section. */
  const granted = { ...plain(), job_status: 6, is_cancelled_by_app: 1 };
  assert.equal(R.appRequestOf(granted), null,
    'a cancelled job still carries is_cancelled_by_app = 1 — status 6 is what makes it handled');

  /* Same for every other status a pending order can move to. 2 = In Progress
   * (the technician started it anyway), 3 = Completed. */
  for (const status of [0, 2, 3, 6, 9, 10, 20]) {
    assert.equal(R.appRequestOf({ ...plain(), job_status: status, is_rescheduled_by_app: 1 }), null,
      `job_status ${status} must not be treated as a pending request`);
  }
});

test('the status arrives as a string on some transports and still narrows', () => {
  assert.ok(R.appRequestOf({ ...plain(), job_status: '1', is_cancelled_by_app: 1 }));
  assert.equal(R.appRequestOf({ ...plain(), job_status: '6', is_cancelled_by_app: 1 }), null);
});

// ─── Flag truthiness ────────────────────────────────────────────────────

test('a flag is ON only for an affirmative value', () => {
  for (const on of [1, true, '1']) {
    assert.ok(R.appRequestOf({ ...plain(), is_cancelled_by_app: on }),
      `${JSON.stringify(on)} must read as ON`);
  }
  /* '0' is the one that matters: a non-empty string is truthy in JS, so a
   * bare `if (row.is_cancelled_by_app)` turns the whole queue into requests
   * the moment the value round-trips through a stringifying transport. */
  for (const off of [0, false, '0', '', null, undefined]) {
    assert.equal(R.appRequestOf({ ...plain(), is_cancelled_by_app: off }), null,
      `${JSON.stringify(off)} must read as OFF`);
  }
});

test('a missing row is not a request', () => {
  assert.equal(R.appRequestOf(null), null);
  assert.equal(R.appRequestOf(undefined), null);
  assert.equal(R.appRequestOf({}), null);
});

// ─── Kind discrimination ────────────────────────────────────────────────

test('cancellation outranks reschedule when a row carries BOTH flags', () => {
  /* Both are sticky audit flags: a job rescheduled from the app last week and
   * asked to be cancelled today carries both. Rendering it as a reschedule
   * would hide the request to kill the order. */
  const both = {
    ...plain(),
    is_cancelled_by_app: 1,
    is_rescheduled_by_app: 1,
    cancel_reason_name: 'Self installed by customer',
    cancel_date_time: '2026-05-05 09:12',
    reschedule_reason_name: 'Customer want a reschedule',
    reschedule_date_time_app: '2026-05-06 17:30',
  };
  const req = R.appRequestOf(both);
  assert.equal(req.kind, 'cancel');
  assert.equal(req.reason, 'Self installed by customer');
  assert.equal(req.requestedFor, null,
    'a cancellation proposes no new appointment — the comparison line must not render');
});

test('each kind reads its OWN raised-at stamp and reason', () => {
  const cancel = R.appRequestOf({
    ...plain(),
    is_cancelled_by_app: 1,
    cancel_date_time: '2026-05-05 09:12',
    cancel_reason_name: 'Self installed by customer',
    /* Present but belonging to the other kind — must not leak across. */
    reschedule_at_app: '2026-04-01 08:00',
    reschedule_reason_name: 'Customer want a reschedule',
    reschedule_date_time_app: '2026-05-06 17:30',
  });
  assert.equal(cancel.raisedAt, '2026-05-05 09:12');
  assert.equal(cancel.reason, 'Self installed by customer');

  const resch = R.appRequestOf({
    ...plain(),
    is_rescheduled_by_app: 1,
    reschedule_at_app: '2026-05-05 14:40',
    reschedule_reason_name: 'Customer want a reschedule',
    reschedule_date_time_app: '2026-05-06 17:30',
    cancel_date_time: '2026-01-01 00:00',
    cancel_reason_name: 'Self installed by customer',
  });
  assert.equal(resch.raisedAt, '2026-05-05 14:40');
  assert.equal(resch.reason, 'Customer want a reschedule');
  assert.equal(resch.requestedFor, '2026-05-06 17:30',
    'the requested new appointment is what ops compares against requested_date_time');
});

test('a reschedule with no picked date still renders as a request', () => {
  const req = R.appRequestOf({ ...plain(), is_rescheduled_by_app: 1 });
  assert.ok(req);
  assert.equal(req.requestedFor, null);
  assert.equal(req.reason, null);
  assert.equal(req.raisedAt, null);
});

test('blank strings collapse to null so the UI has ONE falsy case', () => {
  const req = R.appRequestOf({
    ...plain(),
    is_rescheduled_by_app: 1,
    reschedule_reason_name: '   ',
    reschedule_date_time_app: '',
  });
  assert.equal(req.reason, null);
  assert.equal(req.requestedFor, null);
});

// ─── Vocabulary ─────────────────────────────────────────────────────────

test('labels are Title Case and name the ASK, not the state', () => {
  const cancel = R.appRequestOf({ ...plain(), is_cancelled_by_app: 1 });
  const resch = R.appRequestOf({ ...plain(), is_rescheduled_by_app: 1 });
  assert.equal(cancel.label, 'Cancellation Requested');
  assert.equal(resch.label, 'Reschedule Requested');
  for (const label of [cancel.label, resch.label]) {
    for (const word of label.split(' ')) {
      assert.match(word, /^[A-Z]/, `"${label}" must be Title Case (check:brand / label-casing rule)`);
    }
  }
  /* Tones must be StatusChip tone names, or the chip renders unstyled. */
  assert.equal(cancel.tone, 'urgent');
  assert.equal(resch.tone, 'warning');
});

// ─── Rendering invariants (source-scanned) ──────────────────────────────

test('the requests section renders ABOVE Over Due', () => {
  const src = view();
  const requests = src.indexOf('title="Technician Requests"');
  const overDue = src.indexOf('title="Over Due"');
  assert.ok(requests > 0, 'the Technician Requests section must exist');
  assert.ok(overDue > 0, 'the Over Due bucket must still exist');
  assert.ok(requests < overDue,
    'Technician Requests must be rendered before Over Due — it is the only section waiting on a person');
});

test('an empty requests section occupies no space', () => {
  const src = view();
  assert.match(src, /if \(appRequests && total === 0\) return null;/,
    'the requests section must return null when it has no rows, not an empty-state card');
});

test('the count and the rows come from the SAME predicate call', () => {
  const src = view();
  assert.match(src, /items\.filter\(\(j\) => appRequestOf\(j\) !== null\)/,
    'the section must filter through appRequestOf, never re-read the flags inline');
  assert.match(src, /const total = appRequests \? matched\.length/,
    'the header count must be the length of the filtered set, not the server total');
});

test('the requests section sends NO date window', () => {
  const src = view();
  for (const param of ['dateType', 'startDate', 'endDate']) {
    assert.match(src, new RegExp(`${param}: appRequests \\? undefined :`),
      `${param} must be dropped on the requests section — a request is orthogonal to the appointment date`);
  }
});

test('the attention styling uses a token pair that inverts with the theme', () => {
  const src = view();
  assert.match(src, /bg-warning-tint text-warning-strong/,
    'the requests header must use the tint/strong pair StatusChip uses');
  /*
   * `bg-ink-*` with fixed white text is the documented dark-mode trap: the ink
   * ramp inverts, so the surface goes light while the text stays white (1.08
   * contrast). tint/strong swap together and stay legible in both themes.
   */
  assert.doesNotMatch(src, /bg-ink-\d+[^"'`]*text-white/,
    'never pair an ink surface with fixed white text — it inverts in dark mode');
});

test('the Request column has a header, and the skeleton/colSpan agree with it', () => {
  const src = view();
  assert.match(src, /\{appRequests && <th>Request<\/th>\}/,
    'the requests section needs its own column header');
  assert.match(src, /const colCount = appRequests \? 13 : 12;/,
    'the column count must be derived, or the skeleton and empty-state colSpan drift from <thead>');
  assert.doesNotMatch(src, /colSpan=\{12\}/, 'colSpan must use colCount, not a literal');
  assert.doesNotMatch(src, /Array\.from\(\{ length: 12 \}\)/, 'the skeleton must use colCount, not a literal');
});

test('the reschedule ask renders beside the live appointment', () => {
  const src = view();
  const appt = src.indexOf('{j.requested_date_time ? formatDate(j.requested_date_time)');
  const asked = src.indexOf('Requested: {formatDate(req.requestedFor)}');
  assert.ok(appt > 0 && asked > appt,
    'the requested new appointment must sit in the same cell as the current one, so ops can compare them');
});

test('ShareChip is on the pending rows, exactly as the other call sites use it', () => {
  const src = view();
  assert.match(src, /import \{ ShareChip \} from '@\/components\/job\/JobShareControls';/);
  assert.match(src, /<ShareChip share=\{j\.share\} className="ml-1" \/>/,
    'match /my-orders and /jobs verbatim — a delegated job must be identifiable here too');
});

// ─── Control ────────────────────────────────────────────────────────────

test('positive control — the comment stripper actually removes prose', () => {
  /*
   * Every scan above runs against a stripped copy, and a stripper that silently
   * stopped working would start matching the view's explanations instead of its
   * code — which is exactly how the ShareChip assertion above first passed with
   * the component deleted. Proven on a synthetic sample so the control cannot
   * be satisfied by whatever the view happens to contain today.
   */
  const sample = [
    '/* <ShareChip share={j.share} className="ml-1" /> described in prose */',
    'const kept = 1;',
    '// title="Technician Requests"',
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('ShareChip'), 'block comments must go');
  assert.ok(!stripped.includes('Technician Requests'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'code must survive');
  assert.equal(stripped.split('\n').length, sample.split('\n').length,
    'blanking must preserve line count so nothing merges across a removed span');
});
