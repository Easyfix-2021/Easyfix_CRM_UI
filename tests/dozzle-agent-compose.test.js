/**
 * Prod UI host Dozzle: :latest images, the opt-in agent refresh, and the
 * client-UI mirror of the compose.
 *
 * The prod BE host's Dozzle lists crm-ui + client-ui through `dozzle-agent`
 * in deploy/docker-compose.prod-frontend.yml (runbook: EasyFix_Backend
 * docs/dozzle-agent.md). The agent is a remote container-control surface, so
 * deploy.yml starts and refreshes it ONLY on Production and ONLY while the repo
 * variable PROD_DOZZLE_AGENT_ENABLED is "true" (set after the security-group
 * audit). Every way that breaks is silent — the deploy stays green whether the
 * gate is dropped (agent starts on merge), the variable never reaches the
 * script (agent never starts), or a dropped `|| echo` lets a Docker Hub
 * outage fail the deploy — so the remote script is rendered the way the
 * runner builds it and its agent block is EXECUTED with docker stubbed out.
 *
 * `:latest` alone never upgrades (`compose up` pulls only a MISSING image);
 * the refresh is what moves it. Its BE-host half lives in EasyFix_Backend
 * tests/dozzle-pin-and-agent.test.js, not cross-read from here.
 *
 * The MIRROR: both UI repos write this compose to the same host and the last
 * deploy wins, so a stale copy in Easyfix_client_UI silently reverts it.
 * Read from EASYFIX_CLIENT_UI_DIR or the sibling checkout; absent is a
 * FAILURE, never a skip — so every workflow that runs `npm test` (ci.yml AND
 * deploy.yml) must clone it, which is asserted below.
 *
 * js-yaml is not a direct dependency here; it is present through eslint
 * (@eslint/eslintrc). If that ever changes this fails loudly with
 * MODULE_NOT_FOUND, never silently.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE = 'deploy/docker-compose.prod-frontend.yml';
const compose = yaml.load(fs.readFileSync(path.join(ROOT, COMPOSE), 'utf8'));
const workflowText = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const ssmStep = yaml.load(workflowText).jobs.deploy.steps.find((s) => s.id === 'ssm');

test('every Dozzle image on the prod UI host is amir20/dozzle:latest', () => {
  const images = Object.values(compose.services).map((s) => s.image).filter((i) => /^amir20\/dozzle\b/.test(i));
  assert.ok(images.length >= 2, `expected the dozzle server and the agent, located ${images.length}`);
  for (const i of images) assert.equal(i, 'amir20/dozzle:latest');
});

test('Easyfix_client_UI ships a byte-identical prod-frontend compose', () => {
  const dir = process.env.EASYFIX_CLIENT_UI_DIR || path.join(ROOT, '..', 'Easyfix_client_UI');
  const theirs = path.join(dir, COMPOSE);
  assert.ok(fs.existsSync(theirs), `${theirs} not found, so the mirror was NOT checked. `
    + 'Clone https://github.com/Easyfix-2021/Easyfix_client_UI beside this repo, or point EASYFIX_CLIENT_UI_DIR at a checkout.');
  assert.ok(fs.readFileSync(theirs).equals(fs.readFileSync(path.join(ROOT, COMPOSE))),
    `${theirs} differs from this repo's ${COMPOSE} — copy it byte for byte; the last UI deploy writes its copy to the prod UI host`);
});

test('every workflow step that runs npm test clones Easyfix_client_UI for the mirror check', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const runners = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const [job, { steps = [] }] of Object.entries(yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')).jobs || {})) {
      steps.forEach((s, i) => { if (/\bnpm test\b/.test(s.run || '')) runners.push({ where: `${f} ${job}`, step: s, before: steps.slice(0, i) }); });
    }
  }
  assert.ok(runners.length >= 2, `expected ci.yml and deploy.yml, located ${runners.length}`);
  for (const { where, step, before } of runners) {
    assert.equal((step.env || {}).EASYFIX_CLIENT_UI_DIR, '${{ runner.temp }}/easyfix-client-ui', `${where}: npm test runs without EASYFIX_CLIENT_UI_DIR, so the mirror test fails`);
    const clone = before.find((s) => /git clone\b.*--branch "\$BRANCH" https:\/\/github\.com\/Easyfix-2021\/Easyfix_client_UI\.git "\$RUNNER_TEMP\/easyfix-client-ui"/.test(s.run || ''));
    assert.ok(clone, `${where}: no earlier step clones Easyfix_client_UI into $RUNNER_TEMP/easyfix-client-ui`);
    // An empty BRANCH (github.base_ref on a dispatch) is `--branch ""`, a red
    // run: the last `||` operand must always be set.
    assert.match(String((clone.env || {}).BRANCH), /\|\|\s*('[^']+'|github\.ref_name)\s*\}\}$/, `${where}: BRANCH can resolve empty`);
  }
});

test('the service deploy.yml refreshes is a Dozzle agent on 7007 in the prod compose', () => {
  const started = [...workflowText.matchAll(/docker compose up -d --no-deps (dozzle[\w-]*)/g)].map((m) => m[1]);
  assert.equal(started.length, 1, `deploy.yml should start exactly one dozzle service, found: ${started.join(', ') || 'none'}`);
  const svc = compose.services[started[0]];
  assert.ok(svc, `deploy.yml starts "${started[0]}" but the prod compose has no such service`);
  assert.equal(svc.command, 'agent');
  assert.ok((svc.ports || []).includes('7007:7007'), 'agent does not publish 7007 — the BE Dozzle dials <ui-host-ip>:7007');
  assert.equal(svc.restart, 'unless-stopped');
});

// The SSM step's REMOTE_SCRIPT exactly as the runner builds it — Actions
// expressions substituted, the variable arriving through env — stopped at the
// AWS transport. Returns the agent block (its enclosing if … fi).
function renderAgentBlock(envName, enabled) {
  const run = ssmStep.run
    .replace(/\$\{\{\s*needs\.build-and-push\.outputs\.env_name\s*\}\}/g, envName)
    .replace(/\$\{\{[^}]*\}\}/g, 'STUB');
  const cut = run.indexOf('SCRIPT_B64=$(printf');
  assert.ok(cut > 0, 'the SSM transport line was not found — the render located nothing');
  const env = { PATH: process.env.PATH };
  if (enabled !== undefined) env.PROD_DOZZLE_AGENT_ENABLED = enabled;
  const remote = execFileSync('bash', ['-c', `${run.slice(0, cut)}\nprintf '%s' "$REMOTE_SCRIPT"`], { encoding: 'utf8', env });
  assert.ok(remote.includes('cd /opt/easyfix'), 'the render produced no remote script');
  const lines = remote.split('\n');
  const agentCmd = (l) => !/^\s*#/.test(l) && /docker compose (pull|up)\b.*\bdozzle-agent\b/.test(l);
  const first = lines.findIndex(agentCmd);
  assert.ok(first > 0, `${envName}: no dozzle-agent pull/up in the remote script — the check located nothing`);
  // The NEAREST if/fi above, so a command sitting after some other block's fi
  // reads as ungated instead of borrowing that block's if.
  let start = first;
  while (start >= 0 && !/^\s*(if|fi)\b/.test(lines[start])) start -= 1;
  let end = first;
  while (end < lines.length && !/^\s*fi\s*$/.test(lines[end])) end += 1;
  assert.ok(start >= 0 && /^\s*if\b/.test(lines[start]) && end < lines.length,
    `${envName}: the dozzle-agent commands are not inside an if … fi gate`);
  const block = lines.slice(start, end + 1);
  assert.equal(block.filter(agentCmd).length, lines.filter(agentCmd).length,
    `${envName}: a dozzle-agent pull/up sits OUTSIDE the opt-in gate`);
  return { remote, block: block.join('\n') };
}

// Runs a block under the remote script's own shell options with every docker
// call failing (a Docker Hub outage, a rate limit). Functions shadow
// docker/timeout, so nothing real runs.
function runWithFailingDocker(block) {
  return spawnSync('bash', ['-c', [
    'set -euo pipefail',
    'docker() { echo "CALL docker $*"; return 1; }',
    'timeout() { echo "CALL timeout $1"; shift; "$@"; }',
    block,
    'echo SURVIVED',
  ].join('\n')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

test('PROD_DOZZLE_AGENT_ENABLED reaches the deploy through env:, never as an expression in run:', () => {
  assert.ok(ssmStep, 'no deploy step with id "ssm"');
  assert.equal((ssmStep.env || {}).PROD_DOZZLE_AGENT_ENABLED, '${{ vars.PROD_DOZZLE_AGENT_ENABLED }}');
  assert.doesNotMatch(ssmStep.run, /vars\.PROD_DOZZLE_AGENT_ENABLED/, 'spliced into run: — pass it via the step env instead');
});

test('the agent is refreshed only on Production with the variable "true", and a Docker Hub failure cannot fail the deploy', () => {
  const on = runWithFailingDocker(renderAgentBlock('production', 'true').block);
  assert.equal(on.status, 0, `a failing docker aborted the remote script:\n${on.stdout}${on.stderr}`);
  assert.match(on.stdout, /SURVIVED/);
  assert.match(on.stdout, /CALL timeout \d+\nCALL docker compose pull\b[^\n]*\bdozzle-agent\b/, 'enabled: the agent is not pulled (bounded)');
  assert.match(on.stdout, /CALL timeout \d+\nCALL docker compose up -d --no-deps dozzle-agent\b/, 'enabled: the agent is not re-upped (bounded)');

  for (const [label, envName, value] of [
    ['Production, variable unset', 'production', undefined],
    ['Production, variable "false"', 'production', 'false'],
    ['Production, variable "TRUE"', 'production', 'TRUE'],
    ['QA, variable "true"', 'qa', 'true'],
  ]) {
    const off = runWithFailingDocker(renderAgentBlock(envName, value).block);
    assert.equal(off.status, 0, `${label}: ${off.stderr}`);
    assert.doesNotMatch(off.stdout, /CALL docker/, `${label}: the agent was touched`);
    assert.match(off.stdout, /SURVIVED/);
  }

  // The raw value never reaches the root script on the host.
  const { remote } = renderAgentBlock('production', 'true";echo INJECTED;"');
  assert.doesNotMatch(remote, /INJECTED/, 'the variable text reached the remote script');
});
