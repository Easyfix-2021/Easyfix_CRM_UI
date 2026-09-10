#!/usr/bin/env node
/*
 * The TypeScript half of the dead-export sweep — CRM src/lib/**.
 *
 * SCOPE IS DELIBERATELY NARROW, and the exclusion is the interesting part:
 * src/app/** is NOT swept. Next.js consumes `default`, `metadata`,
 * `generateMetadata`, `dynamic`, `revalidate` and friends BY CONVENTION, with
 * no importer anywhere — so "nothing imports it" is meaningless there and a
 * sweep would flag the framework itself. src/components/** is swept but
 * reported separately, because a component exported for one page reads the same
 * as one exported for nobody until you look.
 *
 * Same false-negative bias as the CommonJS half: usage is a word-boundary
 * identifier match, so collisions read as CONSUMED. A sweep that might become
 * deletions should under-report.
 *
 * TYPE-ONLY EXPORTS ARE CLASSIFIED SEPARATELY. `export type X` consumed via
 * `import type { X }` is real usage, but a type nobody imports is a different
 * (and much lower-stakes) finding than dead runtime code.
 *
 * Usage: node dead-exports-ts.js <repo-root> <ref> [--dir src/lib]
 */
const path = require('path');
const { execFileSync } = require('child_process');

/* ABSOLUTE, always. require(path.join('.', 'node_modules', 'typescript'))
 * resolves against THIS FILE's directory, not the cwd, so a relative root
 * silently becomes scripts/node_modules and MODULE_NOT_FOUNDs. */
const ROOT = path.resolve(process.argv[2] || '.');
const REF = process.argv[3];
const dirIdx = process.argv.indexOf('--dir');
const DIR = dirIdx > -1 ? process.argv[dirIdx + 1] : 'src/lib';

const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

/*
 * execFileSync with an ARGUMENT ARRAY, never a shell string.
 *
 * The first version interpolated the path into `git -C … show ref:path` and ran
 * it through /bin/sh. Next.js route groups are literally named "(authed)", and
 * an unquoted "(" is a shell syntax error — so every one of the ~123 files under
 * src/app/ failed to load, silently, and "no importer" was then computed over a
 * corpus missing most of the application. The run still printed a confident
 * list. No shell, no quoting question.
 */
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 1 << 28 }).toString();

const all = git(['ls-tree', '-r', REF, '--name-only']).split('\n');
const SUBJECT = all.filter((f) => f.startsWith(DIR + '/') && /\.tsx?$/.test(f));
/* The corpus we search for usage: EVERY ts/tsx plus the test .js files. */
const CORPUS = all.filter((f) => /\.(tsx?|js)$/.test(f) && !f.startsWith('node_modules'));

const body = new Map();
let unreadable = 0;
for (const f of CORPUS) {
  try { body.set(f, git(['show', `${REF}:${f}`])); } catch { unreadable += 1; }
}
/* A corpus that failed to load is not an empty corpus — halt rather than report
   "unreferenced" against files nobody managed to read. */
if (unreadable > 0) {
  console.error(`ABORT: ${unreadable} of ${CORPUS.length} corpus files could not be read. `
    + 'Any "unreferenced" verdict would be measured against an incomplete corpus.');
  process.exit(2);
}

function exportsOf(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const isExported = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;
  const visit = (n) => {
    if (ts.isVariableStatement(n) && isExported(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, kind: 'value' });
      }
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && isExported(n) && n.name) {
      out.push({ name: n.name.text, kind: 'value' });
    } else if ((ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && isExported(n)) {
      out.push({ name: n.name.text, kind: 'type' });
    } else if (ts.isEnumDeclaration(n) && isExported(n)) {
      out.push({ name: n.name.text, kind: 'value' });
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/*
 * References to `name` INSIDE its own file, excluding the declaration itself.
 *
 * Without this the TS half disagreed with the CommonJS half on what "unused"
 * means, and it showed: portal-markers.ts builds every _SELECTOR and _ATTR out
 * of its own _MARKER, so 8 exports that are plainly used were reported as
 * unreferenced. They are an over-wide INTERFACE, not dead code — a different
 * finding with a different fix (stop exporting them), and one that must not be
 * mixed into a list someone might delete from.
 */
function internalRefs(file, src, name) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const par = node.parent;
      const isDeclName = par
        && (ts.isVariableDeclaration(par) || ts.isFunctionDeclaration(par)
          || ts.isClassDeclaration(par) || ts.isTypeAliasDeclaration(par)
          || ts.isInterfaceDeclaration(par) || ts.isEnumDeclaration(par))
        && par.name === node;
      const isPropName = par && ts.isPropertyAssignment(par) && par.name === node;
      const isAccess = par && ts.isPropertyAccessExpression(par) && par.name === node;
      if (!isDeclName && !isPropName && !isAccess) n += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return n;
}

const rows = [];
let total = 0;
for (const f of SUBJECT) {
  const src = body.get(f);
  if (src === undefined) continue;
  for (const { name, kind } of exportsOf(f, src)) {
    total += 1;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    let refs = 0; const where = [];
    for (const [g, b] of body) {
      if (g === f) continue;
      if (re.test(b)) { refs += 1; if (where.length < 2) where.push(g); }
    }
    if (refs === 0) {
      const own = internalRefs(f, src, name);
      rows.push({ f, name, kind, status: own > 0 ? 'internal-only' : 'dead' });
    }
  }
}

console.log(`\nrepo: ${ROOT} @ ${REF}   subject: ${DIR}/**`);
console.log(`  files swept        : ${SUBJECT.length}`);
console.log(`  corpus searched    : ${CORPUS.length} files (all ts/tsx + test js)`);
console.log(`  exports found      : ${total}`);
console.log(`  UNREFERENCED       : ${rows.length}  (${total ? (rows.length / total * 100).toFixed(1) : 0}%)`);
const v = rows.filter((r) => r.kind === 'value' && r.status === 'dead');
const vi = rows.filter((r) => r.kind === 'value' && r.status === 'internal-only');
const t = rows.filter((r) => r.kind === 'type' && r.status === 'dead');
const ti = rows.filter((r) => r.kind === 'type' && r.status === 'internal-only');
console.log(`     runtime DEAD          : ${v.length}`);
console.log(`     runtime internal-only : ${vi.length}   (used in their own file; over-wide export, not dead)`);
console.log(`     types DEAD            : ${t.length}`);
console.log(`     types internal-only   : ${ti.length}`);
for (const [label, list] of [['RUNTIME VALUES — DEAD', v], ['RUNTIME VALUES — INTERNAL-ONLY', vi], ['TYPES — DEAD', t], ['TYPES — INTERNAL-ONLY', ti]]) {
  if (!list.length) continue;
  console.log(`\n── UNREFERENCED ${label} ──`);
  for (const r of list.sort((a, b) => a.f.localeCompare(b.f))) console.log(`  ${r.f}  ::  ${r.name}`);
}
