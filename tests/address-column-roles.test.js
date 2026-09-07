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

/*
 * ─── THIS RULE IS NOW STRUCTURAL, NOT A CONVENTION ─────────────────────────
 *
 * This test used to assert that every <AddressPickerWithMap> call site passed
 * `serviceAddressReadOnly`, because the component's DEFAULT mode bound the
 * Google autocomplete to `address` and would overwrite the Service Address on
 * every pick. That guard worked, but it protected a landmine rather than
 * removing one: any new call site that forgot the flag got the old behaviour,
 * and the inverted code sat there waiting.
 *
 * Mode A was deleted on 2026-09-07, along with the flag and `buildingLabel`.
 * The search can only be on `building` now, so the assertion moved from "every
 * caller opts out of the bad mode" to "the bad mode does not exist". A prop
 * nobody can forget to pass is a stronger guarantee than a test that checks
 * they remembered.
 */
test('the picker cannot bind its autocomplete to the Service Address', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/components/ui/address-picker-with-map.tsx'), 'utf8',
  );

  const autos = (src.match(/<AddressAutocomplete/g) || []).length;
  assert.equal(
    autos, 1,
    `expected exactly ONE autocomplete in the picker (the map search on \`building\`), found ${autos}. `
    + 'A second one is almost certainly mode A coming back.',
  );

  const i = src.indexOf('<AddressAutocomplete');
  const block = src.slice(i, src.indexOf('/>', i));
  assert.match(
    block, /value=\{value\.building \|\| ''\}/,
    'the picker\'s autocomplete must drive `building` — the map-search / GPS anchor',
  );
  assert.ok(
    !/value=\{value\.address\}/.test(block),
    'the autocomplete must NOT be bound to `address`, the Service Address the whole CRM displays',
  );

  /*
   * Strip comments first. The docblock EXPLAINS that serviceAddressReadOnly was
   * removed and why, so a raw scan reads the explanation as the thing it
   * forbids — this test failed on its own documentation before the strip was
   * added. Same fix as tests/map-no-fallback-centre.test.js; a guard has to
   * distinguish code from prose about code.
   */
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The deleted flag must not return: its presence would mean the two-mode
  // shape is back, and with it the branch this test exists to prevent.
  assert.ok(
    !/serviceAddressReadOnly/.test(codeOnly),
    'serviceAddressReadOnly is gone — the search lives on `building` unconditionally. '
    + 'Reintroducing it means reintroducing the mode that binds it to `address`.',
  );
  assert.ok(
    !/buildingLabel/.test(codeOnly),
    'buildingLabel only ever labelled the mode-A field; its return implies mode A returned',
  );
});

test('no call site still passes the removed props', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/JobModal.tsx'), 'utf8');
  const blocks = propsBlocks(src);
  assert.equal(blocks.length, 3, `expected the 3 known call sites, found ${blocks.length}`);
  for (const block of blocks) {
    assert.ok(!block.includes('serviceAddressReadOnly'), 'removed prop still passed');
    assert.ok(!block.includes('buildingLabel'), 'removed prop still passed');
  }
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

/*
 * The public job-completion page (customer-facing, magic-link) does NOT use
 * AddressPickerWithMap — it reimplements a pared-down widget against the
 * /api/public/maps/* endpoints, so the call-site rule above cannot see it.
 *
 * Its equivalent switch is `mapOnly`. With it, the search box binds to
 * `form.building` (the map-search column) and the booked Service Address is
 * untouchable. WITHOUT it the box binds to `form.address` — so a customer
 * searching for their own location would overwrite the Service Address the job
 * was booked against, from a public page, with no operator watching.
 *
 * That branch is currently unreachable (the one call site passes mapOnly), and
 * unreachable is not the same as removed: dropping the prop from that one call
 * site is a one-word change that silently re-arms it.
 */
const PUBLIC_PAGE = 'src/app/public/job-completion/[token]/page.tsx';

test('every public AddressMapWidget runs in mapOnly mode, so the search cannot rewrite the booked address', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', PUBLIC_PAGE), 'utf8');
  const blocks = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf('<AddressMapWidget', from);
    if (i === -1) break;
    const end = src.indexOf('/>', i);
    assert.ok(end > i, 'unterminated <AddressMapWidget');
    blocks.push(src.slice(i, end));
    from = end;
  }
  assert.ok(blocks.length > 0, `no <AddressMapWidget found in ${PUBLIC_PAGE} — did it move?`);
  for (const block of blocks) {
    assert.ok(
      /\bmapOnly\b/.test(block),
      'an <AddressMapWidget on the public page omits mapOnly, so its search box binds to '
      + '`form.address` — a customer could overwrite the booked Service Address with a Google '
      + 'string from a public page.',
    );
  }
});

test('mapOnly is still the switch that does the remap', () => {
  // If this expression changes, the guard above is asserting the wrong prop and
  // would keep passing while protecting nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', PUBLIC_PAGE), 'utf8');
  assert.match(
    src,
    /const searchQuery = mapOnly \? form\.building : form\.address;/,
    'the public widget no longer selects its bound column with `mapOnly` — the mapOnly guard '
    + 'above is now meaningless and needs rewriting against whatever replaced it.',
  );
});

/*
 * ─── THE SURFACE THIS FILE ORIGINALLY MISSED ───────────────────────────────
 *
 * Everything above scans <AddressPickerWithMap> CALL SITES. AddressEditDialog
 * does not use that component — it wires AddressAutocomplete directly — so it
 * was invisible to the guard and kept the inverted roles for three days after
 * every other surface was converted. Reported 2026-09-07.
 *
 * The lesson is about the guard, not the dialog: a rule scoped to one
 * component only protects the surfaces that happen to use it. Anything that
 * reaches for the same primitive underneath needs its own check.
 */

const EDIT_DIALOG = 'src/components/job/AddressEditDialog.tsx';
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('AddressEditDialog binds the autocomplete to the map-search field, not the Service Address', () => {
  const src = readSrc(EDIT_DIALOG);
  const i = src.indexOf('<AddressAutocomplete');
  assert.notEqual(i, -1, `no <AddressAutocomplete found in ${EDIT_DIALOG} — did it move?`);
  const block = src.slice(i, src.indexOf('/>', i));
  assert.match(
    block, /value=\{f\.building\}/,
    'the autocomplete must drive `building` (the map-search / GPS anchor). Bound to '
    + '`f.address` it overwrites the operator\'s Service Address with Google\'s '
    + 'formatted_address on every pick — the inversion fixed everywhere else.',
  );
  assert.ok(
    !/value=\{f\.address\}/.test(block),
    'the autocomplete must NOT be bound to `address`',
  );
  // Only ONE autocomplete in this dialog; a second would almost certainly be a
  // re-inverted Service Address field.
  assert.equal(
    (src.match(/<AddressAutocomplete/g) || []).length, 1,
    'expected exactly one autocomplete in this dialog',
  );
});

test('AddressEditDialog re-syncs GPS when the search text is typed, not only picked', () => {
  const src = readSrc(EDIT_DIALOG);
  assert.match(
    src, /maps\/geocode/,
    'the dialog must forward-geocode a typed search. GPS is read-only here, so '
    + 'without this a hand-edited address saves against the PREVIOUS coordinates '
    + 'and nothing on screen admits the two disagree.',
  );
  assert.match(src, /lastGeocodedSearchRef/, 'the watcher needs its dedupe ref');
  assert.match(
    src, /\}, \[f\.building, open\]\);/,
    'the watcher must key on the search field so a typed edit re-runs it',
  );
});
