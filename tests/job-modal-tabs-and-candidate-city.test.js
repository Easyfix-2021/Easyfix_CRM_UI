'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Three ops-requested changes, 2026-09-09:
 *
 *   1. Schedule tab — "TX details will go in the summary. Here will show
 *      scheduling history."
 *   2. Services tab — "Service status not required here - we will show client
 *      charges and TX charges and EF margin %"; "Category will be pre selected
 *      like job type"; "Once job will have only 1 category - so that can be
 *      removed from service table".
 *   3. Schedule & Assign — "show TX city here. search by city as well."
 *
 * Only ONE of these can put a wrong number in front of an operator, and that is
 * the reason this file exists. The rest is layout; the charge mapping is money.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM.
 */

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/*
 * Comments stripped before every structural scan — a guard in this repo has
 * already failed because its own docblock mentioned the identifier it asserted
 * the absence of. The runs below are BOUNDED for the same reason the scanners
 * in tests/report-client-scope-claims.test.js were bounded today: a lazy run
 * that can leave its region reports green on source it should reject.
 */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const modalSrc = read('components', 'job', 'JobModal.tsx');
const tableSrc = read('components', 'job', 'CandidateTable.tsx');
const modal = strip(modalSrc);
const table = strip(tableSrc);

// ── 1. The money mapping ─────────────────────────────────────────────

/*
 * The payload's layer names do not mean what they look like. A single unit
 * price cascades through four deductions (utils/rate-card-calc.js):
 *
 *   totalCharge    the rate-card price — what the CLIENT is billed. The top;
 *                  everything else is carved out of it.
 *   easyfixDirect  L1, EasyFix's direct share
 *   overhead       L2, bundled into easyfix_charge with L1 — together, MARGIN
 *   clientShare    L3, the operator true-up bucket. NOT the client's bill.
 *   remainder      L4 residual, stored as easyfixer_charge — the TECHNICIAN's.
 *
 * `clientShare` is the trap: it is the one field whose NAME says "client" and
 * whose VALUE is not what the client pays. Reaching for it would put a
 * plausible, wrong, unfalsifiable number on the screen — nobody reviewing the
 * UI could tell, because every layer is a rupee figure of a believable size.
 */

// Bounded to the services <td> block so a match cannot drift into the
// breakdown-expansion panel below, which legitimately renders every layer.
const MONEY_CELLS = /<td className="!text-right font-mono text-xs">(?:(?!<\/tbody>)[\s\S])*?EF Margin|Client ₹/;

test('the three money columns exist and are right-aligned', () => {
  for (const header of ['Client ₹', 'TX ₹', 'EF Margin %']) {
    assert.ok(
      modal.includes(`>${header}</th>`),
      `the services table must carry a ${header} column`,
    );
  }
  assert.ok(MONEY_CELLS.test(modal), 'positive control: the money cells must be findable');
});

test('client = totalCharge, TX = remainder — the two that decide what is owed', () => {
  assert.match(
    modal,
    /\{line \? `₹\$\{line\.lineTotal\.totalCharge\.toFixed\(2\)\}` : '—'\}/,
    'the client charge must read the TOP of the cascade (totalCharge), the rate-card price',
  );
  assert.match(
    modal,
    /\{line \? `₹\$\{line\.lineTotal\.remainder\.toFixed\(2\)\}` : '—'\}/,
    "the TX charge must read the L4 residual (remainder), stored as easyfixer_charge",
  );
});

test('EF margin is (client − TX) / client — the SAME definition Billing & Charges uses', () => {
  /*
   * There is a more literal reading — easyfixDirect + overhead, EasyFix's own
   * two layers — and it is rejected on purpose. BillingChargesTab, in this same
   * modal, has shipped `inr(r.client - r.tx)` for a while; two tabs quoting
   * different margins for one job is exactly the two-readers-one-fact defect
   * this codebase keeps paying for. The two formulas differ by the L3
   * clientShare layer alone, which the rate-card worked example puts at 0%.
   *
   * Pinned in BOTH files, so a change to either is a failure rather than a
   * silent divergence.
   */
  assert.match(
    modal,
    /line\.lineTotal\.totalCharge - line\.lineTotal\.remainder\)\s*\/ line\.lineTotal\.totalCharge/,
    'margin must be (client − TX) over client',
  );
  const billing = strip(read('components', 'job', 'BillingChargesTab.tsx'));
  assert.match(
    billing,
    /inr\(r\.client - r\.tx\)/,
    'the Billing tab must still use client − tx — if it changes, this tab must change with it',
  );
  assert.match(
    modal,
    /line\.lineTotal\.totalCharge > 0/,
    'and must guard the divisor — a zero-priced service must render —, not NaN%',
  );
});

