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
  const names = [...backendFile(path.join('routes', 'mobile', 'index.js')).matchAll(/perMobile:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 2, `positive control: found the backend's limiters, got ${JSON.stringify(names)}`);
  const labels = dialog.slice(dialog.indexOf('const LIMITER_LABEL'), dialog.indexOf('};', dialog.indexOf('const LIMITER_LABEL')));
  for (const n of names) assert.match(labels, new RegExp(`'${n}':\\s*'[^']+'`), `no label for limiter '${n}'`);
});

test('the rows render, enable Unlock, and tolerate an older backend', () => {
  assert.match(dialog, /appLoginLimits\?:/, 'optional in the type');
  assert.match(dialog, /p\?\.appLoginLimits \?\? \[\]/, 'defaulted, never read raw');
  assert.match(dialog, /appLimits\.some\(touched\)/, 'a locked app limit enables Unlock');
  assert.match(dialog, /appLimits\.map\(\(a\) =>/, 'each limit is a row');
  assert.match(dialog, /p\.login\.length > 0 \|\| appLimits\.length > 0 \|\| p\.technician/,
    'a mobile with only app limits still shows the table');
});
