'use strict';

/*
 * pagination — the arithmetic behind the table footer (ui/table-pagination.tsx).
 *
 * The reported bug: an operator on page 3 of a list narrows a filter, the result
 * set shrinks to one row, and the footer renders "Showing 21-1 of 1" beside a
 * page box reading "3 / 1" over an empty table. Nothing throws, nothing fails a
 * build, and it is invisible in development because you rarely page past 1 while
 * building a screen. Hence a test rather than a look.
 *
 * The original defect was a HALF-applied clamp: rangeEnd was bounded by `total`
 * (Math.min(..., total)) while rangeStart was computed from `page` alone, so the
 * two ends crossed the moment the page index overshot. Every assertion below is
 * about that invariant surviving.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computePageView } = require('../.test-build/pagination.js');

test('the exact reported case: page 2, size 10, total 1 does not render "21-1 of 1"', () => {
  const v = computePageView(2, 10, 1);
  assert.equal(v.totalPages, 1);
  assert.equal(v.safePage, 0, 'page must be clamped onto the only page that exists');
  assert.equal(v.rangeStart, 1);
  assert.equal(v.rangeEnd, 1);
  // The literal string the operator complained about, asserted as a string so a
  // future refactor that reintroduces it fails here and not in production.
  assert.notEqual(`${v.rangeStart}-${v.rangeEnd} of 1`, '21-1 of 1');
});

test('the range never runs backwards or past the data, at any page index', () => {
  for (const total of [0, 1, 9, 10, 11, 234, 26_000]) {
    for (const size of [10, 20, 50, 100]) {
      for (const page of [-5, 0, 1, 3, 99, 1e9]) {
        const v = computePageView(page, size, total);
        const at = `page ${page}, size ${size}, total ${total}`;
        assert.ok(v.safePage >= 0, `safePage ${v.safePage} < 0 at ${at}`);
        assert.ok(v.safePage < v.totalPages, `safePage ${v.safePage} >= totalPages ${v.totalPages} at ${at}`);
        assert.ok(v.rangeStart <= v.rangeEnd, `range runs backwards (${v.rangeStart}-${v.rangeEnd}) at ${at}`);
        assert.ok(v.rangeEnd <= total, `rangeEnd ${v.rangeEnd} > total ${total} at ${at}`);
        if (total > 0) assert.ok(v.rangeStart >= 1, `rangeStart ${v.rangeStart} < 1 at ${at}`);
      }
    }
  }
});

test('size 100 — the settings lists page at their inherited default, not at 50', () => {
  /*
   * The six settings lists (tools, verticals, document-types, skill-levels, both
   * rate-cards) carried `const PAGE_SIZE = 100` in their own hand-rolled footers.
   * When those were retired onto TablePagination, TablePageSize was widened from
   * 10|20|50|'all' to include 100 so the default survived the move. Nothing in
   * the type system notices if 100 stops being honoured — a size that silently
   * fell back to 50 would still type-check, still render a plausible footer, and
   * just show half the rows with double the pages. Hence arithmetic, not a type.
   */
  const v = computePageView(0, 100, 250);
  assert.equal(v.totalPages, 3, '250 rows at 100/page is 3 pages, not 5');
  assert.equal(v.rangeStart, 1);
  assert.equal(v.rangeEnd, 100, 'first page must end at row 100, not 50');

  // Second page — the offset the parent sends is page * 100, so the hint has to
  // agree with it or the footer describes rows the fetch never asked for.
  const p2 = computePageView(1, 100, 250);
  assert.equal(p2.rangeStart, 101);
  assert.equal(p2.rangeEnd, 200);

  // Last page is short, and the clamp still holds one size up.
  const p3 = computePageView(9, 100, 250);
  assert.equal(p3.safePage, 2, 'a stale index past the end clamps at size 100 too');
  assert.equal(p3.rangeStart, 201);
  assert.equal(p3.rangeEnd, 250);
});

