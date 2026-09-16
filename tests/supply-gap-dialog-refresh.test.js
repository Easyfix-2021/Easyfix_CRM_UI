'use strict';
/*
 * Supply Gap request dialog re-reads itself after every action (2026-09-15,
 * pre-Production review).
 *
 * refreshAfterAction only called invalidateFetch(), which evicts the cache and
 * notifies useFetchOnce listeners — useFetch does not subscribe. The open
 * dialog therefore kept its first-load status, action buttons and Action
 * History: an added remark never appeared (inviting a duplicate), and after
 * Cancel / Allocate every stale button stayed and answered with a 409.
 *
 * Source-shape guard (the suite mounts nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/quicksight/SupplyGapRequestDialog.tsx'), 'utf8');
const flat = src.replace(/\s+/g, ' ');

test('detail and history are useFetch reads, so only refetch() re-runs them', () => {
  assert.match(flat, /const detail = useFetch<SupplyGapDetail>\(`\$\{API_BASE\}\/\$\{id\}`\);/);
  assert.match(flat, /const history = useFetch<SupplyGapHistoryEntry\[\]>\(`\$\{API_BASE\}\/\$\{id\}\/history`\);/);
});

test('refreshAfterAction refetches the detail and the history, then the list', () => {
  const fn = (flat.match(/function refreshAfterAction\(\) \{.*?onSaved\(\); \}/) || [''])[0];
  assert.ok(fn, 'refreshAfterAction must exist');
  assert.match(fn, /detail\.refetch\(\);/);
  assert.match(fn, /history\.refetch\(\);/);
  assert.match(fn, /onSaved\(\);/);
});

test('every action path in the dialog goes through refreshAfterAction', () => {
  assert.match(flat, /<AddRemarkBox id=\{id\} onAdded=\{refreshAfterAction\} \/>/);
  assert.match(flat, /<CloseRequestDialog id=\{id\} kind=\{action\} onClose=\{\(\) => setAction\(null\)\} onDone=\{refreshAfterAction\} \/>/);
  assert.match(flat, /<NewTechnicianDialog mode="supply" id=\{id\} onClose=\{\(\) => setAction\(null\)\} onDone=\{refreshAfterAction\} \/>/);
});
