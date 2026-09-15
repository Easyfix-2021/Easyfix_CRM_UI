'use strict';
/*
 * Issue Queue screenshots enlarge on click (2026-09-11).
 *
 * The detail dialog rendered each screenshot as a bare <img> capped at 420px —
 * a full-page capture was unreadable and clicking it did nothing. Each
 * thumbnail now opens the shared lightbox, in its WIDE mode: at the default
 * 2xl a full-width capture comes out smaller than the thumbnail it came from.
 * Source-shape, because the suite mounts nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'src/app/(authed)/admin-actions/issues/page.tsx'), 'utf8');
const BOX = fs.readFileSync(path.join(ROOT, 'src/components/easyfixer/SkillImageLightbox.tsx'), 'utf8');
const panel = PAGE.slice(PAGE.indexOf('function ScreenshotPanel('));

test('a screenshot is a button that opens the lightbox', () => {
  assert.ok(panel.length > 0, 'ScreenshotPanel must exist');
  assert.match(panel, /<button type="button" onClick=\{onOpen\}[^>]*>\s*\{\/\* eslint-disable-next-line @next\/next\/no-img-element \*\/\}\s*<img/,
    'the live image must be wrapped in the click target');
  assert.match(PAGE, /<ScreenshotPanel key=\{u\} url=\{u\} onReload=\{refetch\}\s*\n\s*onOpen=\{\(\) => setZoom\(\{ url: u,/,
    'every signed screenshot must pass its own URL to the lightbox');
  assert.match(PAGE, /<SkillImageLightbox wide value=\{zoom\} onClose=\{\(\) => setZoom\(null\)\} \/>/,
    'and the lightbox must be mounted, in wide mode');
});

test('wide mode is opt-in — the four existing lightbox users keep their size', () => {
  assert.match(BOX, /value, onClose, wide = false,/, 'default must stay the original 2xl box');
  assert.match(BOX, /className=\{wide \? '!max-w-none w-\[calc\(100vw-48px\)\]' : 'sm:max-w-2xl'\}/,
    'wide must actually be wider than the 420px thumbnail it enlarges');
});
