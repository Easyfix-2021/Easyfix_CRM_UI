'use strict';
/*
 * Job Details panel (Schedule & Assign / Assign / Reassign Technician) —
 * Payment Mode reads tbl_job.collected_by, and the Services table carries no
 * per-service Payment column.
 *
 * ─── WHAT WAS WRONG (2026-09-11) ───────────────────────────────────────────
 *
 * Job #538816 stores collected_by = 1 (Paid By Customer), yet the panel printed
 * "Payment Mode: Not Set" and put a "Free for Customer" pill on every service
 * line. Both read tbl_job.paid_by — the field via the BE's
 * `payment_mode = paidByLabel(paid_by)`, the pill via `paid_by === 2` — and
 * paid_by is 0 or NULL on 463,680 of 481,048 jobs (QA census, 2026-09-11). Of
 * QA's 82,371 collected_by = 1 jobs, 78,922 showed that pill as "Free".
 *
 * collected_by is already on the wire: buildJobHeader (candidate-ranking.service)
 * projects it for both /candidates and /candidates/search.
 *
 * A runtime check of the mapping, plus source-shape guards on the panel,
 * because the suite mounts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const PANEL = path.join(ROOT, 'src/components/job/JobContextPanel.tsx');
const COLLECTED_BY = path.join(ROOT, 'src/lib/collected-by.ts');

function loadCollectedBy() {
  const { outputText } = ts.transpileModule(fs.readFileSync(COLLECTED_BY, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'collected-by.ts',
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  return mod.exports;
}

test('collectedByText maps the stored enum to the words ops read', () => {
  const { collectedByText } = loadCollectedBy();
  assert.equal(collectedByText(1), 'Paid By Customer');
  assert.equal(collectedByText('1'), 'Paid By Customer'); // tinyint may arrive as a string
  assert.equal(collectedByText(2), 'Free For Customer');
  assert.equal(collectedByText(3), 'Client');
  // Unset — the panel's own placeholder applies.
  for (const v of [0, '0', null, undefined, '']) assert.equal(collectedByText(v), undefined, String(v));
});

test('Payment Mode renders collected_by, falling back to Not Set only when unset', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  const fields = [...src.matchAll(/<ReadField label="Payment Mode" value=\{(.+?)\} \/>/g)];
  assert.equal(fields.length, 1, 'expected exactly one Payment Mode field');
  assert.equal(fields[0][1], "collectedByText(job.collected_by) ?? 'Not Set'");
  // paid_by is not a "who pays" signal on this data — nothing may read it here.
  assert.doesNotMatch(src, /\bjob\.(payment_mode|paid_by)\b/);
});

test('Services table has no Payment column, and every header has its cell', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  const tables = src.match(/<table[\s\S]*?<\/table>/g) || [];
  assert.equal(tables.length, 1, 'expected the one Services table');
  const th = (tables[0].match(/<th\b/g) || []).length;
  const td = (tables[0].match(/<td\b/g) || []).length;
  assert.ok(th > 0, 'found no <th> — the extraction is broken, not the table');
  assert.equal(td, th, `${th} headers vs ${td} cells per row`);
  assert.ok(!/<th\b[^>]*>\s*Payment\s*<\/th>/.test(tables[0]), 'Payment header is back');
  // The pill itself, as JSX text or the chip component — not prose in a comment.
  assert.ok(!/>\s*(Free for|Paid by) Customer\s*</i.test(tables[0]), 'per-service payment pill is back');
  assert.ok(!/\bStatusChip\b/.test(src), 'StatusChip is back (its only use was the pill)');
});
