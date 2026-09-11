'use strict';
/*
 * Confirm & Schedule has the same View History button as Book New Call.
 *
 * ─── WHY (2026-09-11) ──────────────────────────────────────────────────────
 *
 * Book New Call shows "View History" in its "Booking for" bar once the mobile
 * gate matches an existing customer. Confirm & Schedule had no equivalent, so
 * an operator confirming a customer's new order could not see their earlier
 * ones from the modal they were working in.
 *
 * ─── WHAT IS PINNED, AND WHY THESE ─────────────────────────────────────────
 *
 * The button itself is trivial. What can go wrong silently is the NUMBER:
 * confirm mode loads the job with ?unmasked=true so the form can edit the
 * customer mobile, and the history dialog prints its `mobile` prop in its
 * title. Handing it the raw value would show the full customer number to
 * every operator whenever the customer-number-visible flag is off — no error,
 * just a leak on screen. Source-shape guards, because the suite mounts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src/components/job/JobModal.tsx'), 'utf8');

/* The `historyCustomer` declaration, and its confirm-mode branch. */
const decl = SRC.slice(SRC.indexOf('  const historyCustomer:'), SRC.indexOf('        : null;\n', SRC.indexOf('  const historyCustomer:')));
const confirmBranch = decl.slice(decl.indexOf(': isConfirm && initial'));

test('one value decides whose history — the button and the dialog cannot disagree', () => {
  assert.ok(decl.length > 0, 'historyCustomer must be declared');
  assert.match(SRC, /\{historyCustomer \? \(\s*\n\s*<CustomerHistoryDialog/,
    'the dialog mounts off historyCustomer');
  assert.match(SRC, /\{historyCustomer && \(\s*\n\s*<Button type="button" variant="outline" size="sm" onClick=\{\(\) => setHistoryOpen\(true\)\}>/,
    'and so does the button');
  // Book New Call's own rule is unchanged: a MATCHED customer, create mode only.
  assert.match(decl, /!isEditShape && prefillCustomer\?\.found && prefillCustomer\.customer\?\.customer_id/,
    'the create-mode condition must be the one Book New Call always had');
});

test('the confirm-mode number is MASKED unless the visibility flag is on', () => {
  assert.ok(confirmBranch.length > 0, 'the confirm branch must exist');
  assert.match(confirmBranch, /mobile: \(customerNumberVisible\s*\n?\s*\?/,
    'the flag must decide, exactly as the Job Summary display does');
  assert.match(confirmBranch, /: maskMobile\(\(initial\.customer_mob_no/,
    'with the flag off the dialog must receive the masked value');
  // The raw value may appear only as the flag-ON arm, never as the whole value.
  assert.doesNotMatch(confirmBranch, /mobile: \(?initial\.customer_mob_no/,
    'passing the raw number prints the full customer mobile in the dialog title');
});

test('the job being confirmed is left out of its own history', () => {
  assert.match(confirmBranch, /excludeJobId: Number\(initial\.job_id\)/, 'confirm passes its own id');
  assert.match(SRC, /\.filter\(\(j\) => Number\(j\.job_id\) !== excludeJobId\)/, 'the dialog filters it');
  assert.match(SRC, /\}, \[open, customerId, excludeJobId\]\);/,
    'and refetches if it changes — a stale id in a dependency-less effect filters the wrong row');
});

test('the button sits in the Job Summary strip, beside the customer number', () => {
  const strip = SRC.slice(SRC.indexOf('>Job Summary</div>'), SRC.indexOf('Handyman Notes:</span>'));
  assert.ok(strip.length > 0, 'the Job Summary strip must be found');
  assert.match(strip, /<CallableMobile[\s\S]*\{historyCustomer && \(/,
    'the button follows the number, rightmost — the position Book New Call uses');
});
