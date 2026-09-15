'use strict';
/*
 * The Unconfirmed table carries the booking reference UNDER the Job #, not in a
 * column of its own.
 *
 * ─── WHAT THIS IS FOR (2026-09-11) ─────────────────────────────────────────
 *
 * Ops: "job booking reference id taking long space in table — mention it small
 * under the Job Id only." The main /jobs grid got that first (its guard is
 * tests/manage-jobs-table.test.js); Manage Jobs' Unconfirmed tab renders THIS
 * shared component instead, and so does every section of My Orders' Unconfirmed
 * tab, so it kept its own "Job Ref" column until now.
 *
 * ─── WHAT IT CATCHES ───────────────────────────────────────────────────────
 *
 * Source-shape assertions (the suite mounts nothing), each blocking a silent
 * failure:
 *
 *   · Header and cell drifting apart — two hand-written runs; a column dropped
 *     from one side shifts every later cell under the wrong heading.
 *   · The two colSpan literals going stale — a mis-spanned "Loading…" / empty
 *     row, visible only when the list is empty.
 *   · The reference drifting from the /jobs markup it was asked to match — the
 *     same identifier rendering two ways on the two tabs of one screen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/components/job/UnconfirmedJobsTable.tsx'), 'utf8');
const jobsPage = fs.readFileSync(path.join(ROOT, 'src/app/(authed)/jobs/page.tsx'), 'utf8');

const thead = src.slice(src.indexOf('<thead>'), src.indexOf('</thead>'));
const tbody = src.slice(src.indexOf('<tbody>'), src.indexOf('</tbody>'));
const heads = [...thead.matchAll(/^\s*<(?:SortHeader|th)\b[^\n]*/gm)].map((m) => m[0]);
const cells = [...tbody.matchAll(/<td\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/colSpan=/.test(t));

// The reference line, whitespace-normalised so indentation depth cannot matter.
const REF_BLOCK = /\{j\.job_reference_id && \(\s*<div[^>]*>\s*\{j\.job_reference_id\}\s*<\/div>\s*\)\}/g;
const norm = (s) => s.replace(/\s+/g, ' ');

test('the parse found the header and cell runs', () => {
  // A slice that silently came back empty would make every test below vacuous.
  assert.ok(heads.length >= 10, `expected the header run, parsed ${heads.length}`);
  assert.ok(cells.length >= 10, `expected the cell run, parsed ${cells.length}`);
});

test('the header run and the cell run are the same length, and both colSpans match it', () => {
  assert.equal(cells.length, heads.length, `${heads.length} headers vs ${cells.length} cells`);
  const spans = [...tbody.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
  assert.equal(spans.length, 2, 'the Loading and empty rows each carry one colSpan');
  for (const n of spans) assert.equal(n, heads.length, `colSpan ${n} vs ${heads.length} columns`);
});

test('no Job Ref column, and no sort by it', () => {
  assert.ok(!heads.some((h) => />\s*Job Ref\s*</.test(h)), 'the Job Ref header is gone');
  assert.doesNotMatch(thead, /col="job_reference_id"/, 'and so is its sort');
});

test('the booking reference rides under the Job #, which holds the pinned slot', () => {
  assert.match(heads[0], /col="job_id"[^\n]*className="stick-col-head stick-left">Job #</, 'Job # is the pinned first header');
  assert.match(cells[0], /stick-col stick-left/, 'and its cell is the pinned first cell');
  assert.equal((thead.match(/stick-left/g) || []).length, 1, 'exactly one pinned-left header');
  assert.equal((tbody.match(/stick-left/g) || []).length, 1, 'exactly one pinned-left cell');

  const start = tbody.indexOf(cells[0]);
  const cell = tbody.slice(start, tbody.indexOf('</td>', start));
  assert.match(cell, /#\{j\.job_id\}/, 'the cell still shows the id');
  assert.match(cell, /<CallHistoryButton jobId=\{j\.job_id\} \/>/, 'and keeps its call-history popover');
  assert.match(cell, /\{j\.job_reference_id && \(\s*<div className="[^"]*\btext-xs\b[^"]*\btext-muted-foreground\b/,
    'the reference renders small and muted, and only when the job has one');
  assert.equal((tbody.match(/j\.job_reference_id/g) || []).length, (cell.match(/j\.job_reference_id/g) || []).length,
    'and nowhere else in the row');
});

test('the reference markup is the /jobs Job Id cell\'s, verbatim', () => {
  const here = src.match(REF_BLOCK) || [];
  const there = jobsPage.match(REF_BLOCK) || [];
  assert.equal(here.length, 1, 'one reference block in the Unconfirmed table');
  assert.equal(there.length, 1, 'one reference block in the /jobs grid');
  assert.equal(norm(here[0]), norm(there[0]), 'the two tabs of Manage Jobs render the reference the same way');
});
