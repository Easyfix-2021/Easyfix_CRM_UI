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
 * WHERE IT IS FOUND. Two layouts, and as of 2026-09-01 CI is no longer one that
 * gets to shrug:
 *
 *   EASYFIX_BACKEND_DIR   CI. The workflow shallow-clones the backend into
 *                         RUNNER_TEMP — both repos are public, so this needs no
 *                         token and no secret — and points this variable at it.
 *                         RUNNER_TEMP, not the workspace: inside it, `eslint .`
 *                         would lint the backend with this repo's config and the
 *                         audit's own file walk would scan it as if it were ours.
 *   ../EasyFix_Backend    a developer machine, where the two repos are siblings.
 *
 * Until then this test skipped whenever the sibling was absent, which meant it
 * had never once run in CI — committed, green, and enforcing nothing. Skipping
 * is now a local convenience only; in CI a missing checker is a failure, because
 * it can only mean the fetch step broke.
 *
 * IT HAS ALREADY EARNED ITS PLACE HERE. Two comments in the Add User dialog
 * described the employee-code affix as `EF` months after the prefix became E,
 * while the JSX three lines below rendered EMP_CODE_PREFIX correctly. A grep for
 * 'EF' / "EF" / EF###### missed both: one was backticked, one was bare.
 *
 * NOTE FOR WHOEVER SHORTENS CI ONE DAY. The RETIRED half reads `git log -L` over
 * THIS repo's history to learn what a constant used to hold. A shallow checkout
 * makes that history a single commit, so every constant's past equals its
 * present and the check silently cannot fire. The workflows pin `fetch-depth: 0`
 * for exactly that reason.
 */
function resolveAudit() {
  const roots = [
    process.env.EASYFIX_BACKEND_DIR,
    path.join(__dirname, '..', '..', 'EasyFix_Backend'),
  ];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, 'scripts', 'audit-message-literals.mjs');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

test('no retired value is named in prose, and no owned value is spelt out', (t) => {
  const audit = resolveAudit();
  if (!audit) {
    if (process.env.CI) {
      assert.fail('the message-literal audit is missing in CI. The "Fetch the shared '
        + 'message-literal audit" workflow step must clone EasyFix_Backend and set '
        + 'EASYFIX_BACKEND_DIR. This must never degrade to a silent skip here — that '
        + 'is how a guard ends up committed, green, and never run.');
    }
    t.skip('EasyFix_Backend not checked out beside this repo — audit unavailable');
    return;
  }
  const root = path.join(__dirname, '..');
  try {
    const out = execFileSync(process.execPath, [audit, root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(out, /RETIRED[^\n]*: 0/);
    assert.match(out, /LATENT[^\n]*: 0/);
  } catch (e) {
    assert.fail(`the audit reported findings:\n${e.stdout || ''}${e.stderr || ''}`);
  }
});
