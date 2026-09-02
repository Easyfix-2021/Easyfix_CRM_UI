#!/usr/bin/env node
/**
 * Runs a command under a per-worktree exclusive lock, so two `next build`s
 * cannot rewrite the same `.next/` at the same time.
 *
 * Usage:  node scripts/build-lock.js <command> [args...]
 * Wired:  "build": "node scripts/build-lock.js npm run build:unlocked"
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Two agents ran `npm run build` in this worktree on the same day. One died:
 *
 *   [Error: ENOENT: no such file or directory, open '.../.next/build-manifest.json']
 *
 * Neither build was broken. `next build` deletes and repopulates `.next/`, and
 * the loser read a manifest the winner had just unlinked. The failure is pure
 * contention on one shared output directory, and it is worse than a crash
 * because it reads like a real build error — it sends whoever sees it hunting
 * a bug that does not exist.
 *
 * "Don't build concurrently" is a guideline. A parallel agent that never read
 * the guideline still breaks the build; a lock removes the race between BUILDS
 * whoever starts them, which is the kind of fix that survives contact with an
 * agent pool.
 *
 * SCOPED TO BUILDS, and deliberately not claimed wider. `npm run dev`
 * (`next dev -p 5180`) writes the same `.next/` and takes no lock, so a dev
 * server left running in this worktree can still produce the same ENOENT during
 * someone else's build. Wrapping `dev` was not done because this project never
 * runs a dev server (the house rule is `npm run build` for verification), so the
 * lock would guard a path nobody uses while adding a wait to an interactive
 * command. If that rule ever changes, wrap `dev` and `start` too.
 *
 * ─── PRIMARY REQUIREMENT: THE SINGLE-PROCESS PATH IS UNCHANGED ─────────────
 *
 * Dockerfile:176 is `RUN npm run build`, so a bug in here breaks production
 * images. Everything below is arranged so that the uncontended case — the only
 * case Docker and CI ever hit — is: create one file, spawn the child with
 * inherited stdio, delete the file, exit with the child's status. No output, no
 * behaviour change. Measured on this machine, mean of 5, both variants
 * spawning exactly one child so the comparison is like for like: 53 ms through
 * the wrapper against 33 ms bare — a 20 ms delta, and note what that delta
 * actually is. It is a SECOND Node startup plus four file syscalls, not 20 ms of
 * "lock work"; the wrapper is itself a Node process. Against a build measured at
 * 33 s warm on this machine (and one to two minutes cold, or in Docker with no
 * cache at all) it is under a tenth of a percent either way.
 *
 * EXIT CODES ARE PASSED THROUGH, and this is not a nicety — this repo has
 * already been bitten by a wrapper masking an exit code (piping to grep under
 * dash, which has no `pipefail`, see scripts/test-no-skips.js). A failing build
 * must fail. If the child dies on a SIGNAL the wrapper re-raises that same
 * signal on itself after removing its own handlers, so the parent shell sees
 * WIFSIGNALED exactly as it would without the wrapper — npm does the same. The
 * `process.exit(128 + n)` after the re-raise is unreachable belt-and-braces.
 *
 * ─── WHERE THE LOCK LIVES, AND WHY ─────────────────────────────────────────
 *
 *   os.tmpdir()/easyfix-build-<sha1(realpath repo root)[0..12]>.lock
 *
 * NOT in `.next/` — that directory is wiped mid-build, which is the entire
 * problem; a lock stored there would be deleted by the process holding it.
 *
 * NOT in the repo — it would need a .gitignore entry (a file I do not own, and
 * one more thing to forget), and a stray lock could be committed. It would also
 * land in the Docker build context.
 *
 * The temp dir keyed by a hash of the ABSOLUTE worktree path scopes the lock
 * per-checkout: two different clones (or git worktrees) build in parallel
 * exactly as they do today, while two processes in the SAME checkout serialise.
 * `realpathSync` first, so `/tmp` vs `/private/tmp` style symlinks resolve to
 * one key. No repo changes, and nothing to clean up.
 *
 * Nothing is left in the built image: the lock is unlinked on every exit path,
 * and even a leaked one would be `/tmp/easyfix-build-*.lock` in the BUILDER
 * stage — Dockerfile's runner stage copies exactly three things out of the
 * builder (`/app/.next/standalone`, `/app/.next/static`, `/app/public`; the
 * pruned modules ride inside the standalone tree, there is no node_modules
 * COPY), so a stray /tmp file could not reach the shipped image regardless.
 *
 * ─── ACQUIRE: `openSync(path, 'wx')`, NOT CHECK-THEN-CREATE ────────────────
 *
 * `wx` is O_CREAT|O_EXCL — one syscall, atomic on every platform, EEXIST when
 * the file is already there. `existsSync()` followed by a write is a race in
 * the thing whose job is to prevent races. `mkdirSync` is equally atomic but
 * then needs a SECOND, non-atomic write to record the holder's pid, which is
 * the payload every other feature here depends on. So: one open, one write.
 *
 * A waiter can catch the file between the open and the write and read zero
 * bytes. Such a lock is simply not readable yet, and an unreadable lock is
 * NEVER taken over — see the acquire loop. It resolves itself microseconds
 * later when the writer finishes.
 *
 * ─── STALE LOCKS: LIVENESS BY PID, TAKEOVER BY RENAME ──────────────────────
 *
 * A build killed with SIGKILL cannot release anything. If that wedged every
 * later build until a human deleted a file, the cure would be worse than the
 * disease. So the holder's pid is probed with `process.kill(pid, 0)`, and only
 * ESRCH means dead. EPERM means the process exists and is owned by another
 * user — ALIVE. A live holder's lock is never removed.
 *
 * The takeover itself is `rename()` to a `.stale.<own pid>` name, then unlink.
 * Two waiters that both spot the same corpse will both try to rename; POSIX
 * rename is atomic, so exactly one succeeds and the other gets ENOENT and keeps
 * polling. An unlink-then-acquire pair would let the loser delete the WINNER's
 * fresh lock. Renaming to a name that contains our own pid is what "never
 * remove one you do not own" means in practice.
 *
 * Known ceiling, accepted: pid reuse. If the OS has recycled the dead holder's
 * pid onto an unrelated live process, the lock is considered held until the
 * 10-minute timeout. That fails loudly and safely, and the alternative (start
 * time / boot id comparison) is a pile of platform-specific code for a case
 * nobody here has hit.
 *
 * ─── WAITING ───────────────────────────────────────────────────────────────
 *
 * Contention waits; it does not fail. A build here measured 33 s warm and runs
 * one to two minutes cold, so the cap is 10 minutes — long enough for a queue of
 * several builds, short enough that a genuinely wedged state surfaces within a
 * coffee. Timeout exits 1 with the
 * holder printed. The waiter announces itself immediately and every 15 s after,
 * so an agent watching the output does not conclude it has hung.
 *
 * ─── WHY A SECOND package.json ENTRY ───────────────────────────────────────
 *
 * `build:unlocked` holds the real command so a reader can still see what the
 * build IS without opening this file. CI and Docker may call it directly: they
 * are single-process by construction, there is no contention to prevent, and
 * skipping the wrapper removes this script from the critical path of a
 * production image. That is a feature, not a bypass — the lock exists for a
 * shared developer/agent worktree, which is the only place the race happens.
 *
 * No new dependencies: node: builtins only, like every other script in here.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 1000;
const ANNOUNCE_EVERY_MS = 15000;
const TIMEOUT_MS = 10 * 60 * 1000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** inode of the lock THIS process created; null until acquired. See release(). */
let myLockIno = null;

