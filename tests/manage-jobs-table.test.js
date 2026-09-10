'use strict';
/*
 * The Manage Jobs grid renders the legacy 20 columns, in the legacy order.
 *
 * ─── WHAT THIS IS FOR (2026-09-10) ─────────────────────────────────────────
 *
 * Ops asked for the /jobs table to carry exactly the columns their old CRM's
 * Manage Jobs screen had. Header text and sequence come verbatim from
 * EasyFix_CRM/src/main/webapp/pages/jobs/manageJob.vm:778-797 — including its
 * "Escalted By" spelling, so an operator moving between the two screens reads
 * the same words in the same places. Anyone "fixing" that typo changes the
 * thing that was asked for.
 *
 * ─── WHY A SOURCE-SHAPE GUARD, AND WHAT IT CATCHES ─────────────────────────
 *
 * The suite mounts nothing, so these are shape assertions — but the failures
 * they block are all real and all silent:
 *
 *   · A header and its cell drifting apart. The <thead> and the row body are
 *     two independent hand-written runs; a column inserted in one and not the
 *     other shifts every cell after it, and the table still renders.
 *   · jobCols going stale. One constant feeds three colSpans; a wrong number
 *     is invisible until the list comes back empty.
 *   · A sort header naming a key the backend does not whitelist. That does not
 *     degrade — the validator derives its valid() list from SORTABLE_COLUMNS,
 *     so the request 400s and the grid renders EMPTY.
 *   · The element name appearing in PROSE. The backend's
 *     tests/wire-contract.test.js scans this file for sort headers and fails on
 *     any whose col= it cannot read; a comment that mentioned the element by
 *     name broke that gate the first time this table was rewritten.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'src/app/(authed)/jobs/page.tsx');
const src = fs.readFileSync(PAGE, 'utf8');

const thead = src.slice(src.indexOf('                <thead>'), src.indexOf('                </thead>'));
const tbody = src.slice(src.indexOf('                <tbody ref={vJobs.bodyRef}>'), src.indexOf('                </tbody>'));

/* The operator's list, verbatim, in order. */
const WANTED = [
  'Job booking reference id',
  'Job Id',
  'Age',
  'Cx Name &amp; Number',
  'Remark',
  'Open Due to',
  'City / PIN',
  'Client',
  'Client Ref Id',
  'Appointment Date',
  'Ticket Created',
  'Rating',
  'Bucket',
  'Bucket Status',
  'Category',
  'Client SPOC Name &amp; No.',
  'Easyfix SPOC',
  'Tx name -ID-Master/Under Master',
  'Escalted By',
  'Action',
];

test('the 20 headers render in exactly the requested order', () => {
  const found = [...thead.matchAll(/^\s*<(?:SortHeader[^>]*?|th[^>]*?)>(.+?)<\/(?:SortHeader|th)>/gm)]
    .map((m) => m[1].trim());
  assert.deepEqual(found, WANTED,
    `header text or order drifted.\n  got:    ${found.join(' | ')}\n  wanted: ${WANTED.join(' | ')}`);
});

test('"Escalted By" keeps the legacy spelling', () => {
  // Deliberate. The two screens run side by side during the migration, and the
  // request was for parity, not for a copy-edit.
  assert.ok(thead.includes('Escalted By'), 'the legacy spelling is what was asked for');
  assert.ok(!thead.includes('Escalated By'), 'a corrected spelling breaks the parity that was requested');
});

test('the header run and the cell run are the same length', () => {
  /*
   * Two independent hand-written runs. A column added to one and not the other
   * shifts every cell after it and the table still renders — no error, wrong
   * data under every subsequent heading. Both counts include the ONE
   * permission-gated bulk-select column, which must appear on both sides.
   */
  const heads = (thead.match(/^\s*<(SortHeader|th)\b/gm) || []).length;
  const cells = (tbody.match(/<td\b/g) || []).length - (tbody.match(/<td colSpan=/g) || []).length;
  assert.equal(cells, heads, `${heads} headers vs ${cells} cells`);

  const gate = '{canJob.isTransferJobOwnership && (';
  assert.equal(thead.split(gate).length - 1, 1, 'the select column must be gated once in the header');
  assert.equal(tbody.split(gate).length - 1, 1, 'and once in the row');
});