test('clientShare never reaches the services table — the named trap', () => {
  /*
   * The breakdown-expansion panel DOES render clientShare, legitimately, so
   * this cannot be a whole-file absence check. Scoped to the table body.
   */
  const body = modal.slice(modal.indexOf('>Client ₹</th>'), modal.indexOf('</tbody>', modal.indexOf('>Client ₹</th>')));
  assert.ok(body.length > 0, 'positive control: the table body must be locatable');
  assert.ok(
    !/clientShare/.test(body),
    'clientShare is the operator true-up bucket, not the client bill — it must not appear in these cells',
  );
});

test('the breakdown is loaded eagerly, or all three columns are permanently —', () => {
  /*
   * It used to load on the per-row "Show Breakdown" click. Columns that are
   * always visible cannot wait for a click that may never come; without this
   * the money reads as em-dashes forever and looks like missing data.
   */
  assert.match(
    modal,
    /useEffect\(\(\) => \{\s*void ensureBreakdown\(\);/,
    'ensureBreakdown must run on mount',
  );
});

// ── 2. Columns removed, and what replaced their information ──────────

test('Service Category and Status are gone as COLUMNS', () => {
  const head = modal.slice(modal.indexOf('<th>Job#</th>'), modal.indexOf('</thead>', modal.indexOf('<th>Job#</th>')));
  assert.ok(head.length > 0, 'positive control: the services header must be locatable');
  assert.ok(!head.includes('Service Category'), 'a job has one category — the column repeated it on every row');
  assert.ok(!/>Status</.test(head), 'Active/Inactive no longer earns a column');
});

test('but the inactive STATE survives, inline — removing the column is not removing the fact', () => {
  assert.match(
    modal,
    /\{!isActive && \(\s*<StatusChip tone="slate" size="sm" className="ml-1\.5">Inactive<\/StatusChip>\s*\)\}/,
    'an inactive row must still say so in words; dimming alone is a difference in degree',
  );
  assert.match(
    modal,
    /Show Inactive \(\{inactiveCount\}\)/,
    'the Show Inactive checkbox must stay — it is the only route to Restore, and the '
    + 'Remove confirmation promises it by name',
  );
});

test('the empty-state and breakdown spans follow the header, or the layout tears', () => {
  const head = modal.slice(modal.indexOf('<th>Job#</th>'), modal.indexOf('</thead>', modal.indexOf('<th>Job#</th>')));
  const cols = (head.match(/<th[\s>]/g) || []).length;
  assert.equal(cols, 8, 'the services header must have 8 columns');
  assert.match(modal, /<tr><td colSpan=\{8\} className="text-center text-muted-foreground py-8">No services/);
  assert.ok(
    !/<td colSpan=\{6\} className="bg-ink-50/.test(modal),
    'the breakdown-expansion rows must span the new width, not the old one',
  );
});

// ── 3. Category pre-selected from the job, like Job Type ─────────────

test('the category is seeded from the job column, not left blank', () => {
  assert.match(
    modal,
    /const \[addCatgId, setAddCatgId\] = useState<string>\(\s*\(\) => \(job\.fk_service_catg_id != null \? String\(job\.fk_service_catg_id\) : ''\),\s*\)/,
    'addCatgId must seed from tbl_job.fk_service_catg_id — the rate-card list says which '
    + 'categories are AVAILABLE, never which one this job is',
  );
});

test('a successful add re-seeds rather than blanks — else the first Add loses the pin', () => {
  assert.ok(
    !/^\s*setAddCatgId\(''\);\s*$/m.test(modal),
    'blanking after submit is what made the control look unset on a job that has a category',
  );
  assert.match(
    modal,
    /setAddCatgId\(job\.fk_service_catg_id != null \? String\(job\.fk_service_catg_id\) : ''\);/,
    'the post-submit reset must restore the seed',
  );
});

// ── 4. Schedule tab: technician out, history in ──────────────────────

test('the Assignment card is gone and its rows landed in Summary', () => {
  assert.ok(
    !/<DlCard title="Assignment"/.test(modal),
    'the Assignment card must be retired from the Schedule tab',
  );
  const jobMeta = modal.slice(modal.indexOf('<DlCard title="Job Meta"'), modal.indexOf('<DlCard title="Audit & History"'));
  assert.ok(jobMeta.length > 0, 'positive control: the Job Meta card must be locatable');
  for (const row of ["['Technician'", "['Tech mobile'", "['Helper Req'"]) {
    assert.ok(jobMeta.includes(row), `${row} must now live on Summary's Job Meta card`);
  }
});

test('Time slot stayed on Schedule — it is WHEN, not WHO', () => {
  const timeline = modal.slice(modal.indexOf('<DlCard title="Timeline"'), modal.indexOf(']}/>', modal.indexOf('<DlCard title="Timeline"')));
  assert.ok(timeline.includes("['Time slot'"), 'Time slot belongs with the other scheduling facts');
  assert.ok(!timeline.includes("['Technician'"), 'but the technician does not');
});

test('scheduling history reads the record, not the commentary', () => {
  assert.match(modal, /<JobSchedulingHistory jobId=\{Number\(job\.job_id\)\} \/>/, 'it must be mounted');
  assert.match(
    modal,
    /useFetch<ScheduleRow\[\]>\(`\/admin\/reports\/job-tracking\?jobId=\$\{jobId\}`\)/,
    'it must read the scheduling_history endpoint — no new backend was needed',
  );
  /*
   * NOT the same source as JobRescheduleHistory on Summary, which reads
   * tbl_job_comment for changes an operator narrated. A reschedule with no
   * comment appears only in scheduling_history, so neither is derivable from
   * the other and both are kept.
   */
  assert.match(modal, /<JobRescheduleHistory jobId=/, 'the comment-derived trail stays on Summary');
  assert.match(
    modal,
    /function JobSchedulingHistory/,
    'and the new one is its own component, not a rename of that',
  );
});

// ── 5. Schedule & Assign: the city the search already matched ────────

test('the candidate table shows the technician city', () => {
  assert.match(table, /city_name: string \| null;/, 'ScheduleCandidate must declare it');
  assert.match(table, /<th className="!text-left min-w\[120px\]">City<\/th>|<th className="!text-left min-w-\[120px\]">City<\/th>/);
  assert.match(
    table,
    /\{c\.city_name \|\| <span className="text-muted-foreground">—<\/span>\}/,
    'and render it, with an em-dash for a technician whose city is unset',
  );
});

test('COLS matches the real header count — a stale span only shows when the list is empty', () => {
  /*
   * COLS spans the loading / error / empty rows ONLY. Get it wrong and the
   * populated table is fine, so the defect appears exactly when an operator is
   * already looking at a confusing screen. Counted from the header rather than
   * asserted as a literal, so adding a column cannot silently desync it.
   */
  const head = table.slice(table.indexOf('<thead'), table.indexOf('</thead>'));
  const ths = (head.match(/<th[\s>]/g) || []).length;
  const decl = /const COLS = canCommit \? (\d+) : (\d+);/.exec(table);
  assert.ok(decl, 'the COLS declaration must be found');
  assert.equal(Number(decl[1]), ths, 'canCommit spans every column including the select control');
  assert.equal(Number(decl[2]), ths - 1, 'without it, one fewer');
});

// ── Controls ─────────────────────────────────────────────────────────

test('positive control — the comment stripper actually removes prose', () => {
  /*
   * Every scan above runs against a stripped copy. This file's own docblocks
   * name `clientShare` and `Service Category` repeatedly, which are exactly the
   * strings two tests assert the ABSENCE of — so a stripper that stopped
   * working would not merely weaken those tests, it would make them match their
   * own explanations. Proven on a synthetic sample so the control cannot be
   * satisfied by whatever these files happen to contain today.
   */
  const sample = [
    "/* clientShare and Service Category, described in prose */",
    'const kept = 1;',
    '// <DlCard title="Assignment"',
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('clientShare'), 'block comments must go');
  assert.ok(!stripped.includes('Assignment'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'and the code must survive');

  for (const [name, raw, code] of [['JobModal', modalSrc, modal], ['CandidateTable', tableSrc, table]]) {
    assert.ok(code.length < raw.length, `${name} must contain comments the scans excluded`);
  }
});
