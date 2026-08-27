const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  QUICKSIGHT_FAMILY_KEY, isQuickSightReportKey,
  splitActionFamily, familyCheckState, applyToggle, applyFamilyToggle,
} = require('../.test-build/action-family');

/*
 * The QuickSight permission family in Manage Roles.
 *
 * These are permission STATE TRANSITIONS, so the cost of a wrong one is a role
 * that can see something it should not, or an operator who ticks a box that
 * does nothing. Both have already happened here: ten report keys were
 * ungrantable for two months, and a report ticked without `ef-QuickSight`
 * saves cleanly and then 403s, because the server checks the family key first.
 *
 * Tested in lib rather than in the page for the reason job-buckets.test.js
 * gives — importing a page drags React and the Next runtime in, which is how
 * rules that live in pages end up with no coverage at all.
 */

const mk = (id, action_name, name = action_name) => ({ id, action_name, name });

const HOME = [
  mk(1, 'isBookNewCall', 'Book new call'),
  mk(2, 'isCallInfo', 'Call Info'),
  mk(40, QUICKSIGHT_FAMILY_KEY, 'QuickSight'),
  mk(65, 'isQuickSightOpenOrdersView', 'View QuickSight - Open Orders'),
  mk(73, 'isQuickSightEmployeeProductivityView', 'View QuickSight - Employee Productivity'),
  mk(87, 'isQuickSightCallTrackingView', 'View QuickSight - Call Tracking'),
];

// ─── which keys are family members ───────────────────────────────────

test('report keys are matched by shape, not by a hardcoded list', () => {
  assert.ok(isQuickSightReportKey('isQuickSightOpenOrdersView'));
  assert.ok(isQuickSightReportKey('isQuickSightSomeReportInventedTomorrowView'),
    'a report seeded later must join the tree without editing this file — '
    + 'a stale list is what left ten reports ungrantable');
  // The door is not one of the rooms.
  assert.equal(isQuickSightReportKey(QUICKSIGHT_FAMILY_KEY), false);
  // Neighbours that merely look similar are not members.
  assert.equal(isQuickSightReportKey('isQuicksight'), false, 'the legacy lowercase-s button');
  assert.equal(isQuickSightReportKey('ef-QuickSightOpenOrdersView'), false, 'the old ef- prefix');
  assert.equal(isQuickSightReportKey('isQuickSightOpenOrders'), false, 'no View suffix');
});

// ─── splitting ───────────────────────────────────────────────────────

test('the split separates the door, the rooms, and everything else', () => {
  const { familyParent, reports, plain, familyIds } = splitActionFamily(HOME);
  assert.equal(familyParent.id, 40);
  assert.deepEqual(reports.map((r) => r.id), [65, 73, 87]);
  assert.deepEqual(plain.map((p) => p.id), [1, 2], 'non-QuickSight actions stay flat');
  assert.deepEqual(familyIds, [40, 65, 73, 87], 'door first, then every room');
});

test('a menu with no QuickSight actions is untouched', () => {
  const other = [mk(9, 'isSomethingElse', 'Something else')];
  const { familyParent, reports, plain, familyIds } = splitActionFamily(other);
  assert.equal(familyParent, undefined);
  assert.deepEqual(reports, []);
  assert.deepEqual(plain.map((p) => p.id), [9]);
  assert.deepEqual(familyIds, [], 'no family header renders for this menu');
});

// ─── the header checkbox ─────────────────────────────────────────────

test('the header is checked only when the door AND every room are granted', () => {
  const ids = [40, 65, 73, 87];
  assert.deepEqual(familyCheckState(ids, new Set(ids)),
    { allOn: true, anyOn: true, indeterminate: false });
  assert.deepEqual(familyCheckState(ids, new Set([40, 65])),
    { allOn: false, anyOn: true, indeterminate: true }, 'some rooms → indeterminate');
  assert.deepEqual(familyCheckState(ids, new Set()),
    { allOn: false, anyOn: false, indeterminate: false });
});

test('holding ONLY the door still reads as partial, not empty', () => {
  // This is a real state: a reporting manager needs ef-QuickSight with no
  // per-report grant, because Employee Productivity is gated on the relation.
  const s = familyCheckState([40, 65, 73], new Set([40]));
  assert.equal(s.indeterminate, true);
  assert.equal(s.allOn, false);
});

// ─── granting a room opens the door ──────────────────────────────────

test('ticking a report also grants the family key', () => {
  const next = applyToggle(new Set(), 73, 40);
  assert.deepEqual([...next].sort((a, b) => a - b), [40, 73],
    'a report without ef-QuickSight saves fine and then 403s — the server '
    + 'checks the family key before the report key');
});

test('un-ticking the last report does NOT shut the door', () => {
  const next = applyToggle(new Set([40, 73]), 73, 40);
  assert.deepEqual([...next], [40],
    'the family key with no reports is a reachable, wanted state — revoking '
    + 'it here would strip a reporting manager as a side effect');
});

test('a plain action carries no implication', () => {
  assert.deepEqual([...applyToggle(new Set(), 1)], [1]);
  assert.deepEqual([...applyToggle(new Set([1]), 1)], []);
});

test('toggling is its own inverse for a plain action', () => {
  const once = applyToggle(new Set([5, 6]), 5);
  const twice = applyToggle(once, 5);
  assert.deepEqual([...twice].sort((a, b) => a - b), [5, 6]);
});

// ─── the header click ────────────────────────────────────────────────

test('clicking a partly-filled family fills it', () => {
  const next = applyFamilyToggle(new Set([40, 65]), [40, 65, 73, 87]);
  assert.deepEqual([...next].sort((a, b) => a - b), [40, 65, 73, 87],
    'indeterminate is a display state — a click resolves it to ALL');
});

test('clicking a full family empties it, door included', () => {
  const next = applyFamilyToggle(new Set([40, 65, 73, 87]), [40, 65, 73, 87]);
  assert.deepEqual([...next], []);
});

test('the family toggle leaves unrelated permissions alone', () => {
  const next = applyFamilyToggle(new Set([1, 2, 40]), [40, 65]);
  assert.ok(next.has(1) && next.has(2), 'Book new call / Call Info must survive');
});

test('an empty family is a no-op, not a wipe', () => {
  const before = new Set([1, 2]);
  const after = applyFamilyToggle(before, []);
  assert.deepEqual([...after].sort((a, b) => a - b), [1, 2]);
});

test('neither toggle mutates the set it was given', () => {
  const before = new Set([40]);
  applyToggle(before, 73, 40);
  applyFamilyToggle(before, [40, 65]);
  assert.deepEqual([...before], [40],
    'React state must never be mutated in place — a mutated Set can skip a '
    + 'render and leave the checkbox disagreeing with what will be saved');
});
