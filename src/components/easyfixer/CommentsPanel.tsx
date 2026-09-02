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
      <label className="text-xs font-semibold text-ink-700">{addLabel}</label>
      <textarea
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded-md border border-ink-100 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        placeholder="Your Notes"
      />
      <div className="flex justify-end">
        {/* (c) hover-only crossover. The resting green is fine — --success is
          * 36.27% lightness in BOTH themes (STABLE), so `text-white` holds at
          * 4.6:1 either way. The hover is the defect: --success-strong is
          * 20.78% under :root but 92.35% under .dark, crossing the mid-point
          * while `text-white` does not move —
          *
          *   light  --success-strong  rgb(14,92,52)     8.08:1 vs white ✓
          *   dark   --success-strong  rgb(226,245,234)  1.14:1 vs white ✗
          *
          * so "Add" went white-on-near-white in dark mode on hover. Rather
          * than drop the hover, name the dark half: --success-tint and
          * --success-strong SWAP with each other (92.35% ↔ 20.78%), so dark
          * --success-tint IS rgb(14,92,52), bit-identical to the light-mode
          * hover. `dark:hover:` compiles to `.dark .dark\:hover\:…:hover` —
          * two classes to `hover:`'s one — so it wins on specificity whatever
          * the source order. Light theme is byte-identical; the `dark:` half
          * never applies there. Same idiom as the green CTAs in
          * easyfixers/[id]/verification. */}
        <Button
          type="button"
          size="sm"
          className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white"
          onClick={submit}
          disabled={saving || draft.trim().length === 0}
        >
          Add
        </Button>
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto space-y-2 pr-1">
        {entries.length === 0 ? (
          <div className="text-xs text-ink-500 italic">{emptyHint}</div>
        ) : entries.map((c, idx) => (
          <div key={c.id ?? idx} className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2">
            {/* Legacy stamped status into the comment using <br>; render as HTML safely-ish */}
            <p className="text-xs text-ink-900 whitespace-pre-line"
               dangerouslySetInnerHTML={{ __html: sanitize(c.text) }} />
            <div className="mt-1 text-xs text-ink-500 flex items-center justify-between">
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
