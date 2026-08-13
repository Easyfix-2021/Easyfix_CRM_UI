'use strict';

/*
 * call-legs — the browser-side rules that keep a conference reading as ONE call.
 *
 * Two things in this module have real consequences, and they are what this file
 * is mostly about.
 *
 * ─── 1. groupCallRows, the fan-out guard ─────────────────────────────────
 *
 * `GET /api/admin/calls` INNER JOINs tbl_job_caller_info to tbl_plivo_call_log
 * on `job_caller_info_id`, which is a plain KEY and NOT UNIQUE. A conference
 * writes one log row per person, so the join fans out: three rows carrying the
 * SAME call id, every call-level column duplicated verbatim. Rendered raw, the
 * operator sees three calls where there was one — the exact failure this
 * feature was asked to avoid — plus three duplicate React keys.
 *
 * The tests below pin the properties that make the collapse safe: idempotence
 * (a collapsed response must survive untouched), order preservation (a call log
 * is read chronologically), and leg de-duplication (a merge must not list the
 * same person twice).
 *
 * ─── 2. The status vocabulary is the DATABASE'S ──────────────────────────
 *
 * A conference leg is stored in `tbl_plivo_call_log.status`, so it speaks that
 * table's words — `answered`, not `joined`. The literal-value assertions here
 * are a cross-repo tripwire: they fail loudly if someone "tidies" the values
 * into conference vocabulary, which would silently break every leg chip
 * (`callLegStatusLabel` degrades to 'Unknown' rather than throwing) AND every
 * `active` check on the live panel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../.test-build/call-legs.js');

/* ─── helpers ───────────────────────────────────────────────────────────── */

function leg(id, target_kind, over) {
  return Object.assign({ id, target_kind, status: 'completed' }, over || {});
}

/* ─── status vocabulary ─────────────────────────────────────────────────── */

test('CALL_LEG_STATUS values are the call-log words, not conference words', () => {
  // Mirrors EasyFix_Backend/services/plivo-call-log.service.js → LEG_STATUS.
  assert.equal(L.CALL_LEG_STATUS.DIALLING, 'initiated');
  assert.equal(L.CALL_LEG_STATUS.RINGING, 'ringing');
  assert.equal(L.CALL_LEG_STATUS.JOINED, 'answered');
  assert.equal(L.CALL_LEG_STATUS.LEFT, 'completed');
  assert.equal(L.CALL_LEG_STATUS.NO_ANSWER, 'no_answer');
  assert.equal(L.CALL_LEG_STATUS.FAILED, 'failed');
});

test('LEFT and REMOVED collapse to one value — the DB cannot tell them apart', () => {
  /*
   * Both are 'completed'. The call log records that the leg ended, not WHY, so
   * a UI distinction between "hung up" and "was dropped" would be invented.
   */
  assert.equal(L.CALL_LEG_STATUS.REMOVED, L.CALL_LEG_STATUS.LEFT);
});

test('the ACTIVE set is exactly the three still-on-the-call statuses', () => {
  assert.deepEqual([...L.ACTIVE_CALL_LEG_STATUSES], ['initiated', 'ringing', 'answered']);
  assert.equal(L.isActiveCallLegStatus('answered'), true);
  assert.equal(L.isActiveCallLegStatus('completed'), false);
  // The pre-rework words must NOT read as active — if the BE ever regressed to
  // them, a stale leg would sit lit on the panel forever.
  assert.equal(L.isActiveCallLegStatus('joined'), false);
  assert.equal(L.isActiveCallLegStatus(null), false);
});

test('an unknown status degrades to a readable chip rather than blank', () => {
  assert.equal(L.callLegStatusLabel('answered'), 'On Call');
  assert.equal(L.callLegStatusLabel('who_knows'), 'Unknown');
  assert.equal(L.callLegStatusLabel(undefined), 'Unknown');
  assert.equal(L.callLegStatusTone('who_knows'), 'slate');
});

/* ─── role labels + tones ───────────────────────────────────────────────── */

test('operator is "Ops Agent" in the shared map — "You" is the live panel override', () => {
  /*
   * Call history is mostly OTHER people's calls. If the shared map said 'You',
   * every historic call would caption another agent's leg as the reader.
   */
  assert.equal(L.CALL_LEG_ROLE_LABEL.operator, 'Ops Agent');
  assert.equal(L.callLegRoleLabel('technician'), 'Assigned Technician');
  assert.equal(L.callLegRoleLabel('nonsense'), 'Participant');
});

test('partyTone maps BOTH role vocabularies to the same colour', () => {
  /*
   * The same screen carries leg roles (`client_contact`) and the backend's
   * per-row classification (`Client SPOC`). Colouring them differently would
   * imply they are different kinds of party.
   */
  assert.equal(L.partyTone('client_contact'), L.partyTone('Client SPOC'));
  assert.equal(L.partyTone('customer_alt'), L.partyTone('Alternate'));
  assert.equal(L.partyTone('technician'), L.partyTone('Technician'));
  assert.equal(L.partyTone('anything else'), 'slate');
});

