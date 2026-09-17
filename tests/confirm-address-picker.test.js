'use strict';
/*
 * Confirm & Schedule books a saved address AS IS, or a NEW one — never an edit
 * (2026-09-17, ops — Priyanka).
 *
 * ─── WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * My Orders -> Unconfirmed -> Confirm & Schedule let the operator pick one of
 * the customer's saved addresses, copied it into editable fields, and the save
 * sent `patch.address` — which the backend applies to the job's CURRENT
 * tbl_address row, in place. Picking address B therefore overwrote address A,
 * a row other jobs still point at. On top of that the newest saved row was
 * auto-ticked while the form still showed the job's own address, so the ticked
 * radio and what would be booked were two different places; and the list
 * included blank "(No Address)" rows.
 *
 * ─── THE RULES PINNED HERE ─────────────────────────────────────────────────
 *
 *   R1  saved addresses are never edited from this screen (read-only fields,
 *       and the confirm save never sends `patch.address`);
 *   R2  picking a saved row sends `fk_address_id` — the row, as stored;
 *   R3  otherwise Add New Address, sent as `new_address` (always a new row);
 *   R4  the list is fetched with `?complete=1` and filtered again client-side;
 *   R5  the current address is pinned first and checked by default.
 *   Defaults: PIN mandatory; Add New Address pre-fills from the checked row;
 *   an incomplete current address still books as-is under the Book Call gate.
 *
 * Executed where the rule is a value (the module-level helpers are transpiled
 * out of JobModal.tsx and run, the same transpile call
 * job-remarks-legacy.test.js uses); source-scanned where it is wiring, with
 * comments stripped first and each scan bound to the code that runs it —
 * every regression below is a plain edit that still type-checks and builds.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Comments are stripped before every scan — this repo explains itself in prose
// beside the code (including prose about the removed behaviour), and a raw scan
// would read the explanation as the code. JSX comments go first so their braces
// do not survive as `{}`.
const strip = (text) => text
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/[^\n]*$/gm, '')
  .replace(/\s\/\/ [^\n]*$/gm, '');

const RAW = read('src/components/job/JobModal.tsx');
const SRC = strip(RAW);
const PICKER = strip(read('src/components/ui/address-picker-with-map.tsx'));

/* A slice of SRC between two anchors that must both exist, in order. */
function between(text, from, to, what) {
  const a = text.indexOf(from);
  const b = a > -1 ? text.indexOf(to, a + from.length) : -1;
  assert.ok(a > -1 && b > a, `${what}: could not find the region (${from} … ${to}) — did it move?`);
  return text.slice(a, b);
}

