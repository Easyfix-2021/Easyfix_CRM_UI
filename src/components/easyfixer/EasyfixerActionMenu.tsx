'use client';

import { Pencil, Link as LinkIcon, Receipt, ClipboardList, Send, Loader2, ClipboardCopy, MoreVertical, History, Smartphone, Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

/*
 * EasyfixerActionMenu — kebab (3-dot) dropdown menu for the Manage
 * Easyfixers row Action cell. Replaces the legacy horizontal 6-icon strip
 * with a single MoreVertical trigger that opens a portaled dropdown of
 * labeled action items. Existing actions plus canonical lifecycle management:
 *
 *   Read-only group:
 *     1. Edit Easyfixer          → edit modal       (Pencil)         [gated by canEdit]
 *     2. Client Mapping          → mapped-clients   (Link)
 *     3. Transactions            → transactions     (Receipt)
 *     4. Assessment              → coming-soon      (ClipboardList)
 *   --- separator ---
 *   Write group:
 *     5. Send Profile Update Link → magic-link send  (Send)           [gated by canSend; isSending → spinner+disable]
 *     6. Copy Dev URL            → mint + clipboard (ClipboardCopy)  [gated by canCopyDevUrl; isCopyingDevUrl → spinner+disable]
 *     7. Status & History         → lifecycle dialog (History)        [gated by canManageLifecycle]
 *     8. Update Mobile Number     → mobile dialog    (Smartphone)     [gated by canUpdateMobile]
 *     9. Update Bank Details      → bank OTP dialog  (Landmark)       [gated by canUpdateBank]
 *
 * The Edit action is gated by `canEdit` — roles without
 * `isEasyfixerEdit` action permission don't see it. Read-only roles
 * still get Client Mapping, Transactions, Assessment.
 *
 * Live Location is NOT in this menu — it lives as a sibling location-pin
 * IconButton next to the trigger (see easyfixers/page.tsx). Opening it from
 * a DropdownMenuItem race'd the menu's close pointer/focus event against the
 * just-mounted Dialog (instant-dismiss); a plain button is race-free.
 *
 * The Send action is gated by `canSend` (`isProfileUpdateLinkSend`
 * permission). While a send is in flight (`isSending`), the icon swaps
 * to a spinning Loader2 and the item is disabled to prevent double-fires.
 *
 * The Copy Dev URL action is shown ONLY in non-production builds via the
 * `canCopyDevUrl` prop the parent sets from
 * `process.env.NODE_ENV !== 'production' && hasIsProfileUpdateLinkSend`.
 * Production bundles strip the override path through Next's static
 * dead-code elimination, so the item literally doesn't ship in prod.
 * Clicking calls the dev-url endpoint and copies the response URL to the
 * clipboard — lets engineers paste the link into a mobile-viewport tab
 * without an actual WhatsApp send. While the request is in flight
 * (`isCopyingDevUrl`), the icon swaps to a Loader2 spinner.
 *
 * Trigger is a 28×28 (h-7 w-7) icon button with MoreVertical. Content is
 * portaled and aligned to the trigger's end edge, so it overflows the
 * row without clipping. Each item is a flex row: icon (16×16) + label.
 */
type Easyfixer = { efr_id: number; efr_name: string };

export function EasyfixerActionMenu({
  easyfixer,
  onEdit,
  onClientMapping,
  onTransactions,
  onAssessment,
  onSendProfileUpdateLink,
  onCopyDevUrl,
  onLifecycle,
  onUpdateMobile,
  onUpdateBank,
  canEdit = true,
  canSend = false,
  canCopyDevUrl = false,
  canManageLifecycle = false,
  canUpdateMobile = false,
  canUpdateBank = false,
  isSending = false,
  isCopyingDevUrl = false,
}: {
  easyfixer: Easyfixer;
  onEdit: () => void;
  onClientMapping: () => void;
  onTransactions: () => void;
  onAssessment: () => void;
  /* Opens canonical lifecycle status + history; only shown when permitted. */
  onLifecycle?: () => void;
  /* Gate for lifecycle management (parent passes isEdit). */
  canManageLifecycle?: boolean;
  /* Opens the change-mobile dialog. The mobile is the technician's LOGIN
   * identity, so this is gated on its own action permission rather than
   * riding along with the general edit right. */
  onUpdateMobile?: () => void;
  /* Opens the OTP-gated change-bank-details dialog. */
  onUpdateBank?: () => void;
  /* Roles without `isEasyfixerMobileUpdate` shouldn't see the mobile item. */
  canUpdateMobile?: boolean;
  /* Roles without `isEasyfixerBankUpdate` shouldn't see the bank item. */
  canUpdateBank?: boolean;
  /* Click handler for the Send Profile Update Link action; only invoked
   * when `canSend` is true and `isSending` is false. */
  onSendProfileUpdateLink?: () => void;
  /* Click handler for the Copy Dev URL action; only invoked when
   * `canCopyDevUrl` is true and `isCopyingDevUrl` is false. */
  onCopyDevUrl?: () => void;
  /* Some viewers (read-only roles) shouldn't see Edit; pass false to hide. */
  canEdit?: boolean;
  /* Roles without `isProfileUpdateLinkSend` shouldn't see the Send item. */
  canSend?: boolean;
  /* Non-prod-only affordance — parent passes
   * `process.env.NODE_ENV !== 'production' && hasPermission`. Hidden in
   * prod via static dead-code elimination. */
  canCopyDevUrl?: boolean;
  /* While a send-link request is in flight, show a spinner + disable the
   * item so rapid double-clicks don't fire two POSTs. */
  isSending?: boolean;
  /* While a dev-url request is in flight, show a spinner + disable the
   * item so rapid double-clicks don't double-mint. */
  isCopyingDevUrl?: boolean;
}) {
  const hasWriteGroup = (canSend && onSendProfileUpdateLink)
    || (canCopyDevUrl && onCopyDevUrl)
    || (canManageLifecycle && onLifecycle)
    || (canUpdateMobile && onUpdateMobile)
    || (canUpdateBank && onUpdateBank);
  return (
    // modal={false}: Radix's default modal dropdown locks document.body
    // pointer-events while open/closing; that lock races a Dialog opened from
    // an item's onClick (Send Profile Update Link etc.) so the just-mounted
    // dialog can't take interaction / gets dismissed. Disabling modal removes
    // the lock — combined with onCloseAutoFocus (below) + the parent's
    // setTimeout-deferred open, the menu→dialog handoff is reliable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded',
            /* (b) PAIRED FOREGROUND on the hover scope. The hover surface
             * --ink-100 inverts (90.59% under :root, 23.33% under .dark) but
             * the old `hover:text-primary` does not — --primary is
             * 355.5 68.97% 45.49% in BOTH blocks — so the kebab measured
             *
             *   light  #C4212B on rgb(226,230,233)   ≈ 5.3:1 ✓
             *   dark   #C4212B on rgb(55,59,65)      ≈ 1.7:1 ✗
             *
             * a mid red sitting on dark slate: the icon all but vanished the
             * moment you hovered it in dark mode. Fixed by letting the label
             * travel with its surface — --brand-700 is the same 355° brand red
             * and inverts the OTHER way (30.39% → 91.76%), so it lands deep on
             * the light grey and pale on the dark slate: ≈6.4:1 light, ≈9.9:1
             * dark. Same swap the sibling row-action kebab in
             * settings/zones/page.tsx already ships.
             *
             * Light theme is NOT byte-identical here — that is (a)'s
             * requirement, and there is no stable token sitting at ink-100's
             * 90.59%. The hover red deepens 45.49% → 30.39%; same hue, still
             * on-palette, and now matching the zones kebab. The RESTING colour
             * stays `text-muted-foreground`, which is itself inverting
             * (39.02% → 63.33%) and is the app-wide resting tone for a row
             * action — changing it here alone would put this one icon
             * permanently off-palette. Measured resting on the row's bg-card
             * plate: light 6.08:1, dark 4.33:1 (#9aa1a9 on #363b41). This is a
             * bare glyph with no text label, so the bar is WCAG 1.4.11's 3.0
             * for non-text contrast, not 4.5 — 4.33 clears it in both themes.
             * Left as-is deliberately; do not "fix" it to 4.5 here alone. */
            'text-muted-foreground hover:bg-ink-100 hover:text-brand-700',
            'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          )}
          aria-label={`Actions for ${easyfixer.efr_name}`}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      {/* Prevent Radix's focus-return-to-trigger on close: that focus shuffle
          races the Dialog opened from an item's onClick (Send Profile Update
          Link etc.), and the just-mounted Dialog's DismissableLayer reads it as
          a click-outside → instant dismiss ("nothing happens"). Suppressing the
          auto-focus removes that half of the race; the parent also defers the
          open via setTimeout(0). */}
      <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        {canEdit && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit Easyfixer
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onClientMapping}>
          <LinkIcon className="mr-2 h-4 w-4" />
          Client Mapping
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onTransactions}>
          <Receipt className="mr-2 h-4 w-4" />
          Transactions
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAssessment}>
          <ClipboardList className="mr-2 h-4 w-4" />
          Assessment
        </DropdownMenuItem>
        {hasWriteGroup && <DropdownMenuSeparator />}
        {canSend && onSendProfileUpdateLink && (
          <DropdownMenuItem
            onClick={onSendProfileUpdateLink}
            disabled={isSending}
          >
            {isSending
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Send className="mr-2 h-4 w-4" />}
            {isSending ? 'Sending…' : 'Send Profile Update Link'}
          </DropdownMenuItem>
        )}
        {canCopyDevUrl && onCopyDevUrl && (
          <DropdownMenuItem
            onClick={onCopyDevUrl}
            disabled={isCopyingDevUrl}
          >
            {isCopyingDevUrl
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <ClipboardCopy className="mr-2 h-4 w-4" />}
            {isCopyingDevUrl ? 'Copying…' : 'Copy Dev URL'}
            <span className="ml-auto text-xs text-muted-foreground">(dev)</span>
          </DropdownMenuItem>
        )}
        {canManageLifecycle && onLifecycle && (
          <DropdownMenuItem onClick={onLifecycle}>
            <History className="mr-2 h-4 w-4 text-gold-strong" />
            Status &amp; History
          </DropdownMenuItem>
        )}
        {canUpdateMobile && onUpdateMobile && (
          <DropdownMenuItem onClick={onUpdateMobile}>
            {/* DropdownMenuContent paints bg-popover, which inverts hard
                (100% → 23.33%) while --primary is fixed at 45.49% in both
                blocks: this glyph measured 1.96:1 on #363b41, the worst in the
                menu. Its two siblings are already safe because -strong tokens
                travel with the popover (text-gold-strong above,
                text-success-strong below) — text-primary was the outlier.
                `dark:text-brand-700` repaints only the dark side (--brand-700
                is 91.76% there); light is byte-identical, a `dark:` variant
                cannot apply under :root. Measured: light 5.77 → 5.77, dark
                1.96 → 8.85:1. */}
            <Smartphone className="mr-2 h-4 w-4 text-primary dark:text-brand-700" />
            Update Mobile Number
          </DropdownMenuItem>
        )}
        {canUpdateBank && onUpdateBank && (
          <DropdownMenuItem onClick={onUpdateBank}>
            <Landmark className="mr-2 h-4 w-4 text-success-strong" />
            Update Bank Details
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
