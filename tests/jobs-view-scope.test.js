'use strict';
/*
 * Manage Jobs: the view scope must be VISIBLE and clearable, and the legacy
 * route map's prose must agree with the map.
 *
 * ─── WHY (2026-09-16) ──────────────────────────────────────────────────────
 *
 * /jobs has no tab bar (grep TabsTrigger in that page: 0 hits), so a `?tab=`
 * in the URL narrowed the whole list with nothing on screen saying so. An
 * Admin arrived on ?tab=pending-scheduling from an old bookmark, saw a
 * "Pending For Scheduling Filters" panel no colleague had, and reported the UI
 * as differing per user. It did not — the URL differed.
 *
 * The param stays: five live deep links use it (AttentionSummary x4 and
 * jobs/upload). What was missing is a statement of the scope and a way out,
 * and what MADE the stale bookmarks is prose that still pointed those buckets
 * at /jobs eleven lines above a map that sends them to /my-orders. Prose no
 * test can read is prose that drifts, so the last test here reads it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src/app/(authed)/jobs/page.tsx'), 'utf8');
const MAP = fs.readFileSync(path.join(__dirname, '..', 'src/lib/legacy-url-map.ts'), 'utf8');
const PSF = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/PendingSchedulingFilters.tsx'), 'utf8');

/* Transpile one top-level declaration out of a TSX file and evaluate it. */
function evaluate(src, startMarker, endMarker, closure = {}) {
  const start = src.indexOf(startMarker);
  assert.ok(start > -1, `could not find ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `could not find the end of ${startMarker}`);
  // Strip `export`: transpiled to CommonJS it becomes `exports.X = …`, which
  // leaves no local binding for the `return X` below — the first run of this
  // file died on exactly that, not on the code under test.
  const body = src.slice(start, end + endMarker.length).replace(/^export\s+/m, '');
  const { outputText } = ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, removeComments: true },
  });
  const names = Object.keys(closure);
  const returned = startMarker.includes('function ')
    ? startMarker.replace(/^\s*(async\s+)?function\s+/, '').replace(/\(.*$/, '')
    : startMarker.replace(/^export const /, '').replace(/[:=].*$/, '').trim();
  return new Function(...names, `${outputText}; return ${returned};`)(...names.map((n) => closure[n]));
}

const EMPTY_PS_FILTERS = evaluate(PSF, 'export const EMPTY_PS_FILTERS', '\n};');

test('the empty-filter constant was really extracted, not defaulted to {}', () => {
  // Positive control for the two tests below: they compare against this value,
  // so an empty object here would make them pass while proving nothing.
  assert.equal(typeof EMPTY_PS_FILTERS, 'object');
  assert.ok(Object.keys(EMPTY_PS_FILTERS).length >= 4,
    `expected the real PsFilters shape, got ${JSON.stringify(EMPTY_PS_FILTERS)}`);
});

function runClear(initialQuery) {
  const calls = { tab: [], page: [], ps: [], uw: [], replaced: [], wrote: [] };
  const fn = evaluate(PAGE, '  function clearTabScope() {', '\n  }', {
    setTab: (v) => calls.tab.push(v),
    setPage: (v) => calls.page.push(v),
    setPsFilters: (v) => calls.ps.push(v),
    setUnmappedWebsite: (v) => calls.uw.push(v),
    searchParams: new URLSearchParams(initialQuery),
    pathname: '/jobs',
    router: { replace: (url) => calls.replaced.push(url) },
    writePsFilterParams: (p, f) => { calls.wrote.push(f); ['psStatus', 'psCategory', 'psCity', 'psClient', 'psZonalManager'].forEach((k) => p.delete(k)); },
    EMPTY_PS_FILTERS,
  });
  fn();
  return calls;
}

test('clearing the scope removes the tab from the URL — otherwise a refresh restores it', () => {
  const c = runClear('tab=pending-scheduling&psCity=12&q=lenskart&sort=age:desc');
  assert.equal(c.replaced.length, 1, 'the URL must be rewritten exactly once');
  const url = c.replaced[0];
  assert.ok(!/(\?|&)tab=/.test(url), `tab must be gone, got ${url}`);
  assert.ok(!/psCity/.test(url), `the bucket's own filters must go with it, got ${url}`);
  // Unrelated view state the operator chose is PRESERVED: clearing a scope is
  // not the same as clearing a search.
  assert.match(url, /q=lenskart/);
  assert.match(url, /sort=age%3Adesc|sort=age:desc/);
});

test('clearing resets the bucket state it was showing, not just the URL', () => {
  const c = runClear('tab=pending-scheduling&unmappedWebsite=true');
  assert.deepEqual(c.tab, ['all']);
  assert.deepEqual(c.page, [0], 'page 3 of a narrowed list is not page 3 of all jobs');
  assert.deepEqual(c.ps, [EMPTY_PS_FILTERS]);
  assert.deepEqual(c.uw, [false]);
  assert.deepEqual(c.wrote, [EMPTY_PS_FILTERS], 'the URL writer must be handed the EMPTY filters');
});

test('with no query left, it replaces to the bare path rather than a dangling ?', () => {
  const c = runClear('tab=completed');
  assert.equal(c.replaced[0], '/jobs');
});

test('the scope bar renders only when a tab narrows the list, and hides the way out when the clamp owns it', () => {
  assert.match(PAGE, /\{tab !== 'all' && \(/, 'the bar is gated on a narrowing tab');
  assert.match(PAGE, /Showing <span className="font-medium">\{scopeLabel\}<\/span> Only/);
  assert.match(PAGE, /\{!scopeIsClamped && \([\s\S]{0,200}onClick=\{clearTabScope\}/,
    'the clear action must be hidden when the stage clamp would snap the user back');
  assert.match(PAGE, /scopeIsClamped = !!allowedStages && allowedStages\.mode !== 'all'\s*\n?\s*&& !filterTabsForStages\(TABS, allowedStages\)\.some\(\(t\) => t\.value === 'all'\)/,
    'clamped means: stage-restricted AND not permitted to sit on all');
});

test("the legacy map's own prose points where the map actually points", () => {
  /*
   * The drift this catches: the table was repointed from /jobs to /my-orders
   * and the comment above it was not, so every bookmark made from the comment's
   * claim kept working against a page that no longer advertised the bucket.
   */
  const documented = [...MAP.matchAll(/^\s*\*\s+(\w+)\s+→\s+(\/[\w-]+)\?tab=([\w-]+)/gm)]
    .map(([, enumDesc, page, tab]) => ({ enumDesc, page, tab }));
  assert.ok(documented.length >= 8,
    `parsed ${documented.length} documented routes — the matcher is broken, not the comment`);
  let compared = 0;
  for (const d of documented) {
    const re = new RegExp(`'dashboardChecking\\?enumDesc=${d.enumDesc}':\\s*'([^']+)'`);
    const m = MAP.match(re);
    assert.ok(m, `the comment documents ${d.enumDesc} but the map has no such key`);
    assert.equal(m[1], `${d.page}?tab=${d.tab}`,
      `${d.enumDesc}: the comment says ${d.page}?tab=${d.tab}, the map says ${m[1]}`);
    compared += 1;
  }
  assert.equal(compared, documented.length);
  console.log(`legacy map prose: ${compared}/${documented.length} documented routes match the map`);
});
