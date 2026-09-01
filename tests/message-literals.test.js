const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/*
 * The message-literal audits, run against THIS repo.
 *
 * The checker itself lives in EasyFix_Backend/scripts/audit-message-literals.mjs
 * and is not copied here. Copying it would be the same defect the audit exists
 * to find — a second copy of something with one home, free to drift — and the
 * backend is where it is tested (tests/message-literals.test.js there plants a
 * defect and proves the checker fires before trusting any clean result).
 *
 * TWO MODES, as tests/emp-code-roundtrip.test.js and
 * scripts/sync-brand-assets.mjs --check already do. With EasyFix_Backend checked
 * out beside this repo the audit runs for real; without it — CI, a fresh clone —
 * this test skips rather than fails, because a missing sibling repo is not a
 * defect in this one.
 *
 * IT HAS ALREADY EARNED ITS PLACE HERE. Two comments in the Add User dialog
 * described the employee-code affix as `EF` months after the prefix became E,
 * while the JSX three lines below rendered EMP_CODE_PREFIX correctly. A grep for
 * 'EF' / "EF" / EF###### missed both: one was backticked, one was bare.
 */
const AUDIT = path.join(__dirname, '..', '..', 'EasyFix_Backend',
  'scripts', 'audit-message-literals.mjs');

test('no retired value is named in prose, and no owned value is spelt out', (t) => {
  if (!fs.existsSync(AUDIT)) {
    t.skip('EasyFix_Backend not checked out beside this repo — audit unavailable');
    return;
  }
  const root = path.join(__dirname, '..');
  try {
    const out = execFileSync(process.execPath, [AUDIT, root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(out, /RETIRED[^\n]*: 0/);
    assert.match(out, /LATENT[^\n]*: 0/);
  } catch (e) {
    assert.fail(`the audit reported findings:\n${e.stdout || ''}${e.stderr || ''}`);
  }
});
