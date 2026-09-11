'use strict';
/*
 * The View modal is one body for every status, and its Job Meta says who pays.
 *
 * ─── WHY (2026-09-11, two ops requests) ────────────────────────────────────
 *
 * "For unconfirmed orders the View button shows a single-page Job Info layout.
 * Make it the same for all." Status 9 was special-cased to JobTransactionView,
 * a read-only replica of the legacy "Job Transaction" page, while every other
 * status got ViewBody (the tabs + Single Page toggle). Two layouts for one
 * modal is how the replica's Remarks table ended up never re-reading after an
 * Add Remarks save. The replica is deleted; this pins that no status split
 * comes back in front of ViewBody.
 *
 * "Collected By is missing — Free For Customer or Paid By Customer." The
 * column (tbl_job.collected_by, tinyint) is already on the detail payload via
 * getByIdCore's `j.*`. What can go wrong silently is the MAPPING: it stores
 * 1/2/3, and the file's other helper, collectedByDisplay, maps the form's
 * LABELS — handed a 1 it prints "1". So the helper the row calls is RUN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/components/job/JobModal.tsx'), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('every status, Unconfirmed included, renders the one ViewBody', () => {
  const start = SRC.indexOf("{!loading && effectiveMode === 'view' && job && (");
  const end = SRC.indexOf("{!loading && mode === 'create' && (", start);
  assert.ok(start > -1 && end > start, 'the view-mode body branch must be found');
  const branch = strip(SRC.slice(start, end));
  assert.match(branch, /<ViewBody\b/, 'positive control: the branch mounts ViewBody');
  // The defect was `job_status === 9 ? <replica> : <ViewBody>` — no status
  // comparison, and no other body, may sit in front of it again.
  assert.doesNotMatch(branch, /job_status\)?\s*[!=]==?\s*\d/, 'the view body must not branch on status');
  // Nor on anything else: the sibling-family tabs (one replica per category)
  // were a second body picked off a prop rather than the status.
  assert.doesNotMatch(branch, /<(?!ViewBody\b)[A-Z]\w*/, 'ViewBody must be the only component this branch renders');
});

test('status 9 keeps its own footer action — Add Remarks keys off the status, not the body', () => {
  assert.match(SRC, /\{!loading && job && \(Number\(job\.job_status\) === 9 \|\| mode === 'checkin'\) && \(\s*\n\s*<Button/,
    'the Add Remarks button must still render for an Unconfirmed job');
});

test('Job Meta carries Collected By, read through the stored-code mapping', () => {
  const start = SRC.indexOf('<DlCard title="Job Meta"');
  const meta = SRC.slice(start, SRC.indexOf(']}/>', start));
  assert.ok(start > -1 && meta.length > 0, 'the Job Meta card must be found');
  assert.match(meta, /\['Collected By', collectedByText\(job\.collected_by\)\]/,
    'the row must pass the stored value through collectedByText');
  assert.ok(meta.indexOf("['Collected By'") > meta.indexOf("['Reference'"), 'beside Job ID / Reference, where ops asked for it');

  // The helper, executed. Same transpile call tests/festivals.test.js uses.
  const lib = fs.readFileSync(path.join(ROOT, 'src/lib/collected-by.ts'), 'utf8');
  const { outputText } = ts.transpileModule(lib, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  const { collectedByText } = mod.exports;
  assert.equal(typeof collectedByText, 'function', 'the transpiled module must export the helper');
  // mysql2 hands a tinyint over as a number; QA's status-9 rows are 2 (106), 1 (41), null (2), 0 (1).
  assert.equal(collectedByText(1), 'Paid By Customer');
  assert.equal(collectedByText(2), 'Free For Customer');
  assert.equal(collectedByText(3), 'Client');
  // Unset → undefined, which DlCard renders as its em dash — never "0" or blank.
  for (const unset of [0, null, undefined, '']) {
    assert.equal(collectedByText(unset), undefined, `${JSON.stringify(unset)} must read as unset`);
  }
});
