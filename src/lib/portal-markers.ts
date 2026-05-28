/*
 * Shared portal markers (2026-05-28).
 *
 * Several UI primitives in this codebase render their floating /
 * detached content via React Portal — popovers from SearchSelect /
 * SearchMultiSelect, toasts from ToastHost, nested confirm dialogs,
 * etc. Because these portals attach to `document.body`, they are
 * DOM SIBLINGS of any open Radix `<Dialog>` rather than descendants.
 *
 * Radix Dialog detects "user clicked outside the modal" via the
 * pointer's actual target — so a click on a portaled SearchSelect
 * option, a toast surface, or a nested confirm dialog counts as
 * "outside" the parent Dialog and triggers its dismiss/close path.
 * That's almost never what we want.
 *
 * The Dialog component's `onPointerDownOutside` /
 * `onInteractOutside` guards walk up the click target's ancestor
 * chain looking for known portal markers; finding one preventDefaults
 * the dismiss so the parent Dialog stays mounted.
 *
 * This module centralises the marker names so:
 *   - the producer (SearchSelect, ToastHost, etc.) and the consumer
 *     (Dialog) cannot drift apart silently on a rename;
 *   - future portals add themselves by importing a constant rather
 *     than copy-pasting a magic string;
 *   - one place documents the contract.
 *
 * Usage producer side:
 *   <div {...PORTAL_POPOVER_ATTR}>...popover content...</div>
 *
 * Usage consumer side (in Dialog's outside-click guard):
 *   if (target.closest(PORTAL_POPOVER_SELECTOR)) e.preventDefault();
 */

/** SearchSelect / SearchMultiSelect popover lists. */
export const PORTAL_POPOVER_MARKER = 'data-portal-popover';
export const PORTAL_POPOVER_SELECTOR = `[${PORTAL_POPOVER_MARKER}]`;
export const PORTAL_POPOVER_ATTR = { [PORTAL_POPOVER_MARKER]: '' } as const;

/** Toast container rendered by ToastHost (src/components/ui/toast.tsx). */
export const TOAST_HOST_MARKER = 'data-toast-host';
export const TOAST_HOST_SELECTOR = `[${TOAST_HOST_MARKER}]`;
export const TOAST_HOST_ATTR = { [TOAST_HOST_MARKER]: '' } as const;

/**
 * Full list consumed by Dialog's outside-click guards. Keep in sync
 * when adding a new marker above — Dialog reads from this single
 * source of truth so a new portal kind only needs a single export
 * here to be honoured.
 */
export const DIALOG_IGNORED_PORTAL_SELECTORS: ReadonlyArray<string> = [
  PORTAL_POPOVER_SELECTOR,
  TOAST_HOST_SELECTOR,
];
