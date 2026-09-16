'use strict';

/*
 * Technician app requests on Pending to Start — the invariants that decide
 * whether an operator ever sees the ask.
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 * A technician asking for a job to be cancelled or moved does not change
 * job_status, so without a surface of its own the row would sit among the
 * appointments like any other. The Reschedule request / Cancel request tabs
 * (and the Request column on All) are the ONLY surface in the CRM that answers
 * "who is waiting on me". Four ways it can go wrong, all of them silent —
 * nothing throws, nothing fails to compile, the page just renders a table with
 * the wrong rows in it:
 *
 *   1. the status test is dropped, and every request ops has ALREADY actioned
 *      comes back forever — a request has no "handled" flag of its own, the
 *      status IS the handled flag;
 *   2. the flag test accepts a stringified '0', which is a non-empty string
 *      and therefore truthy in JS — every pending order in the queue becomes a
 *      "request" and the request tabs are noise;
 *   3. a row carrying BOTH flags renders as a reschedule, hiding the fact that
 *      somebody is asking to kill the order;
 *   4. a cancellation acquires a requested-new-appointment line, so the row
 *      claims a time nobody asked for.
 *
 * The predicate lives in `src/lib/job-app-request.ts`, which `npm run
 * test:build` compiles, so these are real behavioural imports. The rendering
 * invariants that cannot be expressed there — that the server partitions the
 * requests into their own tabs, that the Request column shows where request
 * rows can appear, and that its colour pair is theme-correct — live in a .tsx
 * and are source-scanned, the same way resend-pin-action.test.js and
 * job-share.test.js do it.
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
    /* The BE's COALESCE already resolved the winner; the FE's job is only to
     * agree about the KIND, so this is the cancel reason. */
    app_request_reason: 'Self installed by customer',
    cancel_date_time: '2026-05-05 09:12',
    reschedule_date_time_app: '2026-05-06 17:30',
  };
  const req = R.appRequestOf(both);
  assert.equal(req.kind, 'cancel');
  assert.equal(req.reason, 'Self installed by customer');
  assert.equal(req.requestedFor, null,
    'a cancellation proposes no new appointment — the comparison line must not render');
});

