'use strict';
/*
 * The "Offered To" surfaces must show who took the job, and must not re-derive
 * why an offer closed.
 *
 * ─── 2026-09-15 ────────────────────────────────────────────────────────────
 * Job 540158 was offered to two technicians at 09:35. Rahul Singh accepted at
 * 10:33:07 and was assigned; ritik wankhede's offer was closed in the same
 * second. Schedule & Assign's "Offered To" table showed ONLY ritik, as EXPIRED,
 * and never showed that Rahul accepted: GET /admin/jobs/:id/offers filtered
 * ACCEPTED rows out, and both CRM surfaces coloured any status other than 2/3
 * amber, so an ACCEPTED row would have read as a pending offer anyway. With
 * offer expiry switched off, "EXPIRED" also invited the reading that ritik
 * ignored the job — a claim about a person that was false.
 *
 * The backend now returns every status plus a derived `outcome`,
 * `outcome_label` and `outcome_detail` (job.listOffers). The CRM renders those
 * and keeps no copy of the reason wording, so the label table lives in one
 * place (offer-closed-reason.js) and cannot drift.
 *
 * Source-shape guards, because the suite mounts nothing. offerOutcome.ts is
 * also transpiled and run (as festivals.test.js does), because the CRM ships
 * BEFORE the backend: its fallback for rows without `outcome` is what keeps
 * today's backend rendering correctly, and a regex cannot tell a dropped
 * fallback from a reworded one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const API = path.join(SRC, 'lib/api.ts');
const OUTCOME = path.join(SRC, 'components/job/offerOutcome.ts');
const MODAL = path.join(SRC, 'components/job/ScheduleAssignModal.tsx');
const HOVER = path.join(SRC, 'components/job/OfferHoverCard.tsx');
const COMPONENTS = [MODAL, HOVER];

const read = (p) => fs.readFileSync(p, 'utf8');

function loadOfferOutcome() {
  // `import type` from '@/lib/api' is erased, so the module needs no require.
  const { outputText } = ts.transpileModule(read(OUTCOME), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'offerOutcome.ts',
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  return mod.exports;
}

test('offerOutcome maps the holder green and colours every outcome', () => {
  const api = read(API);
  const union = api.match(/export type OfferOutcome = ([^;]+);/);
  assert.ok(union, 'OfferOutcome must still be exported from lib/api.ts');
  const keys = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(keys.length, 8, `expected 8 OfferOutcome keys, got ${keys.join(', ')}`);

  const src = read(OUTCOME);
  const block = src.match(/const OUTCOME_TEXT: Record<OfferOutcome, string> = \{[\s\S]*?\n\};/);
  assert.ok(block, 'OUTCOME_TEXT must stay a Record<OfferOutcome, string> so tsc rejects a gap');
  for (const key of keys) {
    assert.match(block[0], new RegExp(`\\b${key}: 'text-`), `OUTCOME_TEXT has no colour for '${key}'`);
  }
  // An accepted offer used to fall through to amber and read as still pending.
  assert.match(block[0], /\baccepted: 'text-success-strong'/);
  assert.match(block[0], /\bassigned: 'text-success-strong'/);
});

test('both surfaces take status colour from offerOutcome, not inline status codes', () => {
  for (const file of COMPONENTS) {
    const src = read(file);
    const name = path.basename(file);
    assert.match(src, /from '\.\/offerOutcome'/, `${name} must import from ./offerOutcome`);
    assert.doesNotMatch(src, /offer_status === 3\s*\?\s*'text-ink-500'/,
      `${name} is back to colouring by raw offer_status — ACCEPTED falls through to amber`);
  }
});

test('both surfaces render the backend detail line and the inferred tooltip', () => {
  for (const file of COMPONENTS) {
    const src = read(file);
    const name = path.basename(file);
    assert.match(src, /o\.outcome_detail/, `${name} must render outcome_detail`);
    assert.match(src, /INFERRED_OUTCOME_TITLE/,
      `${name} must say when a close reason was inferred rather than recorded`);
  }
});

test('JobOffer carries the outcome fields as optional', () => {
  const api = read(API);
  const block = api.match(/export type JobOffer = \{[\s\S]*?\n\};/);
  assert.ok(block, 'JobOffer must still exist');
  // Optional, so this CRM still renders against a backend that predates them.
  for (const field of ['closed_reason', 'outcome', 'outcome_label', 'outcome_detail', 'outcome_inferred']) {
    assert.match(block[0], new RegExp(`\\b${field}\\?:`), `JobOffer is missing optional ${field}`);
  }
});

test('the CRM keeps no copy of the close-reason wording or keys', () => {
  /*
   * Case-sensitive on purpose: INFERRED_OUTCOME_TITLE says "another technician
   * accepting", which is tooltip prose, not the backend's label.
   */
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const src = read(full);
      for (const needle of ['Another technician accepted', 'sibling_accepted']) {
        if (src.includes(needle)) hits.push(`${path.relative(ROOT, full)}: ${needle}`);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(hits, [],
    'reason labels come from the backend (OFFER_CLOSED_REASON_LABEL); a CRM copy drifts');
});

