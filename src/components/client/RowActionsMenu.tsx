'use client';

/*
 * Per-row action menu for the Manage Clients list.
 *
 * Two-button cluster — pencil (primary "Edit") + 3-dot dropdown for
 * the longer tail of actions. Pencil stays a single-click affordance
 * for the most-common operation; the dropdown surfaces less-frequent
 * actions without crowding the table.
 *
 * Menu items split into two kinds:
 *   - **Open at a Specific Tab**: opens the manage modal directly to
 *     the named tab (Services / Rate Cards / Tech Mapping / Billing /
 *     Contacts). Saves an extra click vs. Edit → click tab.
 *   - **Direct action**: bypasses the modal entirely — currently just
 *     Download Rate Card (Xlsx export). Fired inline.
 *
 * Questionnaire + Custom Properties are intentionally NOT in this menu
 * per user direction — they're surface-level config that lives behind
 * the full edit flow.
 *
 * Component is a controlled disclosure (parent owns nothing): clicking
 * the kebab opens the popover; clicking outside or pressing Escape
 * closes it. Each menu item closes the popover before firing its
 * callback so a quick double-click can't open the modal AND fire the
 * direct download in the same gesture.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Pencil, MoreHorizontal, Download, Layers, Calculator, Users, MapPin, Phone, X, RotateCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { invalidateFetch } from '@/lib/hooks';
import { usePopoverPosition } from '@/lib/use-popover-position';

type ClientTab = 'overview' | 'contacts' | 'billing' | 'props' | 'services' | 'rate-cards' | 'tech-mapping' | 'verticals' | 'documents';

type Props = {
  clientId: number;
  clientName: string;
  /* Current active flag — drives the deactivate (X) vs reactivate
     (RotateCw) toggle button. */
  isActive: boolean;
  /* Whether the operator has isClientEdit. If false, ONLY the
     read-only quick actions render (Download Rate Card stays visible
     because it's a read action). */
  canEdit: boolean;
  /* Opens the manage modal at a specific tab. The parent (clients
     page) is responsible for setting both `editingId` AND
     `editingTab` state before mounting <ClientDetailDialog>. */
  onOpen: (tab: ClientTab) => void;
  /* Fires after a successful status toggle so the parent can refetch
     the list (the active/inactive flag drives the row's visibility
     under the default filter). */
  onStatusChanged?: () => void;
};

type MenuItem = {
  icon: React.ReactNode;
  label: string;
  /* If `onClick` is provided we run it; if `tab` is provided we
     delegate to onOpen(tab). Mutually exclusive. */
  onClick?: () => void;
  tab?: ClientTab;
  /* Read-only items stay enabled for users without isClientEdit. */
  readOnly?: boolean;
};

export function RowActionsMenu({ clientId, clientName, isActive, canEdit, onOpen, onStatusChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const { style } = usePopoverPosition(open, triggerRef, popRef, {
    matchTriggerWidth: false,
    minHeight: 180,
    maxHeight: 320,
  });

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /*
   * Toggle the client's active flag. Active → Inactive uses a
   * destructive confirm because the row drops out of the default list
   * filter. Inactive → Active is a single-click action (cheaper to
   * undo + matches how legacy CRM handled it).
   */
  async function toggleStatus() {
    if (toggling) return;
    const nextStatus = isActive ? 0 : 1;
    if (isActive) {
      const ok = await confirm({
        title: 'Deactivate Client',
        description: `Mark "${clientName}" as inactive? The row hides from the default list; toggle "Include Inactive" to see it again.`,
        confirmLabel: 'Deactivate',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      await api.put(`/admin/clients/${clientId}`, { clientStatus: nextStatus } as never);
      invalidateFetch((k) => k.startsWith('/admin/clients'));
      showToast({
        variant: 'success',
        message: nextStatus === 1 ? 'Client reactivated.' : 'Client deactivated.',
      });
      onStatusChanged?.();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Status toggle failed.' });
    } finally { setToggling(false); }
  }

  async function downloadRateCard() {
    setOpen(false);
    try {
      const safeName = clientName.replace(/[^a-z0-9_-]+/gi, '_') || `client-${clientId}`;
      await downloadXlsx({
        url: `/admin/clients/${clientId}/rate-cards/download`,
        filename: `rate-cards-${safeName}.xlsx`,
      });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' });
    }
  }

  // Menu definition — split into "tab jumps" + "direct actions" for
  // readability. The render is a single flat list with optional
  // dividers.
  const items: (MenuItem | 'divider')[] = [
    { icon: <Layers     className="size-3.5" />, label: 'Client Services',   tab: 'services' },
    { icon: <Calculator className="size-3.5" />, label: 'Rate Cards',        tab: 'rate-cards' },
    { icon: <Users      className="size-3.5" />, label: 'Easyfixer Mapping', tab: 'tech-mapping' },
    { icon: <MapPin     className="size-3.5" />, label: 'Billing',           tab: 'billing' },
    { icon: <Phone      className="size-3.5" />, label: 'Contacts',          tab: 'contacts' },
    'divider',
    { icon: <Download   className="size-3.5" />, label: 'Download Rate Card', onClick: downloadRateCard, readOnly: true },
  ];

  function fire(item: MenuItem) {
    setOpen(false);
    if (item.onClick) item.onClick();
    else if (item.tab) onOpen(item.tab);
  }

  // Tight icon-button row — matches the inline action style on
  // Unconfirmed Orders (px-1.5, no gap between the two icons). The
  // operator's eye reads the two buttons as ONE compact cluster.
  return (
    <div className="inline-flex items-center" onClick={(e) => e.stopPropagation()}>
      {canEdit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpen('overview')}
          title="Edit Client"
          className="size-7 p-0"
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      {canEdit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={toggleStatus}
          disabled={toggling}
          title={isActive ? 'Deactivate Client' : 'Reactivate Client'}
          className={
            'size-7 p-0 ' +
            (isActive
              ? 'text-red-500 hover:text-red-600 hover:bg-red-50'
              : 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50')
          }
        >
          {isActive ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
        </Button>
      )}
      <Button
        ref={triggerRef as React.RefObject<HTMLButtonElement>}
        size="sm"
        variant="ghost"
        onClick={() => setOpen((o) => !o)}
        title="More Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="size-7 p-0"
      >
        <MoreHorizontal className="size-3.5" />
      </Button>

      {open && typeof document !== 'undefined' && createPortal(
        /*
         * Solid background — `bg-popover` resolves to a CSS variable
         * that isn't reliably set in this theme, leaving the dropdown
         * see-through (the row below shows through and the menu reads
         * as "spaced out"). Explicit `bg-white` (+ shadow) guarantees
         * opaque rendering.
         */
        <div
          ref={popRef}
          role="menu"
          className="bg-white border border-slate-200 rounded-md shadow-xl overflow-hidden z-50 min-w-[200px] py-1"
          style={style}
        >
          {items.map((item, idx) => {
            if (item === 'divider') {
              return <div key={`d-${idx}`} className="my-1 border-t border-slate-100" />;
            }
            const disabled = !item.readOnly && !canEdit;
            return (
              <button
                key={item.label}
                role="menuitem"
                disabled={disabled}
                onClick={() => fire(item)}
                className={
                  'w-full text-left text-sm px-3 py-1.5 flex items-center gap-2 ' +
                  (disabled
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-slate-50 cursor-pointer')
                }
                title={disabled ? 'You do not have isClientEdit permission' : undefined}
              >
                <span className="text-muted-foreground">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