/*
 * REENTRANCY. The lock is not recursive, so a nested `npm run build` inside a
 * build would wait on a lock its own ancestor holds — a ten-minute hang ending
 * in a timeout that names the parent as the culprit. Nothing nests today, but an
 * npm `prebuild` hook or a brand: script that ever grows a build step would do
 * it, and the failure would be baffling. The wrapper marks its own subtree; a
 * nested call sees the mark and just runs the command.
 */
const REENTRY_FLAG = 'EASYFIX_BUILD_LOCK_HELD';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: node scripts/build-lock.js <command> [args...]');
  process.exit(2);
}

// Keyed off the script's own repo root, not process.cwd(): the lock must follow
// the checkout even if someone invokes the wrapper from a subdirectory.
const root = fs.realpathSync(path.resolve(__dirname, '..'));
const lockPath = path.join(
  os.tmpdir(),
  `easyfix-build-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 12)}.lock`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => `${Math.round(ms / 1000)}s`;

/** true if the file was created by us (we now hold the lock), false on EEXIST. */
function tryAcquire() {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      cmd: argv.join(' '),
      cwd: root,
      startedAt: Date.now(),
    }));
    // Identity for release(), taken from the descriptor we just created so it
    // cannot be confused with a file some other process put here later.
    myLockIno = fs.fstatSync(fd).ino;
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** holder object · null if the lock vanished · undefined if not yet readable. */
function readHolder() {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // caught mid-write, or truncated
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM ⇒ exists, other user ⇒ alive
  }
}

