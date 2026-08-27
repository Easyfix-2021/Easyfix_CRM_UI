'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * The dismiss grace window in src/components/ui/dialog.tsx.
 *
 * WHY THIS IS GUARDED IN SOURCE
 *
 * "The modal opens and instantly closes" has now been diagnosed four separate
 * times on this codebase. A DropdownMenuItem's onClick opens a Dialog; the
 * menu's close returns focus to its trigger; Radix's DismissableLayer reads
 * that focus shuffle as an interaction outside the just-mounted content and
 * dismisses it. The blink is under 50ms and reads to the operator as the click
 * having done nothing at all.
 *
 * Each of the first four fixes was a per-dialog copy — EasyfixerStatusDialog,
 * …MobileDialog, …BankDialog, SendProfileUpdateLinkDialog — and each protected
 * only the dialog someone remembered to copy it into. Transactions, Client
 * Mapping and Deep Skill were missed, and Transactions was reported broken from
 * production. The fix now lives once, in the shared DialogContent.
 *
 * There is no DOM test harness in this repo (tests/ is node:test over pure
 * logic), so this asserts the SOURCE still carries the guard. That is a weaker
 * check than rendering, but it catches the thing that actually happens: someone
 * refactors DialogContent and the guard quietly disappears, which nobody
 * notices until a dropdown-launched modal blinks again months later.
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'ui', 'dialog.tsx'),
  'utf8',
);

// Strip comments so the prose above the code cannot satisfy these assertions —
// the whole file is heavily commented and every term below appears in it.
// Blocks BEFORE lines, and blanked rather than deleted, so nothing merges.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const CODE = stripComments(SRC);

test('DialogContent defines a dismiss grace window', () => {
  const m = CODE.match(/DISMISS_GRACE_MS\s*=\s*(\d+)/);
  assert.ok(m, 'DISMISS_GRACE_MS must exist — it is what stops the phantom close');
  const ms = Number(m[1]);
  assert.ok(ms >= 200 && ms <= 1000,
    `grace of ${ms}ms is outside the sane band: the race fires within ~50ms, `
    + 'and anything past ~1s starts swallowing a real click-away');
});

test('the stamp lives INSIDE the portal, where mounting means opening', () => {
  /*
   * The bug this exists for, and it shipped once.
   *
   * Radix's DialogPortal renders children through Presence, so only what is
   * INSIDE it exists when open is true. The DialogContent wrapper itself runs
   * on every render of whatever holds the dialog — and nearly every dialog here
   * is rendered persistently with an `open` prop, so the wrapper mounts with the
   * PAGE. A window stamped there begins at page load, is long gone by the time
   * anyone clicks, and protects nothing while looking exactly like a fix.
   */
  assert.ok(/function DialogContentBody\(/.test(CODE),
    'the content body must be its own component so it can mount on open');

  const bodyStart = CODE.indexOf('function DialogContentBody(');
  const wrapStart = CODE.indexOf('export const DialogContent = React.forwardRef');
  assert.ok(bodyStart > -1 && wrapStart > bodyStart, 'body must be declared before the wrapper');

  const body = CODE.slice(bodyStart, wrapStart);
  const wrapper = CODE.slice(wrapStart);

  assert.ok(/mountedAtRef\.current = Date\.now\(\)/.test(body),
    'the stamp belongs in the portal-mounted body');
  assert.ok(!/mountedAtRef/.test(wrapper),
    'the stamp must NOT be in the DialogContent wrapper — that runs at page '
    + 'load for every persistently-rendered dialog, which is a silent no-op');
  assert.ok(/<DialogPortal>[\s\S]*<DialogContentBody/.test(wrapper),
    'the body must be rendered inside DialogPortal, or it mounts while closed');
});

test('the grace window is stamped during render, not in an effect', () => {
  assert.ok(/mountedAtRef\s*=\s*React\.useRef\(0\)/.test(CODE),
    'the mount stamp must be a ref');
  assert.ok(/if\s*\(mountedAtRef\.current === 0\)\s*mountedAtRef\.current = Date\.now\(\)/.test(CODE),
    'the stamp must be set during RENDER — the racing event can arrive before '
    + 'effects flush, and a zero stamp makes the window match everything');
  assert.ok(!/useEffect\(\(\) => \{\s*mountedAtRef\.current = Date\.now\(\)/.test(CODE),
    'stamping in an effect reintroduces the race this guard exists to close');
});

test('both outside-interaction handlers consult the window', () => {
  for (const handler of ['onPointerDownOutside', 'onInteractOutside']) {
    // Take the handler body up to the next handler/prop at the same depth.
    const start = CODE.indexOf(`${handler}={(e) => {`);
    assert.ok(start > -1, `${handler} must still be intercepted`);
    const body = CODE.slice(start, start + 400);
    assert.ok(/if \(withinGrace\(\)\) \{ e\.preventDefault\(\); return; \}/.test(body),
      `${handler} must short-circuit inside the grace window, before any other `
      + 'branch — otherwise the phantom dismiss gets through');
  }
});

test('the guard does not swallow Escape or programmatic closes', () => {
  // Escape is a separate Radix event and must NOT be gated: a dialog the
  // operator cannot dismiss is a worse bug than one that blinks.
  assert.ok(!/onEscapeKeyDown=\{\(e\) => \{[\s\S]{0,200}?withinGrace\(\)/.test(CODE),
    'Escape must stay ungated');
  // The window is applied inside the outside-interaction handlers only, so an
  // app-level onOpenChange(false) is untouched. If withinGrace ever appears in
  // the Dialog root wrapper, a form that closes itself on a fast success would
  // silently stop closing.
  const root = CODE.slice(CODE.indexOf('export function Dialog('), CODE.indexOf('export const DialogTrigger'));
  assert.ok(!/withinGrace/.test(root),
    'the grace window must not reach the Dialog root — that would swallow '
    + 'legitimate programmatic closes, not just the phantom one');
});
