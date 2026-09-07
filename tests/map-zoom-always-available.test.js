'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * `ui.map.clickable=false` must not take zoom away.
 *
 * WHAT WENT WRONG
 *
 * The flag was implemented as `gestureHandling: mapClickable ? 'auto' : 'none'`
 * plus `disableDefaultUI: !mapClickable`. 'none' blocks EVERY gesture — wheel
 * and pinch zoom included — and disableDefaultUI removes the +/- buttons. So a
 * map that was only meant to be non-EDITABLE became non-READABLE: you could see
 * a pin and never get close enough to tell which building it sat on. Reported
 * 2026-09-07.
 *
 * The flag governs EDITING. Zoom edits nothing, and neither does panning: the
 * pin is held still by three other things — the marker is not draggable, the
 * map click listener is not bound, and clickableIcons is off — none of which
 * this test relaxes.
 *
 * There is no DOM harness here (tests/ is node:test over pure logic), so this
 * asserts the SOURCE. Weaker than driving a map, but it catches the thing that
 * actually happens: someone adds a third call site, copies the old pair of
 * options, and quietly ships an unreadable map again.
 */

const FILES = [
  'src/components/ui/address-picker-with-map.tsx',
  'src/app/public/job-completion/[token]/page.tsx',
];

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('no map gates gestureHandling on the clickable flag', () => {
  for (const file of FILES) {
    const src = read(file);
    assert.ok(
      !/gestureHandling:\s*mapClickable/.test(src),
      `${file} gates gestureHandling on ui.map.clickable. 'none' blocks wheel and `
      + 'pinch zoom too, which makes a read-only map unreadable. Use '
      + "gestureHandling: 'auto' — the pin is held still by draggable/listener/"
      + 'clickableIcons, not by disabling gestures.',
    );
  }
});

test('every map that hides default UI re-enables the zoom control', () => {
  for (const file of FILES) {
    const src = read(file);
    const hides = (src.match(/disableDefaultUI:\s*!mapClickable/g) || []).length;
    const zooms = (src.match(/zoomControl:\s*true/g) || []).length;
    assert.ok(hides > 0, `${file}: expected at least one map options block`);
    assert.equal(
      zooms, hides,
      `${file} has ${hides} block(s) hiding the default UI but ${zooms} re-enabling `
      + 'zoomControl. disableDefaultUI strips the +/- buttons, so each block that '
      + 'sets it must set zoomControl: true back.',
    );
  }
});

test('the picker re-centres once the map exists, not only when GPS changes', () => {
  // The build effect is async and keyed on [flagsLoaded], so it closes over
  // whatever initialLatLng held when the flag resolved. If that was null the
  // map centres on the Delhi fallback — and the re-centre effect had already
  // bailed on a null mapInstance. Depending on mapReady is what re-runs it.
  const src = read('src/components/ui/address-picker-with-map.tsx');
  assert.match(
    src, /\}, \[initialLatLng, mapReady\]\);/,
    'the re-centre effect must depend on mapReady as well as initialLatLng, or a '
    + 'map built before gps_location arrived stays on the Delhi fallback while the '
    + 'GPS field shows the right coordinates.',
  );
  assert.match(src, /setMapReady\(true\)/, 'mapReady must actually be set when a map is built');
  // Both build paths — reuse and fresh — have to report readiness.
  assert.equal(
    (src.match(/setMapReady\(true\)/g) || []).length, 2,
    'both the reuse and fresh-build paths must set mapReady, or the reused-instance '
    + 'path silently keeps the old behaviour',
  );
});
