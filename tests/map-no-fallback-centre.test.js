'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * A map must never centre on a guessed location.
 *
 * WHAT WENT WRONG (2026-09-07)
 *
 * Both map builders defaulted to {lat: 28.6139, lng: 77.2090} — Delhi —
 * whenever coordinates were absent. A Panchkula job rendered Delhi landmarks
 * while its GPS field read 30.7023839,76.857682, because the build is async and
 * closed over a null value that arrived a tick later.
 *
 * WHY A FALLBACK IS THE WRONG SHAPE, not just a wrong number
 *
 * A pin on the wrong city is indistinguishable from real data. There is no
 * visual difference between "here is the location" and "we had nothing so here
 * is Delhi", so the operator cannot know to distrust it. Absence has to LOOK
 * like absence. Waiting longer to show the right place beats instantly showing
 * the wrong one.
 *
 * So both builders now treat coordinates as a BUILD PRECONDITION: bail without
 * them, keep them in the dep array so the build fires when they arrive, and
 * show an explicit "No Location Yet" placeholder meanwhile.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM.
 */

const BUILDERS = [
  'src/components/ui/address-picker-with-map.tsx',
  'src/app/public/job-completion/[token]/page.tsx',
];

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Strip block and line comments so the historical explanation of the bug
// does not read as the bug. Without this, the comment naming the old Delhi
// constant would fail the very test that documents it.
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('no map builder carries a hard-coded fallback centre', () => {
  for (const file of BUILDERS) {
    const src = code(read(file));
    assert.ok(
      !/lat:\s*28\.6139/.test(src),
      `${file} still centres on the Delhi fallback. A guessed centre is `
      + 'indistinguishable from real data — bail without coordinates instead.',
    );
    assert.ok(
      !/parseLatLng\([^)]*\)\s*\|\|\s*\{/.test(src) && !/initialLatLng\s*\|\|\s*\{/.test(src),
      `${file} substitutes an object when coordinates are missing. That is a `
      + 'fallback centre by another name.',
    );
  }
});

test('each builder treats coordinates as a precondition, in the deps too', () => {
  const picker = code(read(BUILDERS[0]));
  assert.match(
    picker, /!flagsLoaded \|\| !initialLatLng/,
    'the picker must bail out of the build when it has no coordinates',
  );
  assert.match(
    picker, /\}, \[flagsLoaded, initialLatLng\]\);/,
    'initialLatLng must be in the build effect deps — without it the effect never '
    + 're-runs when coordinates arrive and the map never builds at all',
  );

  const publicPage = code(read(BUILDERS[1]));
  assert.match(publicPage, /if \(!initial\) return;/, 'the public builder must bail without coordinates');
  assert.match(
    publicPage, /\}, \[form\.gps_location\]\);/,
    'form.gps_location must be in the deps for the same reason',
  );
});

test('absence is shown, not faked', () => {
  for (const file of BUILDERS) {
    assert.match(
      read(file), /No Location Yet/,
      `${file} must render an explicit placeholder while it has no coordinates — `
      + 'an empty grey box reads as a broken map rather than as missing data.',
    );
  }
});
