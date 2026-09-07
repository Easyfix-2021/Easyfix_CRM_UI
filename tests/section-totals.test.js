'use strict';
/*
 * The sum-vs-total guard. Both of its cases are REAL INCIDENTS, reproduced with
 * the numbers that were actually on screen, so a future edit that weakens the
 * check fails with the story attached.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileSectionTotals } = require('../.test-build/section-totals.js');

test('INCIDENT 1: sections grouped one PAGE — five headings summing to the page size', () => {
  // Screenshot: 0 / 0 / 2 / 8 / 0 under "84 matching orders". Sum = 10 = pageSize.
  const r = reconcileSectionTotals({ totals: [0, 0, 2, 8, 0], pageTotal: 84 });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.sum, 10);
  assert.equal(r.filterIgnored, false, 'not a dropped filter — the counts differ from each other');
  assert.match(r.message, /add up to 10/);
});

test('INCIDENT 2: frontend deployed ahead of the backend — every section reports the total', () => {
  // Screenshot: 84 / 84 / 84 / 84 / 84 under "84 matching orders".
  const r = reconcileSectionTotals({ totals: [84, 84, 84, 84, 84], pageTotal: 84 });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.filterIgnored, true, 'this exact shape means the section param was dropped');
  assert.match(r.message, /ignoring the section filter/);
});

test('a correct partition is silent', () => {
  const r = reconcileSectionTotals({ totals: [0, 121, 0, 0, 29], pageTotal: 150 });
  assert.equal(r.status, 'ok');
  assert.equal(r.sum, 150);
});

test('nothing is claimed until every section AND the tab total have answered', () => {
  // A warning that fires during loading is a warning people stop reading.
  assert.equal(reconcileSectionTotals({ totals: [1, null, 3], pageTotal: 4 }).status, 'pending');
  assert.equal(reconcileSectionTotals({ totals: [1, 2, 3], pageTotal: null }).status, 'pending');
  assert.equal(reconcileSectionTotals({ totals: [], pageTotal: 0 }).status, 'pending');
});

test('an empty tab is fine, not a skew', () => {
  const r = reconcileSectionTotals({ totals: [0, 0, 0, 0, 0], pageTotal: 0 });
  assert.equal(r.status, 'ok', 'all zero against a zero total is a correct partition');
});

test('one section equal to the total is a partition, not a dropped filter', () => {
  // The fingerprint needs MORE THAN ONE section, else a single-section tab that
  // legitimately holds everything would be reported as broken forever.
  const r = reconcileSectionTotals({ totals: [7], pageTotal: 7 });
  assert.equal(r.status, 'ok');
});

test('a genuine overlap is reported as one, not as a dropped filter', () => {
  // Same job in two sections: sum exceeds the total, but the counts differ.
  const r = reconcileSectionTotals({ totals: [10, 12, 3], pageTotal: 24 });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.filterIgnored, false);
  assert.match(r.message, /more than one/);
});

test('jobs falling through every section are caught too', () => {
  const r = reconcileSectionTotals({ totals: [5, 5], pageTotal: 40 });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.sum, 10);
});
