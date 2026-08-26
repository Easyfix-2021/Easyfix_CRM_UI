'use strict';

/*
 * virtual-window — the arithmetic behind table row virtualisation.
 *
 * The QuickSight Call Tracking report lost its server row caps (they were
 * quietly answering a much smaller question than the one asked), so a wide
 * window now returns tens of thousands of rows and the tables render a moving
 * slice of them with spacer rows standing in for the rest.
 *
 * Everything here fails INVISIBLY. A window that runs past the end renders a
 * short page; a negative spacer height collapses to 0 in the browser and shifts
 * every row; a total height that changes as you scroll makes the scrollbar thumb
 * resize under the cursor. None of it throws, none of it fails a build, and none
 * of it is reproducible on the few-hundred-row windows anyone loads while
 * developing. Hence a test rather than a look.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../.test-build/virtual-window.js');

const ROW = 40;
const VIEW = 800;          // ~20 rows visible
const TOTAL = 26_000;      // an eight-month Call Tracking window, measured

const at = (scrollTop, total = TOTAL, rowPx = ROW, view = VIEW) =>
  V.computeWindow(total, scrollTop, view, rowPx);

test('the window never runs past the data, at any scroll position', () => {
  for (const top of [0, 1, ROW - 1, 5_000, TOTAL * ROW / 2, TOTAL * ROW, TOTAL * ROW * 2]) {
    const w = at(top);
    assert.ok(w.start >= 0, `start ${w.start} < 0 at scrollTop ${top}`);
    assert.ok(w.start <= w.end, `start ${w.start} > end ${w.end} at scrollTop ${top}`);
    assert.ok(w.end <= TOTAL, `end ${w.end} > total at scrollTop ${top}`);
  }
});

test('spacer heights are never negative — a negative one collapses to 0 and shifts every row', () => {
  for (const top of [0, 400, 100_000, TOTAL * ROW, TOTAL * ROW * 3]) {
    const w = at(top);
    assert.ok(w.padTop >= 0, `padTop ${w.padTop}`);
    assert.ok(w.padBottom >= 0, `padBottom ${w.padBottom}`);
  }
});

test('total height is CONSTANT wherever you are in the list — else the scrollbar resizes as you drag', () => {
  const expected = TOTAL * ROW;
  for (const top of [0, 1_000, 250_000, 700_000, TOTAL * ROW]) {
    const w = at(top);
    const measured = w.padTop + (w.end - w.start) * ROW + w.padBottom;
    assert.equal(measured, expected, `scroll height ${measured} !== ${expected} at scrollTop ${top}`);
  }
});

test('the rendered slice covers the visible band plus overscan on BOTH sides', () => {
  const top = 40_000;                       // row 1000 at the top of the viewport
  const w = at(top);
  const firstVisible = Math.floor(top / ROW);
  const lastVisible = Math.ceil((top + VIEW) / ROW);
  assert.ok(w.start <= firstVisible - V.OVERSCAN + 1, `start ${w.start} leaves no overscan above`);
  assert.ok(w.end >= lastVisible + V.OVERSCAN, `end ${w.end} leaves no overscan below (last visible ${lastVisible})`);
});

test('at the very top the window starts at 0 and nothing is padded above', () => {
  const w = at(0);
  assert.equal(w.start, 0);
  assert.equal(w.padTop, 0);
  assert.ok(w.end > 0);
});

test('scrolled to the very bottom the LAST row is inside the window', () => {
  // The browser clamps scrollTop to scrollHeight - clientHeight; use that exact
  // value, because an off-by-one here means the final row can never be read.
  const w = at(TOTAL * ROW - VIEW);
  assert.equal(w.end, TOTAL, 'the window must reach the last row');
  assert.equal(w.padBottom, 0, 'nothing left to pad below the last row');
  assert.ok(w.start < TOTAL, 'and there must be rows to show');
});

test('a scroll position past the end still yields a valid, non-empty window', () => {
  // Reachable in practice: rowPx is a MEASURED average, so a momentary
  // under-estimate makes the content shorter than the browser's current
  // scrollTop until the next frame corrects it.
  const w = at(TOTAL * ROW * 4);
  assert.equal(w.end, TOTAL);
  assert.equal(w.padBottom, 0);
  assert.ok(w.start <= TOTAL);
});

test('a zero or NaN row height falls back instead of producing an Infinity window', () => {
  // Dividing by a bad measurement would render EVERY row — precisely the hang
  // this module exists to prevent, arrived at by a different route.
  for (const bad of [0, -5, NaN, Infinity]) {
    const w = V.computeWindow(TOTAL, 10_000, VIEW, bad);
    assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end), `non-finite window for rowPx ${bad}`);
    assert.ok(w.end - w.start < 200, `rowPx ${bad} rendered ${w.end - w.start} rows`);
  }
});

test('an empty list produces an empty window and no spacers', () => {
  const w = at(0, 0);
  assert.deepEqual(w, { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test('a list smaller than one viewport renders whole', () => {
  const w = at(0, 5);
  assert.equal(w.start, 0);
  assert.equal(w.end, 5);
  assert.equal(w.padTop, 0);
  assert.equal(w.padBottom, 0);
});

test('the threshold is above a page size an operator would ever read manually', () => {
  // If this ever drops near a real page size, small tables start acquiring a
  // scroll box and losing their footer totals off-screen for no benefit.
  assert.ok(V.VIRTUALISE_ABOVE >= 100, 'too low — ordinary tables would be boxed');
  assert.ok(V.OVERSCAN > 0, 'no overscan means a visible gap on every flick');
});
