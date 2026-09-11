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
 * Same day, second pass: the button now carries the COUNT ("View History · 3"),
 * and a customer with no prior jobs gets Book New Call's "No prior history"
 * text instead of a button that opens an empty dialog. One useFetch in JobForm
 * feeds the count, the text and the dialog's rows.
 *
 * ─── WHAT IS PINNED, AND WHY THESE ─────────────────────────────────────────
 *
 * The button itself is trivial. What can go wrong silently is the NUMBER:
 * confirm mode loads the job with ?unmasked=true so the form can edit the
 * customer mobile, and the history dialog prints its `mobile` prop in its
 * title. Handing it the raw value would show the full customer number to
 * every operator whenever the customer-number-visible flag is off — no error,
 * just a leak on screen. And the COUNT, which is arithmetic with two traps
 * (a capped page, an excluded row) — so that one is RUN, not pattern-matched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src/components/job/JobModal.tsx'), 'utf8');

/* The `historyCustomer` declaration, and its confirm-mode branch. */
const decl = SRC.slice(SRC.indexOf('  const historyCustomer:'), SRC.indexOf('        : null;\n', SRC.indexOf('  const historyCustomer:')));
const confirmBranch = decl.slice(decl.indexOf(': isConfirm && initial'));
/* The slot both surfaces render. */
const slot = SRC.slice(SRC.indexOf('  const historySlot = '), SRC.indexOf('      );\n', SRC.indexOf('  const historySlot = ')));
/* The dialog component, up to its return. */
const dialog = SRC.slice(SRC.indexOf('function CustomerHistoryDialog('), SRC.indexOf('  return (', SRC.indexOf('function CustomerHistoryDialog(')));

/*
 * priorJobs, lifted out of the TSX and executed. Transpiling the whole of
 * JobModal would need React and every import; the helper is pure, so its own
 * text is enough. Same transpile call tests/festivals.test.js uses.
 */
function loadPriorJobs() {
  const start = SRC.indexOf('function priorJobs(');
  assert.ok(start > -1, 'priorJobs must exist in JobModal.tsx');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  const { outputText } = ts.transpileModule(`${body}\nmodule.exports = priorJobs;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  assert.equal(typeof mod.exports, 'function', 'the extracted text must evaluate to the helper');
  return mod.exports;
}
const priorJobs = loadPriorJobs();
const jobs = (...ids) => ids.map((job_id) => ({ job_id }));

test('one value decides whose history — the slot and the dialog cannot disagree', () => {
  assert.ok(decl.length > 0, 'historyCustomer must be declared');
  assert.match(SRC, /\{historyCustomer \? \(\s*\n\s*<CustomerHistoryDialog/,
    'the dialog mounts off historyCustomer');
  assert.match(slot, /^ {2}const historySlot = !historyCustomer \|\| historyFetch\.loading \? null/,
    'and so does the slot');
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

test('the count reads the TOTAL and drops only the job being confirmed', () => {
  assert.match(confirmBranch, /excludeJobId: Number\(initial\.job_id\)/, 'confirm passes its own id');

  // Book New Call: no job yet, nothing to exclude.
  assert.deepEqual(priorJobs({ items: jobs(3, 2, 1), total: 3 }), { rows: jobs(3, 2, 1), count: 3 });
  // Confirm: the order on screen is not prior history — out of rows AND count.
  assert.deepEqual(priorJobs({ items: jobs(9, 4), total: 2 }, 9), { rows: jobs(4), count: 1 });
  // Its only job is the one being confirmed → 0 → "No prior history".
  assert.equal(priorJobs({ items: jobs(9), total: 1 }, 9).count, 0);
  // The page is capped at 100; one QA customer has 1,026 jobs. The count must
  // come from `total`, or the button would read "· 100" for all of them.
  const page = { items: jobs(...Array.from({ length: 100 }, (_, i) => 2000 - i)), total: 1026 };
  assert.equal(priorJobs(page).count, 1026);
  // Only a row actually in the page is dropped. A confirmed job 100+ orders
  // back is not seen, so that customer's count reads one high — accepted.
  assert.equal(priorJobs(page, 5).count, 1026, 'not in the page → nothing to drop');
  assert.equal(priorJobs(page, 2000).count, 1025, 'in the page → dropped once');
  // A response without `total` degrades to the page it has.
  assert.equal(priorJobs({ items: jobs(1, 2) }).count, 2);
  // Nothing loaded yet is not "zero prior jobs".
  assert.equal(priorJobs(null), null, 'null must stay null, or the loading state reads as "No prior history"');
});

test('no history → Book New Call\'s text; loading → nothing; error → the button, uncounted', () => {
  assert.ok(slot.length > 0, 'historySlot must be declared');
  assert.match(slot, /history && history\.count === 0 && !historyFetch\.error\s*\n\s*\? <span className="text-xs text-muted-foreground italic">No prior history<\/span>/,
    'zero prior jobs renders the text, not a button that opens an empty dialog');
  assert.match(slot, /View History\{history && !historyFetch\.error \? ` · \$\{history\.count\}` : ''\}/,
    'the button carries the count, and drops it rather than show a wrong one on error');
  // Book New Call's new-customer branch keeps its own wording.
  assert.match(SRC, /prefillCustomer\.customer\?\.customer_id \? historySlot : \(\s*\n\s*<span className="text-xs text-muted-foreground italic">No prior history \(new customer\)<\/span>/,
    'Book New Call renders the same slot for a matched customer');
});

test('the dialog does not fetch — JobForm\'s useFetch owns the request', () => {
  assert.ok(dialog.length > 0, 'CustomerHistoryDialog must be found');
  assert.doesNotMatch(dialog, /useEffect|api\.get/,
    'a raw useEffect + api.get in the dialog is the pattern @/lib/hooks replaces');
  assert.match(SRC, /const historyFetch = useFetch<CustomerHistoryPage>\(\s*\n\s*historyCustomer \? `\/admin\/jobs\?customerId=\$\{historyCustomer\.id\}&limit=100` : null,/,
    'one useFetch keyed on the customer, off entirely when there is none');
  assert.match(SRC, /rows=\{history\?\.rows \?\? null\}/, 'the dialog gets the same rows the count was taken from');
});

test('the slot sits in the Job Summary strip, beside the customer number', () => {
  const strip = SRC.slice(SRC.indexOf('>Job Summary</div>'), SRC.indexOf('Handyman Notes:</span>'));
  assert.ok(strip.length > 0, 'the Job Summary strip must be found');
  assert.match(strip, /<CallableMobile[\s\S]*\{historySlot\}/,
    'the slot follows the number, rightmost — the position Book New Call uses');
});
