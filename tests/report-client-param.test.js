'use strict';
/*
 * `?clientId=` parsing for the QuickSight reports.
 *
 * The reports hold their client filter in three different shapes, so the
 * parsing lives in one place. A per-page Number() would drift, and the failure
 * is silent in the worst way: a misread param shows the WHOLE book under a
 * heading that names one client.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIdsFromParams, clientIdFromParams } = require('../.test-build/report-client-param.js');

/** Stand-in for useSearchParams().getAll */
const g = (...vals) => (k) => (k === 'clientId' ? vals.map(String) : []);

test('the profile link seeds the report', () => {
  assert.deepEqual(clientIdsFromParams(g(42)), [42]);
  assert.equal(clientIdFromParams(g(42)), '42', 'single-client reports take a string');
});

test('repeated params are supported — the multi-selects really are multi', () => {
  assert.deepEqual(clientIdsFromParams(g(1, 2, 3)), [1, 2, 3]);
  assert.equal(clientIdFromParams(g(7, 8)), '7', 'a single-client report takes the first');
});

test('a bare visit is UNCHANGED — no param, no filter', () => {
  assert.deepEqual(clientIdsFromParams(() => []), []);
  assert.equal(clientIdFromParams(() => []), '', 'the same "nothing picked" value those pages already use');
});

test('the URL is INPUT: anything not a positive integer is dropped', () => {
  // Each of these would otherwise reach the report's own API as clientId=NaN —
  // a filter matching nothing, under a heading claiming a client.
  // '1e3' and '0x10' are the interesting ones: Number() turns them into 1000
  // and 16, both real client ids reached by a spelling nobody would recognise
  // in a bookmark. Plain digits only.
  for (const bad of ['abc', '', '0', '-3', '1.5', 'null', 'undefined', '1e3', '0x10', ' 5 ', '+5']) {
    assert.deepEqual(clientIdsFromParams(g(bad)), [], `${JSON.stringify(bad)} must not seed`);
    assert.equal(clientIdFromParams(g(bad)), '');
  }
});

test('valid ids survive alongside junk, rather than the whole list being dropped', () => {
  assert.deepEqual(clientIdsFromParams(g('abc', 12, '-1', 34)), [12, 34]);
});

test('duplicates collapse, order preserved', () => {
  assert.deepEqual(clientIdsFromParams(g(5, 5, 9, 5)), [5, 9],
    'a repeated id would otherwise appear twice in the picker');
});

/* ─── ?period= ──────────────────────────────────────────────────────────── */

const { reportPeriodFromParams } = require('../.test-build/report-client-param.js');
const one = (v) => (k) => (k === 'period' && v !== undefined ? String(v) : null);

test('?period= seeds the two performance reports', () => {
  assert.equal(reportPeriodFromParams(one('weekly')), 'weekly');
  assert.equal(reportPeriodFromParams(one('monthly')), 'monthly');
});

test('anything unrecognised falls back to monthly — both reports already default there', () => {
  // A stale or hand-edited link must open a working page, not an empty one.
  for (const bad of ['Weekly', 'WEEKLY', 'daily', 'yearly', '', '1', 'null', undefined]) {
    assert.equal(reportPeriodFromParams(one(bad)), 'monthly',
      `period=${JSON.stringify(bad)} must fall back`);
  }
});
