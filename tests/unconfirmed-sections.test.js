'use strict';
/*
 * My Orders -> Unconfirmed — what stays THIS page's own now that the order /
 * collapse / drag / keyboard / slide interaction has moved into the shared
 * <ReorderableSections>/<SectionFrame> (2026-09-14).
 *
 * The migration was required to change nothing an operator sees, so the things
 * that could silently change in it are pinned here:
 *   - the two localStorage keys (a different key = every saved arrangement
 *     silently reset, and no error anywhere);
 *   - the older v1 saved-order/collapse shapes still being read;
 *   - the auto-collapse rule, the count-only fetch for a shut section, and the
 *     per-section footer — the parts the shared component deliberately does NOT
 *     own, and which a migration is most likely to drop on the floor;
 *   - the px-3 inset that replaced each card's mx-3.
 *
 * Source-scanned, like pending-to-start-sections.test.js: these rules live in
 * .tsx that test:build does not compile, and each regression below is a plain
 * deletion that type-checks. The drag arithmetic is behaviour-tested in
 * tests/section-reorder.test.js; that the two pages share one copy of the
 * interaction is pinned in tests/pending-to-start-sections.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Comments are stripped before every scan — this file explains its migrated-out
// logic in prose, and a raw scan would read the explanation as the code.
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const UNCONFIRMED = 'src/components/job/UnconfirmedSections.tsx';
const SHARED = 'src/components/ui/reorderable-sections.tsx';

const src = strip(read(UNCONFIRMED));
const shared = strip(read(SHARED));

/* Everything inside <ReorderableSections …> … </ReorderableSections>. */
function reorderable(text) {
  const open = text.indexOf('<ReorderableSections');
  const close = text.indexOf('</ReorderableSections>');
  return open > 0 && close > open ? { open, text: text.slice(open, close) } : null;
}

// ─── 1. The five sections render through the shared component ────────────

test('the server\'s section list is what gets reordered, each section in a SectionFrame', () => {
  // The list is the SERVER's, so a sixth section is a backend change.
  assert.match(src, /useFetch<MetaResp>\('\/admin\/jobs\/unconfirmed-sections'\)/);
  assert.match(src, /const meta = metaReq\.data\?\.meta;/);

  const region = reorderable(src);
  assert.ok(region, 'the sections must be wrapped in <ReorderableSections>…</ReorderableSections>');
  assert.match(region.text, /sections=\{meta\}/,
    'the server\'s meta is the section set — hard-coding it here would strand a section added by the backend');
  assert.match(region.text, /orderKey=\{ORDER_KEY\}/);
  assert.match(region.text, /collapsedKey=\{COLLAPSED_KEY\}/);
  assert.match(region.text, /className="px-3 pt-3"/,
    'px-3 is the inset each card used to carry as mx-3; without it every card goes flush to the tab edge');
  assert.match(region.text, /<SectionCard\b[\s\S]*?controls=\{controls\}/,
    'each section gets its SectionControls, or nothing can be dragged, collapsed or numbered');
  assert.match(src, /<SectionFrame\s+label=\{section\.label\}/);
});

