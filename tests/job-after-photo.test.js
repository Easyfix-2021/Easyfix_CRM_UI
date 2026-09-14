'use strict';
/*
 * Ops can add an AFTER-WORK PHOTO from the job modal (2026-09-11).
 *
 * The backend now refuses every close without one (409 AFTER_PHOTO_REQUIRED,
 * services/job.service.js setStatus), so the CRM needs a way to supply the
 * proof: POST /admin/jobs/:id/images, multipart, field "file" — ONE file per
 * request (multer files:1) — plus "category" = "Completion", gated server-side
 * on isJobAfterPhotoUpload and an image by its bytes (a PDF is a 400).
 *
 * Source-shape for the gate and the mount; the upload routine itself is
 * transpiled out of JobModal.tsx and run against stubs, so "sequential",
 * "category=Completion", the toasts and the one refresh are observed, not
 * pattern-matched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/JobModal.tsx'), 'utf8');
const strip = (t) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = strip(SRC);

function fnSource(name) {
  const start = CODE.indexOf(`\nfunction ${name}(`);
  assert.ok(start > -1, `${name} must exist in JobModal.tsx`);
  return CODE.slice(start, CODE.indexOf('\nfunction ', start + 1));
}
const BTN = fnSource('AddAfterWorkPhotoButton');

test('the button is gated on isJobAfterPhotoUpload (fail closed) and hidden on a Cancelled job', () => {
  const mounts = [...CODE.matchAll(/<AddAfterWorkPhotoButton\b/g)];
  assert.equal(mounts.length, 1, `one mount, found ${mounts.length} — a second would need its own gate`);
  // The JSX expression that renders it: from the gate's `{` to the mount.
  const at = mounts[0].index;
  const expr = CODE.slice(CODE.lastIndexOf('{', CODE.lastIndexOf('hasAction(', at)), at);
  assert.match(expr, /^\{hasAction\(me, 'isJobAfterPhotoUpload'\) && Number\(job\.job_status\) !== 6 && \(\s*<div[^>]*>\s*$/,
    'the gate must sit directly on the mount: the RBAC key AND not Cancelled (6)');
  assert.match(CODE, /import \{[^}]*\bhasAction\b[^}]*\} from '@\/lib\/permissions';/,
    'hasAction from lib/permissions — false until me.permissions says otherwise');
});

test('it lives on the view-mode Images panel, outside the image grid, so a job with no images shows it', () => {
  const panelAt = CODE.indexOf('<Panel value="images"');
  assert.ok(panelAt > -1, 'the Images panel must be found');
  const panel = CODE.slice(panelAt, CODE.indexOf('</Panel>', panelAt));
  assert.ok(panel.includes('<AddAfterWorkPhotoButton'), 'mounted inside the Images panel');
  assert.ok(panel.indexOf('<AddAfterWorkPhotoButton') < panel.indexOf('<JobImagesTab'),
    'before and outside JobImagesTab, whose empty state replaces its whole body');
  // Refresh = the modal's refresh(), which re-reads the job whose .images the panel shows.
  assert.match(panel, /<AddAfterWorkPhotoButton jobId=\{Number\(job\.job_id\)\} onUploaded=\{onRefresh\} \/>/);
  assert.match(CODE, /<ViewBody\s+job=\{job\}\s+onRefresh=\{refresh\}/, 'ViewBody\'s onRefresh must be refresh()');
  const refresh = CODE.slice(CODE.indexOf('async function refresh()'), CODE.indexOf('\n  }\n', CODE.indexOf('async function refresh()')));
  assert.match(refresh, /setJob\(await api\.get<Job>\(`\/admin\/jobs\/\$\{resolvedJobId\}`/, 'refresh() must re-read the job');
  assert.match(CODE, /const images = Array\.isArray\(\(job as Record<string, unknown>\)\.images\)/,
    'the panel\'s images come from that job payload');
});

test('the picker offers images only, several at once, and the label is Title Case', () => {
  const input = BTN.slice(BTN.indexOf('<input'), BTN.indexOf('/>', BTN.indexOf('<input')));
  const accept = input.match(/accept="([^"]*)"/);
  assert.ok(accept, 'the input must declare accept=');
  assert.deepEqual(accept[1].split(',').sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
    'exactly the types the backend accepts as proof — no PDF, no image/* wildcard (HEIC would 400)');
  assert.match(input, /type="file"/);
  assert.match(input, /\bmultiple\b/);
  assert.match(input, /className="hidden"/);
  assert.match(BTN, /'Add After-Work Photo'/);
});

/* The real upload routine, run: transpiled out of the component with its deps injected. */
function loadUpload() {
  const start = BTN.indexOf('  async function upload(');
  const end = BTN.indexOf('\n  }\n', start);
  assert.ok(start > -1 && end > start, 'upload() must be found inside AddAfterWorkPhotoButton');
  const { outputText } = ts.transpileModule(`${BTN.slice(start, end + 4)}\nmodule.exports = upload;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  class ApiError extends Error {}
  return (post) => {
    const log = { posts: [], toasts: [], busy: [], refreshed: 0, reset: false };
    const deps = {
      jobId: 42,
      api: { post },
      ApiError,
      showToast: (t) => log.toasts.push(t),
      setUploading: (b) => log.busy.push(b),
      fileRef: { current: { set value(v) { log.reset = v === ''; } } },
      onUploaded: () => { log.refreshed += 1; },
    };
    const mod = { exports: {} };
    new Function('exports', 'module', ...Object.keys(deps), outputText)(mod.exports, mod, ...Object.values(deps));
    return { upload: mod.exports, log, ApiError };
  };
}
const file = (name, type = 'image/jpeg') => new File([new Uint8Array([1, 2, 3])], name, { type });

test('each file is its own sequential POST carrying category=Completion; one refresh after the last', async () => {
  let inFlight = 0; let maxInFlight = 0; const bodies = [];
  const make = loadUpload();
  const { upload, log } = make(async (url, fd) => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    bodies.push({ url, file: fd.get('file').name, category: fd.get('category') });
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { image_id: bodies.length };
  });
  await upload([file('a.jpg'), file('b.png', 'image/png')]);
  assert.equal(maxInFlight, 1, 'one request at a time — the route takes files:1');
  assert.deepEqual(bodies, [
    { url: '/admin/jobs/42/images', file: 'a.jpg', category: 'Completion' },
    { url: '/admin/jobs/42/images', file: 'b.png', category: 'Completion' },
  ]);
  assert.deepEqual(log.busy, [true, false], 'busy for the whole batch');
  assert.deepEqual(log.toasts, [{ variant: 'success', message: '2 After-Work Photos Added.' }]);
  assert.equal(log.refreshed, 1, 'the job re-reads once, after the last upload');
  assert.ok(log.reset, 'the input is cleared, so the same file can be picked again');

  const one = make(async () => ({}));
  await one.upload([file('c.webp', 'image/webp')]);
  assert.deepEqual(one.log.toasts, [{ variant: 'success', message: 'After-Work Photo Added.' }]);
});

test('a refused upload shows the server\'s sentence and does not stop the rest', async () => {
  const make = loadUpload();
  let n = 0; let ApiErrorRef;
  const run = make(async () => {
    n += 1;
    if (n === 1) throw new ApiErrorRef('An after-work photo must be an image (PNG, JPEG, WEBP or GIF).');
    return {};
  });
  ApiErrorRef = run.ApiError;
  await run.upload([file('x.jpg'), file('y.jpg')]);
  assert.equal(n, 2, 'the second file still uploads');
  assert.deepEqual(run.log.toasts, [
    { variant: 'success', message: 'After-Work Photo Added.' },
    { variant: 'error', message: 'An after-work photo must be an image (PNG, JPEG, WEBP or GIF).' },
  ]);
  assert.equal(run.log.refreshed, 1, 'what did land is shown');

  const denied = make(async () => { throw new ApiErrorRef('Missing permission: isJobAfterPhotoUpload'); });
  ApiErrorRef = denied.ApiError;
  await denied.upload([file('z.jpg')]);
  assert.deepEqual(denied.log.toasts, [{ variant: 'error', message: 'Missing permission: isJobAfterPhotoUpload' }]);
  assert.equal(denied.log.refreshed, 0, 'nothing landed, nothing to re-read');
  assert.deepEqual(denied.log.busy, [true, false], 'busy clears on failure too');
});

test('a close refused for want of a photo surfaces the server\'s sentence, not a generic one', () => {
  /*
   * 409 AFTER_PHOTO_REQUIRED arrives as { success:false, error:<sentence>, code }
   * and lib/api.ts throws ApiError(status, json.error). JobModal's own status
   * PATCHes are cancel (6) and Confirm & Schedule's outcomes (0/7/9) — none a
   * close — and both already show ApiError.message. Pinned so a new status
   * error path cannot swap in a canned string without this going red.
   */
  const api = fs.readFileSync(path.join(__dirname, '..', 'src/lib/api.ts'), 'utf8');
  assert.match(api, /throw new ApiError\(res\.status, json\.error \|\| `HTTP \$\{res\.status\}`/);
  const patches = [...CODE.matchAll(/api\.patch\(`\/admin\/jobs\/\$\{[\w.]+\}\/status`/g)];
  assert.equal(patches.length, 2, `JobModal status PATCHes changed (found ${patches.length}) — re-check their error paths`);
  assert.doesNotMatch(CODE, /AFTER_PHOTO_REQUIRED/, 'no second copy of the backend\'s sentence in the client');
});
