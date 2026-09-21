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
const ORDERS = fs.readFileSync(path.join(__dirname, '..', 'src/app/(authed)/my-orders/page.tsx'), 'utf8');
const BAR = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/JobScopeBar.tsx'), 'utf8');

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

function runClear(initialQuery, src = PAGE, extras = {}) {
  const calls = { tab: [], page: [], ps: [], uw: [], replaced: [], wrote: [], filters: [] };
  const fn = evaluate(src, '  function clearTabScope() {', '\n  }', {
    setTab: (v) => calls.tab.push(v),
    setPage: (v) => calls.page.push(v),
    // /jobs resets the single filter state; /my-orders still owns a ps panel.
    setFilters: (fnOrVal) => calls.filters.push(
      typeof fnOrVal === 'function'
        ? fnOrVal({ bucketStatus: 'open', stages: ['scheduling'], offerState: 'offered', clientId: '7' })
        : fnOrVal,
    ),
    setPsFilters: (v) => calls.ps.push(v),
    setUnmappedWebsite: (v) => calls.uw.push(v),
    searchParams: new URLSearchParams(initialQuery),
    pathname: '/jobs',
    router: { replace: (url) => calls.replaced.push(url) },
    writePsFilterParams: (p, f) => { calls.wrote.push(f); ['psStatus', 'psCategory', 'psCity', 'psClient', 'psZonalManager'].forEach((k) => p.delete(k)); },
    EMPTY_PS_FILTERS,
    // /my-orders' clear also drops the Pending to Start sub-tab param.
    PTS_TAB_PARAM: 'ptsTab',
    ...extras,
  });
  fn();
  return calls;
}

test('clearing the scope removes the tab from the URL — otherwise a refresh restores it', () => {
  const c = runClear('tab=pending-scheduling&q=lenskart&sort=age:desc&unmappedWebsite=true');
  assert.equal(c.replaced.length, 1, 'the URL must be rewritten exactly once');
  const url = c.replaced[0];
  assert.ok(!/(\?|&)tab=/.test(url), `tab must be gone, got ${url}`);
  assert.ok(!/unmappedWebsite/.test(url), 'the preset goes with the scope');
  // Unrelated view state the operator chose is PRESERVED: clearing a scope is
  // not the same as clearing a search.
  assert.match(url, /q=lenskart/);
  assert.match(url, /sort=age%3Adesc|sort=age:desc/);
});

test('clearing resets the dropdowns the TAB pre-selected, not just the URL', () => {
  const c = runClear('tab=pending-scheduling');
  assert.deepEqual(c.tab, ['all']);
  assert.deepEqual(c.page, [0], 'page 3 of a narrowed list is not page 3 of all jobs');
  assert.deepEqual(c.uw, [false]);
  assert.equal(c.filters.length, 1, 'the filter state must be reset exactly once');
  const f = c.filters[0];
  assert.equal(f.bucketStatus, '', 'the bucket the tab selected must go');
  assert.deepEqual(f.stages, [], 'and the stage it selected');
  assert.equal(f.offerState, '', 'and the Scheduling Status narrowing');
  assert.equal(f.clientId, '7', 'but an unrelated filter the operator set survives');
});

test('with no query left, it replaces to the bare path rather than a dangling ?', () => {
  const c = runClear('tab=completed');
  assert.equal(c.replaced[0], '/jobs');
});

