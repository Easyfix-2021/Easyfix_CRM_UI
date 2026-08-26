'use client';

/*
 * Assessments — the MCQ tab of LMS ▸ Content.
 *
 * An assessment is a content KIND, not a feature bolted onto a course: it sits
 * in `lms_content` beside videos and documents, in one ordered list, and a
 * technician completes it by having a PASSING row in `lms_assessment_attempt`.
 *
 * WHAT THIS SCREEN OWNS, AND WHAT IT DELIBERATELY DOES NOT
 *   Owns   — the question bank: title, pass mark, attempt limit, questions and
 *            options, including WHICH option is correct.
 *   Not    — scoring. The technician app posts answers to
 *            /api/mobile/lms/assessments/:id/submit and the SERVER scores them;
 *            `is_correct` never leaves the server on the mobile read. That is
 *            why this screen is the only place the correct answer is visible,
 *            and why it gates on isLmsManage.
 *
 * WHY THE QUESTION SAVE IS A FULL REPLACE. PUT /assessments/:id/questions takes
 * the whole list and rewrites it, so array order IS `sequence` and there is no
 * per-question id to reconcile. Editing in place would need three verbs
 * (add/update/delete) and a client that tracks which questions are new — for a
 * form whose realistic size is ten questions.
 *
 * Backend: /admin/lms/assessments, gated by requireLmsManage.
 */

