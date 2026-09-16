'use client';

import { useState } from 'react';
import { StickyNote, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { showToast } from '@/components/ui/toast';

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
 * READ AND ADD ONLY — the table has no status, no updated_at and no soft
 * delete, so an edit or a delete would be an unaudited rewrite of somebody
 * else's note.
 */

export type JobNote = {
  id: number;
  notes: string;
  job_stage?: string | null;
  note_created_on?: string | null;
  note_created_by?: string | null;
};

const MAX = 1000;

export function JobInternalNotes({ jobId, canAdd = true }: {
  jobId: number | null;
  /** The host withholds adding on a read-only open, same gate as its editors. */
  canAdd?: boolean;
}) {
  const { data, loading } = useFetch<JobNote[]>(jobId ? `/admin/jobs/${jobId}/notes` : null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const notes = data ?? [];
  /* Same gate as Add Remarks, which JobModal deliberately leaves
     un-permissioned: the host withholds `canAdd` on a read-only open, and
     nothing finer than that exists for writing a note. */
  const mayAdd = canAdd;

  async function add() {
    const body = text.trim();
    if (!body) { setErr('Write a note first'); return; }
    if (!jobId) return;
    setSaving(true); setErr('');
    try {
      await api.post(`/admin/jobs/${jobId}/notes`, { notes: body });
      setText('');
      // The list is a mounted useFetch; drop its key so it re-reads the row we
      // just wrote rather than showing the thread without it until reopen.
      invalidateFetch((k) => k === `/admin/jobs/${jobId}/notes`);
      showToast({ variant: 'success', message: 'Note Added.' });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the note');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <StickyNote className="h-3.5 w-3.5" />Internal notes
          <span className="font-mono text-xs normal-case tracking-normal">{notes.length}</span>
        </h3>
        <span className="text-xs text-muted-foreground">EasyFix team only</span>
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

      {loading && notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          No internal notes on this job.
        </p>
      ) : (
        <ul className="grid gap-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-gold bg-gold-tint p-2.5 text-xs">
              <p className="whitespace-pre-wrap break-words text-ink-900">{n.notes}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-700">
                <span className="font-medium">{n.note_created_by || 'Unknown'}</span>
                {n.note_created_on && <span>{formatDate(n.note_created_on)}</span>}
                {/* The stage the note was written AT — a warning left at
                    "Pending to start" reads differently once the job is in
                    audit, and the legacy rows all carry it. */}
                {n.job_stage && <span className="rounded-full bg-white/60 px-1.5">{n.job_stage}</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
