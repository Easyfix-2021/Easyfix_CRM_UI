'use client';

import { useEffect, useState } from 'react';
import { StickyNote, Plus, Pin, PinOff } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { showToast } from '@/components/ui/toast';
import { formatApiError } from '@/lib/api-errors';

/*
 * JobInternalNotes — the ops-only notes on a job, as sticky notes.
 *
 * WHY THEY LOOK LIKE STICKIES rather than another comment thread: these are the
 * things the next person must not miss ("don't close without confirming with
 * the customer", "customer's number is wrong, use the alt"), and next to a
 * 40-row remarks thread a plain list of them reads as more of the same. The
 * paper look is doing one job — making a handful of short warnings survive a
 * page that is mostly tables.
 *
 * THEY ARE NOT REMARKS. Remarks are the job's audit trail, visible per audience
 * (internal / technician / client) and written on every action. These are free
 * text for the team, never shown outside EasyFix, and the two live side by side
 * rather than merged: two things that are read for different reasons should not
 * share one scroll.
 *
 * READ, ADD AND PIN — the text is never edited or deleted (the table has no
 * status, no updated_at and no soft delete, so an edit would be an unaudited
 * rewrite of somebody else's note). A PIN only changes where a note sits: pinned
 * notes list first and are flagged on the Job notes card, so a warning that
 * matters is not scrolled away by newer chatter.
 *
 * WHO / WHEN / STAGE SIT ABOVE THE TEXT: on a long note the byline used to be
 * below the fold of its own card, so the reader met the text before knowing
 * who wrote it or at which stage.
 */

export type JobNote = {
  id: number;
  notes: string;
  job_stage?: string | null;
  note_created_on?: string | null;
  note_created_by?: string | null;
  /* Present only once the pin migration has run on this environment. */
  is_pinned?: number | boolean | null;
  pinned_on?: string | null;
  pinned_by_name?: string | null;
};

const MAX = 1000;

