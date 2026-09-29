'use strict';
/*
 * LMS ▸ Courses ▸ Edit Course: the content list must be THIS course's
 * (owner, 2026-09-29: "sometimes showing no content inside modal and
 * sometimes showing it").
 *
 * THE BUG THIS PINS. useFetch keeps the previous key's data on screen while a
 * new key loads (its flicker fix), and CourseModal stayed mounted across opens.
 * Opening course B therefore seeded B's draft from A's leftover content, marked
 * B seeded, and ignored B's real list when it arrived — empty or wrong at
 * random, and Save would have written that list over B. Reopening the SAME
 * course after a save did the same with its pre-save list, because
 * invalidateFetch evicts the cache but does not refetch a mounted hook.
 *
 * Both halves are one-token deletions that still type-check and build, so they
 * are source-scanned here (this .tsx is not in test:build).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/app/(authed)/lms/courses/page.tsx'),
  'utf8',
);

test('the course modal remounts on every open', () => {
  assert.match(src, /<CourseModal\s+key=\{modalSeq\}/, 'CourseModal must be keyed per open');
  assert.match(src, /const openCourseModal = \(c: Course \| 'new'\) => \{ setModalSeq\(\(n\) => n \+ 1\); setFormCourse\(c\); \};/);
  assert.doesNotMatch(src, /setFormCourse\((c|'new')\)\}/, 'every open goes through openCourseModal');
});

test('the draft seeds only from content fetched for this course', () => {
  assert.match(
    src,
    /if \(contentFetch\.data && contentFetch\.dataKey === contentKey && seededFor\.current !== editing\.id\)/,
    'a payload for another key must never seed the draft',
  );
});
