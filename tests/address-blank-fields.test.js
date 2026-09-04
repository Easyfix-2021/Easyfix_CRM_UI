'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * BLANK_ADDRESS_FIELDS (src/components/job/JobModal.tsx) must cover every
 * field AddressPickerWithMap writes into the form.
 *
 * WHY THIS IS GUARDED
 *
 * Three handlers in the Book New Call address picker each enumerated the
 * address fields by hand, and they had drifted: selecting a saved address
 * copied SIX, "+ Add a new address" cleared FIVE, deleting the selected
 * address cleared THREE. So "add a new address" produced a blank form with
 * the PREVIOUS address's Landmark still sitting in it — reported from
 * production on 2026-09-04.
 *
 * A partial clear is the dangerous shape: the operator sees a mostly-empty
 * form, has no reason to suspect one box is a leftover, and saves it onto a
 * NEW address. Nothing errors, and the wrong landmark is now on file.
 *
 * The clear is one constant now, so the remaining failure is someone adding a
 * field to AddressValue and not to that constant — which silently reopens
 * exactly this bug for the new field. That is what this test catches. There is
 * no DOM harness here (tests/ is node:test over pure logic), so it compares the
 * two SOURCE declarations.
 */

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Keys of a `{ ... }` block: `name:` at the start of a line, ignoring comments.
// NOTE: no /g + .test() here — a global regex keeps lastIndex between calls and
// would skip alternate matches.
function keysOf(block) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .map((line) => (line.match(/^([a-z_][a-z0-9_]*)\??\s*:/i) || [])[1])
    .filter(Boolean);
}

function blockAfter(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker} — the declaration was renamed or removed`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('};', open);
  assert.ok(close > open, `could not find the end of ${marker}`);
  return src.slice(open + 1, close);
}

test('BLANK_ADDRESS_FIELDS clears every field the address picker can write', () => {
  const blank = keysOf(blockAfter(read('src/components/job/JobModal.tsx'), 'const BLANK_ADDRESS_FIELDS ='));
  const value = keysOf(blockAfter(read('src/components/ui/address-picker-with-map.tsx'), 'export type AddressValue ='));

  assert.ok(blank.length >= 7, `expected the full address set, got ${blank.length}: ${blank.join(', ')}`);
  const missing = value.filter((k) => !blank.includes(k));
  assert.deepEqual(
    missing, [],
    `AddressValue field(s) ${missing.join(', ')} are written by the picker but NOT cleared by `
    + 'BLANK_ADDRESS_FIELDS — "+ Add a new address" would leave the previous address\'s value behind.',
  );
});

test('both clear sites go through the shared constant, not a hand-written list', () => {
  const src = read('src/components/job/JobModal.tsx');
  const spreads = src.split('...BLANK_ADDRESS_FIELDS').length - 1;
  // Two clears (add-new, delete-selected) + the blank-then-copy on select.
  assert.ok(spreads >= 3, `expected at least 3 uses of the shared blank set, found ${spreads}`);
  assert.ok(
    !/setF\(\(s\) => \(\{ \.\.\.s, address: '', city_id: '', pin_code: ''/.test(src),
    'a hand-enumerated partial address clear is back — use BLANK_ADDRESS_FIELDS',
  );
});