test('the shared bar renders only when a tab narrows the list, and hides the way out when the clamp owns it', () => {
  assert.match(BAR, /if \(tab === 'all'\) return null;/, 'no bar on the neutral view');
  assert.match(BAR, /Showing <span className="font-medium">\{label\}<\/span> Only/);
  assert.match(BAR, /\{!clamped && \([\s\S]{0,240}onClick=\{onClear\}/,
    'the clear action must be hidden when the stage clamp would snap the user back');
  assert.match(BAR, /Limited By Your Job Stage Access/, 'a clamped user is told why instead');
  assert.match(BAR, /if \(!allowedStages \|\| allowedStages\.mode === 'all'\) return false;/,
    'admin / finance / still-loading are never clamped');
});

test('/jobs renders the shared bar — it has no tab bar of its own', () => {
  /*
   * Positive control: the claim "no tab bar" is what makes the bar necessary.
   * Matched on the JSX USE (`<TabsTrigger`), not the bare word — the page
   * mentions the token in a comment documenting this very denominator, and a
   * prose mention is not a tab bar.
   */
  assert.equal((PAGE.match(/<TabsTrigger/g) || []).length, 0, 'jobs must still have no tab bar');
  /*
   * Props asserted INDIVIDUALLY, not as one formatted line: pinning the exact
   * one-liner broke the moment a fifth prop wrapped it across lines, which
   * says nothing about behaviour.
   */
  const at = PAGE.indexOf('<JobScopeBar');
  assert.ok(at > -1, 'jobs must render the shared bar');
  const el = PAGE.slice(at, PAGE.indexOf('/>', at) + 2);
  for (const prop of ['tab={tab}', 'clamped={scopeIsClamped}', 'onClear={clearTabScope}', 'noun="Jobs"']) {
    assert.ok(el.includes(prop), `jobs: the bar must receive ${prop} — got ${el}`);
  }
  assert.match(PAGE, /scopeIsClamped = scopeIsClampedFor\(me\?\.allowedStages\)/,
    'jobs must use the shared clamp predicate, not its own copy');
});

/*
 * my-orders RETIRED the shared "Showing X Only · Show All Orders" bar
 * (2026-09-21): every My Orders sidebar sub-menu already lands on a
 * dedicated single-bucket page, so naming the bucket again was telling ops
 * what the click they just made already told them. The exit is NOT gone with
 * it, though — no sidebar entry links to the unscoped /my-orders, so
 * "Show All Orders" is the only way back and now lives in the page header.
 */
test('my-orders retired the shared banner and states "Show All Orders" in the header instead', () => {
  assert.equal((ORDERS.match(/<TabsTrigger/g) || []).length, 0, 'my-orders must still have no tab bar');
  assert.ok(!/<JobScopeBar/.test(ORDERS), 'the banner must be gone from my-orders');
  assert.match(ORDERS, /scopeIsClamped = scopeIsClampedFor\(me\?\.allowedStages\)/,
    'my-orders must still use the shared clamp predicate');
  // Same visibility rule the retired bar's own exit used: hidden on the
  // neutral 'all' view, and hidden under the stage clamp (a "Show All" the
  // operator isn't permitted to sit on would fire and appear to do nothing).
  assert.match(ORDERS, /\{tab !== 'all' && !scopeIsClamped && \(/,
    'the exit must be gated the same way the retired bar gated its own onClear');
  // Matched on the JSX TEXT NODE, not a bare substring — the phrase also
  // appears in prose comments elsewhere in the file, which would let this
  // check pass on documentation alone.
  const linkMatch = ORDERS.match(/>\s*Show All Orders\s*</);
  assert.ok(linkMatch, 'the exit must still read "Show All Orders" as rendered text');
  const linkAt = linkMatch.index;
  const before = ORDERS.slice(Math.max(0, linkAt - 400), linkAt);
  assert.match(before, /onClick=\{clearTabScope\}/, 'the exit must call the same clearTabScope() as before');
});

test('my-orders states the bucket ONCE — the H1 suffix gave way to the bar', () => {
  assert.ok(!/· \{activeTab\.label\}/.test(ORDERS), 'the duplicate scope statement must be gone');
  assert.ok(!/const activeTab =/.test(ORDERS), 'and its now-dead lookup with it');
  assert.match(ORDERS, /<h1 className="text-2xl font-semibold">My Orders<\/h1>/);
});

test('clearing on my-orders drops the tab and the bucket filters too', () => {
  const c = runClear('tab=pending-scheduling&psCity=12&q=goa', ORDERS);
  assert.equal(c.replaced.length, 1);
  assert.ok(!/(\?|&)tab=/.test(c.replaced[0]), `tab must be gone, got ${c.replaced[0]}`);
  assert.ok(!/psCity/.test(c.replaced[0]));
  assert.match(c.replaced[0], /q=goa/, 'an unrelated search survives');
  assert.deepEqual(c.tab, ['all']);
  assert.deepEqual(c.page, [0]);
  assert.deepEqual(c.ps, [EMPTY_PS_FILTERS]);
});

test('clearing on my-orders also drops the Pending to Start sub-tab', () => {
  // Without this a "Show All Orders" from the Pending to Start strip left
  // ?ptsTab=missed behind, and the next visit reopened that tab unasked.
  const c = runClear('tab=pending-start&ptsTab=missed&q=goa', ORDERS);
  assert.ok(!/ptsTab=/.test(c.replaced[0]), `ptsTab must be gone, got ${c.replaced[0]}`);
  assert.match(c.replaced[0], /q=goa/, 'an unrelated search survives');
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

/* ─────────────────────────────────────────────────────────────────────
 * ONE PANEL FOR EVERYONE (2026-09-16). The reported symptom was a separate
 * "Pending For Scheduling Filters" card that only some users ever saw, above a
 * Filter Job panel whose own two status dropdowns were HIDDEN while it showed.
 * ───────────────────────────────────────────────────────────────────── */

test('Manage Jobs no longer hosts the separate bucket card', () => {
  // Positive control: the page must still be the one that filters jobs, or
  // these absence checks are asserting about the wrong file.
  assert.match(PAGE, /Filter Job|JOB ID \/ REF ID|bucketStatus/, 'this must be the Manage Jobs page');
  assert.ok(!/<PendingSchedulingFilters/.test(PAGE), 'the card must be gone from Manage Jobs');
  assert.ok(!/psActive &&|!psActive &&/.test(PAGE), 'and with it the gate that hid the panel controls');
  // /my-orders keeps its card — that page IS the per-bucket surface.
  assert.match(ORDERS, /<PendingSchedulingFilters/, 'My Orders still hosts it');
});

test('the two status dropdowns are rendered unconditionally, and offer only permitted values', () => {
  assert.match(PAGE, /options=\{bucketOptionsFor\(me\?\.allowedStages\)\}/,
    'the bucket list must be narrowed by the caller\'s stage grant');
  assert.match(PAGE, /options=\{jobStageOptionsFor\(filters\.bucketStatus, me\?\.allowedStages\)\}/,
    'and so must the Job Status list');
  // No conditional may wrap them any more — that was the whole defect.
  const bucketAt = PAGE.indexOf('>Bucket Status<');
  assert.ok(bucketAt > -1, 'the Bucket Status control must exist');
  /*
   * No conditional may stand between the comment above and the control — the
   * first version of this check was END-ANCHORED and a `{false && (` inserted
   * just before the <div> slipped straight past it (mutation M5 survived).
   * Positive control first: prove the window really is the control's own.
   */
  const before = PAGE.slice(Math.max(0, bucketAt - 260), bucketAt);
  assert.match(before, /<div>\s*\n\s*<label/, 'the window must cover the control markup');
  assert.ok(!/&&\s*\(/.test(before),
    `a conditional gates the Bucket Status control: …${before.slice(-140)}`);
});

test('the one control the card contributed survived, from the shared vocabulary', () => {
  assert.match(PAGE, />Scheduling Status<\/label>/, 'Scheduling Status moved into the panel');
  assert.match(PAGE, /options=\{PS_OFFER_STATE_OPTIONS\}/,
    'reusing the panel\'s own option list rather than a second copy of three values');
  assert.match(PAGE, /offerState \? \{ offerState: filters\.offerState \} : \{\}/,
    'and it must reach the list request');
  assert.match(PAGE, /qs\.set\('offerState', filters\.offerState\)/,
    'and the export, which has silently drifted from the table before');
});

test('a tab pre-selects the dropdowns, keyed on the selection so a no-op costs no request', () => {
  assert.match(PAGE, /const tabSelection = tabSelectionFor\(TABS\.find\(\(t\) => t\.value === tab\)\)/);
  assert.match(PAGE, /if \(!tabExpressed\) return;/, 'a tab that cannot be expressed leaves the dropdowns alone');
  assert.match(PAGE, /\}, \[tabSelKey\]\);/, 'keyed on the SELECTION, not on the tab');
  assert.match(PAGE, /\? f\s*\n?\s*:/, 'returns the same state object when nothing changed');
});

test('the scope bar is now the exception: only when the dropdowns cannot state the view', () => {
  assert.match(PAGE, /\{\(scopeIsClamped \|\| !tabExpressed\) && \(/,
    'expressible tabs are stated by the dropdowns, so the bar would duplicate them');
});

test('the bar does not NAME a scope the dropdowns own — it would go stale', () => {
  /*
   * Found by reading the shipped page against a screenshot: the label comes from
   * `tab`, and nothing writes `tab` when Job Status changes. A restricted user
   * switching to another granted stage therefore saw "Showing Pending for
   * Scheduling Only" above a table of Pending to Start.
   */
  assert.match(BAR, /nameScope\?: boolean;/, 'the component must take the mode');
  assert.match(BAR, /if \(!nameScope && !clamped\) return null;/,
    'with the scope stated elsewhere and nothing limiting it, there is nothing to say');
  assert.match(BAR, /\{nameScope \? \(/, 'the name is rendered only in naming mode');
  // The limitation-only branch must NOT carry the bucket label.
  const elseBranch = BAR.slice(BAR.indexOf(') : ('), BAR.indexOf('</span>', BAR.indexOf(') : (')));
  assert.match(elseBranch, /Limited By Your Job Stage Access/);
  assert.ok(!/\{label\}/.test(elseBranch), 'the stale half must not appear in the limitation-only branch');

  /*
   * Element-scoped, not a whole-file match: the comment above the element also
   * contains the literal `nameScope={!tabExpressed}`, so a file-wide regex would
   * pass on the prose alone if someone changed only the prop.
   */
  const barAt = PAGE.indexOf('<JobScopeBar');
  assert.ok(barAt > -1, 'Manage Jobs must render the bar');
  const barEl = PAGE.slice(barAt, PAGE.indexOf('/>', barAt) + 2);
  assert.match(barEl, /nameScope=\{!tabExpressed\}/,
    `the element must pass the mode, got ${barEl}`);
  // …and My Orders keeps naming it, because it has no such dropdowns.
  assert.ok(!/nameScope/.test(ORDERS), 'My Orders must keep the default naming mode');
});
