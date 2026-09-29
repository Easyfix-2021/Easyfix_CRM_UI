'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Ops Desk moved from a card on /admin-actions to its own sidebar leaf under
 * Jobs (2026-09-29). The sidebar is tbl_menu-driven: the backend migration
 * seeds a row with url 'opsDesk', and URL_MAP is what turns that token into
 * the route — without the entry the leaf falls through to /coming-soon.
 * Source-level, because tests/ here is node:test with no DOM.
 */

const ROOT = path.join(__dirname, '..');
const URL_MAP = path.join(ROOT, 'src', 'lib', 'legacy-url-map.ts');
const ADMIN_ACTIONS = path.join(ROOT, 'src', 'app', '(authed)', 'admin-actions', 'page.tsx');
const JOBS = path.join(ROOT, 'src', 'app', '(authed)', 'jobs', 'page.tsx');

// Comments out first: both files mention /ops-desk in prose, and the absence
// check below must not be satisfied (or tripped) by a sentence.
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test("the sidebar token 'opsDesk' resolves to /ops-desk", () => {
  assert.match(strip(fs.readFileSync(URL_MAP, 'utf8')), /'opsDesk':\s*'\/ops-desk'/);
});

test('the Admin Actions grid no longer links /ops-desk', () => {
  const code = strip(fs.readFileSync(ADMIN_ACTIONS, 'utf8'));
  // Positive control: the scan is reading the grid, whose other cards remain.
  assert.match(code, /href: '\/verification'/);
  assert.ok(!code.includes("'/ops-desk'"), 'Ops Desk lives under Jobs in the sidebar now');
});

test('the /jobs header link to Ops Desk is kept', () => {
  assert.match(strip(fs.readFileSync(JOBS, 'utf8')), /href="\/ops-desk"/);
});