test('the decline quote follows the REJECTED outcome, not the raw status', () => {
  /*
   * The job's holder can sit on an old REJECTED row (assigned directly later).
   * Quoting their decline under ASSIGNED would contradict the status word.
   */
  assert.match(read(MODAL), /showsRejectReason\(o\) && o\.reject_reason/,
    'ScheduleAssignModal must gate the reject quote on showsRejectReason(o)');
  assert.doesNotMatch(read(MODAL), /o\.offer_status === 2 && o\.reject_reason/,
    'the raw status-2 gate is back');
  assert.match(read(OUTCOME),
    /export function showsRejectReason\(o: JobOffer\): boolean \{\s*return o\.outcome \? o\.outcome === 'rejected'/,
    "showsRejectReason must key on outcome === 'rejected' when the backend sends an outcome");
});

test('rows from a backend without `outcome` render exactly as before', () => {
  /*
   * Today's Production listOffers sends no outcome keys. If this fallback goes,
   * its REJECTED and EXPIRED rows turn amber (read as pending) and every
   * decline quote disappears — on the backend the CRM deploys in front of.
   */
  const { offerStatusLabel, offerStatusTextClass, showsRejectReason, offersCarryOutcome } = loadOfferOutcome();
  const base = { efr_id: 9427, efr_name: 'T', offered_at: '2026-09-15T09:35:06Z' };
  const rows = [
    { ...base, offer_status: 0, offer_status_label: 'OFFERED' },
    { ...base, offer_status: 2, offer_status_label: 'REJECTED', reject_reason: 'Too far' },
    { ...base, offer_status: 3, offer_status_label: 'EXPIRED' },
  ];

  assert.equal(offersCarryOutcome(rows), false);
  assert.equal(offersCarryOutcome(undefined), false);
  assert.deepEqual(rows.map(offerStatusLabel), ['OFFERED', 'REJECTED', 'EXPIRED']);
  assert.deepEqual(rows.map(offerStatusTextClass), ['text-warning-strong', 'text-urgent-strong', 'text-ink-500']);
  assert.deepEqual(rows.map(showsRejectReason), [false, true, false]);
});

test('rows with `outcome` take label, colour and decline quote from it', () => {
  const { offerStatusLabel, offerStatusTextClass, showsRejectReason, offersCarryOutcome } = loadOfferOutcome();
  const base = { efr_id: 8079, efr_name: 'T', offered_at: '2026-09-15T09:35:06Z', outcome_inferred: false };
  // The holder on an old REJECTED row: ASSIGNED, green, and no decline quote.
  const holder = {
    ...base, offer_status: 2, offer_status_label: 'REJECTED', reject_reason: 'Busy',
    outcome: 'assigned', outcome_label: 'ASSIGNED', outcome_detail: 'Assigned directly',
  };
  const rejected = { ...base, offer_status: 2, offer_status_label: 'REJECTED', outcome: 'rejected', outcome_label: 'REJECTED' };
  const closed = { ...base, offer_status: 3, offer_status_label: 'EXPIRED', outcome: 'closed', outcome_label: 'CLOSED' };

  assert.deepEqual([holder, rejected, closed].map(offerStatusLabel), ['ASSIGNED', 'REJECTED', 'CLOSED']);
  assert.deepEqual([holder, rejected, closed].map(offerStatusTextClass),
    ['text-success-strong', 'text-urgent-strong', 'text-ink-500']);
  assert.deepEqual([holder, rejected, closed].map(showsRejectReason), [false, true, false]);
  // The backend's no-match branch sends outcome: null. That is still a new backend.
  assert.equal(offersCarryOutcome([{ ...base, offer_status: 0, outcome: null }]), true);
});

test('the caption describes outcome rows only when the backend sent them', () => {
  /*
   * On a backend without `outcome`, "the holder is listed first" and "Expired
   * marks an offer that timed out" are both false about its rows: ACCEPTED is
   * dropped and every closed offer says EXPIRED. That backend keeps the earlier
   * wording, which was the true warning for its data.
   */
  const caption = read(MODAL).match(/<p className="mb-2 text-xs text-muted-foreground">[\s\S]*?<\/p>/);
  assert.ok(caption, 'the Offered To caption paragraph must still exist');
  const text = caption[0].replace(/\s+/g, ' ');

  assert.match(text, /\{offerRowsCarryOutcome \? \( <> Technicians this job has been offered to \{offerHolderListed \? ', with the technician who holds the job listed first' : ''\}/,
    'the holder-first lead must be gated on the rows carrying outcome AND on a holder row being present');
  /*
   * On an unassigned job with live offers nobody holds the job, so the first row
   * is just an open offer — "the holder is listed first" would describe someone
   * who does not exist. Only an accepted/assigned outcome row is a holder.
   */
  assert.match(read(MODAL), /const offerHolderListed = offerRowsCarryOutcome\s*&& \(offers\.data\?\.items \?\? \[\]\)\.some\(\(o\) => o\.outcome === 'accepted' \|\| o\.outcome === 'assigned'\)/,
    'offerHolderListed must require rows with outcome AND an accepted/assigned holder row');
  assert.match(text, /offer_expiry_enabled === false \? \( offerRowsCarryOutcome \? \(/,
    'the Closed/Expired sentence must be gated on the rows carrying outcome');
  assert.match(text, /An <span className="font-medium">Expired<\/span>\{' '\} offer here was closed by a later action on the job/,
    'an older backend must keep the "closed by a later action" wording for its EXPIRED rows');
  /*
   * acceptOffer's lost-race branch closes the offer of a technician who tapped
   * Accept after the job moved on, so a Closed row may not claim they never
   * answered.
   */
  assert.doesNotMatch(text, /before the technician answered/);
  assert.match(read(OUTCOME), /o\.outcome !== undefined/,
    'offersCarryOutcome must treat outcome: null (sent by the backend) as present');
});
