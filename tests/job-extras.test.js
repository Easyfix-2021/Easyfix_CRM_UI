'use strict';
/*
 * Pure logic behind the V3 Phase 4 "job extras" CRM work (lib/job-extras.ts):
 *   - sanitizeSvgPathData / sanitizeSvgViewBox — the gate a stored signature
 *     payload must pass before JobSignatureCard puts it into a real <svg>
 *     attribute (never dangerouslySetInnerHTML — the path is DATA).
 *   - toolSelectionChanged — Tools to Carry Save-button dirty check.
 *
 * Runner: `node --test` (via `npm test`, which runs `test:build` first —
 * job-extras.ts is in that tsc file list in package.json).
 *
 * Each check below was run against a mutated copy of job-extras.ts and
 * watched go red before being restored:
 *   - SVG_PATH_DATA_ALLOWED widened to `/^.*$/` (accept anything)
 *                                  → 'rejects a path carrying a non-path character' failed.
 *   - sanitizeSvgViewBox     `w <= 0` changed to `w < 0` (let zero through)
 *                                  → 'rejects a zero or negative dimension' failed.
 *   - sanitizeSvgViewBox     dropped the MAX_SIGNATURE_DIMENSION cap
 *                                  → 'caps a runaway dimension' failed.
 *   - toolSelectionChanged   `a.size !== b.size` deleted (size check dropped)
 *                                  → 'flags an added or removed id' failed (an
 *                                    added id went undetected: every id in the
 *                                    OLD set is still in the new one, so the
 *                                    membership loop alone never sees it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeSvgPathData, sanitizeSvgViewBox, toolSelectionChanged,
} = require('../.test-build/job-extras.js');

// ─── sanitizeSvgPathData ─────────────────────────────────────────────────

test('accepts a well-formed SVG path data string verbatim', () => {
  const d = 'M0,0 L10.5,20 C1,2 3,4 5,6 Z';
  assert.equal(sanitizeSvgPathData(d), d);
});

test('rejects a path carrying a non-path character (script injection shape)', () => {
  assert.equal(sanitizeSvgPathData('M0,0 L10,10" onload="alert(1)'), '');
  assert.equal(sanitizeSvgPathData('<script>alert(1)</script>'), '');
});

test('rejects non-string input', () => {
  assert.equal(sanitizeSvgPathData(null), '');
  assert.equal(sanitizeSvgPathData(undefined), '');
  assert.equal(sanitizeSvgPathData(12345), '');
  assert.equal(sanitizeSvgPathData({ d: 'M0,0' }), '');
});

test('rejects an empty or whitespace-only path', () => {
  assert.equal(sanitizeSvgPathData(''), '');
  assert.equal(sanitizeSvgPathData('   '), '');
});

test('rejects an oversized path (past the 200KB gate)', () => {
  const huge = 'M0,0 ' + '1'.repeat(200_001);
  assert.equal(sanitizeSvgPathData(huge), '');
});

// ─── sanitizeSvgViewBox ──────────────────────────────────────────────────

test('accepts finite positive width/height', () => {
  assert.deepEqual(sanitizeSvgViewBox(300, 150), { width: 300, height: 150 });
  assert.deepEqual(sanitizeSvgViewBox('300', '150'), { width: 300, height: 150 });
});

test('rejects a zero or negative dimension', () => {
  assert.equal(sanitizeSvgViewBox(0, 150), null);
  assert.equal(sanitizeSvgViewBox(300, -1), null);
});

test('rejects a non-numeric or non-finite dimension', () => {
  assert.equal(sanitizeSvgViewBox('abc', 150), null);
  assert.equal(sanitizeSvgViewBox(Infinity, 150), null);
  assert.equal(sanitizeSvgViewBox(null, undefined), null);
});

test('caps a runaway dimension at 5000', () => {
  assert.deepEqual(sanitizeSvgViewBox(999_999, 150), { width: 5000, height: 150 });
});

// ─── toolSelectionChanged ────────────────────────────────────────────────

test('reports unchanged for the identical set, any order', () => {
  assert.equal(toolSelectionChanged([1, 2, 3], [3, 1, 2]), false);
});

test('flags an added or removed id', () => {
  assert.equal(toolSelectionChanged([1, 2], [1, 2, 3]), true);
  assert.equal(toolSelectionChanged([1, 2, 3], [1, 2]), true);
});

test('flags a same-size but different selection as changed', () => {
  assert.equal(toolSelectionChanged([1, 2, 3], [1, 2, 4]), true);
});

test('treats two empty sets as unchanged', () => {
  assert.equal(toolSelectionChanged([], []), false);
});

// ── current tools from the real GET /admin/jobs/:id/tools body ────────────
// The first build read `toolIds`, which the backend never sends: the editor
// showed no current tools and Save wiped the job's real list.
test('current tool ids come from items[].id, the shape the backend sends', () => {
  const { toolIdsFromResponse } = require('../.test-build/job-extras.js');
  assert.deepEqual(toolIdsFromResponse({ items: [{ id: 3, name: 'Drill' }, { id: '7', name: 'Tape' }] }), [3, 7]);
  assert.deepEqual(toolIdsFromResponse({ toolIds: [3, 7] }), [], 'a guessed field must not be read');
  assert.deepEqual(toolIdsFromResponse(null), []);
});
