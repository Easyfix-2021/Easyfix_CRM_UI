'use client';

import { Pencil, Link as LinkIcon, Receipt, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * EasyfixerActionMenu — 4-icon inline action group for the Manage
 * Easyfixers row Action cell. Mirrors the legacy CRM's row-level
 * affordances:
 *
 *   1. Update Easyfixer  → edit modal      (Pencil)
 *   2. Client Mapping    → mapped-clients  (Link)
 *   3. Transaction List  → transactions    (Receipt)
 *   4. Assessment        → coming-soon     (ClipboardList)
 *
 * Each button is a 24×24 hit target (down from 28×28) with NO hover
 * background — only the icon colour shifts on hover. Result: icons sit
 * tightly together with no "boxy" padding around them. The native
 * `title` attribute supplies the tooltip.
 *
 * The Pencil (Update Easyfixer) icon is gated by `canEdit` — roles
 * without the `isEasyfixerEdit` action permission don't see it.
 * Operators on those roles still see the other 3 icons (read-only:
 * Client Mapping list, Transaction list, Assessment placeholder).
 */
type Easyfixer = { efr_id: number; efr_name: string };

export function EasyfixerActionMenu({
  easyfixer,
  onEdit,
  onClientMapping,
  onTransactions,
  onAssessment,
  canEdit = true,
}: {
  easyfixer: Easyfixer;
  onEdit: () => void;
  onClientMapping: () => void;
  onTransactions: () => void;
  onAssessment: () => void;
  /* Some viewers (read-only roles) shouldn't see Edit; pass false to hide. */
  canEdit?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-0.5" role="group" aria-label={`Actions for ${easyfixer.efr_name}`}>
      {canEdit && (
        <IconButton title="Update Easyfixer" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </IconButton>
      )}
      <IconButton title="Client Mapping" onClick={onClientMapping}>
        <LinkIcon className="h-4 w-4" />
      </IconButton>
      <IconButton title="Transaction List" onClick={onTransactions}>
        <Receipt className="h-4 w-4" />
      </IconButton>
      <IconButton title="Assessment" onClick={onAssessment}>
        <ClipboardList className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center justify-center h-6 w-6 rounded',
        'text-muted-foreground hover:text-primary',
        'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
    >
      {children}
    </button>
  );
}
