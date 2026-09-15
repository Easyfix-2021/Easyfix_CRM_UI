'use strict';
/*
 * OfferHoverCard opens UPWARDS when it would not fit below (2026-09-15, ops).
 *
 * On the last rows of Manage Jobs / Pending for Scheduling the card opened
 * downwards and was cut off by the table's own `overflow-x-auto` wrapper
 * (overflow-x other than visible clips the Y axis too), well before the bottom
 * of the screen. Verified in a browser: row 1 opens below, row 8 of 8 opens
 * above, neither clipped.
 *
 * Source-shape guard (the suite mounts nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/OfferHoverCard.tsx'), 'utf8');
const flat = src.replace(/\s+/g, ' ');

test('the visible area is narrowed by every clipping ancestor, not just the viewport', () => {
  assert.match(flat, /if \(s\.overflowX !== 'visible' \|\| s\.overflowY !== 'visible'\)/,
    'an overflow-x-auto table wrapper must count as a clipping edge');
});

test('the card flips above only when below does not fit AND above has more room', () => {
  assert.match(flat, /setAbove\(needed > spaceBelow && spaceAbove > spaceBelow\);/);
  assert.match(flat, /\$\{above \? 'bottom-full mb-1' : 'top-full mt-1'\}/);
});

test('placement is measured before paint and again when the content resizes', () => {
  assert.match(flat, /React\.useLayoutEffect\(\(\) => \{ if \(!open\) \{ setAbove\(false\); return; \}/);
  assert.match(flat, /\}, \[open, loading, error, items\]\);/, 'Loading… → roster changes the height, so re-measure');
});
