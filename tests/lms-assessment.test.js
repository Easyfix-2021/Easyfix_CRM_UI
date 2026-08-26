'use strict';

/*
 * lms-assessment — the rules that decide whether an assessment can be saved.
 *
 * WHY THESE MATTER MORE THAN THEY LOOK
 *
 * Every clause here has a consequence that is invisible on the screen where it
 * is broken and expensive on the screen where it surfaces:
 *
 *   - An assessment with no questions is addable to a course and unpassable,
 *     so every technician holding that course is stuck at incomplete forever
 *     and nothing in the CRM says why.
 *   - A question with no correct option scores 0 for everybody, including
 *     people who answered the way the syllabus intended.
 *   - A question with two correct options makes "the answer" undefined, which
 *     the server-side scorer resolves silently and differently from whatever
 *     the operator had in mind.
 *
 * None of that is catchable by the type checker — they are all value-level
 * facts about a form. The editor's radio group makes the "two correct" case
 * unreachable through the UI today, which is precisely why the rule needs a
 * test: nothing else would notice if a future multi-select control let it
 * through.
 *
 * ─── WHY IT COMPILES FIRST ────────────────────────────────────────────────
 *
 * Same as the other suites here: no test-time transpiler in this repo, so
 * `npm run test:build` emits CommonJS into .test-build and this file requires
 * that. Run the whole thing with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateAssessmentDraft } = require('../.test-build/lms-assessment.js');

/* A saveable two-option question, so each test below can break exactly one
 * thing and nothing else. */
const ok = (text = 'What is the first step?') => ({
  text,
  options: [
    { text: 'Isolate the power', correct: true },
    { text: 'Start the motor', correct: false },
  ],
});

test('a well-formed draft is saveable', () => {
  assert.equal(validateAssessmentDraft([ok()]), null);
  assert.equal(validateAssessmentDraft([ok('One'), ok('Two')]), null);
});

test('an empty draft is refused', () => {
  assert.equal(
    validateAssessmentDraft([]),
    'Add at least one question before saving.',
  );
});

test('question text must not be blank or whitespace', () => {
  assert.equal(validateAssessmentDraft([ok('')]), 'Question 1 has no text.');
  // Whitespace is the interesting case: it is truthy, so a bare `!q.text`
  // check would let '   ' through and store a blank question.
  assert.equal(validateAssessmentDraft([ok('   ')]), 'Question 1 has no text.');
});

test('a question needs at least two real options', () => {
  const oneOption = { text: 'Q', options: [{ text: 'Only', correct: true }] };
  assert.equal(
    validateAssessmentDraft([oneOption]),
    'Question 1 needs at least two options.',
  );

  // One real option + one blank is still ONE option, and the message says so
  // rather than complaining about the blank — the operator's actual problem is
  // that there is nothing to choose between.
  const oneRealOneBlank = {
    text: 'Q',
    options: [{ text: 'Only', correct: true }, { text: '  ', correct: false }],
  };
  assert.equal(
    validateAssessmentDraft([oneRealOneBlank]),
    'Question 1 needs at least two options.',
  );
});

test('a blank option beside two real ones is refused on its own terms', () => {
  const withBlank = {
    text: 'Q',
    options: [
      { text: 'A', correct: true },
      { text: 'B', correct: false },
      { text: '', correct: false },
    ],
  };
  assert.equal(
    validateAssessmentDraft([withBlank]),
    'Question 1 has a blank option — fill it in or remove it.',
  );
});

test('exactly one option must be correct', () => {
  const none = {
    text: 'Q',
    options: [{ text: 'A', correct: false }, { text: 'B', correct: false }],
  };
  assert.equal(
    validateAssessmentDraft([none]),
    'Question 1 has no correct answer marked.',
  );

  // Unreachable through the editor's radio group — and that is the point.
  const two = {
    text: 'Q',
    options: [{ text: 'A', correct: true }, { text: 'B', correct: true }],
  };
  assert.equal(
    validateAssessmentDraft([two]),
    'Question 1 has more than one correct answer marked.',
  );
});

test('the message names the question the operator is looking at', () => {
  // The whole reason this validation exists client-side rather than being left
  // to the backend's 400: a report about "questions[2]" sends someone counting
  // from zero through a form numbered from one.
  const draft = [ok('One'), ok('Two'), { text: '', options: ok().options }];
  assert.equal(validateAssessmentDraft(draft), 'Question 3 has no text.');
});

test('only the FIRST problem is reported', () => {
  // Two broken questions, one message — a list of complaints about a
  // half-typed form is noise, and the first fix usually resolves several.
  const draft = [
    { text: '', options: ok().options },
    { text: 'Q', options: [{ text: 'A', correct: false }, { text: 'B', correct: false }] },
  ];
  assert.equal(validateAssessmentDraft(draft), 'Question 1 has no text.');
});
