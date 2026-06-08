'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * CsvCellModal — generic "show the full list behind a comma-separated cell".
 *
 * Many list cells (Service Categories, Service Types, deep-skill mappings…)
 * compress a row into "First Item (Id: N) +K". Clicking the cell pops this
 * modal so the operator can see the full set + filter through it without
 * leaving the page.
 *
 * Keep this component small + dumb: it's a presentation layer. The parent
 * does all the id→name mapping and passes the already-resolved list down.
 */
export type CsvCellItem = { id: number | string; name: string };

export function CsvCellModal({
  open,
  onClose,
  title,
  items,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: CsvCellItem[];
}) {
  const [q, setQ] = useState('');
  // Read-only modal — no form input to protect, so guard short-circuits
  // straight to onClose. Wrapping in the shared hook keeps the lint rule
  // happy and matches the canonical Dialog open-change pattern.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  // Filter on name OR id substring — operators often search by either,
  // so a single input that matches either column is the lowest-friction UX.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(needle) ||
        String(it.id).toLowerCase().includes(needle),
    );
  }, [items, q]);

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md w-[min(95vw,500px)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search By Name Or Id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>

          <div className="max-h-[55vh] overflow-y-auto rounded-md border">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No Matches.
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((it) => (
                  <li
                    key={String(it.id)}
                    className="px-3 py-2 text-sm flex items-center justify-between gap-3"
                  >
                    <span className="truncate">{it.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      Id: {it.id}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="text-xs text-muted-foreground text-right">
            {filtered.length} Of {items.length} Shown
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
