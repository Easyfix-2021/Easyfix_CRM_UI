'use strict';
/*
 * OfferHoverCard is never clipped by the list table (2026-09-15, ops).
 *
 * The card was `absolute` inside the table's `overflow-x-auto` wrapper
 * (overflow-x other than visible clips the Y axis too). On the last rows it
 * was cut off at the table's bottom edge; flipping it upwards inside the same
 * box still sliced its top off when the box had no room either way — a
 * one-row Manage Jobs result (job 482502). It now portals into <body> and is
 * placed `fixed` against the viewport: below when the screen has room, above
 * when it doesn't and above has more, clamped on screen.
 *
 * Source-shape guard (the suite mounts nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/OfferHoverCard.tsx'), 'utf8');
const flat = src.replace(/\s+/g, ' ');

test('the card portals into <body> with fixed positioning, out of every clipping ancestor', () => {
  assert.match(flat, /import \{ createPortal \} from 'react-dom';/);
  assert.match(flat, /\{open && typeof document !== 'undefined' && createPortal\(/);
  assert.match(flat, /document\.body, \)\}/);
  assert.match(flat, /className=\{`fixed z-\[60\]/);
  assert.doesNotMatch(flat, /absolute left-0/, 'an absolute card is clipped by the table wrapper again');
  assert.doesNotMatch(flat, /bottom-full|top-full/, 'placement comes from the viewport maths, not cell-relative classes');
});

test('placement is against the viewport: below if it fits, else the roomier side, clamped on screen', () => {
  assert.match(flat, /const spaceBelow = window\.innerHeight - a\.bottom - VIEWPORT_EDGE;/);
  assert.match(flat, /const spaceAbove = a\.top - VIEWPORT_EDGE;/);
  assert.match(flat, /const below = h <= spaceBelow \|\| spaceBelow >= spaceAbove;/);
  assert.match(flat, /top: below \? a\.bottom : a\.top - Math\.min\(h, room\),/);
  assert.match(flat, /left: Math\.max\(VIEWPORT_EDGE, Math\.min\(a\.left, window\.innerWidth - w - VIEWPORT_EDGE\)\),/);
  assert.match(flat, /maxHeight: h > room \? Math\.max\(0, room - 4\) : null,/, 'neither side fits → cap and scroll, never overflow the screen');
});

test('the natural height is measured even while a previous cap is applied', () => {
  assert.match(flat, /const h = panel\.scrollHeight \+ \(panel\.offsetHeight - panel\.clientHeight\) \+ 4;/);
});

test('placed before paint, hidden on the measuring frame, re-placed when the content resizes', () => {
  assert.match(flat, /React\.useLayoutEffect\(\(\) => \{ if \(!open\) \{ setPos\(null\); return; \} place\(\); \}, \[open, loading, error, items, place\]\);/);
  assert.match(flat, /: \{ top: 0, left: 0, visibility: 'hidden' \}\}/);
});

test('closes when something containing the chip scrolls; other scrolls and resizes do not close it', () => {
  assert.match(flat, /if \(t === document \|\| \(t instanceof Node && anchorRef\.current && t\.contains\(anchorRef\.current\)\)\) \{ setOpen\(false\); \}/);
  assert.match(flat, /window\.addEventListener\('scroll', onScroll, true\);/);
  assert.match(flat, /window\.addEventListener\('resize', place\);/);
});

test('the 4px gap is padding inside the card box, so the pointer can reach the card', () => {
  assert.match(flat, /\$\{pos\?\.placement === 'above' \? 'pb-1' : 'pt-1'\}/);
});
