/*
 * Admin Actions → Unlock OTP / PIN shows the technician app's per-mobile login
 * limits (EasyFix_Backend: routes/mobile/index.js registers them with
 * `perMobile: '<limiter>'`; routes/admin/otp-locks.js returns appLoginLimits).
 *
 * Pinned, against the backend SOURCE so the two repos cannot drift:
 *   - every limiter the backend registers has a label here — an unlabelled one
 *     would render as the raw key 'verify-otp';
 *   - the rows render, count toward enabling Unlock, and appLoginLimits stays
 *     OPTIONAL (a backend older than this dialog does not send it).
 *
 * Runner: `node --test` (see npm test). Needs the backend checkout: the
 * EASYFIX_BACKEND_DIR env var (CI) or the sibling ../EasyFix_Backend.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dialog = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', '(authed)', 'admin-actions', 'UnlockOtpDialog.tsx'), 'utf8');

function backendFile(rel) {
  for (const root of [process.env.EASYFIX_BACKEND_DIR, path.join(__dirname, '..', '..', 'EasyFix_Backend')]) {
    if (root && fs.existsSync(path.join(root, rel))) return fs.readFileSync(path.join(root, rel), 'utf8');
  }
  return assert.fail(`EasyFix_Backend not found — set EASYFIX_BACKEND_DIR (looking for ${rel})`);
}

test('every per-mobile limiter the backend registers has a label in the dialog', () => {
  const src = backendFile(path.join('routes', 'mobile', 'index.js'));
  assert.match(src, /'\/auth\/verify-otp'/, 'positive control: this is the technician auth router');
  const labels = dialog.slice(dialog.indexOf('const LIMITER_LABEL'), dialog.indexOf('};', dialog.indexOf('const LIMITER_LABEL')));
  // CI and the deploy precheck clone the backend's DEFAULT branch (Production), which
  // can be older than this CRM and register none — its lookup then sends no
  // appLoginLimits, so there is nothing to label. Whatever it does register must be.
  const names = [...src.matchAll(/perMobile:\s*'([^']+)'/g)].map((m) => m[1]);
  for (const n of new Set([...names, 'login-otp', 'verify-otp'])) {
    assert.match(labels, new RegExp(`'${n}':\\s*'[^']+'`), `no label for limiter '${n}'`);
  }
});

test('the rows render, enable Unlock, and tolerate an older backend', () => {
  assert.match(dialog, /appLoginLimits\?:/, 'optional in the type');
  assert.match(dialog, /p\?\.appLoginLimits \?\? \[\]/, 'defaulted, never read raw');
  assert.match(dialog, /appLimits\.some\(touched\)/, 'a locked app limit enables Unlock');
  assert.match(dialog, /appLimits\.map\(\(a\) =>/, 'each limit is a row');
  assert.match(dialog, /p\.login\.length > 0 \|\| appLimits\.length > 0 \|\| p\.technician/,
    'a mobile with only app limits still shows the table');
});
