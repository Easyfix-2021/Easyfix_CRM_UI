'use strict';
/*
 * The TAT Calculator's deep-link contract.
 *
 * The client profile has always linked here as
 * `?mode=client&clientId=N`, and the page imported no useSearchParams at all —
 * so the link opened the calculator in JOB mode with nothing selected, while
 * the profile's own Reports section described it as "the one genuinely
 * client-scoped link". Nothing errored; the operator simply got a blank form.
 *
 * These are pure and read no clock, no DOM and no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  tatKeyFor, tatSeedFromParams, TAT_MODES, TAT_DIMENSION_MODES,
} = require('../.test-build/tat-calculator-url.js');

/** Stand-in for useSearchParams().get */
const params = (o) => (k) => (k in o ? String(o[k]) : null);

test('THE REPORTED BUG: the profile link now lands on the client, computed', () => {
  // Exactly what ReportsSection emits.
  const seed = tatSeedFromParams(params({ mode: 'client', clientId: 42, days: 30 }));
  assert.equal(seed.mode, 'client');
  assert.equal(seed.clientId, 42);
  assert.equal(seed.days, '30');
  assert.equal(seed.key, '/admin/tat/client/42?days=30',
    'a complete selection must compute on arrival — otherwise the operator lands '
    + 'on a form they have to fill in with what the link already said');
});

test('days=30 is carried, so the calculator matches the SLA-breach KPI it came from', () => {
  // The profile KPI fetches /admin/tat/client/:id?days=30. Defaulting to 90 here
  // would show a different number than the one the operator just clicked.
  assert.equal(tatSeedFromParams(params({ mode: 'client', clientId: 7, days: 30 })).key,
    '/admin/tat/client/7?days=30');
  assert.equal(tatSeedFromParams(params({ mode: 'client', clientId: 7 })).key,
    '/admin/tat/client/7?days=90', 'and without it the page default still applies');
});

test('a bare visit computes NOTHING — the endpoint scans a lifetime of jobs', () => {
  const seed = tatSeedFromParams(params({}));
  assert.equal(seed.mode, 'job');
  assert.equal(seed.clientId, '');
  assert.equal(seed.key, null, 'no auto-query without an explicit selection');
});

test('the URL is INPUT, not truth — every field is validated', () => {
  // An unknown mode would render a tab that does not exist.
  assert.equal(tatSeedFromParams(params({ mode: 'wat' })).mode, 'job');
  assert.equal(tatSeedFromParams(params({ mode: 'CLIENT' })).mode, 'job', 'case-sensitive by design');
  // A non-numeric id would build /admin/tat/client/NaN.
  for (const bad of ['abc', '-1', '0', '1.5', '']) {
    const s = tatSeedFromParams(params({ mode: 'client', clientId: bad }));
    assert.equal(s.clientId, '', `clientId=${JSON.stringify(bad)} must not seed`);
    assert.equal(s.key, null, 'and must not compute');
  }
});

test('days is BOUNDED — a URL must not ask the database for everything', () => {
  assert.equal(tatSeedFromParams(params({ days: 999999 })).days, '90', 'absurd falls back');
  assert.equal(tatSeedFromParams(params({ days: 0 })).days, '90');
  assert.equal(tatSeedFromParams(params({ days: -5 })).days, '90');
  assert.equal(tatSeedFromParams(params({ days: 1825 })).days, '1825', 'five years is the ceiling');
});

test('every declared mode either computes a key or is deliberately unseedable', () => {
  /*
   * Derived from TAT_MODES so a mode added later is covered without anyone
   * remembering this test. `technician` is the one exception and it is
   * intentional: its picker holds a whole easyfixer row, not an id.
   */
  for (const mode of TAT_MODES) {
    if (mode === 'technician') {
      assert.equal(tatSeedFromParams(params({ mode })).key, null,
        'technician cannot be seeded from a URL — documented in the lib');
      continue;
    }
    const supply = mode === 'job' ? { jobId: '5' }
      : mode === 'client' ? { clientId: 5 }
      : { dimId: '5' };
    const seed = tatSeedFromParams(params({ mode, ...supply }));
    assert.equal(seed.mode, mode, `${mode} must survive validation`);
    assert.ok(seed.key, `${mode} with an id must compute a key`);
    assert.match(seed.key, /^\/admin\/tat\//);
  }
});

test('the four dimension modes all route to their own endpoint', () => {
  for (const m of TAT_DIMENSION_MODES) {
    assert.equal(tatKeyFor({ mode: m, dimId: '3', days: '60' }), `/admin/tat/${m}/3?days=60`);
  }
});

test('tatKeyFor is the ONE definition — an incomplete selection is null, never a partial URL', () => {
  assert.equal(tatKeyFor({ mode: 'client', clientId: '' }), null);
  assert.equal(tatKeyFor({ mode: 'job', jobId: '   ' }), null, 'whitespace is not an id');
  assert.equal(tatKeyFor({ mode: 'technician', techId: null }), null);
  assert.equal(tatKeyFor({ mode: 'technician', techId: 88 }), '/admin/tat/technician/88');
});

/* ── the wiring, not just the contract ─────────────────────────────────── */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'src/app/(authed)/admin-actions/tat-calculator/page.tsx');
const SENDER = path.join(ROOT, 'src/components/client/ReportsSection.tsx');

test('THE PAGE ACTUALLY READS THE URL — the tests above are otherwise vacuous', () => {
  /*
   * Everything above passes whether or not the page imports any of it. The
   * original bug was EXACTLY that: a correct link, a correct endpoint, and a
   * page that never looked at the query string. So this asserts the wiring.
   */
  const src = fs.readFileSync(PAGE, 'utf8');
  assert.match(src, /useSearchParams/,
    'the page must read search params — without this the deep link is decorative');
  assert.match(src, /tatSeedFromParams\(/, 'and seed its state through the shared contract');
  assert.match(src, /tatKeyFor\(/,
    'Compute must use the SAME key builder as the seed, or a link computes a '
    + 'different query than the form it filled in');
  assert.doesNotMatch(src, /const DIMENSION_MODES = \[/,
    'the mode list must not be re-declared here — it belongs to the shared contract');
});

test('the client profile link carries everything the page needs', () => {
  const src = fs.readFileSync(SENDER, 'utf8');
  const m = /href=\{`\/admin-actions\/tat-calculator\?([^`]*)`\}/.exec(src);
  assert.ok(m, 'the TAT Calculator link must still exist on the client profile');
  const qs = m[1];
  assert.match(qs, /mode=client/, 'without it the calculator opens in job mode');
  assert.match(qs, /clientId=\$\{clientId\}/, 'the subject of the report');
  assert.match(qs, /days=30/,
    'the SLA-breach KPI on that page fetches ?days=30 — a link without it opens '
    + 'the calculator on its 90-day default and shows a DIFFERENT number than the '
    + 'one the operator just clicked away from');
});