/* Run module-scope TS from JobModal.tsx. Same extraction as job-remarks-legacy. */
function load(names, exportsExpr) {
  const parts = names.map((n) => {
    const m = RAW.match(new RegExp(`\\n(const ${n}\\b[^\\n]*;|const ${n}\\b[^\\n]*\\{\\n[\\s\\S]*?\\n\\};|function ${n}\\([\\s\\S]*?\\n\\})\\n`));
    assert.ok(m, `${n} must be found at module scope in JobModal.tsx`);
    return m[1];
  });
  const { outputText } = ts.transpileModule(`${parts.join('\n')}\nmodule.exports = ${exportsExpr};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  return mod.exports;
}

const H = load(
  [
    'BLANK_ADDRESS_FIELDS', 'CONFIRM_GPS_RX', 'toConfirmAddressFields', 'confirmAddressMissing',
    'confirmCurrentAddressId', 'confirmAddressLabel', 'prefillNewConfirmAddress',
    'buildConfirmNewAddress', 'sameConfirmAddressField', 'confirmAddressStart',
  ],
  '{ toConfirmAddressFields, confirmAddressMissing, confirmCurrentAddressId, confirmAddressLabel, '
  + 'prefillNewConfirmAddress, buildConfirmNewAddress, confirmAddressStart }',
);

const COMPLETE = {
  address: 'Flat 4B, Palm Grove',
  building: 'Palm Grove Society, Sector 21',
  landmark: 'Near the park',
  city_id: '12',
  pin_code: '122001',
  gps_location: '28.459500,77.026600',
  address_instruction: 'Ring the 2nd-floor bell',
};

// The submit handler and the confirm-only render, each bound once.
const SUBMIT = between(SRC, 'async function submit(e: React.FormEvent) {', 'const [confirmOpenSection, setConfirmOpenSection]', 'JobForm submit');
const CONFIRM_PATCH = between(SUBMIT, 'if (isConfirm && !isOutcomeOnly) {', 'const saved = await api.patch<Job>(`/admin/jobs/${initial.job_id}`, patch);', 'confirm PATCH assembly');
const CONFIRM_RENDER = between(SRC, 'if (isConfirm && initial) {', "title=\"3 · Select Products\"", 'confirm Customer Details render');

// ─── 1. The completeness rule, executed (R4, default a) ────────────────────

test('a complete address is address + building + city + 6-digit PIN + GPS — and nothing less', () => {
  assert.deepEqual(H.confirmAddressMissing({ ...COMPLETE }), [], 'positive control: a complete row passes');
  assert.deepEqual(H.confirmAddressMissing({ ...COMPLETE, landmark: '', address_instruction: '' }), [],
    'landmark and the technician note are optional');
  const cases = [
    [{ address: '   ' }, 'Service Address'],
    [{ building: '' }, 'Building (Search Location On Map)'],
    [{ city_id: '' }, 'City'],
    [{ city_id: '0' }, 'City'],
    [{ pin_code: '12345' }, 'PIN (6 digits)'],
    [{ pin_code: '' }, 'PIN (6 digits)'],
    [{ gps_location: '' }, 'GPS Location (pick on the map)'],
    [{ gps_location: 'somewhere' }, 'GPS Location (pick on the map)'],
  ];
  for (const [patch, label] of cases) {
    assert.deepEqual(H.confirmAddressMissing({ ...COMPLETE, ...patch }), [label],
      `${JSON.stringify(patch)} must be reported as missing ${label}`);
  }
});

test('the saved-address filter and the Book Call gate share ONE GPS regex', () => {
  const decls = SRC.match(/const CONFIRM_GPS_RX = /g) || [];
  assert.equal(decls.length, 1,
    'a second CONFIRM_GPS_RX can drift from the first — then the list offers a row the gate refuses');
  assert.match(SRC, /\nconst CONFIRM_GPS_RX = /, 'declared at module scope, where the helpers can read it');
  const gate = between(SRC, 'const confirmSection2Complete =', ';\n', 'confirmSection2Complete');
  assert.match(gate, /CONFIRM_GPS_RX\.test\(String\(f\.gps_location \|\| ''\)\.trim\(\)\)/);
});

// ─── 2. The list: fetched complete, filtered again, current row excluded (R4) ─

test('the saved addresses are fetched with ?complete=1 and filtered again client-side', () => {
  // Bound to the effect that runs it: the request AND its dep array, no
  // other effect in between.
  const effect = SRC.match(/useEffect\(\(\) => \{\s*if \(!confirmCustomerId\) \{ setSavedAddresses\(\[\]\); return; \}[\s\S]*?\}, \[confirmCustomerId\]\);/);
  assert.ok(effect, 'the saved-address effect keyed on confirmCustomerId must exist');
  const body = effect[0];
  assert.match(body, /api\.get<\{ addresses\?: SavedCustomerAddress\[\] \}>\(`\/admin\/customers\/\$\{confirmCustomerId\}\?complete=1`\)/,
    'without complete=1 the server returns incomplete and blank "(No Address)" rows');
  assert.match(body, /\.filter\(\(a\) => Number\(a\.customer_id\) === confirmCustomerId\)/,
    'defence in depth: a row that is not this customer\'s must never be offered');
  assert.match(body, /\.filter\(\(a\) => a\.address_id > 0 && confirmAddressMissing\(a\)\.length === 0\)/,
    'defence in depth: the same completeness rule the new-address gate uses');
  assert.equal((SRC.match(/\/admin\/customers\/\$\{confirmCustomerId\}/g) || []).length, 1,
    'no second, unfiltered fetch of the same customer');
  assert.match(SRC, /const confirmCustomerId = isConfirm \?/,
    'Confirm only — the Edit form never rendered this list');
});

test('the current address is not listed twice', () => {
  assert.match(SRC, /const confirmOtherRows = savedAddresses\.filter\(\(a\) => a\.address_id !== confirmCurrentRow\?\.address_id\);/);
  assert.doesNotMatch(CONFIRM_RENDER, /savedAddresses\.(map|filter)\(/,
    'the render must list confirmOtherRows, not the raw list that can contain the current row');
});

// ─── 3. The current address is pinned and checked (R5) ─────────────────────

test('the newest-row preselect is gone', () => {
  assert.doesNotMatch(SRC, /savedAddresses\[0\]/, 'nothing may auto-pick the newest saved row');
  assert.doesNotMatch(SRC, /confirmAddrAppliedRef/, 'the once-per-job preselect effect must not return');
  assert.doesNotMatch(CONFIRM_RENDER, /selectedAddressId/,
    'the confirm picker reads its own confirmAddrPickId, never the create flow\'s selection');
});

test('where the picker starts: current row checked, or NEW when there is none', () => {
  const job = { job_id: 7, fk_address_id: 55, source_type: 'CRM - New', ...COMPLETE };

  const saved = H.confirmAddressStart(job, H.toConfirmAddressFields(job));
  assert.equal(saved.mode, 'saved');
  assert.equal(saved.pickId, 55, 'the CURRENT row is the checked one');
  assert.deepEqual(saved.fields, H.toConfirmAddressFields(job));

  const precision = H.confirmAddressStart(job, { ...H.toConfirmAddressFields(job), gps_location: '28.4595,77.0266', city_id: ' 12 ' });
  assert.equal(precision.mode, 'saved', 'formatting noise is not a changed address');

  const none = H.confirmAddressStart({ job_id: 8, fk_address_id: null }, H.toConfirmAddressFields(null));
  assert.equal(none.mode, 'new', 'a job with no address row starts in new mode');
  assert.equal(none.pickId, null);

  // A magic-link submission that changed the address: new mode, those values,
  // and the current row kept as the way back.
  const shown = { ...H.toConfirmAddressFields(job), address: 'House 9, New Colony' };
  const overlay = H.confirmAddressStart(job, shown);
  assert.equal(overlay.mode, 'new', 'accepting a changed submission must create a row, not edit this one');
  assert.equal(overlay.pickId, 55);
  assert.equal(overlay.fields.address, 'House 9, New Colony');
});

test('the reseed effect derives the picker with the form, and the first render agrees', () => {
  const effect = SRC.match(/useEffect\(\(\) => \{\s*if \(mode === 'create'\) return;\s*const base = toFormShape\(initial\);[\s\S]*?\}, \[initial, mode\]\);/);
  assert.ok(effect, 'the reseed effect must be found');
  const calls = effect[0].match(/const start = confirmAddressStart\(initial, toConfirmAddressFields\((seeded|base)\)\);\s*setConfirmAddrMode\(start\.mode\);\s*setConfirmAddrPickId\(start\.pickId\);\s*setF\(\{ \.\.\.(seeded|base), \.\.\.start\.fields \}\);/g) || [];
  assert.equal(calls.length, 2,
    'both reseed paths (with and without a customer submission) must reset mode, checked row and fields together');
  assert.match(SRC, /useState<'saved' \| 'new'>\(\s*\(\) => \(mode === 'confirm' \? confirmAddressStart\(initial, toConfirmAddressFields\(initial\)\)\.mode : 'saved'\),\s*\)/);
  assert.match(SRC, /useState<number \| null>\(\s*\(\) => \(mode === 'confirm' \? confirmCurrentAddressId\(initial\) : null\),\s*\)/);
});

test('the pinned row is first, labelled "Current address", and checked by the pick id', () => {
  const pinned = CONFIRM_RENDER.indexOf('Current address');
  const others = CONFIRM_RENDER.indexOf('shownRows.map((a) => (');
  assert.ok(pinned > -1 && others > pinned, 'the current row renders before the other saved rows');
  const row = between(CONFIRM_RENDER, '{confirmCurrentRow && (', 'Current address', 'pinned row');
  assert.match(row, /checked=\{!isNewAddress && confirmAddrPickId === confirmCurrentRow\.address_id\}/);
  assert.match(row, /onChange=\{\(\) => pickConfirmAddress\(confirmCurrentRow\)\}/);
  assert.match(CONFIRM_RENDER, /\{currentMissing\.length > 0 && \([\s\S]{0,600}?>\s*Incomplete\s*</,
    'default (c): an incomplete current address is still offered, tagged');
  assert.match(CONFIRM_RENDER, /const currentMissing = confirmCurrentRow \? confirmAddressMissing\(confirmCurrentRow\) : \[\];/);
});

test('row labels are building, address, city, PIN — and search matches that label', () => {
  assert.equal(H.confirmAddressLabel({ ...COMPLETE }, 'Gurugram'),
    'Palm Grove Society, Sector 21, Flat 4B, Palm Grove, Gurugram, 122001');
  assert.equal(H.confirmAddressLabel({ ...COMPLETE, building: '  ', landmark: 'hidden' }, ''),
    'Flat 4B, Palm Grove, 122001', 'blank parts are skipped; landmark is not part of the label');
  assert.match(CONFIRM_RENDER, /const labelOf = \(row: ConfirmAddressRow\) => confirmAddressLabel\(row, confirmAddressCityName\(row\)\);/);
  assert.match(CONFIRM_RENDER, /confirmOtherRows\.filter\(\(a\) => labelOf\(a\)\.toLowerCase\(\)\.includes\(q\)\)/,
    'search must match what is shown, not fields hidden behind the label');
  assert.match(CONFIRM_RENDER, /<span className="flex-1">\{labelOf\(a\)\}<\/span>/);
});

test('the helper text is exactly the agreed sentence', () => {
  assert.ok(CONFIRM_RENDER.includes("{'Pick a saved address or add a new one. Saved addresses can\\'t be edited.'}"),
    'helper text must read: Pick a saved address or add a new one. Saved addresses can\'t be edited.');
  assert.doesNotMatch(SRC, /You can still edit it\./, 'the old promise contradicts R1');
});

// ─── 4. Read-only saved mode, editable new mode (R1, R3, default b) ────────

test('a saved address renders read-only, and the model refuses writes too', () => {
  const site = between(CONFIRM_RENDER, '<AddressPickerWithMap', '/>', 'confirm picker call site');
  assert.match(site, /editable=\{confirmAddrMode === 'new'\}/, 'every field is disabled unless adding a new address');
  assert.match(site, /key=\{`confirm-address-\$\{confirmAddrMode\}`\}/,
    'the picker binds draggability and its GPS dedupe at mount — a mode switch must remount it');
  // Reads the LIVE mode via the ref (see the review-fix test below): a late
  // geocode calls the closure of an unmounted instance, where the state is stale.
  assert.match(site, /onChange=\{\(next: AddressValue\) => \{\s*if \(confirmAddrModeRef\.current !== 'new'\) return;/,
    'a stray write in saved mode would make the fields disagree with the row being booked');
  // The landmark and instruction inputs honour `editable` inside the picker.
  const landmark = between(PICKER, '<Label className="text-xs">Landmark</Label>', '/>', 'picker landmark input');
  assert.match(landmark, /disabled=\{!editable\}/);
  const note = between(PICKER, '<Label className="text-xs">Address Instructions</Label>', '/>', 'picker instruction textarea');
  assert.match(note, /disabled=\{!editable\}/);
});

test('picking a row copies every field, the technician note included, and counts as a change', () => {
  const pick = between(SRC, 'function pickConfirmAddress(row: ConfirmAddressRow) {', '\n  }\n', 'pickConfirmAddress');
  assert.match(pick, /onFormDirty\?\.\(true\);/);
  assert.match(pick, /setConfirmAddrMode\('saved'\);/);
  assert.match(pick, /setConfirmAddrPickId\(row\.address_id\);/);
  assert.match(pick, /const fields = toConfirmAddressFields\(row\);\s*setF\(\(s\) => \(\{ \.\.\.s, \.\.\.fields \}\)\);/);
  assert.deepEqual(Object.keys(H.toConfirmAddressFields({})).sort(),
    ['address', 'address_instruction', 'building', 'city_id', 'gps_location', 'landmark', 'pin_code'],
    'all seven — a field left out keeps the PREVIOUS row\'s value on screen (the note, typically)');
});

test('Add New Address pre-fills from the checked row, and Use a saved address restores it', () => {
  const start = between(SRC, 'function startNewConfirmAddress() {', '\n  }\n', 'startNewConfirmAddress');
  assert.match(start, /onFormDirty\?\.\(true\);/);
  assert.match(start, /const from = confirmPickedRow \? toConfirmAddressFields\(confirmPickedRow\) : toConfirmAddressFields\(f\);/);
  assert.match(start, /prefillNewConfirmAddress\(initial, from\)/);
  assert.match(start, /setConfirmAddrMode\('new'\);/);
  assert.match(CONFIRM_RENDER, /onClick=\{startNewConfirmAddress\}>\s*<Plus [^>]*\/>\s*Add New Address\s*</);
  assert.match(CONFIRM_RENDER, /onClick=\{\(\) => pickConfirmAddress\(confirmPickedRow\)\}\s*>\s*Use a saved address\s*</);
});

test('the Bulk Upload building mirror only ever shapes a NEW address', () => {
  const blob = { ...COMPLETE, building: '' };
  assert.equal(H.prefillNewConfirmAddress({ source_type: 'Bulk Upload' }, blob).building, blob.address);
  assert.equal(H.prefillNewConfirmAddress({ source_type: 'excel' }, blob).building, blob.address);
  assert.equal(H.prefillNewConfirmAddress({ source_type: 'CRM - New' }, blob).building, '', 'other sources untouched');
  assert.equal(H.prefillNewConfirmAddress({ source_type: 'Bulk Upload' }, COMPLETE).building, COMPLETE.building,
    'a building that is already there is never overwritten');
  assert.doesNotMatch(SRC, /building: s\.address/, 'the old in-place mirror onto the booked row must not return');
});

// ─── 5. The save: never patch.address; fk_address_id or new_address (R1-R3) ─

test('the Confirm save never assigns patch.address', () => {
  assert.match(CONFIRM_PATCH, /patch\.services = /, 'positive control: this is the confirm PATCH assembly');
  assert.doesNotMatch(SUBMIT, /patch\.address\s*=/, 'patch.address edits the current tbl_address row in place (R1)');
  assert.doesNotMatch(SUBMIT, /patch\[['"]address['"]\]/);
  assert.doesNotMatch(SUBMIT, /setIf\(['"]address['"]/);
  assert.doesNotMatch(CONFIRM_PATCH, /pickIf\(\{\s*address:/, 'the old in-place address sub-payload is gone');
});

test('saved mode sends fk_address_id only for a DIFFERENT row; new mode sends new_address', () => {
  const branch = between(CONFIRM_PATCH, "if (confirmAddrMode === 'saved') {", 'setIf(\'job_desc\', (parentOverride', 'confirm address branch');
  assert.match(branch, /const currentAddressId = confirmCurrentAddressId\(initial\);\s*if \(confirmAddrPickId && confirmAddrPickId !== currentAddressId\) \{\s*patch\.fk_address_id = confirmAddrPickId;\s*\}/,
    'the current row sends nothing; another row re-points the job at it as is');
  // A complete new address is sent as new_address — unless this open modal
  // already created that exact row, in which case it re-points (retry safety).
  assert.match(branch, /\} else \{\s*const newAddress = toConfirmAddressFields\(f\);\s*const newAddressMissing = confirmAddressMissing\(newAddress\);\s*if \(newAddressMissing\.length === 0\) \{\s*const newAddressPayload = buildConfirmNewAddress\(newAddress\);[\s\S]{0,260}?patch\.new_address = newAddressPayload;/);
  assert.match(branch, /\} else if \(submitVariant === 'draft'\) \{\s*newAddressNotSaved = newAddressMissing;\s*\} else \{\s*setError\([^;]*;\s*return;\s*\}/,
    'an incomplete new address: a draft saves without it; anything else stops before the PATCH');
  // Outcome variants keep skipping the address: the branch sits inside the
  // `!isOutcomeOnly` block, before the PATCH.
  assert.ok(CONFIRM_PATCH.includes(branch));
});

test('the new_address body is trimmed, typed, and omits empty optional fields', () => {
  assert.deepEqual(H.buildConfirmNewAddress({
    ...COMPLETE, address: '  Flat 4B  ', landmark: '   ', address_instruction: '',
  }), {
    address: 'Flat 4B',
    building: 'Palm Grove Society, Sector 21',
    city_id: 12,
    pin_code: '122001',
    gps_location: '28.459500,77.026600',
  });
  assert.equal(H.buildConfirmNewAddress({ ...COMPLETE }).address_instruction, 'Ring the 2nd-floor bell',
    'the new address carries its own technician note');
});

test('a draft that dropped an incomplete new address says so, once, after the save lands', () => {
  const afterPatch = SUBMIT.slice(SUBMIT.indexOf('const saved = await api.patch<Job>(`/admin/jobs/${initial.job_id}`, patch);'));
  const draft = between(afterPatch, "if (submitVariant === 'draft') {", 'const closesAfterBook', 'draft success block');
  assert.match(draft, /message: 'Draft Saved'/, 'positive control: the draft success block');
  assert.match(draft, /if \(newAddressNotSaved\) \{\s*showToast\(\{\s*variant: 'warning',\s*message: `New address not saved — it is incomplete\. Missing: \$\{newAddressNotSaved\.join\(', '\)\}\./);
  assert.equal((SUBMIT.match(/New address not saved/g) || []).length, 1, 'one toast, not one per field');
});