test('an in-range page is left exactly as it was — the clamp must not move anyone', () => {
  // Regression guard for the opposite failure: a clamp that is too eager would
  // silently pin every list to page 1.
  const v = computePageView(1, 10, 234);
  assert.equal(v.safePage, 1);
  assert.equal(v.rangeStart, 11);
  assert.equal(v.rangeEnd, 20);
  assert.equal(v.totalPages, 24);
});

test('the last page reports a short range, not a full one', () => {
  const v = computePageView(23, 10, 234);
  assert.equal(v.safePage, 23);
  assert.equal(v.rangeStart, 231);
  assert.equal(v.rangeEnd, 234);
});

test('an empty list is one page showing 0-0, never "1-10 of 0"', () => {
  const v = computePageView(4, 10, 0);
  assert.equal(v.totalPages, 1, 'totalPages floors at 1 so the box reads "1 / 1", not "1 / 0"');
  assert.equal(v.safePage, 0);
  assert.equal(v.rangeStart, 0);
  assert.equal(v.rangeEnd, 0);
});

test("'all' is a single page — a stale index cannot leave the box reading '3 / 1'", () => {
  const v = computePageView(2, 'all', 7);
  assert.equal(v.totalPages, 1);
  assert.equal(v.safePage, 0);
  assert.equal(v.rangeStart, 1);
  assert.equal(v.rangeEnd, 7);
});

test("'all' on an empty list does not divide by zero", () => {
  const v = computePageView(0, 'all', 0);
  assert.equal(v.totalPages, 1);
  assert.equal(v.rangeStart, 0);
  assert.equal(v.rangeEnd, 0);
});

test('a NaN total from a failed fetch renders zeros, not "NaN-NaN of NaN"', () => {
  // total comes straight from a parent's fetch state; a failed or in-flight one
  // can hand us undefined -> NaN, which compares false against every guard and
  // renders literally as "NaN".
  const v = computePageView(3, 10, Number.NaN);
  assert.equal(v.totalPages, 1);
  assert.equal(v.safePage, 0);
  assert.equal(v.rangeStart, 0);
  assert.equal(v.rangeEnd, 0);
});

/*
 * The `loading` prop — a STRUCTURAL assertion, because this suite reaches only
 * pure modules (tests/*.test.js compile src/lib/* via test:build) and the
 * disabled logic lives in the component's render.
 *
 * WHAT IT PROTECTS: without `loading` folded into the nav's disabled state, an
 * operator on a slow list can click Next three times and queue three page
 * changes against one in-flight fetch — whichever response lands last wins, and
 * the footer then reads a page number the rows do not match.
 *
 * Each assertion carries its own control, because "the string is present"
 * proves nothing on its own: a file that merely MENTIONS loading in a comment
 * would satisfy a naive grep.
 */
test('TablePagination folds `loading` into the nav disabled state', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ui', 'table-pagination.tsx'), 'utf8');

  // The prop must exist on the type, and be optional so existing call sites
  // keep compiling untouched.
  assert.match(src, /loading\?:\s*boolean/, 'loading must be an OPTIONAL prop');
  assert.match(src, /loading\s*=\s*false/, 'it must default to false, or 53 call sites change behaviour');

  // Both nav directions must consult it — not just the one someone tested by hand.
  const prev = src.match(/const prevDisabled = [^;]+;/);
  const next = src.match(/const nextDisabled = [^;]+;/);
  assert.ok(prev && next, 'the disabled derivations should still exist — renamed?');
  assert.match(prev[0], /\bloading\b/, 'prevDisabled must consider loading');
  assert.match(next[0], /\bloading\b/, 'nextDisabled must consider loading');

  // CONTROL: those same derivations must STILL carry their original reasons.
  // Without this, replacing the whole expression with `loading` alone would
  // pass every assertion above while breaking the first/last page guards.
  assert.match(prev[0], /safePage\s*<=\s*first/, 'CONTROL: prev must still guard the first page');
  assert.match(next[0], /safePage\s*>=\s*last/, 'CONTROL: next must still guard the last page');
  assert.match(prev[0], /isAll/, 'CONTROL: prev must still be dead under All');
});
