'use strict';
/*
 * Bulk Ops-Approve: the request body the Payouts tab actually sends must
 * satisfy the backend's own Joi schema.
 *
 * ─── WHY (2026-09-16) ──────────────────────────────────────────────────────
 *
 * It posted `{ payoutIds: [...] }` while the endpoint's schema is
 * `{ items: [{ payoutId, opsApprovedAmount }] }`. middleware/validate.js runs
 * with `stripUnknown: true`, so `payoutIds` was DISCARDED before the handler
 * and `items` was then missing — every click returned 400 and the button had
 * never approved a single payout. Nothing caught it because BOTH sides are
 * individually valid: a well-formed object meets a well-formed schema, and only
 * the JOIN between them is wrong.
 *
 * So this test is that join, and it EXECUTES the handler rather than reading it:
 * the first version of this file regex-scanned the source for `key:` pairs and
 * reported an empty key set, because `{ items }` is shorthand and has no colon.
 * A matcher that silently finds nothing is the same shape as a passing test.
 * The required keys are parsed from the backend's Joi source, so adding a
 * required field there fails this test rather than production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const UI_PATH = path.join(__dirname, '..', 'src/app/(authed)/finance/page.tsx');
const UI = fs.readFileSync(UI_PATH, 'utf8');

/* Same two layouts every cross-repo test here uses: EASYFIX_BACKEND_DIR in CI,
 * siblings on a developer machine. */
function backendFile(rel) {
  const root = process.env.EASYFIX_BACKEND_DIR || path.resolve(__dirname, '../../EasyFix_Backend');
  const file = path.join(root, rel);
  return fs.existsSync(file) ? file : null;
}

