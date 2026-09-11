'use strict';
/*
 * The Report An Issue widget lists only the caller's own tickets (2026-09-11).
 *
 * "All Tickets" used to request scope=all for the three issue managers, so
 * their personal widget showed everyone's tickets. Both list tabs are now
 * scope=mine — Open Tickets = mine/open, All Tickets = mine/every status — and
 * the full queue stays on /admin-actions/issues. The server enforces the same
 * rule independently (scope=all refused to non-managers, scope=mine filtered by
 * reporter); this pins the client side so the widget cannot drift back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/components/issue/IssueReporter.tsx'), 'utf8');

test('every list request the widget builds is scope=mine', () => {
  assert.match(SRC, /\$\{LIST_PREFIX\}\?scope=mine&limit=\$\{listLimit\}/, 'the one list-key builder hardcodes scope=mine');
  assert.doesNotMatch(SRC, /scope=\$\{/, 'no interpolated scope — nothing can select scope=all');
  assert.match(SRC, /showingList && tab === 'all' \? listKey\(\) : null/, 'All Tickets = my tickets, every status');
  assert.match(SRC, /showingList && tab === 'open' \? listKey\('open'\) : null/, 'Open Tickets = my open tickets');
});

test('All Tickets is offered to everyone; only Close stays manager-gated', () => {
  assert.match(SRC, /^\s*<TabsTrigger value="all" className="flex-1">All Tickets<\/TabsTrigger>$/m,
    'the tab must not be wrapped in the manager gate any more');
  assert.match(SRC, /\{canManage && issue\.status === 'open' \? \(/, 'closing a ticket is still manager-only');
});