test('jobCols matches the real column count', () => {
  // One constant, three colSpans. It read 19/20 for the old shape and would be
  // silently wrong for the new one — visible only as a mis-spanned "Loading…".
  const m = src.match(/const jobCols = canJob\.isTransferJobOwnership \? (\d+) : (\d+);/);
  assert.ok(m, 'jobCols must still be a single constant');
  const heads = (thead.match(/^\s*<(SortHeader|th)\b/gm) || []).length;
  assert.equal(Number(m[1]), heads, 'with the select column');
  assert.equal(Number(m[2]), heads - 1, 'without it');
});

test('every sort header names a key the backend whitelists', () => {
  /*
   * Cross-repo, read from the backend's own map rather than a copy — a copy is
   * how the two whitelists drifted before. An unwhitelisted key does not
   * degrade to the default order: validators/job.validator.js derives its
   * valid() list from this map, so the request 400s and the grid is empty.
   */
  const beSrc = fs.readFileSync(
    '/Users/harshit/Documents/GitHub/EasyFix_Backend/services/job.service.js', 'utf8');
  const map = beSrc.slice(beSrc.indexOf('const SORTABLE_COLUMNS = {'));
  const allowed = new Set([...map.slice(0, map.indexOf('\n};')).matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]));
  assert.ok(allowed.size >= 20, `expected the BE whitelist, parsed ${allowed.size} keys`);

  const keys = [...thead.matchAll(/<SortHeader col=(?:"([^"]+)"|\{([^}]+)\})/g)]
    .map((m) => m[1] || m[2].trim());
  assert.ok(keys.length >= 9, `expected several sortable headers, found ${keys.length}`);
  for (const k of keys) {
    // JOB_AGE_SORT_KEY is the shared constant for 'age'.
    const resolved = k === 'JOB_AGE_SORT_KEY' ? 'age' : k;
    assert.ok(allowed.has(resolved), `sort key "${resolved}" is not in the backend whitelist`);
  }
});

test('the default sort is Age, not the backend fallback', () => {
  /*
   * Ops asked for oldest-first. Before this the state seeded to null and the
   * backend fell back to job_id DESC — the legacy screen only LOOKED age-sorted
   * because manageJob.vm hardcodes a sort-down icon in that header regardless
   * of state. A ?sort= in the URL still wins.
   */
  assert.match(src, /return s \? \(s\.split\(':'\)\[0\] \|\| null\) : JOB_AGE_SORT_KEY;/,
    'the sort key must seed to the shared age key');
  assert.match(src, /const \[sortDir, setSortDir\][\s\S]{0,200}'asc' : 'desc'/,
    'and descending, so the oldest orders come first');
});

test('the grid asks for the manage PROJECTION', () => {
  // Without this the nine new cells render em-dashes forever, with no error
  // anywhere: validate() runs with stripUnknown, so a misspelled key is
  // silently dropped rather than rejected.
  assert.match(src, /^\s*view: 'manage',$/m, 'the list request must send view=manage');
});

test('the element name never appears in PROSE', () => {
  /*
   * The backend's wire-contract gate scans this file for sort headers and
   * asserts it can read a col= off each one. A comment saying "a header is a
   * <SortHeader> only when…" gave it a match with no col= and failed the build
   * — the gate was right, the comment was the bug.
   */
  const prose = [...src.matchAll(/<SortHeader\b(?![^>]*\bcol=)/g)];
  assert.equal(prose.length, 0,
    `${prose.length} mention(s) of the element without a col= prop — the backend's `
    + 'wire-contract scanner fails on each of them');
});

test('the two current-product signals survived the column change', () => {
  /*
   * The retired Status column carried a delegation chip and a "No Services"
   * pill — signals with no legacy equivalent, so nothing in the requested
   * column list would have preserved them. They now qualify Bucket Status,
   * which is the state cell. Dropping them with the column would have removed
   * two working signals silently.
   */
  assert.match(tbody, /<ShareChip share=\{j\.share\}/, 'the delegation chip must still render');
  assert.match(tbody, /No Services/, 'and the no-services pill');
  const bucketAt = tbody.indexOf('{j.bucket_status || ');
  assert.ok(bucketAt > -1, 'the Bucket Status cell must exist');
  assert.ok(tbody.indexOf('<ShareChip', bucketAt) - bucketAt < 600,
    'the chip belongs in the Bucket Status cell, where it qualifies the state');
});