test('each kind reads its OWN raised-at stamp', () => {
  const cancel = R.appRequestOf({
    ...plain(),
    is_cancelled_by_app: 1,
    cancel_date_time: '2026-05-05 09:12',
    app_request_reason: 'Self installed by customer',
    /* Present but belonging to the other kind — must not leak across. */
    reschedule_at_app: '2026-04-01 08:00',
    reschedule_date_time_app: '2026-05-06 17:30',
  });
  assert.equal(cancel.raisedAt, '2026-05-05 09:12');
  assert.equal(cancel.reason, 'Self installed by customer');

  const resch = R.appRequestOf({
    ...plain(),
    is_rescheduled_by_app: 1,
    reschedule_at_app: '2026-05-05 14:40',
    app_request_reason: 'Customer want a reschedule',
    reschedule_date_time_app: '2026-05-06 17:30',
    /* The other kind's stamp, present and must not leak into raisedAt. */
    cancel_date_time: '2026-01-01 00:00',
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
    app_request_reason: '   ',
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

/*
 * REWRITTEN 2026-09-16 (tabs replaced the sections). The old test here pinned
 * Technician Requests as the DEFAULT-FIRST reorderable section, because it was
 * the only section waiting on a person and a request raised on a far-off job
 * otherwise sank to the bottom of Future. The equivalent intent now: requests
 * are never buried among appointments at all. The server partitions them into
 * their own two tabs — cancel and reschedule outrank every date state — and
 * the strip (tests/pending-to-start-tabs.test.js) puts those tabs on screen
 * beside the counts, so "who is waiting on me" is one glance, not a scroll.
 */
test('requests are their own tabs — the server partitions them out of the date states', () => {
  const src = view();
  assert.match(src, /ptsState: ptsState \|\| undefined,/,
    'the table must ask the server for the selected state, not narrow rows itself');
  const tabs = strip(read('src/components/job/PendingStartTabs.tsx'));
  const values = [...tabs.matchAll(/\{ value: '([^']*)',/g)].map((m) => m[1]);
  for (const kind of ['cancel', 'reschedule']) {
    assert.ok(values.includes(kind), `the strip must carry the ${kind} state as a tab of its own`);
  }
});

test('the count and the rows come from the SAME predicate — the SERVER\'s', () => {
  /*
   * REWRITTEN 2026-09-16, twice. This first required the section to filter
   * client-side (`items.filter(appRequestOf)`) and to count `matched.length`,
   * because /admin/jobs could not filter on the flags — the 500-row ceiling.
   * Then the predicate moved into SQL (`appRequest`). Now the tabs send
   * `ptsState=cancel|reschedule`, whose priority puts every request row in
   * exactly one of those two tabs — still one predicate, one level down.
   *
   * What has to stay true is the AGREEMENT: appRequestOf() still runs per row
   * to draw the chip and pick the actions, so it must recognise everything the
   * server sent. The cross-repo half of that is asserted in the backend.
   */
  const src = view();
  assert.match(src, /const rows = data\?\.items \?\? \[\];/);
  assert.match(src, /const total = data\?\.total \?\? 0;/,
    'the count is the server\'s total — the same query the rows came from');
  assert.doesNotMatch(src, /items\.filter\(\(j\) => appRequestOf\(j\) !== null\)/,
    're-filtering in the browser is what bounded the old section to 500 rows');
  // The chip still renders through the predicate, once, per row.
  assert.match(src, /const req = appRequestOf\(j\);/);
});

test('the view computes NO date window — the server owns the day boundaries', () => {
  /*
   * The old sections sent dateType/startDate/endDate windows built from
   * istNowWallClock(), and the requests section had to drop them. The server's
   * ptsState now draws every boundary in IST, so none of those params (or the
   * clock they were built from) may creep back into this view: a second,
   * browser-side boundary is how a job lands under Today on the table while the
   * strip counts it as Slots missed.
   */
  const src = view();
  for (const param of ['dateType', 'startDate', 'endDate']) {
    assert.doesNotMatch(src, new RegExp(`\\b${param}:`), `${param} must not be sent — ptsState is the window`);
  }
  assert.doesNotMatch(src, /istNowWallClock/, 'no client-side "today"');
});

test('the attention styling uses a token pair that inverts with the theme', () => {
  const src = view();
  /*
   * The reschedule ask's highlight — scoped to THAT span, not "somewhere in
   * the file" (the old requests header strip, which also carried the pair,
   * went with the sections).
   */
  assert.match(src, /<span className="rounded bg-warning-tint px-1\.5 py-0\.5 text-warning-strong">\s*Requested:/,
    'the requested appointment must use the tint/strong pair StatusChip uses');
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
  assert.match(src, /\{showRequest && <th>Request<\/th>\}/,
    'the request tabs need their own column header');
  assert.match(src, /const showRequest = REQUEST_COLUMN_TABS\.has\(ptsState\);/);
  /*
   * Where request rows can appear: All and the two request tabs. On Slots
   * missed / Today / Future the server has excluded them, and the column would
   * be a stack of dashes.
   */
  const set = src.match(/const REQUEST_COLUMN_TABS: ReadonlySet<PtsState> = new Set<PtsState>\(\[([^\]]*)\]\);/);
  assert.ok(set, 'positive control: REQUEST_COLUMN_TABS must be found');
  assert.deepEqual([...set[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).sort(), ['', 'cancel', 'reschedule'],
    'the Request column shows on All, Reschedule request and Cancel request — and nowhere else');
  assert.match(src, /const colCount = showRequest \? 13 : 12;/,
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

// ─── Reassign Technician: "Reschedule Requested" under Job Date & Time ─────

const reschDetail = (over = {}) => ({
  job_id: 1,
  job_status: 1,
  appRequest: { type: 'reschedule', requestedDateTime: '2026-07-08 10:30', reason: 'Customer Busy', requestedAt: null },
  ...over,
});

test('reschedule row: a Pending to Start ask yields its time VERBATIM and its reason', () => {
  const req = R.pendingRescheduleRequest(reschDetail());
  assert.equal(req.requestedFor, '2026-07-08 10:30',
    'an IST wall-clock string must pass through untouched — no Date round-trip');
  assert.equal(req.reason, 'Customer Busy', 'the reason renders next to the time');
  assert.equal(req.label, 'Reschedule Requested');
  assert.equal(R.pendingRescheduleRequest(reschDetail({ job_status: '1' })).requestedFor, '2026-07-08 10:30');
});

test('reschedule row: gated to Pending to Start, to reschedule asks, and to a real time', () => {
  for (const status of [0, 2, 3, 6, null]) {
    assert.equal(R.pendingRescheduleRequest(reschDetail({ job_status: status })), null,
      `job_status ${status} is not Pending to Start and must render no row`);
  }
  assert.equal(R.pendingRescheduleRequest(reschDetail({ appRequest: { type: 'cancel', requestedDateTime: null } })), null,
    'a cancel ask (which wins over a reschedule server-side) proposes no time');
  assert.equal(R.pendingRescheduleRequest(reschDetail({ appRequest: null })), null, 'no ask ⇒ no row');
  assert.equal(R.pendingRescheduleRequest(reschDetail({ appRequest: { type: 'reschedule', requestedDateTime: '  ' } })), null,
    'a blank requested time must not render an empty "Reschedule Requested" row');
  assert.equal(R.pendingRescheduleRequest(null), null);
});

test('Reassign modal feeds the panel from its detail probe, and re-reads it after a reschedule', () => {
  const modal = strip(read('src/components/job/AssignTechnicianModal.tsx'));
  assert.match(modal, /const rescheduleAsk = pendingRescheduleRequest\(probe\);/,
    'the identity-guarded probe, never raw statusGate.data (a previous job\'s ask would show)');
  assert.match(modal, /rescheduleRequest=\{rescheduleAsk\}/);
  assert.match(modal, /<RescheduleDialog[\s\S]*?\{\.\.\.rescheduleRequestPrefill\(rescheduleAsk, istNowWallClock\(\)\)\}[\s\S]*?\/>/,
    'Reschedule opens pre-filled from the same ask the row shows');
  assert.match(modal, /onDone=\{\(\) => \{[\s\S]*?statusGate\.refetch\(\);[\s\S]*?\}\}/,
    'a reschedule clears the ask server-side; without the re-read the row outlives it');

  const panel = strip(read('src/components/job/JobContextPanel.tsx'));
  const slot = panel.indexOf('displaySlot(job.requested_date_time, job.time_slot)');
  const asked = panel.indexOf('<RescheduleRequestedText request={rescheduleRequest} />');
  const past = panel.indexOf('appointmentIsPast(job.requested_date_time)');
  assert.ok(slot > 0 && asked > slot && past > asked,
    'the ask renders directly under Job Date & Time / Time Slot, above the past-appointment notice');
  assert.match(panel, /\{!rescheduling && rescheduleRequest && \(/, 'renders nothing when there is no ask');
});

test('JobModal Timeline shows the ask right under Time slot, through the SAME renderer', () => {
  const modal = strip(read('src/components/job/JobModal.tsx'));
  const slot = modal.indexOf("['Time slot', displaySlot(job.requested_date_time, job.time_slot) || null],");
  const asked = modal.indexOf("...(rescheduleAsk ? [['Reschedule Requested'");
  const checkin = modal.indexOf("['Check-in',");
  assert.ok(slot > 0 && asked > slot && checkin > asked, 'the row sits between Time slot and Check-in');
  assert.match(modal, /const rescheduleAsk = pendingRescheduleRequest\(\{/, 'gated by the shared status-aware helper');
  assert.match(modal, /<RescheduleRequestedText request=\{rescheduleAsk\} \/>/);
  assert.match(modal, /import \{ RescheduleRequestedText \} from '\.\/RescheduleRequestedText';/);
  assert.match(modal, /<ApptRescheduleDialog\s+open=\{rescheduleOpen\}[\s\S]*?\{\.\.\.rescheduleRequestPrefill\(pendingRescheduleRequest\(\{/,
    'the footer Reschedule pre-fills from the technician\'s ask too');

  const text = strip(read('src/components/job/RescheduleRequestedText.tsx'));
  assert.match(text, /export function RescheduleRequestedText/);
  assert.match(text, /\{request\.reason && <> · Reason: \{request\.reason\}<\/>\}/, 'the reason renders next to the time');
});

const NOW = '2026-07-06T20:30';
const ask = (over = {}) => ({ ...R.pendingRescheduleRequest(reschDetail()), ...over });

test('Reschedule pre-fill: a FUTURE ask seeds the picker value and a remarks line', () => {
  assert.deepEqual(R.rescheduleRequestPrefill(ask(), NOW), {
    initialDateTime: '2026-07-08T10:30',
    initialRemarks: 'Technician requested reschedule: Customer Busy',
  });
  assert.equal(R.rescheduleRequestPrefill(ask({ requestedFor: '2026-07-08 10:30:00' }), NOW).initialDateTime,
    '2026-07-08T10:30', 'a seconds-bearing value (as QA stores) is cut to the picker\'s minute shape');
  assert.equal(R.rescheduleRequestPrefill(ask({ reason: null }), NOW).initialRemarks, 'Technician requested reschedule');
});

test('Reschedule pre-fill: a PAST ask keeps the remarks but never seeds an unsubmittable time', () => {
  assert.deepEqual(R.rescheduleRequestPrefill(ask({ requestedFor: '2026-07-06 20:00' }), NOW),
    { initialRemarks: 'Technician requested reschedule: Customer Busy' },
    'the picker min is IST now and the server refuses the past');
  assert.equal(R.rescheduleRequestPrefill(ask({ requestedFor: '2026-07-06 20:30' }), NOW).initialDateTime,
    '2026-07-06T20:30', 'the current minute is not past — same boundary as appointmentIsPast');
});

test('Reschedule pre-fill: no ask, or a cancel ask, pre-fills nothing', () => {
  assert.deepEqual(R.rescheduleRequestPrefill(null, NOW), {});
  assert.deepEqual(R.rescheduleRequestPrefill({ ...ask(), kind: 'cancel' }, NOW), {});
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
