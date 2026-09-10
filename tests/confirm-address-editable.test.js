'use strict';
/*
 * The Confirm & Schedule Service Address is typeable — and rendered exactly once.
 *
 * ─── WHAT WAS WRONG (2026-09-10) ───────────────────────────────────────────
 *
 * Confirming an order is the moment an operator reads the service address back
 * to the customer, and it was the one address surface with no keyboard fix: the
 * host rendered its own grey, disabled copy above the shared picker and omitted
 * `serviceAddressEditable`, so the picker hid its editable field. The only way
 * to change the address was to pick a different SAVED address — and
 * "Search Location On Map" deliberately never writes the `address` column.
 *
 * Two things made the gap invisible. The field LOOKED present (right label,
 * right value), and two files carried the picker's helper sentences, so the
 * difference read as a duplicated component rather than as one omitted prop at
 * one of three call sites.
 *
 * No new server capability: the confirm PATCH has always sent `address.address`,
 * updateBody has always accepted it, and job.service has always written it.
 *
 * Source-shape guards, because the suite mounts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JOB_MODAL = path.join(ROOT, 'src/components/job/JobModal.tsx');
const PICKER = path.join(ROOT, 'src/components/ui/address-picker-with-map.tsx');

const read = (p) => fs.readFileSync(p, 'utf8');
test('every AddressPickerWithMap call site opts into an editable Service Address', () => {
  /*
   * Denominator, not a spot check: count the JSX call sites and require the
   * prop on all of them. Confirm & Schedule was the one omission, and the
   * omission was invisible — the host rendered its own grey copy, so the field
   * looked present while being unreachable from the keyboard.
   */
  const src = read(JOB_MODAL);
  /*
   * PAIRED, not two independent counts. Counting `<AddressPickerWithMap` and
   * `serviceAddressEditable` separately and comparing the totals would stay
   * green if the prop MOVED — two on one call site, none on another — which is
   * the shape of the bug being pinned. So each call site's own JSX block is
   * inspected.
   */
  const blocks = src.split('<AddressPickerWithMap').slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('/>')));
  assert.equal(blocks.length, 3,
    `expected 3 picker call sites, found ${blocks.length} — re-derive the denominator before `
    + 'trusting the per-site check below');
  blocks.forEach((block, i) => {
    assert.match(block, /^\s*serviceAddressEditable\s*$/m,
      `picker call site ${i + 1} of ${blocks.length} does not pass serviceAddressEditable — `
      + 'that omission is invisible in the UI when the host renders its own copy of the field');
  });
});

test('the confirm block renders no SECOND Service Address control', () => {
  /*
   * The picker owns the field now. Re-adding the host's grey copy would render
   * two controls labelled "Service Address" bound to the same `f.address`, one
   * disabled directly above the live one — which is what Book New Call already
   * removed for the same reason (2026-09-07).
   */
  const src = read(JOB_MODAL);
  /*
   * Order-INDEPENDENT. Pinning `readOnly` before `disabled` with a mandatory
   * newline between them asserts one SPELLING of the deleted block, not the
   * invariant: JSX attribute order is inert to TypeScript, no jsx-sort-props
   * rule is configured here, and a hand-written reintroduction would very likely
   * differ. So the rule is the pairing itself — no <textarea> in this file may
   * be fed by formatServiceAddress, however its attributes are arranged.
   */
  for (const m of src.matchAll(/<textarea\b/g)) {
    const tag = src.slice(m.index, src.indexOf('/>', m.index) + 2);
    assert.doesNotMatch(tag, /formatServiceAddress\(/,
      `a <textarea> at index ${m.index} renders formatServiceAddress — the grey read-only `
      + 'Service Address copy is back, and it would sit directly above the live input');
  }
  // The picker's own control must be the only labelled one, and still a plain
  // input: an autocomplete here would overwrite the operator's text with
  // Google's formatted_address.
  const picker = read(PICKER);
  assert.equal((picker.match(/\{addressLabel\}/g) || []).length, 1,
    'exactly one control may carry the Service Address label');
  assert.match(picker, /\{serviceAddressEditable && \(\s*\n\s*<div>\s*\n\s*<Label className="text-xs">\{addressLabel\}<\/Label>\s*\n\s*<Input/,
    'the Service Address must stay a plain <Input>, not become an autocomplete');
});
