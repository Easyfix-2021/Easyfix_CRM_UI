'use strict';
/*
 * The Confirm & Schedule Service Address is rendered exactly once — and typeable
 * only while adding a NEW address.
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
 * ─── WHAT CHANGED SINCE (2026-09-17, ops — Priyanka) ───────────────────────
 *
 * The 2026-09-10 fix made the field typeable by reusing the confirm PATCH's
 * `address` key — which edits the job's CURRENT tbl_address row IN PLACE. The
 * address rules agreed on 2026-09-17 forbid exactly that: a saved address is
 * never edited from Confirm & Schedule; the operator books one as is
 * (`fk_address_id`) or adds a NEW one (`new_address`). So:
 *
 *   - the picker still renders its own Service Address field on this call site
 *     (test 1 and 2 below are unchanged — one field, a plain input), but it is
 *     `editable` only in new mode;
 *   - the "cleared address" guard (old tests 3 and 4) is GONE, because the
 *     silent discard it guarded — pickIf dropping '' out of `patch.address` —
 *     cannot happen when `patch.address` is never sent. Those two tests are
 *     rewritten below to pin what replaced the guard, not deleted.
 *
 * The full rule set is pinned in tests/confirm-address-picker.test.js.
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
// Comments out before the scans added on 2026-09-17: the removed guard is
// explained in prose right where it used to be, and a raw scan would find it.
const strip = (t) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
  /*
   * 2026-09-17: on the Confirm & Schedule call site the field still RENDERS
   * (above), but `serviceAddressEditable` no longer means "typeable" there on
   * its own: the whole picker is `editable` only while adding a new address.
   * Pinned per call site, so the gate cannot quietly move to another one.
   */
  const confirmSite = blocks.filter((b) => /key=\{`confirm-address-\$\{confirmAddrMode\}`\}/.test(b));
  assert.equal(confirmSite.length, 1, 'exactly one call site is the Confirm & Schedule picker');
  assert.match(confirmSite[0], /editable=\{confirmAddrMode === 'new'\}/,
    'a saved address must render read-only — it is booked as is, never edited here');
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

/* ─── nothing typed into it is silently discarded ──────────────────────── */

test('a cleared or incomplete Service Address is never silently discarded', () => {
  /*
   * WAS: "a CLEARED Service Address is blocked on every submit variant" — it
   * asserted a guard (`if (isConfirm && !f.address.trim() && initial.address)
   * → setError`) placed before the book-only gate, so Save Draft could not
   * report success over an address pickIf had quietly dropped from
   * `patch.address`.
   *
   * NOW (2026-09-17): the discard mechanism itself is gone — Confirm &
   * Schedule never sends `patch.address` — so the guard was removed, and it had
   * to be: in new mode it would block exactly the partial Save Draft the new
   * rules allow. What stops a silent loss today, per mode:
   *   saved mode  the fields are read-only, so there is nothing to clear;
   *   new mode    Book Call is gated on the new address being complete, and a
   *               Save Draft that leaves an incomplete one out says so in a toast.
   * This test pins those three facts, and that the old guard did not come back.
   */
  const src = strip(read(JOB_MODAL));
  const submit = src.slice(src.indexOf('async function submit(e: React.FormEvent) {'),
    src.indexOf('const [confirmOpenSection, setConfirmOpenSection]'));
  assert.ok(submit.length > 0, 'the JobForm submit handler must be found');
  assert.doesNotMatch(submit, /patch\.address\s*=/,
    'the confirm save must not send patch.address — that is the in-place edit the discard lived in');
  assert.doesNotMatch(submit, /clearing it would be discarded/,
    'the old guard must not return: it would block a new-mode Save Draft that the rules allow');
  assert.match(src, /CONFIRM_GPS_RX\.test\(String\(f\.gps_location \|\| ''\)\.trim\(\)\) &&\s*confirmNewAddressMissing\.length === 0;/,
    'Book Call must stay gated on a complete NEW address — the half of the old guard that still matters');
  assert.match(submit, /if \(newAddressNotSaved\) \{\s*showToast\(\{\s*variant: 'warning',/,
    'a draft that leaves the new address out must say so — a report, not a silent drop');
});

test('and a job with a blank or incomplete address stays savable', () => {
  /*
   * WAS: "gated on the job HAVING an address, so a blank legacy row stays
   * savable" — the old guard compared against `initial.address` so a legacy
   * job whose tbl_address.address is genuinely blank could still be
   * draft-saved.
   *
   * NOW (2026-09-17): the same promise, kept by different code.
   *   - Saved mode sends NOTHING about the current address, so a blank or
   *     incomplete one can never trip the validator on a draft.
   *   - A job with no address row starts in NEW mode, where an incomplete
   *     address makes the draft save without it rather than refuse to save.
   */
  const src = strip(read(JOB_MODAL));
  assert.match(src, /if \(confirmAddrMode === 'saved'\) \{\s*const currentAddressId = confirmCurrentAddressId\(initial\);\s*if \(confirmAddrPickId && confirmAddrPickId !== currentAddressId\) \{\s*patch\.fk_address_id = confirmAddrPickId;\s*\}/,
    'saved mode with the current row checked must send no address key at all');
  assert.match(src, /\} else if \(submitVariant === 'draft'\) \{\s*newAddressNotSaved = newAddressMissing;\s*\}/,
    'an incomplete new address must not block Save Draft');
  assert.match(src, /if \(currentId && !changed\) return \{ mode: 'saved'[^\n]*\n\s*return \{ mode: 'new'/,
    'a job without a current address row must start in new mode, not in a saved mode with nothing to book');
});
