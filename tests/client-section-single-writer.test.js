'use strict';
/*
 * ONE COLUMN, ONE WRITER — across the client-profile sections.
 *
 * WHAT WENT WRONG. ProfileOverviewSection and AccountPaymentSection both sent
 * `billingName` and `collectedBy` on PUT /admin/clients/:id, each from its own
 * snapshot. Every save is a full-object PUT, so the later one won with whatever
 * it had loaded — and the billing case was worse than a lost edit.
 *
 * billing_raised is a MASTER SWITCH: Account & Payment nulls billing_name,
 * billing_cycle and billing_start_date together when it is off, mirroring
 * ClientDaoImpl. Overview knew nothing about that switch and sent billingName
 * unconditionally, so editing an unrelated field there — an address, a pincode
 * — RESURRECTED a billing name the switch had deliberately cleared.
 *
 * Neither form was wrong on its own, which is exactly why this needs a test
 * that reads them TOGETHER.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'src', 'components', 'client');

/* The payload-building shapes these sections actually use. Keys are camelCase
 * on the wire; the backend maps them to snake_case columns. */
const PATTERNS = [
  /payload\.(\w+)\s*=/g,          // payload.billingName = …
  /(\w+):\s*form\./g,             // billingName: form.billingName — NOT anchored to
                                  // line start: `= { billingRaised: form.x ? 1 : 0 }`
                                  // puts the first key mid-line, and anchoring missed it.
  /\bnum\('(\w+)'/g,              // num('collectedBy', form.collectedBy)
  /\bsetIf\('(\w+)'/g,            // setIf('collectedBy', …)
];

/** Every client column a section WRITES, derived from its source. */
function writtenKeys(src) {
  const keys = new Set();
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) keys.add(m[1]);
  }
  return keys;
}

/** Sections that PUT the client master. Anything else is out of scope. */
function clientMasterWriters() {
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(DIR, f), 'utf8') }))
    .filter(({ src }) => /api\.put\(\s*`\/admin\/clients\/\$\{[^}]+\}`/.test(src))
    // ClientFormDialog is CREATE-only for the master record; it POSTs a new
    // client and cannot race an edit form over an existing one.
    .filter(({ file }) => file !== 'ClientFormDialog.tsx');
}

test('no client column is written by two profile sections', () => {
  const owners = new Map();          // key → [files]
  for (const { file, src } of clientMasterWriters()) {
    for (const k of writtenKeys(src)) {
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(file);
    }
  }
  const shared = [...owners.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([k, files]) => `${k} written by ${files.join(' AND ')}`);

  assert.deepEqual(shared, [],
    'every save is a full-object PUT, so two writers means the later save wins '
    + "with whatever IT loaded — silently reverting the other form's value. Give "
    + 'the column ONE owner and let the other section show it read-only.');
});

test('the guard is not vacuous — it finds the writers and their keys', () => {
  /*
   * Without this, a regex that stopped matching would make the check above pass
   * by comparing empty sets, and report a clean run while enforcing nothing.
   *
   * Not "every writer has 3+ keys": RowActionsMenu legitimately writes exactly
   * one (clientStatus, for Deactivate/Reactivate), and it is IN scope precisely
   * because a one-key writer can still collide with a form. So the floor is on
   * the union, plus the two big forms named individually.
   */
  const writers = clientMasterWriters();
  assert.ok(writers.length >= 2,
    `only ${writers.length} client-master writer(s) detected — the PUT matcher has stopped seeing them`);

  const union = new Set();
  for (const { src } of writers) for (const k of writtenKeys(src)) union.add(k);
  assert.ok(union.size >= 10,
    `only ${union.size} written keys found across all writers — the payload matcher has stopped seeing them`);

  for (const name of ['ProfileOverviewSection.tsx', 'AccountPaymentSection.tsx']) {
    const w = writers.find((x) => x.file === name);
    assert.ok(w, `${name} must be recognised as a client-master writer`);
    assert.ok(writtenKeys(w.src).size >= 3, `${name} yielded fewer than 3 written keys`);
  }
});

test('Account & Payment is the owner of the billing block, whole', () => {
  /*
   * The three columns billing_raised switches off must be written by the SAME
   * form that owns the switch. Split them and "off" stops meaning off.
   */
  const src = fs.readFileSync(path.join(DIR, 'AccountPaymentSection.tsx'), 'utf8');
  const keys = writtenKeys(src);
  for (const k of ['billingRaised', 'billingName', 'billingCycle', 'billingStartDate']) {
    assert.ok(keys.has(k), `AccountPaymentSection must write ${k} — it owns the master switch`);
  }
});

test('Overview shows the two fields but cannot write them', () => {
  const src = fs.readFileSync(path.join(DIR, 'ProfileOverviewSection.tsx'), 'utf8');
  const keys = writtenKeys(src);
  assert.equal(keys.has('billingName'), false, 'Overview must not write billingName');
  assert.equal(keys.has('collectedBy'), false, 'Overview must not write collectedBy');
  // Still rendered, so the page tells the whole story — just with one writer.
  assert.match(src, /label="Billing Name"/, 'it should still be shown, read-only');
  assert.match(src, /label="Collected By"/, 'likewise');
  // And it must not auto-fill a value it cannot save.
  assert.doesNotMatch(src, /billingName: follows\(/,
    'billingName must not follow client_name here — the operator would watch it '
    + 'change, save, and see it revert');
});
