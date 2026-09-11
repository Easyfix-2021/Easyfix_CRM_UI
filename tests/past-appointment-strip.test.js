'use strict';
/*
 * The past-appointment notice that BLOCKS the offer renders as a red strip
 * (2026-09-11, per ops): as a line of red text it read as a hint. It appears in
 * Schedule & Assign's offer mode (JobContextPanel with pastBlocksAction); the
 * assign/reassign advisory stays a non-blocking line. Source-shape, because
 * the suite mounts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/JobContextPanel.tsx'), 'utf8');
const block = SRC.slice(SRC.indexOf('pastBlocksAction ? ('), SRC.indexOf(') : (', SRC.indexOf('pastBlocksAction ? (')));

test('the blocking past-appointment notice is a red alert strip', () => {
  assert.ok(block.includes('This appointment time has already passed. Reschedule it'), 'the blocking branch must be found');
  assert.match(block, /<div role="alert" className="[^"]*\brounded-md\b[^"]*\bborder-urgent\/30\b[^"]*\bbg-urgent-tint\b[^"]*\btext-urgent-strong\b[^"]*">/,
    'a strip (border + tint background), announced as an alert — not bare red text');
  assert.match(block, /<AlertTriangle\b/, 'with the warning icon the other blocking strips carry');
  assert.doesNotMatch(block, /<p className="mt-2 text-xs font-medium text-urgent-strong">/, 'the old text-only rendering must be gone');
});