/* ─── groupCallRows ─────────────────────────────────────────────────────── */

test('a 3-leg fan-out collapses to ONE row carrying all three legs', () => {
  // What the INNER JOIN emits today: one row per leg, same call id on each.
  const fanout = [
    { id: 77, duration: 210, legs: [leg(1, 'operator')] },
    { id: 77, duration: 210, legs: [leg(2, 'customer')] },
    { id: 77, duration: 210, legs: [leg(3, 'technician')] },
  ];
  const out = L.groupCallRows(fanout);
  assert.equal(out.length, 1, 'three legs must not read as three calls');
  assert.equal(out[0].id, 77);
  assert.equal(out[0].duration, 210, 'call-level fields survive the merge');
  assert.equal(out[0].legs.length, 3);
  assert.equal(L.callPartyCount(out[0]), 3);
  assert.equal(L.isConferenceCall(out[0]), true);
});

test('already-collapsed rows pass through unchanged (idempotent)', () => {
  /*
   * The endpoint is expected to collapse server-side. Running the guard over an
   * already-correct response must be a no-op, or the two repos shipping on
   * different days would produce two different screens.
   */
  const collapsed = [{ id: 77, legs: [leg(1, 'operator'), leg(2, 'customer')] }];
  const once = L.groupCallRows(collapsed);
  const twice = L.groupCallRows(once);
  assert.deepEqual(once, twice);
  assert.equal(once.length, 1);
  assert.equal(once[0].legs.length, 2);
});

test('ordinary 1:1 calls are untouched and keep `legs` undefined', () => {
  /*
   * `legs: []` would claim "we looked and nobody was on this call", which is a
   * different statement from "this endpoint does not project legs" — and
   * isConferenceCall must stay false either way.
   */
  const rows = [{ id: 1, duration: 30 }, { id: 2, duration: 45 }];
  const out = L.groupCallRows(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].legs, undefined);
  assert.equal(L.isConferenceCall(out[0]), false);
  assert.equal(L.callPartyCount(out[0]), 0);
});

test('chronological order is preserved — a call log is read top to bottom', () => {
  const rows = [
    { id: 9, legs: [leg(1, 'operator')] },
    { id: 8, legs: [leg(2, 'operator')] },
    { id: 9, legs: [leg(3, 'customer')] }, // late duplicate of the FIRST call
    { id: 7 },
  ];
  const out = L.groupCallRows(rows);
  assert.deepEqual(out.map((r) => r.id), [9, 8, 7], 'first appearance wins');
});

