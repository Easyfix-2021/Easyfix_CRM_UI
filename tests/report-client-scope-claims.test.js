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

/**
 * The REPORTS table, read from the sender — not re-typed here.
 *
 * READ THE BOUNDS BEFORE LOOSENING THEM (2026-09-09). This parser used two
 * unbounded lazy runs and both could leave the region they meant to describe:
 *
 *   /const REPORTS[\s\S]*?\n\];/            — the run can cross `];`
 *   /href: '…'[\s\S]*?scoped:(true|false)/  — the run can cross `}`
 *
 * The second is the dangerous one. An entry with no literal `scoped:` key, or
 * one that spells `scoped` BEFORE `href`, does not simply fail to match — the
 * run walks into the NEXT entry and pairs this report's slug with its
 * neighbour's flag. The test then asserts a scoping claim against the wrong
 * report and passes, which is worse than not running at all.
 *
 * So each entry is matched as a whole object literal (`[^{}]` cannot leave it),
 * the two keys are read out of that entry independently — order no longer
 * matters — and a missing flag is a NAMED failure rather than a silent
 * omission. The cardinality assert below catches an entry the scanner dropped.
 */
function declaredReports() {
  const src = fs.readFileSync(SENDER, 'utf8');
  const block = /const REPORTS[^\]]*\n\];/.exec(src);
  assert.ok(block, 'the REPORTS table must exist in ReportsSection');

  const entries = (block[0].match(/\{[^{}]*\}/g) || [])
    .filter((e) => /href:\s*'\/quicksight\//.test(e));
  const declared = (block[0].match(/href:\s*'\/quicksight\//g) || []).length;
  assert.equal(
    entries.length, declared,
    'an entry was swallowed by the scanner — every /quicksight/ href must land in its own object literal',
  );

  return entries.map((entry) => {
    const slug = /href:\s*'\/quicksight\/([^']+)'/.exec(entry)[1];
    const scoped = /scoped:\s*(true|false)/.exec(entry);
    assert.ok(scoped, `REPORTS entry ${slug} declares no literal scoped: flag`);
    return { slug, scoped: scoped[1] === 'true' };
  });
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

/* ─── one concept, one wire name ────────────────────────────────────────── */

test('both performance reports send the SAME parameter for the monthly/weekly window', () => {
  /*
   * They did not. client-performance sent `period`; city-performance sent
   * `flag`, the name the legacy DTO used. One concept, two wire names, in
   * sibling reports rendered side by side in the same Performance page — a trap
   * for whoever writes the third, and the sort of thing that is invisible until
   * someone tries to share a link between them.
   *
   * `period` is canonical on both now. The backend still ACCEPTS `flag` as a
   * deprecated alias so the two repos can deploy in either order; this asserts
   * the frontend has stopped sending it.
   */
  const bodies = {
    'client-performance': 'ClientPerformanceBody.tsx',
    'city-performance': 'CityPerformanceBody.tsx',
  };
  for (const [slug, file] of Object.entries(bodies)) {
    const src = fs.readFileSync(path.join(QS, slug, file), 'utf8');
    assert.match(src, /qs\.set\('period',/, `${slug} must send period`);
    assert.doesNotMatch(src, /qs\.set\('flag',/,
      `${slug} still sends the legacy 'flag' spelling`);
    assert.doesNotMatch(src, /\bFlag\b/, `${slug} still has a Flag type`);
  }
});

test('and both seed that window from ?period=', () => {
  for (const [slug, file] of Object.entries({
    'client-performance': 'ClientPerformanceBody.tsx',
    'city-performance': 'CityPerformanceBody.tsx',
  })) {
    const src = fs.readFileSync(path.join(QS, slug, file), 'utf8');
    assert.match(src, /reportPeriodFromParams\(/,
      `${slug} must seed its window from the URL through the shared parser`);
  }
});
