'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';

/*
 * Sidebar "Add your comment/notes" + scrollable history panel used by
 * each section of the Easyfixer Verification page. Mirrors the legacy
 * `.add-comment-area` + `.sidebar-list-eferVerify` pair.
 */

export type CommentEntry = {
  id?: number;
  text: string;
  author: string | null;
  createdAt: string | Date | null;
};

export function CommentsPanel({
  entries,
  onAdd,
  addLabel = 'Add Your Comment',
  emptyHint = 'No comments yet',
  rows = 3,
}: {
  entries: CommentEntry[];
  onAdd: (text: string) => Promise<void> | void;
  addLabel?: string;
  emptyHint?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    try {
      await onAdd(text);
      setDraft('');
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-semibold text-slate-700">{addLabel}</label>
      <textarea
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/40"
        placeholder="Your Notes"
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
          onClick={submit}
          disabled={saving || draft.trim().length === 0}
        >
          Add
        </Button>
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto space-y-2 pr-1">
        {entries.length === 0 ? (
          <div className="text-xs text-slate-400 italic">{emptyHint}</div>
        ) : entries.map((c, idx) => (
          <div key={c.id ?? idx} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
            {/* Legacy stamped status into the comment using <br>; render as HTML safely-ish */}
            <p className="text-xs text-slate-800 whitespace-pre-line"
               dangerouslySetInnerHTML={{ __html: sanitize(c.text) }} />
            <div className="mt-1 text-[10px] text-slate-500 flex items-center justify-between">
              <span>{c.author || '—'}</span>
              <span>{c.createdAt ? formatDate(c.createdAt as string) : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Minimal sanitizer — legacy stamps "Accepted <br> reason text". We
// allow <br> only and strip everything else.
function sanitize(html: string): string {
  return html
    .replace(/<(?!br\s*\/?>)[^>]*>/gi, '')
    .replace(/&/g, '&amp;').replace(/</g, (m, off, full) => {
      // re-allow <br/> that we kept above
      const ahead = full.slice(off, off + 5).toLowerCase();
      return /^<br/.test(ahead) ? m : '&lt;';
    });
}