test('the sibling fan-out still reuses the address id the PATCH response returns', () => {
  assert.match(SUBMIT, /const parentAddressId = resolveParentAddressId\(saved, initial\);/,
    'saved.fk_address_id is the NEW id after a re-point or a new address — reading initial first would fan siblings out onto the old row');
});

// ─── 6. Gates ───────────────────────────────────────────────────────────────

test('Book Call: saved mode keeps its rule; new mode also needs the full completeness rule', () => {
  const gate = between(SRC, 'const confirmNewAddressMissing = ', 'function pickConfirmAddress', 'address gate');
  assert.match(gate, /const confirmNewAddressMissing = confirmAddrMode === 'new'\s*\? confirmAddressMissing\(toConfirmAddressFields\(f\)\)\s*: \[\];/);
  assert.match(gate, /CONFIRM_GPS_RX\.test\(String\(f\.gps_location \|\| ''\)\.trim\(\)\) &&\s*confirmNewAddressMissing\.length === 0;/);
  // The pre-submit gate names the missing fields for whichever address books.
  const book = between(SUBMIT, "if (isConfirm && submitVariant === 'book' && (!confirmSection2Complete || !hasAtLeastOneService)) {", 'setSubmitting(false);', 'book gate');
  assert.match(book, /if \(confirmAddrMode === 'new'\) \{\s*missing\.push\(\.\.\.confirmNewAddressMissing\.map/);
  assert.match(book, /missing\.push\('GPS Location \(pick on the map\)'\)/,
    'GPS was gated but never listed — a GPS-only gap printed an empty list');
  assert.match(book, /use Add New Address/, 'a saved address cannot be fixed here, so say what can');
});

// ─── 6b. Review fixes (2026-09-17) ──────────────────────────────────────────

test('a customer submission never overrides the address the job points at', () => {
  // acceptSubmission merges the submission INTO the job's address row, and the
  // payload is never cleared — so deriving the start from the overlay made every
  // reopen after a re-point uncheck the current address and offer a new row.
  const overlayBranch = between(SRC, "if (mode === 'confirm' && payload) {", 'return;', 'submission overlay branch');
  assert.match(overlayBranch, /const start = confirmAddressStart\(initial, toConfirmAddressFields\(base\)\);/,
    'the picker must start from the job\'s own row (`base`), not the overlay');
  assert.doesNotMatch(overlayBranch, /confirmAddressStart\(initial, toConfirmAddressFields\(seeded\)\)/);
  assert.match(overlayBranch, /setF\(\{ \.\.\.seeded, \.\.\.start\.fields \}\);/,
    'the job row\'s address fields must win over the overlay\'s');
});

test('a late map write from the unmounted new-address picker cannot reach a saved row', () => {
  assert.match(SRC, /const confirmAddrModeRef = useRef\(confirmAddrMode\);[\s\S]{0,40}?useEffect\(\(\) => \{ confirmAddrModeRef\.current = confirmAddrMode; \}, \[confirmAddrMode\]\);/,
    'the ref must track the live mode');
  assert.match(SRC, /if \(confirmAddrModeRef\.current !== 'new'\) return;/,
    'the picker guard must read the LIVE mode — a stale closure still says \'new\'');
  assert.doesNotMatch(SRC, /if \(confirmAddrMode !== 'new'\) return;/);
});

test('retrying after a later step failed re-uses the address the first attempt created', () => {
  assert.match(SUBMIT, /const created = confirmCreatedAddressRef\.current;\s*if \(created && created\.key === JSON\.stringify\(newAddressPayload\)\) \{[\s\S]{0,120}?patch\.fk_address_id = created\.id;\s*\} else \{\s*patch\.new_address = newAddressPayload;/,
    'new_address always INSERTs — the same payload twice must re-point, not insert again');
  assert.match(SUBMIT, /confirmCreatedAddressRef\.current = \{ key: JSON\.stringify\(patch\.new_address\), id: landedId \};/,
    'the created row is remembered only once it has landed');
});

test('an address choice the server dropped fails loudly before anything is booked', () => {
  const patchAt = SUBMIT.indexOf('const saved = await api.patch<Job>(`/admin/jobs/${initial.job_id}`, patch);');
  const guardAt = SUBMIT.indexOf('if (isConfirm && (patch.fk_address_id !== undefined || patch.new_address !== undefined)) {');
  const statusAt = SUBMIT.indexOf('/status`', patchAt);
  assert.ok(patchAt > -1 && guardAt > patchAt, 'the check reads the PATCH response');
  assert.ok(statusAt === -1 || guardAt < statusAt, 'and runs BEFORE the status PATCH books the job');
  const guard = SUBMIT.slice(guardAt, guardAt + 900);
  assert.match(guard, /\? landedId === patch\.fk_address_id\s*: landedId !== null && landedId !== confirmCurrentAddressId\(initial\);/);
  assert.match(guard, /if \(!landed\) \{\s*setError\([^)]*nothing was booked[^)]*\);\s*return;/,
    'a backend that strips the new keys answers 200 with the OLD address — that must stop the booking');
});

// ─── 7. Controls ────────────────────────────────────────────────────────────

test('positive control — the stripper removes prose and keeps code', () => {
  const sample = strip("/* patch.address = x */\n{/* savedAddresses[0] */}\nconst url = 'https://x'; // patch.address\n");
  assert.doesNotMatch(sample, /patch\.address/, 'block and line comments must be blanked');
  assert.doesNotMatch(sample, /savedAddresses/, 'JSX comments must be blanked');
  assert.match(sample, /const url = 'https:\/\/x';/, 'code — including a // inside a string — must survive');
  // And the prose really does mention the removed shapes, so the strip is doing work.
  assert.match(RAW, /savedAddresses\[0\]/, 'the removal is documented in a comment');
});

test('scope control — Book New Call keeps its own picker untouched', () => {
  assert.match(SRC, /const isSelected = selectedAddressId === a\.address_id;/,
    'the create-flow picker still owns selectedAddressId; this change must not have rewired it');
});
