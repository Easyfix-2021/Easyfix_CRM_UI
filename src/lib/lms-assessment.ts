/*
 * LMS assessment draft validation.
 *
 * Lives here rather than inside the editor page for one reason: it is the only
 * non-trivial logic on that screen, and a page component cannot be imported by
 * `node --test`. `npm run test:build` compiles this module to .test-build and
 * tests/lms-assessment.test.js pins the rules against it.
 *
 * WHAT IT ENFORCES, AND WHY EACH CLAUSE IS LOAD-BEARING
 *
 *   >= 1 question    — an assessment with none can never be passed, so any
 *                      course containing it stays incomplete for every
 *                      technician assigned to it, forever.
 *   >= 2 options     — a single-option question is not a question.
 *   no blank option  — a blank option is either a half-typed answer (the
 *                      operator is not finished) or dead weight the technician
 *                      would see as an empty radio row.
 *   exactly 1 correct — server-side scoring divides correct answers by
 *                      question count. Zero correct makes the question
 *                      unanswerable; more than one makes "the answer" undefined.
 *
 * The backend re-validates all four and stays the authority. This exists so
 * the message names the QUESTION NUMBER an operator is looking at, instead of
 * arriving as a 400 about an array index.
 *
 * Returns the FIRST problem as a finished sentence, or null when the draft is
 * saveable. First-problem-only is deliberate: a list of eight complaints about
 * a half-typed form is noise, and fixing the first usually fixes several.
 */

/* Structural minimum — the editor's own draft rows carry a React `key` as
 * well, and structural typing lets them pass without a second type. */
export type ValidatableOption = { text: string; correct: boolean };
export type ValidatableQuestion = { text: string; options: readonly ValidatableOption[] };

export function validateAssessmentDraft(
  questions: readonly ValidatableQuestion[],
): string | null {
  if (questions.length === 0) return 'Add at least one question before saving.';

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const n = i + 1;

    if (!q.text.trim()) return `Question ${n} has no text.`;

    const filled = q.options.filter((o) => o.text.trim());
    /* Order matters: "needs two options" is checked against the FILLED count,
     * so a question with one real option and one blank is told the useful
     * thing (it needs another answer) rather than the pedantic one (a field is
     * empty). Only once there are two real options does a leftover blank
     * become the remaining problem. */
    if (filled.length < 2) return `Question ${n} needs at least two options.`;
    if (filled.length !== q.options.length) {
      return `Question ${n} has a blank option — fill it in or remove it.`;
    }

    const correct = q.options.filter((o) => o.correct).length;
    if (correct === 0) return `Question ${n} has no correct answer marked.`;
    /* Unreachable through the radio group in the editor, which enforces
     * one-of-N by itself. Kept because the rule belongs to the backend, not to
     * the widget — a future multi-select control must not silently pass. */
    if (correct > 1) return `Question ${n} has more than one correct answer marked.`;
  }

  return null;
}
