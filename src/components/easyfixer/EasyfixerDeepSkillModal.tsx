'use client';

import { useMemo, useState } from 'react';
import { X, Loader2, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { formatEasyfixerName } from '@/lib/utils';

/*
 * EasyfixerDeepSkillModal — drill-in from the Manage Easyfixers "Mapped Deep
 * Skill" count. Lists the technician's active deep-skill option mappings with
 * the full 4-level hierarchy (Service Category → Service Type → Deep Skill →
 * Option) and an X to UNMAP a single mapping. BE contract:
 *
 *   GET    /admin/easyfixers/:id/option-mappings        → { items: Mapping[] }
 *   DELETE /admin/easyfixers/:id/option-mappings/:rowId → soft-deletes the row
 *
 * The list is option-level; the page-row "Mapped Deep Skill" count is DISTINCT
 * deep skills. So after an unmap we recompute the distinct-deep-skill count
 * from the remaining rows and hand it back via onUnmapped — never a blind −1
 * (unmapping one option of a 2-option skill must NOT drop the skill count).
 */
type Mapping = {
  mapping_id: number;
  category_id: number;
  category_name: string | null;
  service_type_id: number;
  service_type_name: string | null;
  deep_skill_id: number;
  deep_skill_name: string | null;
  option_id: number;
  option_name: string | null;
};
type Resp = { items: Mapping[] };

export function EasyfixerDeepSkillModal({
  open,
  onClose,
  easyfixerId,
  easyfixerName,
  onUnmapped,
}: {
  open: boolean;
  onClose: () => void;
  easyfixerId: number | null;
  easyfixerName: string | null;
  /** Called after a successful unmap with the technician's NEW distinct-deep-skill count. */
  onUnmapped: (efrId: number, mappedDeepSkillCount: number) => void;
}) {
  const [q, setQ] = useState('');
  const [deleting, setDeleting] = useState<Set<number>>(new Set());
  const confirm = useConfirm();

  // Read-only-ish: the only mutation (unmap) has its own confirm; the dialog
  // itself has no dirty form state, so the guard short-circuits to onClose
  // (satisfies the no-restricted-syntax ESLint rule).
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  const listKey = open && easyfixerId ? `/admin/easyfixers/${easyfixerId}/option-mappings` : null;
  const { data, loading, error, refetch } = useFetch<Resp>(listKey);
  const items = useMemo(() => data?.items ?? [], [data]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter((m) =>
      [m.category_name, m.service_type_name, m.deep_skill_name, m.option_name]
        .some((v) => String(v ?? '').toLowerCase().includes(t)),
    );
  }, [items, q]);

  const distinctSkillCount = useMemo(
    () => new Set(items.map((m) => m.deep_skill_id)).size,
    [items],
  );

  async function handleUnmap(m: Mapping) {
    if (!easyfixerId) return;
    const ok = await confirm({
      title: 'Unmap Deep Skill',
      description:
        `Remove "${m.deep_skill_name ?? 'this deep skill'}${m.option_name ? ` · ${m.option_name}` : ''}" ` +
        `from this technician? They will no longer be matched for it in Schedule & Assign.`,
      confirmLabel: 'Unmap',
      variant: 'destructive',
    });
    if (!ok) return;
    setDeleting((s) => new Set(s).add(m.mapping_id));
    try {
      await api.delete(`/admin/easyfixers/${easyfixerId}/option-mappings/${m.mapping_id}`);
      invalidateFetch((k) => k.startsWith(`/admin/easyfixers/${easyfixerId}/option-mappings`));
      // Recompute the DISTINCT-deep-skill count from the rows that remain and
      // report it to the parent so the row's "Mapped Deep Skill" count is exact.
      const remaining = items.filter((x) => x.mapping_id !== m.mapping_id);
      onUnmapped(easyfixerId, new Set(remaining.map((x) => x.deep_skill_id)).size);
      refetch();
      showToast({ variant: 'success', message: 'Deep skill unmapped.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Unmap failed.' });
    } finally {
      setDeleting((s) => { const n = new Set(s); n.delete(m.mapping_id); return n; });
    }
  }

  const headerTitle = easyfixerName
    ? `Mapped Deep Skills — ${formatEasyfixerName(easyfixerName)}`
    : 'Mapped Deep Skills';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-4xl w-[min(95vw,920px)] h-[78vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{headerTitle}</DialogTitle>
        </DialogHeader>

        <div className="px-4 pt-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by category, service type, deep skill or option…"
              className="pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Service Category</th>
                <th className="!text-left">Service Type</th>
                <th className="!text-left">Deep Skill</th>
                <th className="!text-left">Option Name</th>
                <th className="!text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="!text-center py-8 text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && error && (
                <tr><td colSpan={5} className="!text-center py-8 text-urgent-strong">{error}</td></tr>
              )}
              {!loading && !error && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="!text-center py-8 text-muted-foreground">
                    {items.length === 0 ? 'No Deep Skills Mapped Yet.' : 'No Mappings Match Your Search.'}
                  </td>
                </tr>
              )}
              {!loading && !error && filtered.map((m) => (
                <tr key={m.mapping_id} className="hover:bg-muted/40">
                  <td className="!text-left">{m.category_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{m.service_type_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left font-medium">{m.deep_skill_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{m.option_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-center">
                    <button
                      type="button"
                      onClick={() => handleUnmap(m)}
                      disabled={deleting.has(m.mapping_id)}
                      title="Unmap this deep skill"
                      aria-label={`Unmap ${m.deep_skill_name ?? 'deep skill'}`}
                      className="inline-flex items-center justify-center size-7 rounded-full text-urgent hover:bg-destructive/15 hover:text-urgent-strong disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {deleting.has(m.mapping_id)
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <X className="size-3.5" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-2 border-t bg-background text-xs text-muted-foreground">
          {filtered.length} of {items.length} mapping{items.length === 1 ? '' : 's'}
          {' · '}{distinctSkillCount} deep skill{distinctSkillCount === 1 ? '' : 's'}
        </div>
      </DialogContent>
    </Dialog>
  );
}
