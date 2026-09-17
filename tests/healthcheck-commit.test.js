/**
 * GET /healthcheck reports the commit the running image was built from.
 *
 * ~/.claude/scripts/easyfix-deploy.mjs `wait crm <env> <sha>` exits 0 ONLY when
 * this payload's `commit` matches — the same field name and mechanism as
 * EasyFix_Backend's GET /api/health (Dockerfile ARG GIT_COMMIT → ENV, fed
 * `github.sha` by deploy.yml). Without it a deploy can only be confirmed by
 * asking GitHub, whose quota is shared machine-wide.
 *
 * Every break here is SILENT — the endpoint stays 200 and every consumer
 * (compose healthcheck wget) reads only the status code:
 *   - ARG declared in a stage other than the runner  → ENV never reaches the container
 *   - route statically prerendered at `next build`   → 'unknown' frozen into the build
 *   - build-arg dropped from deploy.yml               → 'unknown' on every deploy
 * So the route is EXECUTED, and the Dockerfile/workflow wiring is read.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROUTE = 'src/app/healthcheck/route.ts';

function loadRoute() {
  const js = ts.transpileModule(read(ROUTE), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

async function body(env) {
  const saved = process.env.GIT_COMMIT;
  if (env === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = env;
  try {
    const res = await loadRoute().GET();
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMIT; else process.env.GIT_COMMIT = saved;
  }
}

test('commit is read from GIT_COMMIT at request time', async () => {
  const b = await body('188feb3deadbeef');
  assert.equal(b.commit, '188feb3deadbeef');
  assert.equal(b.status, 'ok'); // the watcher requires status === 'ok' too
});

test("commit is an explicit 'unknown' when built without the arg (never omitted)", async () => {
  assert.equal((await body(undefined)).commit, 'unknown');
  assert.equal((await body('')).commit, 'unknown');
});

test('route is force-dynamic, so next build cannot freeze the env read', () => {
  assert.equal(loadRoute().dynamic, 'force-dynamic');
});

test('Dockerfile sets ARG → ENV GIT_COMMIT in the RUNNER stage', () => {
  const stages = read('Dockerfile').split(/^FROM /m);
  const runner = stages[stages.length - 1];
  assert.match(runner, /^\S+ AS runner/, 'last stage must be the runner');
  assert.match(runner, /^ARG GIT_COMMIT=unknown$/m);
  assert.match(runner, /^ENV GIT_COMMIT=\$\{GIT_COMMIT\}$/m);
});

test('container healthchecks probe /healthcheck, not a rendered page', () => {
  assert.match(read('Dockerfile'), /^\s+CMD wget -qO- http:\/\/127\.0\.0\.1:5180\/healthcheck -O \/dev\/null \|\| exit 1$/m);
  // The compose healthcheck REPLACES the image's on the host, so it is the one that runs.
  const probes = [...read('deploy/docker-compose.prod-frontend.yml').matchAll(/^\s+test: \[.*"(http:\/\/127\.0\.0\.1:\d+\/\S*?)"/gm)]
    .map((m) => m[1]);
  assert.deepEqual(probes, ['http://127.0.0.1:5180/healthcheck', 'http://127.0.0.1:5181/healthcheck']);
});

test('every image build in deploy.yml passes GIT_COMMIT=github.sha', () => {
  const steps = read('.github/workflows/deploy.yml').split(/uses: docker\/build-push-action@/).slice(1);
  assert.ok(steps.length >= 1, 'no docker/build-push-action step found — test would pass vacuously');
  for (const s of steps) {
    const args = s.match(/build-args: \|\n((?:\s+\S.*\n)+?)\s+tags:/);
    assert.ok(args, 'build-push step has no build-args block');
    assert.match(args[1], /^\s+GIT_COMMIT=\$\{\{ github\.sha \}\}$/m);
  }
});