export function JobInternalNotes({ jobId, canAdd = true, onPinnedChange, fill = false }: {
  jobId: number | null;
  /** Fill the host's height and scroll the notes inside it (the consoles' fixed tile). */
  fill?: boolean;
  /** The host withholds adding (and pinning) on a read-only open, same gate as its editors. */
  canAdd?: boolean;
  /** Reports the pinned notes up, so the host can flag them elsewhere on the page. */
  onPinnedChange?: (pinned: JobNote[]) => void;
}) {
  const key = jobId ? `/admin/jobs/${jobId}/notes` : null;
  const { data, loading, refetch, dataKey } = useFetch<JobNote[]>(key);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [pinning, setPinning] = useState<number | null>(null);
  const [err, setErr] = useState('');
  /* Only this job's notes — never the previous job's while this one loads. */
  const notes = dataKey === key ? (data ?? []) : [];
  const mayAdd = canAdd;
  /*
   * Pinning needs the columns the 2026-09-17 migration adds. The list only
   * carries `is_pinned` once they exist, so an environment that has not run it
   * shows no pin controls rather than buttons that answer 409.
   */
  const pinSupported = notes.length > 0 && notes.some((n) => n.is_pinned !== undefined);
  const pinned = notes.filter((n) => Number(n.is_pinned) === 1);
  const pinnedSig = pinned.map((n) => n.id).join(',');

  useEffect(() => {
    onPinnedChange?.(pinned);
    // Keyed on WHICH notes are pinned, not the array identity (new every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedSig, onPinnedChange]);

  function reload() {
    /*
     * BOTH, and in this order. invalidateFetch only DROPS the cached key — it
     * cannot re-run a hook that is still mounted, which is why a new note
     * appeared only after a page refresh. refetch() is what actually re-reads
     * the list; dropping the key first stops a later mount serving the stale
     * copy. (Same trap the reschedule refresh hit.)
     */
    invalidateFetch((k) => k === `/admin/jobs/${jobId}/notes`);
    refetch();
  }

  async function add() {
    const body = text.trim();
    if (!body) { setErr('Write a note first'); return; }
    if (!jobId) return;
    setSaving(true); setErr('');
    try {
      await api.post(`/admin/jobs/${jobId}/notes`, { notes: body });
      setText('');
      reload();
      showToast({ variant: 'success', message: 'Note Added.' });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the note');
    } finally {
      setSaving(false);
    }
  }

  async function togglePin(n: JobNote) {
    if (!jobId) return;
    const next = Number(n.is_pinned) !== 1;
    setPinning(n.id);
    try {
      await api.patch(`/admin/jobs/${jobId}/notes/${n.id}/pin`, { pinned: next });
      reload();
      showToast({ variant: 'success', message: next ? 'Note Pinned.' : 'Note Unpinned.' });
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not update the pin' }) });
    } finally {
      setPinning(null);
    }
  }

  return (
    <section className={`rounded-md border bg-card p-3 ${fill ? 'flex h-full min-h-0 flex-col' : ''}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <StickyNote className="h-3.5 w-3.5" />Internal notes
        </h3>
        {/* The count is a chip beside the title, not part of it — "Internal
            notes 3" read as one label. */}
        <span className="flex items-center gap-1.5">
          {pinned.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-gold bg-gold-tint px-2 py-0.5 text-xs font-medium text-gold-strong">
              <Pin className="h-3 w-3" />{pinned.length} pinned
            </span>
          )}
          <span className="inline-flex min-w-[1.5rem] justify-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {notes.length}
          </span>
        </span>
      </div>

      {mayAdd && (
        <div className="mb-3 grid gap-2">
          <textarea
            value={text}
            maxLength={MAX}
            disabled={saving}
            onChange={(e) => { setText(e.target.value); setErr(''); }}
            placeholder="Don't close without confirming with the customer"
            className="h-16 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs"
          />
          {err && <p className="text-xs text-urgent-strong" role="alert">{err}</p>}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">{text.trim().length} / {MAX}</span>
            <button
              type="button"
              onClick={add}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md bg-success px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />{saving ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </div>
      )}

      {(loading || dataKey !== key) && notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          No internal notes on this job.
        </p>
      ) : (
        /* Pinned first, then newest (the endpoint orders by is_pinned DESC,
           created DESC, id DESC). The stack is capped and scrolls rather than
           growing without limit: a job with 20 notes must not push the rest of
           the console off screen. */
        <ul className={`grid content-start gap-2 overflow-y-auto pr-0.5 ${fill ? 'min-h-0 flex-1' : 'max-h-72'}`}>
          {notes.map((n) => {
            const isPinned = Number(n.is_pinned) === 1;
            return (
              <li
                key={n.id}
                className={`rounded-md border bg-gold-tint p-2.5 text-xs ${isPinned ? 'border-gold-strong ring-1 ring-gold' : 'border-gold'}`}
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-700">
                    {isPinned && (
                      <span className="inline-flex items-center gap-0.5 font-semibold text-gold-strong" title={n.pinned_by_name ? `Pinned by ${n.pinned_by_name}${n.pinned_on ? ` · ${formatDate(n.pinned_on)}` : ''}` : undefined}>
                        <Pin className="h-3 w-3" />Pinned
                      </span>
                    )}
                    <span className="font-medium">{n.note_created_by || 'Unknown'}</span>
                    {n.note_created_on && <span>{formatDate(n.note_created_on)}</span>}
                    {/* The stage the note was written AT — a warning left at
                        "Pending to start" reads differently once the job is in
                        audit, and the legacy rows all carry it. */}
                    {n.job_stage && <span className="rounded-full bg-white/60 px-1.5">{n.job_stage}</span>}
                  </p>
                  {mayAdd && pinSupported && (
                    <button
                      type="button"
                      onClick={() => togglePin(n)}
                      disabled={pinning != null}
                      aria-label={isPinned ? 'Unpin note' : 'Pin note on top'}
                      title={isPinned ? 'Unpin' : 'Pin on top'}
                      className="shrink-0 rounded-md border border-gold bg-white/60 px-1.5 py-1 text-gold-strong hover:bg-white disabled:opacity-50"
                    >
                      {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words text-ink-900">{n.notes}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