test('the totals-reconciliation banner stays out of the reorderable set', () => {
  // It is a warning about the sections, not a section: draggable, collapsible
  // or numbered it would be nonsense, and it must not take a position number.
  const region = reorderable(src);
  const banner = src.indexOf('These groupings are not trustworthy.');
  assert.ok(banner > 0, 'the mismatch banner must still be rendered');
  assert.ok(banner < region.open, 'and must sit above <ReorderableSections>, outside the reorderable set');
  assert.match(src, /reconcileSectionTotals\(\{\s*totals: \(meta \?\? \[\]\)\.map\(/,
    'the sum is taken over every section the server declared');
  assert.match(src, /pageTotal,/);
  assert.match(src, /reconciliation\.status === 'mismatch'/);
});

// ─── 2. Unconfirmed's own storage keys ───────────────────────────────────

const storageKeys = (text) => [...text.matchAll(/'(easyfix\.crm\.[\w.]+)'/g)].map((m) => m[1]);

test('order and collapse persist under Unconfirmed\'s own keys — the same two as before the migration', () => {
  assert.match(src, /const ORDER_KEY = 'easyfix\.crm\.unconfirmed\.sectionOrder\.v1';/,
    'a changed order key silently resets every operator\'s arrangement');
  assert.match(src, /const COLLAPSED_KEY = 'easyfix\.crm\.unconfirmed\.sectionCollapsed\.v1';/,
    'a changed collapse key silently resets every operator\'s pinned open/shut choices');

  const mine = storageKeys(src);
  assert.equal(mine.length, 2, `expected exactly ORDER_KEY and COLLAPSED_KEY, found ${mine.length}: ${mine}`);
  assert.notEqual(mine[0], mine[1],
    'order and collapse stay in separate entries — one blob means a change to either shape resets both');
  for (const k of mine) {
    assert.ok(!k.startsWith('easyfix.crm.pendingStart.'),
      `${k} is Pending to Start's key — the two pages would overwrite each other's arrangement`);
  }
});

test('the shared component still reads the v1 shapes these keys were written in', () => {
  // A bare ARRAY of collapsed keys (Unconfirmed's first shape) and a bare array
  // of section keys for the order. Dropping either resets real, deliberate
  // choices on deploy, and looks exactly like "the feature works".
  assert.match(shared, /if \(Array\.isArray\(v\)\) \{\s*return Object\.fromEntries\(\s*v\.filter\(\(k\) => typeof k === 'string'\)\.map\(\(k\) => \[k, true\]\),?\s*\);/,
    'the v1 collapsed ARRAY must still be converted, not discarded');
  assert.match(shared, /function reconcile<[^>]*>\(stored: unknown[\s\S]{0,400}?if \(Array\.isArray\(stored\)\)/,
    'a saved order is an array of keys, reconciled against the sections that exist today');
  assert.match(shared, /for \(const s of sections\) if \(!seen\.has\(s\.key\)\) out\.push\(s\);/,
    'a section added after the order was saved must still render, appended');
});

// ─── 3. The per-section behaviour the shared component does NOT own ──────

test('a section on auto opens when it has rows and shuts when it has none; an em dash until it knows', () => {
  assert.match(src, /collapsed=\{controls\.explicitCollapsed \?\? \(data \? total === 0 : false\)\}/,
    'auto rule: open while the count is unknown, shut at 0, an explicit click wins forever after');
  assert.match(src, /count=\{data \? total : null\}/,
    'null while unknown — the frame renders an em dash, never a 0 that means "not loaded yet"');
});

test('an explicitly shut section fetches its count and not its rows', () => {
  assert.match(src, /const countOnly = controls\.explicitCollapsed === true;/,
    'ONLY an explicit shut: a section on auto cannot know whether to open until the count arrives');
  assert.match(src, /limit: countOnly \? 1 : limit,/, 'limit=1 buys the total without a page of records');
  assert.match(src, /offset: countOnly \? 0 : page \* limit,/);
  assert.match(src, /section: section\.key,/, 'each section queries its own membership server-side');
  assert.match(src, /\.\.\.query,/, 'and inherits the tab\'s filters, so the page search reaches every section');
});

test('each section keeps its own page window and its own footer, inside the frame', () => {
  const card = src.slice(src.indexOf('function SectionCard('));
  assert.ok(card.length > 0, 'SectionCard must be found');
  assert.match(card, /const \[page, setPage\] = useState\(0\);/, 'page state is per section, not per page');
  assert.match(card, /const \[pageSize, setPageSize\] = useState<TablePageSize>\(10\);/);
  assert.match(card, /pageSizeToLimit\(pageSize, JOBS_MAX_LIMIT\)/,
    '"All" must send /admin/jobs\' own Joi cap of 500, not the helper\'s 1000 default (which 400s)');
  assert.match(src, /const JOBS_MAX_LIMIT = 500;/);
  assert.match(card, /\{data && total > 0 && \(\s*<TablePagination/,
    'the footer renders only once a response has arrived, so it never shows "1 / 0" against an unknown total');
  const frame = card.slice(card.indexOf('<SectionFrame'), card.indexOf('</SectionFrame>'));
  assert.match(frame, /<UnconfirmedJobsTable/, 'the table is the frame\'s body — collapsed, it is not rendered at all');
  assert.match(frame, /<TablePagination/, 'and so is the footer');
  assert.match(frame, /className="overflow-x-auto"/, 'the wide table scrolls inside its section');
});

test('a mutation still forces every section to refetch', () => {
  // invalidateFetch alone does NOT refresh a MOUNTED section (the key is a pure
  // function of the query, so useFetch's effect never re-runs) — the reloadKey
  // bump is what makes a sent magic link show its pill.
  assert.match(src, /invalidateFetch\(\(k\) => k\.startsWith\('\/admin\/jobs'\)\);/);
  assert.match(src, /setReloadKey\(\(k\) => k \+ 1\);/);
  assert.match(src, /onMagicLinkSent\?\.\(\);/, 'the page is told too — its own header count can change');
  assert.match(src, /refetch\(\);[\s\S]{0,120}?\}, \[reloadKey\]\);/, 'each section watches the signal');
});

// ─── Controls ────────────────────────────────────────────────────────────

test('positive control — the stripper removes prose and keeps code', () => {
  const sample = [
    '/* const ORDER_KEY = \'easyfix.crm.unconfirmed.decoy.v1\'; in prose */',
    'const kept = 1;',
    '// countOnly ? 1 : limit',
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('decoy'), 'block comments must go');
  assert.ok(!stripped.includes('countOnly'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'code must survive');
  assert.ok(src.length < read(UNCONFIRMED).length, 'this component has comments the scans excluded');
});

test('differential control — the pre-migration inline copy would be caught', () => {
  /*
   * The scans above are all assert.match, so they can only fail by DELETION.
   * The failure this file is really guarding is a partial migration, so mutate
   * the two values that a careless one changes and confirm both go red.
   */
  const wrongKey = src.replace(
    "const ORDER_KEY = 'easyfix.crm.unconfirmed.sectionOrder.v1';",
    "const ORDER_KEY = 'easyfix.crm.unconfirmed.sectionOrder.v2';",
  );
  assert.notEqual(wrongKey, src, 'the key mutation must land');
  assert.doesNotMatch(wrongKey, /const ORDER_KEY = 'easyfix\.crm\.unconfirmed\.sectionOrder\.v1';/);

  const noInset = src.replace('className="px-3 pt-3"', 'className="pt-3"');
  assert.notEqual(noInset, src, 'the inset mutation must land');
  const region = reorderable(noInset);
  assert.doesNotMatch(region.text, /className="px-3 pt-3"/);
});