function takeOver(why) {
  const grave = `${lockPath}.stale.${process.pid}`;
  try {
    fs.renameSync(lockPath, grave);
  } catch (err) {
    if (err.code === 'ENOENT') return; // another waiter took it over first
    /*
     * We are not allowed to move it — the sticky bit on a shared /tmp stops a
     * non-owner renaming another user's file (EPERM/EACCES). Fall through to
     * polling rather than throwing: an unhandled fs stack trace out of this
     * script is the SAME failure class it exists to remove, an error that reads
     * like a build bug and sends someone hunting a defect that is not there.
     */
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      console.error(`build-lock: cannot take over the lock (${err.code}) — waiting instead`);
      return;
    }
    throw err;
  }
  try { fs.unlinkSync(grave); } catch { /* best effort */ }
  console.error(`build-lock: ${why} — stale lock taken over`);
}

let released = false;
function release() {
  if (released) return;
  released = true;
  /*
   * OWNERSHIP IS THE INODE, not the contents (2026-09-02). This used to re-read
   * and re-parse the lock at exit and bail when it could not — so a lock whose
   * contents had become unreadable was never deleted, INCLUDING this process's
   * own, contradicting the promise above that it is unlinked on every exit path.
   *
   * The inode recorded at creation answers "is the file still the one I made?"
   * without reading a byte of it, and it is exactly the right question: a waiter
   * that declared us stale RENAMES our file away and creates its own, so a
   * matching inode means nobody has taken over and the lock is still ours to
   * remove. A mismatch means it is someone else's — leave it alone.
   */
  if (myLockIno === null) return;               // never acquired it
  try {
    if (fs.statSync(lockPath).ino !== myLockIno) return;  // someone else's now
  } catch { return; }                            // already gone
  try { fs.unlinkSync(lockPath); } catch { /* raced with a takeover */ }
}
process.on('exit', release); // also covers an uncaught throw

/*
 * The one exit door FOR THE CHILD'S STATUS — mirrored exactly. Two other
 * process.exit() calls never reach here: the usage error at the top (exit 2) and
 * the timeout inside acquire() (exit 1). Both are correct because
 * `process.on('exit', release)` still fires, but a reader who takes "the one
 * exit door" literally will go hunting for a leak that is not there.
 */
function finish(code, signal) {
  release();
  if (!signal) process.exit(code === null || code === undefined ? 1 : code);
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  try { process.kill(process.pid, signal); } catch { /* fall through */ }
  process.exit(128 + (os.constants.signals[signal] || 0));
}

