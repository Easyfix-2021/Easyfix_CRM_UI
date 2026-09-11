/**
 * Prod UI host Dozzle: exact image pin + the agent the deploy starts.
 *
 * The prod BE host's Dozzle lists crm-ui + client-ui through `dozzle-agent`
 * in deploy/docker-compose.prod-frontend.yml (runbook: EasyFix_Backend
 * docs/dozzle-agent.md). deploy.yml starts it with
 * `docker compose up -d --no-deps <service> || echo …` — deliberately
 * non-fatal, so a rename on EITHER side (compose key or workflow line) does not
 * fail anything: the agent just never starts and the UI host silently drops out
 * of Dozzle. This test is the only thing that notices.
 *
 * The pin: `amir20/dozzle:latest` never upgrades, because `compose up` pulls
 * only a MISSING image. The agent must also match the BE-host Dozzle's tag
 * (they share a gRPC protocol that changes between releases); that half lives
 * in EasyFix_Backend tests/dozzle-pin-and-agent.test.js and is not cross-read
 * from here, so neither repo's CI goes red waiting on the other to land.
 *
 * js-yaml is not a direct dependency here; it is present through eslint
 * (@eslint/eslintrc). If that ever changes this fails loudly with
 * MODULE_NOT_FOUND, never silently.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const compose = yaml.load(fs.readFileSync(path.join(ROOT, 'deploy/docker-compose.prod-frontend.yml'), 'utf8'));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

test('every Dozzle image on the prod UI host is one exact version tag', () => {
  const images = Object.values(compose.services).map((s) => s.image).filter((i) => /^amir20\/dozzle\b/.test(i));
  assert.ok(images.length >= 2, `expected the dozzle server and the agent, located ${images.length}`);
  for (const i of images) assert.match(i, /^amir20\/dozzle:v\d+\.\d+\.\d+$/, `"${i}" is not an exact vX.Y.Z tag`);
  assert.equal(new Set(images).size, 1, `server and agent differ: ${[...new Set(images)].join(' vs ')}`);
});

test('the service deploy.yml starts is a Dozzle agent on 7007 in the prod compose', () => {
  const started = [...workflow.matchAll(/docker compose up -d --no-deps (dozzle[\w-]*)/g)].map((m) => m[1]);
  assert.equal(started.length, 1, `deploy.yml should start exactly one dozzle service, found: ${started.join(', ') || 'none'}`);
  const svc = compose.services[started[0]];
  assert.ok(svc, `deploy.yml starts "${started[0]}" but the prod compose has no such service`);
  assert.equal(svc.command, 'agent');
  assert.ok((svc.ports || []).includes('7007:7007'), 'agent does not publish 7007 — the BE Dozzle dials <ui-host-ip>:7007');
  assert.equal(svc.restart, 'unless-stopped');
});