import * as React from 'react';
import {
  Search, Plus, Pencil, Trash2, AlertTriangle, ClipboardCheck,
  ChevronUp, ChevronDown, X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { StatusChip } from '@/components/ui/StatusChip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { validateAssessmentDraft } from '@/lib/lms-assessment';

/* ── Types ──────────────────────────────────────────────────────────────── */

type Assessment = {
  id: number;
  title: string;
  description: string | null;
  pass_percent: number;
  max_attempts: number;
  status: number;          // 1 = Active, 0 = Retired
  question_count: number;
};
type ListResponse = { rows: Assessment[]; total: number; limit: number; offset: number };

/*
 * The detail read — the ONLY place is_correct crosses the wire.
 *
 * `is_correct` is a BOOLEAN here, not the raw TINYINT: getAssessmentForAdmin
 * serialises it as `Number(r.is_correct) === 1` before it leaves the server.
 * Typing it as a number and seeding the editor with `=== 1` compiled fine and
 * was always false, so opening an assessment to fix a typo and saving wiped
 * every correct answer — an assessment nobody can pass, and a course nobody
 * can complete. Every other numeric field on this API (status, question_count,
 * pass_percent, max_attempts) IS the raw column and stays a number.
 */
type DetailOption = { id: number; option_text: string; is_correct: boolean; sequence: number };
type DetailQuestion = { id: number; question_text: string; sequence: number; options: DetailOption[] };
type AssessmentDetail = Assessment & { questions: DetailQuestion[] };

/*
 * The editor's working copy. Deliberately carries NO server ids: the save is a
 * full replace, so a question's identity is its position in this array and
 * nothing else. Keeping ids around would be a second source of truth that the
 * PUT ignores anyway.
 *
 * `key` exists only for React reconciliation — array index would remount every
 * row below an insert or a move, blowing away focus mid-typing.
 */
type DraftOption = { key: string; text: string; correct: boolean };
type DraftQuestion = { key: string; text: string; options: DraftOption[] };

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

const newOption = (): DraftOption => ({ key: nextKey(), text: '', correct: false });
/* A fresh question starts with two blank options because two is the MINIMUM a
 * question can be saved with — starting at one would show a form that is
 * invalid by construction and make the operator discover the rule from an
 * error. */
const newQuestion = (): DraftQuestion => ({
  key: nextKey(),
  text: '',
  options: [{ ...newOption(), correct: true }, newOption()],
});

/*
 * 'All' is withheld, same as the courses list. This endpoint's own `limit`
 * ceiling is not something the page can see, and TablePagination's 'All'
 * renders "Showing 1–N of N" whether or not the server actually returned N —
 * a silent lie on any endpoint that caps lower. Guessing a cap here would be
 * inventing a number the API never promised.
 */
const PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

const TITLE_MAX = 255;
const DESC_MAX = 2000;
const QUESTION_MAX = 1000;
const OPTION_MAX = 500;
/*
 * Mirrors the BACKEND's Joi bound — `max_attempts: Joi.number().max(20)` in
 * EasyFix_Backend/routes/admin/lms.js — not the TINYINT column's 127. Joi is
 * the narrower of the two and therefore the one an operator actually hits, so
 * a client ceiling of 127 was not "generous", it was a form that accepts a
 * number and then fails the save with a 400 nobody expects. Change this only
 * with the Joi line.
 */
const ATTEMPTS_MAX = 20;

/*
 * Joi rejections arrive with a generic top-level message and the per-field
 * reasons in `details`; showing only `.message` says something broke but not
 * what. Same helper as the courses page — flattens details onto the message.
 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.details;
    if (Array.isArray(d) && d.length > 0) {
      const parts = d
        .map((x) => (typeof x === 'string' ? x : (x as { message?: string })?.message))
        .filter((x): x is string => Boolean(x));
      if (parts.length > 0) return `${e.message}: ${parts.join('; ')}`;
    }
    return e.message || fallback;
  }
  return e instanceof Error ? e.message : fallback;
}

/* ── Tab ────────────────────────────────────────────────────────────────── */

export function AssessmentsTab() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isLmsManage']);

  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [formFor, setFormFor] = React.useState<Assessment | 'new' | null>(null);
  const [retiringId, setRetiringId] = React.useState<number | null>(null);

  const dq = useDebouncedValue(search, 300);
  React.useEffect(() => { setPage(0); }, [dq]);

  const limit = pageSizeToLimit(pageSize);
  const offset = page * limit;
  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  const listUrl = `/admin/lms/assessments?${qs.toString()}`;

  const { data, loading, error, refetch } = useFetch<ListResponse>(listUrl);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  function refresh() {
    invalidateFetch((k) => k.startsWith('/admin/lms/assessments'));
    refetch();
  }

  async function handleRetire(a: Assessment) {
    const ok = await confirm({
      title: 'Retire This Assessment?',
      description:
        `"${a.title}" will stop appearing in the picker when building a course. This is a soft `
        + 'retire — questions and every technician attempt are preserved, and any course that '
        + 'already contains it keeps working. An assessment still used by a course cannot be retired.',
      confirmLabel: 'Retire',
      variant: 'destructive',
    });
    if (!ok) return;
    setRetiringId(a.id);
    try {
      await api.delete(`/admin/lms/assessments/${a.id}`);
      showToast({ variant: 'success', message: `"${a.title}" Retired.` });
      refresh();
    } catch (e) {
      /* 409 = still referenced by an lms_content row. The reference count is
       * not on the list response, so this cannot be pre-disabled the way the
       * videos tab pre-disables delete — the server names the blocker. */
      showToast({ variant: 'error', message: errText(e, 'Retire Failed.') });
      refresh();
    } finally {
      setRetiringId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Multiple-choice tests a technician must pass. Add one to a course from
            LMS ▸ Manage Courses.
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            Answers are scored on the server and the correct option is never sent to the technician
            app — this screen is the only place it is visible.
          </p>
        </div>
        {can.isLmsManage && (
          <Button onClick={() => setFormFor('new')}>
            <Plus className="size-4 mr-1" /> Add Assessment
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/* Title */}
              <col style={{ width: '44%' }} />
              {/* Questions */}
              <col style={{ width: '14%' }} />
              {/* Pass Mark */}
              <col style={{ width: '14%' }} />
              {/* Attempts */}
              <col style={{ width: '14%' }} />
              {/* Actions */}
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left whitespace-nowrap">Title</th>
                <th className="!text-right whitespace-nowrap">Questions</th>
                <th className="!text-right whitespace-nowrap">Pass Mark</th>
                <th className="!text-right whitespace-nowrap">Attempts</th>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 5 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="!text-center text-muted-foreground py-8">
                    No assessments match the current search.
                  </td>
                </tr>
              )}
              {!loading && rows.map((a) => (
                <tr key={a.id}>
                  <td className="!text-left">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ClipboardCheck className="size-4 shrink-0 text-muted-foreground" />
                      <span className="font-medium truncate" title={a.title}>{a.title}</span>
                      {a.status !== 1 && (
                        <StatusChip tone="neutral" size="sm" title="Retired — cannot be added to a course">
                          Retired
                        </StatusChip>
                      )}
                    </div>
                    {a.description && (
                      <div className="text-xs text-muted-foreground truncate" title={a.description}>
                        {a.description}
                      </div>
                    )}
                  </td>
                  {/*
                    Zero questions is a real defect, not a small number: the
                    assessment can be added to a course and then never passed,
                    which caps that course at incomplete for everyone assigned
                    to it. Called out in-row so it is caught before it is used.
                  */}
                  <td className="!text-right tabular-nums">
                    {a.question_count === 0 ? (
                      <span
                        className="text-warning-strong font-semibold"
                        title="No questions — technicians can never pass this, so any course containing it can never be completed"
                      >
                        0
                      </span>
                    ) : a.question_count}
                  </td>
                  <td className="!text-right tabular-nums">{a.pass_percent}%</td>
                  <td className="!text-right tabular-nums">{a.max_attempts}</td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {/*
                        View is NOT offered to operators without isLmsManage: the
                        modal shows which option is correct, and that is the one
                        thing on the LMS that must not be casually readable —
                        the whole point of server-side scoring is that the answer
                        key stays with the people who own the syllabus.
                      */}
                      {can.isLmsManage ? (
                        <>
                          <IconButton
                            icon={Pencil}
                            label="Edit Assessment"
                            intent="primary"
                            onClick={() => setFormFor(a)}
                          />
                          <IconButton
                            icon={Trash2}
                            label="Retire Assessment"
                            intent="danger"
                            busy={retiringId === a.id}
                            onClick={() => handleRetire(a)}
                          />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">View Only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              pageSizeOptions={PAGE_SIZES}
            />
          </div>
        </CardContent>
      </Card>

      {/* Rendered unconditionally with `open` derived from state, so the
          open-transition seeding effects inside it actually fire. */}
      {/* Close refreshes too, not just save: a half-failed save leaves the
          modal open on purpose (see AssessmentModal), and the assessment it
          already created has to appear in the list when the operator gives up
          and closes it. */}
      <AssessmentModal
        target={can.isLmsManage ? formFor : null}
        onClose={() => { setFormFor(null); refresh(); }}
        onSaved={() => { setFormFor(null); refresh(); }}
      />
    </div>
  );
}

/* ── Add / Edit modal (settings + question editor in one) ───────────────── */

/*
 * ─── Why the save is ordered, and what happens when half of it fails ─────
 *
 * Questions are saved through PUT /assessments/:id/questions, which needs an
 * id — and on the Add path there is no id until the POST returns. So the save
 * is necessarily two calls, and the interesting case is the POST succeeding
 * and the PUT failing: the assessment now EXISTS. Reporting that as "create
 * failed" would send the operator into a retry that creates a second one.
 *
 * `createdIdRef` makes the retry honest: once a create has succeeded in this
 * modal session the id is remembered, so pressing Save again PATCHes that
 * assessment and re-PUTs the questions instead of POSTing a duplicate. Same
 * shape as CourseModal on the courses page, for the same reason.
 */
function AssessmentModal({ target, onClose, onSaved }: {
  target: Assessment | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = target !== null;
  const editing = target !== null && target !== 'new' ? target : null;

  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [passPercent, setPassPercent] = React.useState('70');
  const [maxAttempts, setMaxAttempts] = React.useState('3');
  const [draft, setDraft] = React.useState<DraftQuestion[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const createdIdRef = React.useRef<number | null>(null);

  /* Questions only exist on an edit, and only the detail read carries them —
   * the list row has a count, not the content. */
  const detail = useFetch<AssessmentDetail>(
    editing ? `/admin/lms/assessments/${editing.id}` : null,
  );

  /*
   * Settings seed on OPEN, keyed on the assessment id — deliberately NOT on
   * `detail.data`, which would wipe anything already typed into Title when the
   * question list lands a moment later.
   */
  React.useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setDescription(editing?.description ?? '');
    setPassPercent(String(editing?.pass_percent ?? 70));
    setMaxAttempts(String(editing?.max_attempts ?? 3));
    setError(null);
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * Questions seed ONCE per open, guarded by a ref rather than by
   * `draft.length === 0` — "the operator deleted every question" is a state
   * they can legitimately be in mid-edit, and a length-based guard would
   * immediately re-seed the list they just cleared.
   */
  const seededFor = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!open) {
      seededFor.current = null;
      createdIdRef.current = null;
      setDraft([]);
      return;
    }
    if (!editing) {
      /* Add: start with one blank question rather than an empty list. A blank
       * form's first action is always "add a question", and `0` stands in for
       * "the new assessment" in the seed guard. */
      if (seededFor.current !== 0) { seededFor.current = 0; setDraft([newQuestion()]); }
      return;
    }
    if (detail.data && seededFor.current !== editing.id) {
      seededFor.current = editing.id;
      /* `?? []` is not paranoia about a field that is always there: an
       * assessment created and then abandoned before its questions PUT
       * succeeded has none, and the detail endpoint has no reason to invent an
       * empty array for it. Crashing the editor is the one outcome that makes
       * that assessment unfixable. */
      setDraft((detail.data.questions ?? []).map((q) => ({
        key: nextKey(),
        text: q.question_text,
        options: (q.options ?? []).map((o) => ({
          key: nextKey(),
          text: o.option_text,
          /* Truthiness, never `=== 1`: the wire sends a boolean. This value is
           * re-sent verbatim by the questions PUT, so a comparison that misses
           * is not a display bug — it silently unmarks the answer key. */
          correct: !!o.is_correct,
        })),
      })));
    }
  }, [open, editing, detail.data]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  /* ── Draft mutators. All immutable, all keyed by index — the array IS the
       sequence, so a move renumbers everything for free. ─────────────────── */

  function patchQuestion(qi: number, fn: (q: DraftQuestion) => DraftQuestion) {
    setDraft((d) => d.map((q, i) => (i === qi ? fn(q) : q)));
  }
  function moveQuestion(qi: number, delta: number) {
    setDraft((d) => {
      const to = qi + delta;
      if (to < 0 || to >= d.length) return d;
      const copy = d.slice();
      [copy[qi], copy[to]] = [copy[to], copy[qi]];
      return copy;
    });
  }
  function markCorrect(qi: number, oi: number) {
    /* Exactly-one is enforced by REWRITING every option's flag, not by
     * toggling the clicked one. The radio group already behaves this way
     * visually; making the state match means the "more than one correct"
     * branch of validateDraft can never be reached from this widget. */
    patchQuestion(qi, (q) => ({
      ...q,
      options: q.options.map((o, i) => ({ ...o, correct: i === oi })),
    }));
  }
  function removeOption(qi: number, oi: number) {
    patchQuestion(qi, (q) => {
      const options = q.options.filter((_, i) => i !== oi);
      /* Removing the correct option would leave the question with no answer
       * and no way to notice — promote the first remaining one so the form is
       * never silently invalid. */
      if (!options.some((o) => o.correct) && options.length > 0) options[0] = { ...options[0], correct: true };
      return { ...q, options };
    });
  }

  async function handleSubmit() {
    const t = title.trim();
    if (!t) { setError('Title is required.'); return; }
    const pass = Number(passPercent);
    const attempts = Number(maxAttempts);
    if (!Number.isInteger(pass) || pass < 1 || pass > 100) {
      setError('Pass mark must be a whole number between 1 and 100.');
      return;
    }
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > ATTEMPTS_MAX) {
      setError(`Max attempts must be a whole number between 1 and ${ATTEMPTS_MAX}.`);
      return;
    }
    /* The four question rules, in @/lib/lms-assessment so `node --test` can
     * reach them — see tests/lms-assessment.test.js. */
    const bad = validateAssessmentDraft(draft);
    if (bad) { setError(bad); return; }

    setError(null);
    setSubmitting(true);
    const existingId = editing?.id ?? createdIdRef.current;
    const toast = showToast({
      variant: 'loading',
      message: existingId ? 'Saving assessment…' : 'Creating assessment…',
    });

    let id: number;
    try {
      const body = {
        title: t,
        description: description.trim(),
        pass_percent: pass,
        max_attempts: attempts,
      };
      if (existingId) {
        await api.patch(`/admin/lms/assessments/${existingId}`, body);
        id = existingId;
      } else {
        const created = await api.post<{ id: number }>('/admin/lms/assessments', body);
        id = created.id;
        /* Remembered BEFORE the questions call, so a failure there leaves a
         * retry that patches rather than duplicates. */
        createdIdRef.current = created.id;
      }
    } catch (e) {
      dismissToast(toast);
      const msg = errText(e, 'Save failed');
      setError(msg);
      showToast({ variant: 'error', message: msg });
      setSubmitting(false);
      return;
    }

    /*
     * Questions are a SECOND call and are ALWAYS sent, even when nothing
     * visibly changed. An assessment with no questions can never be passed, so
     * "skip the PUT if the list looks unchanged" would be a way to leave one
     * empty after a half-failed earlier save — and the payload is ten rows.
     */
    try {
      await api.put(`/admin/lms/assessments/${id}/questions`, {
        questions: draft.map((q, qi) => ({
          question_text: q.text.trim(),
          sequence: qi + 1,
          options: q.options.map((o, oi) => ({
            option_text: o.text.trim(),
            is_correct: o.correct,
            sequence: oi + 1,
          })),
        })),
      });
    } catch (e) {
      dismissToast(toast);
      const msg = errText(e, 'Questions could not be saved');
      setError(
        `The assessment was ${editing ? 'updated' : 'created'}, but its questions could not be saved: `
        + `${msg} Press Save again to retry — this will not create a duplicate.`,
      );
      showToast({ variant: 'error', message: `Assessment Saved, Questions Failed — ${msg}` });
      invalidateFetch((k) => k.startsWith('/admin/lms/assessments'));
      /* NOT onSaved(): that closes the modal, which would take the message
       * above — and the draft the operator would retry with — with it. The
       * list still learns about the new assessment, because the parent
       * refreshes on close as well as on save. */
      setSubmitting(false);
      return;
    }

    dismissToast(toast);
    showToast({ variant: 'success', message: editing ? 'Assessment Saved' : 'Assessment Created' });
    invalidateFetch((k) => k.startsWith('/admin/lms/assessments'));
    onSaved();
    setSubmitting(false);
  }

  const loadingQuestions = !!editing && detail.loading;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {editing ? `Edit Assessment — ${editing.title}` : 'Add Assessment'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 max-h-[75vh] overflow-y-auto pr-1">
          <div>
            <Label className="block mb-1" required>Title</Label>
            <Input
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='e.g. "Refrigerant Safety — Knowledge Check"'
            />
          </div>

          <div>
            <Label className="block mb-1">Description</Label>
            <textarea
              value={description}
              maxLength={DESC_MAX}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown to the technician before they start (optional)"
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1" required>Pass Mark (%)</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={passPercent}
                onChange={(e) => setPassPercent(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-0.5">
                Score needed to complete this item.
              </p>
            </div>
            <div>
              <Label className="block mb-1" required>Max Attempts</Label>
              <Input
                type="number"
                min={1}
                max={ATTEMPTS_MAX}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
              />
              {/*
                States the consequence rather than the number. Attempts are
                counted per technician against this assessment and the submit
                endpoint refuses once they run out — there is no self-service
                reset, so setting this to 1 is a decision with a support cost.
              */}
              <p className="text-xs text-muted-foreground mt-0.5">
                A technician who uses them all without passing is blocked until someone intervenes.
              </p>
            </div>
          </div>

          {/* ── Question editor ────────────────────────────────────────── */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <Label className="block">Questions ({draft.length})</Label>
              <Button
                size="sm"
                variant="outline"
                disabled={submitting || loadingQuestions}
                onClick={() => setDraft((d) => [...d, newQuestion()])}
              >
                <Plus className="size-4 mr-1" /> Add Question
              </Button>
            </div>

            {loadingQuestions && (
              <div className="rounded-md border p-4 text-sm text-muted-foreground">Loading…</div>
            )}

            {!loadingQuestions && draft.length === 0 && (
              /* Not a neutral blank slate: an assessment with no questions is
                 addable to a course and unpassable, so every technician holding
                 that course is stuck at incomplete. */
              <div className="rounded-md border p-6 text-center">
                <div className="text-sm font-semibold">No Questions Yet</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  An assessment with no questions can never be passed — any course containing it
                  would stay incomplete for every technician assigned to it.
                </div>
              </div>
            )}

            {!loadingQuestions && draft.map((q, qi) => (
              <div key={q.key} className="rounded-md border p-3 mb-2 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="mt-2 w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {qi + 1}.
                  </span>
                  <textarea
                    value={q.text}
                    maxLength={QUESTION_MAX}
                    rows={2}
                    disabled={submitting}
                    onChange={(e) => {
                      const text = e.target.value;
                      patchQuestion(qi, (x) => ({ ...x, text }));
                    }}
                    placeholder="Question text"
                    className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40"
                  />
                  <div className="flex items-center gap-1 shrink-0 mt-1">
                    <IconButton
                      icon={ChevronUp}
                      label="Move Question Up"
                      disabled={qi === 0 || submitting}
                      onClick={() => moveQuestion(qi, -1)}
                    />
                    <IconButton
                      icon={ChevronDown}
                      label="Move Question Down"
                      disabled={qi === draft.length - 1 || submitting}
                      onClick={() => moveQuestion(qi, 1)}
                    />
                    <IconButton
                      icon={X}
                      intent="danger"
                      label="Remove Question"
                      disabled={submitting}
                      onClick={() => setDraft((d) => d.filter((_, i) => i !== qi))}
                    />
                  </div>
                </div>

                <div className="pl-8 space-y-1.5">
                  {q.options.map((o, oi) => (
                    <div key={o.key} className="flex items-center gap-2">
                      {/*
                        A native radio group, one per question — the platform's
                        own "exactly one of these" control. `name` is keyed on
                        the question's stable key rather than its index, so
                        moving a question cannot merge two groups into one.
                        The visible label beside it names the option, so the
                        radio carries its own aria-label instead.
                      */}
                      <input
                        type="radio"
                        name={`correct-${q.key}`}
                        checked={o.correct}
                        disabled={submitting}
                        onChange={() => markCorrect(qi, oi)}
                        aria-label={`Mark option ${oi + 1} as the correct answer`}
                        title="Correct Answer"
                        className="h-3.5 w-3.5 shrink-0 accent-primary"
                      />
                      <Input
                        value={o.text}
                        maxLength={OPTION_MAX}
                        disabled={submitting}
                        onChange={(e) => {
                          const text = e.target.value;
                          patchQuestion(qi, (x) => ({
                            ...x,
                            options: x.options.map((y, i) => (i === oi ? { ...y, text } : y)),
                          }));
                        }}
                        placeholder={`Option ${oi + 1}`}
                        className="flex-1 min-w-0"
                      />
                      <IconButton
                        icon={X}
                        intent="danger"
                        /* Two is the floor the backend enforces, so the
                           refusal is shown as a disabled button with the
                           reason in its tooltip rather than as a 400 after
                           the save. */
                        label={q.options.length <= 2 ? 'A Question Needs At Least Two Options' : 'Remove Option'}
                        disabled={q.options.length <= 2 || submitting}
                        onClick={() => removeOption(qi, oi)}
                      />
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={submitting}
                    onClick={() => patchQuestion(qi, (x) => ({ ...x, options: [...x.options, newOption()] }))}
                  >
                    <Plus className="size-4 mr-1" /> Add Option
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {(error || detail.error) && (
            <div className="text-sm text-urgent flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error ?? detail.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting || loadingQuestions}>
              {submitting ? 'Saving…' : editing ? 'Save Changes' : 'Add Assessment'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
