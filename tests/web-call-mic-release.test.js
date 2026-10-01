'use strict';

/*
 * web-call-mic-release — the browser mic is released when a web call ends.
 *
 * THE BUG THIS PINS (2026-10-01, ops): after a call ended the address bar kept
 * showing the mic icon until the tab reloaded. plivo-browser-sdk 2.2.21 with
 * the noise filter on keeps the raw mic stream to itself, hands the call a
 * PROCESSED copy, and on hangup stops only the copy — the raw track lives on.
 *
 * Two halves: the tracker's behaviour (stubbed getUserMedia, replaying the
 * SDK's leak), and a source scan that every way a call ends — operator Hang Up,
 * remote hang-up (onCallTerminated), failure (onCallFailed) — releases it. The
 * wiring lives in .tsx that test:build does not compile.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { trackMicStreams } = require('../.test-build/mic-streams.js');

// ─── Fakes ───────────────────────────────────────────────────────────────

function fakeStream() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  return { track, getTracks: () => [track] };
}

function fakeMediaDevices() {
  const issued = [];
  const md = {
    async getUserMedia() { const s = fakeStream(); issued.push(s); return s; },
  };
  return { md, issued };
}

/*
 * The SDK's noise-filter call, as plivo-browser-sdk 2.2.21 does it: acquire the
 * raw mic, keep a processed copy as the call's stream, and on hangup stop ONLY
 * the copy. Returns the raw stream so the test can look at the leaked track.
 */
async function sdkCall(md) {
  const raw = await md.getUserMedia({ audio: true, video: false });
  const processed = fakeStream();           // MediaStreamDestination output — not from getUserMedia
  return { raw, hangupCleanup: () => processed.getTracks().forEach((t) => t.stop()) };
}

// ─── 1. Behaviour ────────────────────────────────────────────────────────

test('control: without release the SDK leaves the raw mic track live after hangup', async () => {
  const { md } = fakeMediaDevices();
  trackMicStreams(md);
  const call = await sdkCall(md);
  call.hangupCleanup();
  assert.equal(call.raw.track.readyState, 'live', 'the leak this file exists for must reproduce, or the next test proves nothing');
});

test('release() stops the raw mic track the SDK leaked', async () => {
  const { md } = fakeMediaDevices();
  const mic = trackMicStreams(md);
  const call = await sdkCall(md);
  call.hangupCleanup();
  mic.release();
  assert.equal(call.raw.track.readyState, 'ended');
});

test('every stream since the last release is stopped — not just the latest', async () => {
  const { md, issued } = fakeMediaDevices();
  const mic = trackMicStreams(md);
  await md.getUserMedia({ audio: true });   // SDK raw mic
  await md.getUserMedia({ audio: true });   // Teleprompter VAD / SDK stats re-grab
  assert.equal(issued.length, 2);
  mic.release();
  assert.deepEqual(issued.map((s) => s.track.readyState), ['ended', 'ended']);
});

test('the next call gets a fresh, live mic and is released on its own end', async () => {
  const { md } = fakeMediaDevices();
  const mic = trackMicStreams(md);
  const first = await sdkCall(md);
  mic.release();
  const second = await sdkCall(md);
  assert.equal(second.raw.track.readyState, 'live', 'releasing call 1 must not touch call 2');
  mic.release();
  assert.equal(first.raw.track.readyState, 'ended');
  assert.equal(second.raw.track.readyState, 'ended');
});

test('a track that throws on stop() does not strand the rest', async () => {
  const { md, issued } = fakeMediaDevices();
  const mic = trackMicStreams(md);
  await md.getUserMedia();
  await md.getUserMedia();
  issued[0].getTracks = () => { throw new Error('gone'); };
  mic.release();
  assert.equal(issued[1].track.readyState, 'ended');
});

test('restore() puts the original getUserMedia back', () => {
  const { md } = fakeMediaDevices();
  const orig = md.getUserMedia;
  const mic = trackMicStreams(md);
  assert.notEqual(md.getUserMedia, orig, 'tracking must actually wrap getUserMedia');
  mic.restore();
  assert.equal(md.getUserMedia, orig);
});

// ─── 2. Every way a call ends releases the mic ───────────────────────────

const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');
const ctx = strip(fs.readFileSync(path.resolve(__dirname, '../src/components/calls/WebCallContext.tsx'), 'utf8'));

// Text of the block starting at `startRe`, up to its matching close brace.
function block(startRe) {
  const m = startRe.exec(ctx);
  assert.ok(m, `not found: ${startRe}`);
  let i = ctx.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < ctx.length; j += 1) {
    if (ctx[j] === '{') depth += 1;
    else if (ctx[j] === '}' && (depth -= 1) === 0) return ctx.slice(i, j + 1);
  }
  throw new Error(`unbalanced: ${startRe}`);
}

test('the provider tracks getUserMedia and releases + restores on unmount (logout)', () => {
  const eff = block(/trackMicStreams\(md\)[\s\S]*?return \(\) => /);
  assert.match(eff, /tracker\.release\(\)/);
  assert.match(eff, /tracker\.restore\(\)/);
});

test('remote hang-up: onCallTerminated releases the mic', () => {
  assert.match(block(/client\.on\('onCallTerminated', \(\) => /), /releaseMic\(\)/);
});

test('failed call: onCallFailed releases the mic BEFORE any early return', () => {
  const body = block(/client\.on\('onCallFailed', \(reason: any\) => /);
  const rel = body.indexOf('releaseMic()');
  const ret = body.indexOf('return');
  assert.ok(rel !== -1, 'onCallFailed must release the mic');
  assert.ok(ret === -1 || rel < ret, 'a release after the first return misses the Cancelled / retry paths');
});

test('operator hang-up: hangup() releases the mic', () => {
  assert.match(block(/const hangup = React\.useCallback\(\(\) => /), /releaseMic\(\)/);
});
