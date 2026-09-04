'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * tbl_address column roles, enforced at every editable address surface.
 *
 * Per ops (recorded in src/lib/format.ts):
 *   `address`  = THE Service Address. formatServiceAddress reads this column
 *                and nothing else, so it is what the CRM, the client and the
 *                technician all see.
 *   `building` = REPURPOSED to hold the Google-Map search text, used only to
 *                derive the GPS pin. Not part of the Service Address.
 *
 * AddressPickerWithMap has two modes and they bind the Google autocomplete to
 * DIFFERENT columns. Default mode puts it on `address`; `serviceAddressReadOnly`
 * moves it to `building`. Only the second matches the roles above.
 *
 * Book New Call ran in default mode with the labels swapped — "Search Location
 * on Map" on the field writing `address`, "Address" on the field writing
 * `building`. It read correctly and did the exact opposite: every booking
 * stored Google's formatted_address AS the Service Address and the house/flat
 * number in the map-search column. Nothing errored; the job simply read back
 * differently from one confirmed through Confirm & Schedule.
 *
 * That is invisible in review — the labels look right — so it is pinned here.
 */

const CALL_SITE_FILES = ['src/components/job/JobModal.tsx'];

function propsBlocks(src) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf('<AddressPickerWithMap', from);
    if (i === -1) break;
    const end = src.indexOf('/>', i);
    assert.ok(end > i, 'unterminated <AddressPickerWithMap');
    blocks.push(src.slice(i, end));
    from = end;
  }
  return blocks;
}

test('every address picker puts the Google search on `building`, not on the Service Address', () => {
  let checked = 0;
  for (const file of CALL_SITE_FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const blocks = propsBlocks(src);
    assert.ok(blocks.length > 0, `no <AddressPickerWithMap found in ${file} — did it move?`);
    for (const block of blocks) {
      checked += 1;
      assert.ok(
        block.includes('serviceAddressReadOnly'),
        `an <AddressPickerWithMap in ${file} runs in DEFAULT mode, which binds the Google `
        + 'autocomplete to `address` — every pick would overwrite the Service Address with '
        + "Google's formatted_address. Pass serviceAddressReadOnly (+ serviceAddressEditable "
        + 'when the address itself must be editable).',
      );
      assert.ok(
        !block.includes('buildingLabel'),
        `an <AddressPickerWithMap in ${file} passes buildingLabel, which only renders in the `
        + 'inverted default mode. Relabelling that field cannot fix the column roles.',
      );
    }
  }
  assert.equal(checked, 3, `expected the 3 known call sites, checked ${checked}`);
});

test('formatServiceAddress still reads `address` alone — the premise of the rule above', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/lib/format.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function formatServiceAddress'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /p\.address/, 'formatServiceAddress no longer reads `address`');
  for (const col of ['building', 'landmark', 'locality']) {
    assert.ok(
      !new RegExp(`p\\.${col}`).test(body),
      `formatServiceAddress now also composes \`${col}\` — if the Service Address is no longer `
      + '`address` alone, the column-role rule in this file needs rewriting, not deleting.',
    );
  }
});
