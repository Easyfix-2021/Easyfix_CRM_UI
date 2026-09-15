'use strict';
/*
 * Every "How the Top 10 is ranked" tooltip must state the cash gate the backend
 * actually applies.
 *
 * 2026-09-11: it said "COD jobs: account balance ₹500+" and, further down, that
 * account balance does NOT filter the list. Both were wrong for the aligned
 * gate: customerPays() (paid_by = 2 OR collected_by = 1 — the CRM's "Paid By
 * Customer") drops technicians below the floor from the Top 10, and a balance
 * of exactly the floor passes. The floor figure is read from the backend's
 * DEFAULTS, so changing it there fails here instead of leaving stale copy.
 *
 * WHY IT WALKS src/ INSTEAD OF NAMING A FILE. The tooltip is two hand-kept
 * copies — Schedule & Assign and Assign/Reassign — and both modals read the
 * same GET /admin/jobs/:id/candidates, which enforces the gate. The first fix
 * corrected one copy, and this test, which read only that file, passed while
 * Reassign still showed the old claims. So every copy is found by its label,
 * and the count is asserted first: finding nothing must not read as a pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const LABEL = '<InfoTooltip label="How the Top 10 is ranked">';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx$/.test(e.name) ? [path.join(d, e.name)] : []));

function backendRanking() {
  for (const r of [process.env.EASYFIX_BACKEND_DIR, path.join(__dirname, '..', '..', 'EasyFix_Backend')]) {
    const f = r && path.join(r, 'services/candidate-ranking.service.js');
    if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  throw new Error('EasyFix_Backend checkout not found — set EASYFIX_BACKEND_DIR; this half must not degrade to a pass.');
}

test('every Top 10 tooltip states the backend cash gate: who it applies to, and the inclusive floor', () => {
  const tips = walk(SRC).flatMap((f) => {
    const t = fs.readFileSync(f, 'utf8');
    const out = [];
    for (let at = t.indexOf(LABEL); at > -1; at = t.indexOf(LABEL, at + 1)) {
      out.push({ where: path.relative(SRC, f), tip: t.slice(at, t.indexOf('</InfoTooltip>', at)) });
    }
    return out;
  });
  assert.ok(tips.length >= 2,
    `expected the Schedule & Assign and Assign/Reassign copies; found ${tips.length} (${tips.map((x) => x.where).join(', ')})`);

  const be = backendRanking();
  const floor = Number((be.match(/ACCOUNT_BALANCE_FLOOR:\s*(\d+)/) || [])[1]);
  assert.ok(floor > 0, 'DEFAULTS.ACCOUNT_BALANCE_FLOOR must be found');
  assert.match(be, /function customerPays\(job\) \{\s*return [^\n]*paid_by[^\n]*collected_by\) === 1;/,
    'the gate keys on paid_by OR collected_by = 1 — what "Paid By Customer" names');
  // "or more": exactly the floor passes BOTH gates — the Top 10 and the auto-assign pick.
  assert.match(be, /if \(enforceCodBalance && isCod && balance < balanceFloor\)/, 'Top 10 drops only balances BELOW the floor');
  assert.match(be, /Number\(c\.current_balance \?\? 0\) >= balanceFloor/, 'auto-assign accepts a balance AT the floor');

  for (const { where, tip } of tips) {
    assert.ok(tip.includes(`account balance <strong>₹${floor} or more</strong>`), `${where}: the floor (₹${floor}), stated as inclusive`);
    assert.match(tip, /<strong>Cash<\/strong> jobs \(Paid By Customer\)/, `${where}: names who the gate applies to`);
    assert.doesNotMatch(tip, /don&apos;t filter the list/, `${where}: account balance does filter cash jobs`);
  }
});
