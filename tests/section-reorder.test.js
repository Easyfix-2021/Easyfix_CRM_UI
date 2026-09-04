'use strict';
/*
 * The drag-to-reorder index arithmetic for My Orders -> Unconfirmed sections.
 *
 * Pinned because the reported defect ("sometimes it gets dropped at an
 * incorrect position") was NOT a drag-event problem — it was this arithmetic,
 * and it is the kind that looks right when read and is wrong when run. Every
 * case below is written as the OPERATOR's intent, so a future edit that
 * re-breaks it fails with a sentence rather than with two numbers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { reorder } = require('../.test-build/reorder.js');

const L = ['A', 'B', 'C', 'D', 'E'];

test('dragging DOWN onto a later section lands AFTER it — the reported bug', () => {
  /*
   * A dropped on the BOTTOM half of C. The gap below C is index 3.
   * The old code produced ['B','A','C','D','E'] — A above C, one short of
   * where it was aimed, and the reason a downward drag felt unpredictable.
   */
  assert.deepEqual(reorder(L, 0, 3), ['B', 'C', 'A', 'D', 'E']);
});

test('dragging DOWN onto the TOP half of a later section lands BEFORE it', () => {
  // Same drag, pointer a few pixels higher: the gap ABOVE C is index 2.
  assert.deepEqual(reorder(L, 0, 2), ['B', 'A', 'C', 'D', 'E']);
});

test('dragging UP lands above the section aimed at', () => {
  assert.deepEqual(reorder(L, 4, 1), ['A', 'E', 'B', 'C', 'D']);
});

test('dropping into either gap touching the dragged section changes nothing', () => {
  // Its own two edges are no-ops, never an off-by-one shuffle.
  assert.deepEqual(reorder(L, 2, 2), L);
  assert.deepEqual(reorder(L, 2, 3), L);
});

test('the two ends are reachable', () => {
  assert.deepEqual(reorder(L, 2, 0), ['C', 'A', 'B', 'D', 'E'], 'to the very top');
  assert.deepEqual(reorder(L, 2, 5), ['A', 'B', 'D', 'E', 'C'], 'to the very bottom');
});

test('a gap past either end is clamped, not an exception', () => {
  // The keyboard handler computes idx+2 / idx-1 and so runs off both ends on
  // the first and last sections. Those presses must simply do nothing.
  assert.deepEqual(reorder(L, 0, -1), L, 'ArrowUp on the first section');
  assert.deepEqual(reorder(L, 4, 6), L, 'ArrowDown on the last section');
});

test('an unknown source index leaves the list alone', () => {
  assert.deepEqual(reorder(L, -1, 2), L);
  assert.deepEqual(reorder(L, 9, 2), L);
});

test('the input is never mutated — the caller persists the RESULT', () => {
  const before = L.slice();
  reorder(L, 0, 3);
  assert.deepEqual(L, before);
});

test('every reorder is a permutation: no section is lost or duplicated', () => {
  /*
   * The property that matters most on this page. A section dropped out of the
   * list takes a whole bucket of jobs off the screen with it, and a duplicated
   * one renders the same jobs twice under two headings — both silent.
   */
  for (let from = 0; from < L.length; from += 1) {
    for (let at = 0; at <= L.length; at += 1) {
      const out = reorder(L, from, at);
      assert.equal(out.length, L.length, `length changed for ${from}->${at}`);
      assert.deepEqual([...out].sort(), [...L].sort(), `membership changed for ${from}->${at}`);
    }
  }
});
