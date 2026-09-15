'use strict';
/*
 * The Manage Jobs grid renders the legacy columns, in the legacy order.
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
 * 19, not legacy's 20, since 2026-09-11 (per ops): "Job booking reference id"
 * took a whole column for one short string, so it now renders small under the
 * Job Id in the same cell — and the Job Id box searches both.
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

/*
 * WHERE THE BACKEND CHECKOUT IS — the repo's own resolution order, copied from
 * tests/emp-code-roundtrip.test.js and tests/message-literals.test.js rather
 * than reinvented.
 *
 * EASYFIX_BACKEND_DIR FIRST: CI shallow-clones the backend into RUNNER_TEMP and
 * points that variable at it, NOT as a sibling. The sibling path is the
 * developer-machine fallback.
 *
 * The first version of this file read an ABSOLUTE PATH on the author's laptop.
 * It passed locally for exactly that reason, then failed the QA and Production
 * deploys with ENOENT. A test that can only pass on one machine is worse than
 * no test: it reports green everywhere it is meaningless and red only where it
 * runs for real.
 *
 * THROWS rather than skipping, deliberately. This is the cross-repo half of the
 * sort contract; message-literals.test.js records the same rule, that a guard
 * which downgrades itself reports the same green as one that ran. The repo also
 * runs scripts/test-no-skips.js, which treats a skip as a failure anyway.
 */
function backendRoot() {
  for (const root of [process.env.EASYFIX_BACKEND_DIR,
    path.join(__dirname, '..', '..', 'EasyFix_Backend')]) {
    if (root && fs.existsSync(path.join(root, 'services/job.service.js'))) return root;
  }
  throw new Error('EasyFix_Backend checkout not found — set EASYFIX_BACKEND_DIR or clone it '
    + 'beside this repo. This is the cross-repo half of the sort contract and must not '
    + 'degrade to a pass.');
}

const thead = src.slice(src.indexOf('                <thead>'), src.indexOf('                </thead>'));
const tbody = src.slice(src.indexOf('                <tbody ref={vJobs.bodyRef}>'), src.indexOf('                </tbody>'));

/* The operator's list, verbatim, in order. */
const WANTED = [
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

test('the 19 headers render in exactly the requested order', () => {
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
  const beSrc = fs.readFileSync(path.join(backendRoot(), 'services/job.service.js'), 'utf8');
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

test('the default sort is the backend\'s job_id DESC — newest first', () => {
  /*
   * Reverted 2026-09-11, per ops. For one day the key seeded to Age DESC, and
   * page 1 filled with long-closed cancelled and failed orders: age runs to the
   * terminal timestamp, so a job that sat open for months before it was
   * cancelled outranks everything booked this week. With no key the backend
   * falls back to job_id DESC. A ?sort= in the URL still wins.
   */
  assert.match(src, /return s \? \(s\.split\(':'\)\[0\] \|\| null\) : null;/,
    'with no ?sort= the key must seed to null, so the backend default applies');
  assert.doesNotMatch(src, /: JOB_AGE_SORT_KEY;/,
    'Age must not come back as the seeded default');
  // Age stays SORTABLE — only the default changed.
  assert.match(thead, /<SortHeader col=\{JOB_AGE_SORT_KEY\}/, 'the Age header still sorts on click');
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

test('the booking reference id rides under the Job Id, and Job Id holds the pinned slot', () => {
  /*
   * Header and cell are pinned by two separate class lists. Moving only one of
   * them pins a header over a scrolling column (or the reverse), and nothing
   * errors. The select column, when present, comes first on BOTH sides, so the
   * pinned one is the second opening tag on each.
   */
  const heads = [...thead.matchAll(/^\s*<(?:SortHeader|th)\b[^\n]*/gm)].map((m) => m[0]);
  const cells = [...tbody.matchAll(/<td\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/colSpan=/.test(t));
  assert.ok(heads.length > 2 && cells.length > 2, 'the parse must have found the header and cell runs');
  assert.match(heads[1], /col="job_id"[^\n]*className="stick-col-head stick-left">Job Id</, 'Job Id is the pinned first data header');
  assert.match(cells[1], /stick-col stick-left/, 'and its cell is the pinned first data cell');
  assert.equal((thead.match(/stick-left/g) || []).length, 1, 'exactly one pinned-left header');
  assert.equal((tbody.match(/stick-left/g) || []).length, 1, 'exactly one pinned-left cell');

  // The reference lives INSIDE the Job Id cell: small, muted, only when present.
  const start = tbody.indexOf(cells[1]);
  const cell = tbody.slice(start, tbody.indexOf('</td>', start));
  assert.match(cell, /#\{j\.job_id\}/, 'the cell still shows the id');
  assert.match(cell, /<CallHistoryButton jobId=\{j\.job_id\} \/>/, 'and keeps its call-history popover');
  assert.match(cell, /\{j\.job_reference_id && \(\s*<div className="[^"]*\btext-xs\b[^"]*\btext-muted-foreground\b/,
    'the reference renders small and muted, and only when the job has one');
  assert.equal((tbody.match(/j\.job_reference_id/g) || []).length, (cell.match(/j\.job_reference_id/g) || []).length,
    'and nowhere else in the row');
});

test('the Job Id box searches ids AND booking references, on the param the backend reads', () => {
  /*
   * jobIds is digits-only on the backend, so the REF-… shown under every id was
   * a 400 behind a grid that keeps its old rows on error. The box now sends
   * jobIdOrRef, and strips to the backend's own alphabet — read from the
   * validator here rather than copied, because a character the box keeps and
   * the validator rejects is that same silent 400.
   */
  assert.match(src, /^\s*jobIdOrRef: serverQ \|\| undefined,$/m, 'the list request must send jobIdOrRef');
  assert.doesNotMatch(src, /^\s*jobIds: serverQ/m, 'and not the digits-only jobIds');
  // The Export button too: `q` there was a different search inside a 6-month
  // window, so the sheet disagreed with the grid it claims to mirror.
  assert.match(src, /if \(serverQ\) qs\.set\('jobIdOrRef', serverQ\);/, 'the export must send the grid’s param');
  assert.doesNotMatch(src, /qs\.set\('q', serverQ\)/, 'and not the eleven-column q');
  assert.match(src, /setQ\(e\.target\.value\.replace\(JOB_ID_OR_REF_STRIP, ''\)\)/, 'typing is stripped');
  assert.match(src, /\(searchParams\.get\('q'\) \|\| ''\)\.replace\(JOB_ID_OR_REF_STRIP, ''\)/,
    'and so is a ?q= restored from the URL — a bookmark from the name-search era would 400');

  const fe = /const JOB_ID_OR_REF_STRIP = \/\[\^([^\]]+)\]\/g;/.exec(src);
  const beSrc = fs.readFileSync(path.join(backendRoot(), 'validators/job.validator.js'), 'utf8');
  const be = /jobIdOrRef: Joi\.string\(\)\.pattern\(\/\^\[([^\]]+)\]\+\$\/\)/.exec(beSrc);
  assert.ok(fe, 'the FE strip class must be parseable');
  assert.ok(be, 'the BE jobIdOrRef pattern must be parseable');
  assert.equal(fe[1], be[1], 'the box must keep exactly the characters the backend accepts');

  const strip = new RegExp(`[^${fe[1]}]`, 'g');
  assert.equal('REF-538916, 482505'.replace(strip, ''), 'REF-538916,482505', 'a pasted list survives, minus the space');
});