/* Keys marked `.required()` inside the bulk route's Joi literal. */
function bulkRequiredItemKeys(be) {
  const start = be.indexOf("router.post('/payouts/bulk-ops-approve'");
  assert.ok(start > -1, 'the backend must declare POST /payouts/bulk-ops-approve');
  const block = be.slice(start, be.indexOf('\nrouter.', start + 1));
  const items = block.slice(block.indexOf('items:'), block.indexOf('})).min(1)'));
  const keys = [...items.matchAll(/(\w+):\s*Joi\.[^,\n]*\.required\(\)/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'extracted no required item keys — the matcher is broken, not the UI');
  return keys;
}

/* Lift `async function bulkOpsApprove()` out of the TSX and make it callable,
 * with its closure supplied as parameters. */
function loadHandler(closure) {
  const start = UI.indexOf('async function bulkOpsApprove(');
  assert.ok(start > -1, 'bulkOpsApprove must exist in the Finance page');
  let depth = 0; let end = -1;
  for (let i = UI.indexOf('{', start); i < UI.length; i += 1) {
    if (UI[i] === '{') depth += 1;
    else if (UI[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'could not find the end of the handler');
  const { outputText } = ts.transpileModule(`${UI.slice(start, end)}`, {
    // removeComments: the absence assertions below must run on CODE. The first
    // version of this file asserted `payoutIds` was gone from the whole page and
    // failed on the comment explaining why it went.
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.None, removeComments: true },
  });
  const names = Object.keys(closure);
  const fn = new Function(...names, `${outputText}; return bulkOpsApprove;`)(...names.map((n) => closure[n]));
  assert.equal(typeof fn, 'function', 'the extracted text must evaluate to the handler');
  return { fn, js: outputText };
}

const ROWS = [
  { payout_id: 55, efr_id: 7, ops_amount: 1200.5, is_approved_by_fin: 0 },
  { payout_id: 56, efr_id: 9, ops_amount: null, is_approved_by_fin: 0 },
  { payout_id: 57, efr_id: 11, ops_amount: 300, is_approved_by_fin: 0 },   // not selected
];

function harness({ selected = [55, 56], bulkBusy = false, response } = {}) {
  const posted = [];
  const toasts = [];
  const closure = {
    data: ROWS,
    selectedIds: new Set(selected),
    bulkBusy,
    setBulkBusy: () => {},
    setSelectedIds: () => {},
    reload: () => {},
    showToast: (t) => toasts.push(t),
    api: { post: async (url, body) => { posted.push({ url, body }); return response ?? { results: selected.map((id) => ({ payoutId: id, ok: true })), approvedCount: selected.length, failedCount: 0 }; } },
  };
  const { fn, js } = loadHandler(closure);
  return { fn, js, posted, toasts };
}

test('the body satisfies every required key of the backend bulk schema', async () => {
  const file = backendFile('routes/admin/finance.js');
  if (!file) {
    assert.fail('EasyFix_Backend was not found, so the payout request contract was NOT verified.'
      + '\n  FIX IT ONE OF TWO WAYS:'
      + '\n    git clone --depth 1 https://github.com/Easyfix-2021/Easyfix_Backend.git ../EasyFix_Backend'
      + '\n    …or point EASYFIX_BACKEND_DIR at an existing checkout.');
  }
  const required = bulkRequiredItemKeys(fs.readFileSync(file, 'utf8'));

  // The mechanism that made the mismatch silent. If unknown keys ever start
  // being REJECTED, the failure mode changes and so should this test.
  assert.match(fs.readFileSync(backendFile('middleware/validate.js'), 'utf8'), /stripUnknown:\s*true/,
    'this test exists because unknown keys are stripped rather than rejected');

  const { fn, posted } = harness();
  await fn();

  assert.equal(posted.length, 1, 'the handler must post exactly once');   // positive control
  assert.equal(posted[0].url, '/admin/finance/payouts/bulk-ops-approve');
  const { body } = posted[0];
  assert.ok(Array.isArray(body.items), `the endpoint takes { items: [...] }, got ${JSON.stringify(body)}`);
  assert.equal(body.items.length, 2, 'one item per SELECTED row, ignoring the unselected one');
  for (const item of body.items) {
    for (const key of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(item, key),
        `the schema requires "${key}" per item; got ${JSON.stringify(item)}`);
    }
  }
  console.log(`bulk payload verified against ${required.length} required schema keys: ${required.join(', ')}`);
});

test('each item carries its own amount, which an id-only payload cannot express', async () => {
  const { fn, posted } = harness();
  await fn();
  assert.deepEqual(posted[0].body.items, [
    { payoutId: 55, opsApprovedAmount: 1200.5 },
    { payoutId: 56, opsApprovedAmount: 0 },     // a null ops_amount sends 0, as the single-row path does
  ]);
});

test('the discarded shape is gone from the CODE that runs', () => {
  const { js } = harness();
  // Positive control: prove the subject was located before asserting on silence.
  assert.match(js, /bulk-ops-approve/, 'the extracted handler must be the one that posts');
  assert.ok(!/payoutIds/.test(js), 'payoutIds was the key stripUnknown swallowed');
});

test('a selection the current filter no longer shows is refused, not silently dropped', async () => {
  const { fn, posted, toasts } = harness({ selected: [999] });
  await fn();
  assert.equal(posted.length, 0, 'nothing may be posted when no selected row is in view');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].variant, 'error');
});

test('a partial result is reported per row, because the backend refuses a paid payout', async () => {
  const { fn, toasts } = harness({
    response: { results: [{ payoutId: 55, ok: true }, { payoutId: 56, ok: false, error: 'payout is already paid — this action is not allowed from that state' }], approvedCount: 1, failedCount: 1 },
  });
  await fn();
  assert.equal(toasts[0].variant, 'warning', 'part-success is a warning, not a success');
  assert.match(toasts[0].message, /1 Ops-Approved, 1 Skipped/);
  assert.match(toasts[0].message, /already paid/, 'the operator must see WHY a row did not go');
});

test('a second click while one is in flight posts nothing', async () => {
  const { fn, posted } = harness({ bulkBusy: true });
  await fn();
  assert.equal(posted.length, 0, 'the busy guard must block a double submit on a money button');
});
