'use strict';

/*
 * Resend Customer PIN — the invariants that make this action safe.
 *
 * ─── WHY A SOURCE SCANNER ─────────────────────────────────────────────────
 *
 * The rules worth protecting here live in a .tsx component and in two page
 * call sites, not in a pure lib module, so there is nothing `test:build`
 * compiles for a behavioural import. This repo already answers that with
 * source scanners for exactly this class of rule (message-literals.test.js,
 * status-drift-strip.test.js, client-section-single-writer.test.js) — a rule
 * that lives in a component otherwise ends up with no coverage at all.
 *
 * ─── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 *
 * Clicking this control TEXTS A REAL CUSTOMER with the code that now gates
 * closing their job. Three ways it can go wrong, all silent:
 *
 *   1. the confirmation is dropped, so a mis-click messages a stranger;
 *   2. the PIN is rendered somewhere in the CRM, which is the whole reason
 *      the endpoint was built to answer `{ sent: true }` and nothing else;
 *   3. the button is shown to an operator without the permission, or gated on
 *      the wrong key on one page only — an action visible to someone who
 *      cannot call it is worse than no action.
 *
 * None of those breaks a type or a lint rule; each is a plain deletion that
 * compiles. That is what this file is for.
 *
 * NOTE ON REGEXES: every pattern below is non-global, or used via `.match()`.
 * A /g regex reused with `.test()` carries `lastIndex` between calls and
 * silently returns false on the next file — a scanner that reports CLEAN
 * because it started halfway through the string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const COMPONENT = 'src/components/job/ResendPinButton.tsx';
const CALL_SITES = [
  'src/components/job/PendingToStartView.tsx',
  'src/app/(authed)/my-orders/page.tsx',
];

const component = read(COMPONENT);

// ─── 1. it confirms before it sends ───────────────────────────────────────

test('the send is behind an await confirm(...), not a bare click handler', () => {
  const confirmAt = component.indexOf('await confirm(');
  const postAt = component.indexOf('api.post');
  assert.ok(confirmAt !== -1,
    'no `await confirm(` in ' + COMPONENT + ' — this action texts a real '
    + 'customer and must ask first');
  assert.ok(postAt !== -1, 'no api.post found — did the endpoint call move?');
  assert.ok(confirmAt < postAt,
    'the confirm must be awaited BEFORE the POST, not after it');
  // ...and the operator must be able to say no.
  assert.match(component, /if \(!ok\) return;/,
    'the confirm result is not checked — a Cancel would send anyway');
});

test('the confirmation names the recipient and the number', () => {
  // `who` is the customer name (with a fallback) and `where` the masked
  // mobile; both must reach the description or the dialog says "are you sure"
  // about nobody in particular.
  const desc = component.slice(
    component.indexOf('description:'),
    component.indexOf('confirmLabel:'),
  );
  assert.ok(desc.includes('${who}'), 'confirm copy does not name the customer');
  assert.ok(desc.includes('${where}'), 'confirm copy does not name the number');
});

test('no native dialogs — estate rule (showToast + useConfirm only)', () => {
  assert.doesNotMatch(component, /window\.confirm|(^|[^.\w])confirm\s*\(\s*['"`]/,
    'native window.confirm() — use useConfirm()');
  assert.doesNotMatch(component, /(^|[^.\w])alert\s*\(/,
    'native alert() — use showToast()');
});

// ─── 2. the PIN never reaches the browser through this control ────────────

test('the response type carries only `sent` — never the code', () => {
  const generic = component.match(/api\.post<([^>]*)>/);
  assert.ok(generic, 'api.post is not explicitly typed — widen-by-accident risk');
  assert.equal(generic[1].replace(/\s/g, ''), '{sent:boolean}',
    'the resend response type was widened. The endpoint answers { sent: true } '
    + 'and must never carry the PIN; typing it that way is what stops a future '
    + 'field being rendered here.');
});

test('nothing in the component reads a pin/otp value off a response', () => {
  // Prose in the comments talks about the PIN constantly, which is fine.
  // A PROPERTY READ is not.
  const code = component
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments
  assert.doesNotMatch(code, /\.(otp|pin)\b/i,
    'a .otp / .pin property read appeared in ' + COMPONENT
    + ' — staff must never receive the code');
  assert.doesNotMatch(code, /\{\s*(otp|pin)\s*\}/i,
    'a pin/otp value is being destructured — staff must never receive the code');
});

// ─── 3. it is permission-gated, identically, at every call site ───────────

test('the permission key and the route are declared exactly once', () => {
  const decls = component.match(/RESEND_PIN_ACTION\s*=/g) || [];
  assert.equal(decls.length, 1,
    'RESEND_PIN_ACTION must be declared once, in ' + COMPONENT);
  for (const f of CALL_SITES) {
    assert.doesNotMatch(read(f), /'isJobCustomerPinResend'|"isJobCustomerPinResend"/,
      f + ' hardcodes the action key instead of importing RESEND_PIN_ACTION — '
      + 'a rename would then hide the button on one page only');
    assert.doesNotMatch(read(f), /resend-customer-pin/,
      f + ' hardcodes the endpoint path; it belongs in ' + COMPONENT);
  }
});

test('the component refuses to render without the permission or the status', () => {
  assert.match(component, /if \(!allowed[\s\S]{0,80}?\) return null;/,
    'ResendPinButton no longer short-circuits on `allowed` — the control would '
    + 'render for operators who cannot call the endpoint');
  assert.match(component, /PIN_RESENDABLE_STATUSES\.has\(jobStatus\)/,
    'the job-status self-gate is gone — the button would offer to text a '
    + 'customer about an order nobody is working on');
  // The states are the point, not the constant's name: 1 SCHEDULED, 2 and 20
  // IN PROGRESS. Dropping 2/20 would remove it from exactly the closing window
  // the PIN move created.
  const set = component.match(/PIN_RESENDABLE_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'PIN_RESENDABLE_STATUSES is no longer a literal Set');
  const codes = set[1].split(',').map((s) => Number(s.trim()));
  for (const s of [1, 2, 20]) {
    assert.ok(codes.includes(s), 'job_status ' + s + ' dropped from the resend window');
  }
});

test('every call site passes the permission flag, gated on the shared key', () => {
  for (const f of CALL_SITES) {
    const src = read(f);
    const uses = src.match(/<ResendPinButton\b/g) || [];
    assert.ok(uses.length > 0, f + ' no longer renders ResendPinButton');
    // Each usage must carry an `allowed=` bound to canJob[RESEND_PIN_ACTION].
    const blocks = src.split('<ResendPinButton').slice(1);
    for (const b of blocks) {
      const props = b.slice(0, b.indexOf('/>'));
      assert.match(props, /allowed=\{!!canJob\[RESEND_PIN_ACTION\]\}/,
        f + ' renders ResendPinButton without the permission gate');
      assert.match(props, /jobStatus=/,
        f + ' omits jobStatus — the component could not self-gate on the '
        + 'states where a technician is actually holding the job');
    }
    assert.match(src, /RESEND_PIN_ACTION/,
      f + ' does not import the shared action key');
  }
});

test('my-orders requests the permission from actionFlags', () => {
  // Passing `allowed={!!canJob[RESEND_PIN_ACTION]}` is inert unless the key was
  // asked for: actionFlags only returns the keys it was given, so a missing
  // entry reads as `undefined` → the button silently never appears.
  const page = read('src/app/(authed)/my-orders/page.tsx');
  const flags = page.slice(page.indexOf('actionFlags(me, ['));
  const list = flags.slice(0, flags.indexOf(']);'));
  assert.match(list, /RESEND_PIN_ACTION/,
    'RESEND_PIN_ACTION is missing from the actionFlags() list — canJob would '
    + 'never contain it and the button would be permanently hidden');
});

// ─── 4. a 422 stays legible to ops ────────────────────────────────────────

test("the server's own message survives to the toast", () => {
  // A 422 is information ops can act on ("no mobile on file"), not a crash.
  // formatApiError falls through to ApiError.message for a non-validation 4xx.
  assert.match(component, /formatApiError\(e/,
    'the catch flattens the failure instead of surfacing the API message — a '
    + '422 would read as a generic error and cost a developer round trip');
});
