'use strict';
/*
 * A LINK MAY NOT CLAIM A FILTER THE PAGE CANNOT APPLY.
 *
 * The client profile's Reports section links to six reports "for this client".
 * For a long time none of them read a client id, and the section said so in its
 * own UI — the honest choice, because the alternative is the real hazard: an
 * operator sees a client in the URL, trusts a filter that was never applied,
 * and reads whole-book numbers as if they belonged to one client.
 *
 * Five now seed their filter from `?clientId=`. Priority Jobs cannot: it has no
 * client filter at all, only a clientName COLUMN. So the section carries a
 * `scoped` flag per report, and this test makes that flag TRUE OR FALSE
 * rather than aspirational — flipping it on a page that cannot honour it fails
 * here instead of misleading an operator.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SENDER = path.join(ROOT, 'src/components/client/ReportsSection.tsx');
const QS = path.join(ROOT, 'src/app/(authed)/quicksight');

/** The REPORTS table, read from the sender — not re-typed here. */
function declaredReports() {
  const src = fs.readFileSync(SENDER, 'utf8');
  const block = /const REPORTS[\s\S]*?\n\];/.exec(src);
  assert.ok(block, 'the REPORTS table must exist in ReportsSection');
  return [...block[0].matchAll(/href:\s*'\/quicksight\/([^']+)'[\s\S]*?scoped:\s*(true|false)/g)]
    .map((m) => ({ slug: m[1], scoped: m[2] === 'true' }));
}

/*
 * A report's code is either its page, or the Body the page delegates to — two
 * of these routes are 14-line wrappers so the same component can also render
 * inside the Performance report's tabs.
 */
function sourcesFor(slug) {
  const dir = path.join(QS, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

const readsParam = (srcs) => srcs.some((s) => /report-client-param/.test(s) && /useSearchParams/.test(s));

test('every report the profile links as client-scoped actually reads ?clientId=', () => {
  const broken = declaredReports()
    .filter((r) => r.scoped && !readsParam(sourcesFor(r.slug)))
    .map((r) => r.slug);
  assert.deepEqual(broken, [],
    'these are linked with ?clientId= but never read it — the operator would see a '
    + 'client in the URL and trust a filter that was never applied. Either seed the '
    + "page from src/lib/report-client-param.ts, or set scoped:false on its entry.");
});

test('and one marked unscoped genuinely has no client filter to set', () => {
  /*
   * The other direction. If a report gains a client filter and starts reading
   * the param, leaving scoped:false silently wastes it — the link keeps opening
   * unfiltered while the page could have honoured it.
   */
  const stale = declaredReports()
    .filter((r) => !r.scoped && readsParam(sourcesFor(r.slug)))
    .map((r) => r.slug);
  assert.deepEqual(stale, [],
    'this report now reads ?clientId= — set scoped:true so the profile link uses it');
});

test('the parsing is SHARED — no report may hand-roll it', () => {
  /*
   * Three different filter shapes across these reports, so a per-page Number()
   * is the obvious shortcut and the silent one: a misread id becomes
   * clientId=NaN on that report's own API call, showing an empty result under a
   * heading that names a client.
   */
  for (const { slug } of declaredReports()) {
    for (const src of sourcesFor(slug)) {
      if (!/useSearchParams/.test(src)) continue;
      const usesParam = /getAll\(\s*['"]clientId['"]|get\(\s*['"]clientId['"]/.test(src);
      if (!usesParam) continue;
      assert.match(src, /report-client-param/,
        `${slug} reads clientId from the URL without the shared parser`);
    }
  }
});

test('the guard is not vacuous — it can see the table and the pages', () => {
  const reports = declaredReports();
  assert.ok(reports.length >= 5, `only ${reports.length} reports parsed from the sender`);
  assert.ok(reports.some((r) => r.scoped), 'at least one must be client-scoped');
  /*
   * NOT "at least one must be unscoped". That was here while Priority Jobs had
   * no client filter, and it failed the moment the report gained one — a test
   * asserting a temporary fact as an invariant. The `scoped` flag is allowed to
   * be all-true; what must hold is that it MATCHES each page, which the two
   * tests above check in both directions.
   */
  for (const r of reports) {
    assert.ok(sourcesFor(r.slug).length > 0, `no source found for /quicksight/${r.slug}`);
  }
});
