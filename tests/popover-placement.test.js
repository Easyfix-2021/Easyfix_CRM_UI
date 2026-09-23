const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePlacement } = require('../.test-build/use-popover-position');

/*
 * Where a portaled popover is drawn (SearchSelect, SearchMultiSelect,
 * RowActionsMenu all route through usePopoverPosition).
 *
 * The cost of getting this wrong is an option nobody can reach. The height
 * used to carry a 200px FLOOR that ignored the real room below the trigger,
 * so a picker low in the viewport rendered past the viewport bottom — and the
 * hidden rows were unreachable, because a popover's scrollbar only scrolls
 * inside its own box and the clipped part of that box is off screen. Reported
 * 2026-09-23: the last role in the Custom Report dialog's role picker.
 *
 * Measured in a real renderer at 900x1280 before the fix: an 8-row picker with
 * 150/90/40px below the trigger lost 56/116/166px off the bottom.
 *
 * Geometry only — no DOM, no React. The rendered box is derived the way the
 * browser does it, so "off screen" here means off screen there.
 */

const OPTS = { gap: 4, matchTriggerWidth: true, maxHeight: 400, minHeight: 200 };
const VIEW_H = 900;
const VIEW_W = 1280;
// Natural height of an 8-option picker (search row + bulk row + 8 rows),
// measured in the browser. The popover renders min(content, maxHeight).
const CONTENT = 349;
const TRIGGER_H = 38;

/* A trigger whose bottom edge sits `spaceBelow` px above the viewport bottom. */
function triggerRect(spaceBelow) {
  const bottom = VIEW_H - spaceBelow;
  return { top: bottom - TRIGGER_H, bottom, left: 200, width: 320, height: TRIGGER_H };
}

/* The box the browser would paint, from whichever edge the hook anchored. */
function renderedBox(p) {
  const height = Math.min(CONTENT, p.maxHeight);
  const top = p.place === 'below' ? p.top : VIEW_H - p.bottom - height;
  return { top, bottom: top + height, height };
}

const place = (spaceBelow) => computePlacement(triggerRect(spaceBelow), VIEW_H, VIEW_W, OPTS);

test('the popover never renders off the top or bottom of the viewport', () => {
  for (const spaceBelow of [420, 320, 220, 200, 150, 90, 40, 8, 0]) {
    const box = renderedBox(place(spaceBelow));
    assert.ok(
      box.bottom <= VIEW_H + 0.5 && box.top >= -0.5,
      `spaceBelow=${spaceBelow}: box ${Math.round(box.top)}..${Math.round(box.bottom)} escapes 0..${VIEW_H}`,
    );
  }
});

test('with room below it stays below, at exactly the height the old formula gave', () => {
  // Parity guard: this change must be invisible wherever the popover already
  // fitted. `minHeight` is a flip THRESHOLD now, so below it the old floor
  // (max(minHeight, …)) and the new clamp agree exactly.
  const oldFormula = (spaceBelowRaw) => Math.max(OPTS.minHeight, Math.min(OPTS.maxHeight, spaceBelowRaw));
  // The threshold is the USABLE room — gap (4) and the 8px viewport margin come
  // off first — so the boundary sits at spaceBelow = minHeight + 12 = 212, not
  // 200. At exactly 212 the usable room is 200, which is not "< minHeight", so
  // it still draws below. (spaceBelow=200 leaves 188 and correctly flips: the
  // old floor would have asked for 200 there and hung 12px off screen.)
  for (const spaceBelow of [420, 320, 220, 212]) {
    const p = place(spaceBelow);
    const raw = VIEW_H - (VIEW_H - spaceBelow) - OPTS.gap - 8;
    assert.equal(p.place, 'below', `spaceBelow=${spaceBelow} should stay below`);
    assert.equal(p.top, VIEW_H - spaceBelow + OPTS.gap);
    assert.equal(p.bottom, null, 'only the anchored side is set');
    assert.equal(Math.round(p.maxHeight), Math.round(oldFormula(raw)));
  }
});

test('when the space below is too cramped it flips above and anchors its bottom edge', () => {
  for (const spaceBelow of [150, 90, 40]) {
    const p = place(spaceBelow);
    const r = triggerRect(spaceBelow);
    assert.equal(p.place, 'above', `spaceBelow=${spaceBelow} should flip above`);
    assert.equal(p.top, null, 'the top side must be released, or the box stretches between both edges');
    // Bottom edge sits one gap above the trigger.
    assert.equal(p.bottom, VIEW_H - r.top + OPTS.gap);
    assert.ok(p.maxHeight > 0);
  }
});

test('height never exceeds the room on the side it is drawn', () => {
  for (const spaceBelow of [420, 220, 150, 40, 0]) {
    const p = place(spaceBelow);
    const r = triggerRect(spaceBelow);
    const room = p.place === 'below'
      ? VIEW_H - r.bottom - OPTS.gap - 8
      : r.top - OPTS.gap - 8;
    assert.ok(p.maxHeight <= room + 0.5, `spaceBelow=${spaceBelow}: maxHeight ${p.maxHeight} > room ${room}`);
  }
});

test('a trigger squeezed from both sides still gets a non-negative, on-screen box', () => {
  // A short viewport: neither side has minHeight. It must pick the roomier
  // side and stay on screen rather than overflow to reach a floor.
  const shortView = 240;
  const r = { top: 100, bottom: 138, left: 200, width: 320, height: 38 };
  const p = computePlacement(r, shortView, VIEW_W, OPTS);
  assert.ok(p.maxHeight >= 0, 'height must never be negative');
  const height = Math.min(CONTENT, p.maxHeight);
  const top = p.place === 'below' ? p.top : shortView - p.bottom - height;
  assert.ok(top >= -0.5 && top + height <= shortView + 0.5,
    `box ${Math.round(top)}..${Math.round(top + height)} escapes 0..${shortView}`);
});

test('it is horizontally clamped into the viewport', () => {
  const nearRight = { top: 100, bottom: 138, left: VIEW_W - 40, width: 320, height: 38 };
  const p = computePlacement(nearRight, VIEW_H, VIEW_W, OPTS);
  assert.ok(p.left >= 8 && p.left + 320 <= VIEW_W - 8 + 0.5, `left ${p.left} spills horizontally`);
});