test('the same leg arriving twice is listed once', () => {
  // Two rows can repeat a leg when the join multiplies in both directions.
  const out = L.groupCallRows([
    { id: 5, legs: [leg(1, 'operator'), leg(2, 'customer')] },
    { id: 5, legs: [leg(2, 'customer'), leg(3, 'technician')] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].legs.map((l) => l.id), [1, 2, 3]);
});

test('a single-leg conference is NOT badged as one', () => {
  /*
   * Every ops call is now placed as a Multi-Party Call carrying just the
   * operator (Plivo cannot promote a live <Dial> into a conference), so
   * `conference_id` is set on ordinary 1:1 calls too. Badging on the id rather
   * than the leg count would put "Conference" on nearly every row.
   */
  const row = { id: 3, conference_id: 42, legs: [leg(1, 'operator')] };
  assert.equal(L.isConferenceCall(row), false);
  assert.equal(L.isConferenceCall({ id: 4, conference_id: 43 }), false);
});

test('an ordinary 1:1 call is NOT a conference, even though it writes two legs', () => {
  /*
   * REGRESSION (prod, job #526835). Since conferencing shipped, EVERY call
   * writes two rows: the operator's own call-log row and the leg for the person
   * dialled. `legs.length > 1` therefore made every 1:1 call render as
   * "Conference · 2 People".
   *
   * Worse, the operator's row carries the RECEIVER's name and number (it is the
   * "Aryan → Kannan" log row), so the callee was listed TWICE under one name.
   * Both real rows are reproduced here verbatim.
   */
  const row = {
    id: 5,
    conference_id: 52,
    legs: [
      leg(1031, 'operator', { display_name: 'Kannan', masked_number: '9930••••••', joined_at: '2026-08-12 17:03:52' }),
      leg(1032, 'customer', { display_name: 'Kannan', masked_number: '9930••••••', joined_at: '2026-08-12 17:04:04' }),
    ],
  };
  assert.equal(L.isConferenceCall(row), false);
  // The agent and the person they called are two distinct parties...
  assert.equal(L.callPartyCount(row), 2);
  // ...but only ONE of them is a counterparty, listed once.
  assert.equal(L.counterpartyLegs(row).length, 1);
  assert.equal(L.counterpartyLegs(row)[0].target_kind, 'customer');
});

test('a person re-added after dropping counts once, not twice', () => {
  /*
   * The backend's duplicate guard only blocks a re-add while the previous leg
   * is ACTIVE, so a re-add after someone drops legitimately writes a second
   * row. That is one person on the call, not two.
   */
  const row = {
    id: 6,
    conference_id: 53,
    legs: [
      leg(1, 'operator', { display_name: 'Aryan', masked_number: '9187••••••' }),
      leg(2, 'technician', { display_name: 'Ravi', masked_number: '9812••••••' }),
      leg(3, 'technician', { display_name: 'Ravi', masked_number: '9812••••••' }),
    ],
  };
  assert.equal(L.callPartyCount(row), 2);
  assert.equal(L.counterpartyLegs(row).length, 1);
  assert.equal(L.isConferenceCall(row), false);
  const parties = L.callParties(row);
  assert.equal(parties.find((p) => p.leg.display_name === 'Ravi').attempts, 2);
});

test('a genuine multi-party call IS still a conference', () => {
  const row = {
    id: 7,
    conference_id: 54,
    legs: [
      leg(1, 'operator', { display_name: 'Aryan', masked_number: '9187••••••' }),
      leg(2, 'customer', { display_name: 'Kannan', masked_number: '9930••••••' }),
      leg(3, 'technician', { display_name: 'Ravi', masked_number: '9812••••••' }),
    ],
  };
  assert.equal(L.isConferenceCall(row), true);
  assert.equal(L.callPartyCount(row), 3);
  assert.equal(L.counterpartyLegs(row).length, 2);
});

test('rows with an unusable id are kept IN PLACE, never dropped or reordered', () => {
  const out = L.groupCallRows([
    { id: 1 },
    { id: null, duration: 5 },
    { id: 2 },
  ]);
  assert.equal(out.length, 3, 'a call must not vanish because its id was odd');
  assert.equal(out[1].duration, 5, 'and must not be shunted to the end');
});

test('empty and nullish inputs are safe', () => {
  assert.deepEqual(L.groupCallRows([]), []);
  assert.deepEqual(L.groupCallRows(null), []);
  assert.deepEqual(L.groupCallRows(undefined), []);
});

/* ─── leg ordering + naming ─────────────────────────────────────────────── */

test('the ops agent sorts first, then everyone in dial order', () => {
  const sorted = L.sortCallLegs([
    leg(3, 'technician', { created_on: '2026-08-06 10:05:00' }),
    leg(2, 'customer', { created_on: '2026-08-06 10:00:00' }),
    leg(1, 'operator', { created_on: '2026-08-06 10:00:00' }),
  ]);
  assert.deepEqual(sorted.map((l) => l.target_kind), ['operator', 'customer', 'technician']);
});

test('counterpartyLegs drops the operator — "who was the agent talking to"', () => {
  const row = { id: 1, legs: [leg(1, 'operator'), leg(2, 'customer'), leg(3, 'technician')] };
  assert.deepEqual(L.counterpartyLegs(row).map((l) => l.target_kind), ['customer', 'technician']);
  assert.deepEqual(L.counterpartyLegs(null), []);
});

test('callLegName never returns an empty string', () => {
  // A blank cell in a call log reads as a rendering bug, not as missing data.
  assert.equal(L.callLegName(leg(1, 'customer', { display_name: 'Asha' })), 'Asha');
  assert.equal(L.callLegName(leg(1, 'customer', { display_name: '  ' })), 'Customer');
  assert.equal(L.callLegName(leg(1, 'weird', { masked_number: '9812••••••' })), '9812••••••');
  assert.equal(L.callLegName(leg(1, 'weird')), 'Participant');
});

test('fmtLegDuration refuses to render nonsense as a time', () => {
  assert.equal(L.fmtLegDuration(45), '45s');
  assert.equal(L.fmtLegDuration(184), '3m 04s');
  assert.equal(L.fmtLegDuration(0), '0s');
  assert.equal(L.fmtLegDuration(null), '—');
  assert.equal(L.fmtLegDuration(-3), '—');
  assert.equal(L.fmtLegDuration(Number.NaN), '—');
});

test('the page filter can find someone who was conferenced in', () => {
  /*
   * The whole point: a technician added mid-call appears nowhere in the row's
   * own columns (they are all derived from the number dialled first), so a
   * filter that only searched those would hide a person visibly on screen.
   */
  const row = { id: 1, legs: [leg(1, 'operator'), leg(2, 'technician', { display_name: 'Ravi Kumar' })] };
  const hay = L.callLegSearchText(row);
  assert.ok(hay.includes('ravi kumar'));
  assert.ok(hay.includes('assigned technician'), 'the ROLE is searchable too');
  assert.equal(L.callLegSearchText({ id: 2 }), '');
});