let child = null;
function onSignal(sig) {
  if (child) child.kill(sig); // let the child's own exit drive ours
  else finish(null, sig); // still waiting for the lock — nothing to forward to
}
for (const s of SIGNALS) process.on(s, onSignal);

async function acquire() {
  const waitStart = Date.now();
  let announcedAt = 0;

  while (!tryAcquire()) {
    const holder = readHolder();
    /*
     * AN UNREADABLE LOCK IS NEVER TAKEN OVER (2026-09-02). It used to be, after
     * five polls, and that was a hole straight through the one property this
     * script exists to provide: readHolder() returns undefined for ANY read
     * failure, not just a mid-write truncation — EACCES on another user's lock
     * under a restrictive umask on shared /tmp, EMFILE when a parallel agent
     * pool has exhausted descriptors, EIO. In every one of those the holder is
     * very much alive, and taking over let two builds run at once. Measured by
     * an adversarial pass: 5.4 seconds of overlap.
     *
     * Taking over on ignorance trades the guarantee for convenience. We can only
     * remove a lock we can positively attribute to a DEAD pid; if we cannot read
     * it we know nothing, so we wait and then fail loudly with the path. That
     * leaves one bad case — a machine that died inside the few microseconds of
     * the write, leaving a truncated lock with no live owner — which blocks
     * builds until someone deletes one file. Rare, and the timeout message says
     * exactly which file. A rare manual `rm` beats a silent double build.
     */
    if (holder !== null) {
      if (holder !== undefined && !alive(holder.pid)) {
        takeOver(`holder pid ${holder.pid} is gone`);
      } else {
        const waited = Date.now() - waitStart;
        const who = holder === undefined
          ? 'an UNREADABLE lock file (permissions? truncated? out of descriptors?)'
          : `pid ${holder.pid} ("${holder.cmd}", running ${secs(Date.now() - holder.startedAt)})`;
        if (waited > TIMEOUT_MS) {
          console.error(`build-lock: gave up after ${secs(waited)} waiting for ${who}.`
            + `\nIf that process is genuinely stuck, kill it — the lock frees itself.`
            + `\nIf the lock is unreadable and nothing is building, delete it:`
            + `\n  rm ${lockPath}`);
          process.exit(1);
        }
        if (announcedAt === 0 || Date.now() - announcedAt >= ANNOUNCE_EVERY_MS) {
          announcedAt = Date.now();
          console.error(`build-lock: waiting — ${who} holds the build lock`
            + `${waited > POLL_MS ? `, waited ${secs(waited)}` : ''}`);
        }
      }
    }
    await sleep(POLL_MS);
  }
}

function run() {
  child = spawn(argv[0], argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [REENTRY_FLAG]: '1' },
  });
  child.on('error', (err) => {
    console.error(`build-lock: cannot run "${argv[0]}": ${err.message}`);
    finish(127); // shell convention for command-not-found
  });
  child.on('close', (code, signal) => finish(code, signal));
}

if (process.env[REENTRY_FLAG]) {
  // Already inside a locked build — the lock is held by an ancestor. Run
  // straight through; release() is a no-op because myLockIno stays null.
  run();
} else {
  acquire().then(run).catch((err) => {
  /*
   * CATCH AFTER THEN, deliberately. Nothing in acquire() should throw now that
   * takeOver() swallows EPERM/EACCES, but an unhandled rejection would exit 1
   * with a raw fs stack trace that reads like a build failure — the exact thing
   * this script exists to stop happening. Placed after .then() so it also
   * covers a throw from the spawn setup; a .catch() BEFORE .then() would
   * resolve and run the success path anyway, which is worse than no catch.
   */
    console.error(`build-lock: could not acquire the build lock: ${err && err.message}`
      + `\nLock file: ${lockPath}`);
    process.exit(1);
  });
}
