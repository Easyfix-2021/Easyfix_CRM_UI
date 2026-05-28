'use client';
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DIALOG_IGNORED_PORTAL_SELECTORS } from '@/lib/portal-markers';

/*
 * Dialog wrapper — defaults `modal={false}` so Radix's `FocusScope`
 * doesn't trap focus inside the dialog content.
 *
 * Why this matters (2026-05-18 — after five failed focus-guard
 * iterations):
 *   Every dropdown in our app uses a body-portaled popover for its
 *   option list (escapes ancestor overflow clips). When the popover
 *   opens INSIDE a Radix modal Dialog, FocusScope sees the popover
 *   input as "outside the scope" and immediately steals focus back
 *   to the dialog content. No event-listener interception works
 *   reliably because FocusScope uses an internal scope-recheck
 *   mechanism, not a plain event listener. We tried staggered
 *   retries, intervals, rAF tight loops, and a focusin trigger-wrap
 *   detector — each failed in different races. The only fix that
 *   works for the cause (not the symptom) is to disable the trap.
 *
 *   Trade-off: `modal={false}` also drops Radix's `react-remove-scroll`
 *   body lock. Background CAN scroll while a modal is open. The
 *   visual overlay still discourages background interaction; click-
 *   outside-to-close, Esc-to-close, animations, and DismissableLayer
 *   pointer detection all keep working.
 *
 *   Callers that genuinely need a focus-trapped modal (rare — usually
 *   only fully-blocking confirmation flows) can opt back in:
 *     <Dialog modal={true}>...</Dialog>
 *   But before doing so, make sure the dialog has NO nested portaled
 *   popovers — otherwise typing in those popovers will break again.
 */
type DialogRootProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>;
export function Dialog({ modal = false, ...props }: DialogRootProps) {
  return <DialogPrimitive.Root modal={modal} {...props} />;
}
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    /*
     * Layered backdrop:
     *   - `bg-black/55` — slightly softer than 60% so content underneath
     *     remains readable but clearly inactive.
     *   - `backdrop-blur-[2px]` — subtle frost so the page behind feels
     *     visually pushed back without distortion. Heavier blurs
     *     (`backdrop-blur-sm` and above) start to read as a Mac/iOS
     *     trick and don't match the Metronic palette; 2px is the
     *     sweet spot.
     *   - `data-[state=open]:animate-in fade-in-0` — fades in over
     *     200ms when the dialog mounts; matches the content's
     *     duration so they enter as one motion.
     */
    className={cn(
      // Strong dim (75%) + 4px blur so busy backgrounds (dashboard
      // cards, data tables) clearly recede when a modal opens.
      'fixed inset-0 z-50 bg-slate-900/75 backdrop-blur-[4px]',
      // Force pointer-events ON regardless of Radix's modal mode.
      // Our Dialog defaults to `modal={false}` (so SearchSelect popovers
      // inside dialogs work — see Dialog wrapper above). Radix would
      // normally set `pointer-events: none` on the overlay when modal is
      // false, letting background clicks pass through. We do NOT want
      // that: nested dialogs (e.g. JobOutcomeDialog opened from inside
      // JobModal) MUST block clicks on the parent's buttons. The `!`
      // Tailwind important modifier overrides Radix's inline style.
      // Popovers portalled at higher z-index still receive their own
      // clicks, so this doesn't break the search-select popover trick
      // that motivated `modal={false}` in the first place.
      '!pointer-events-auto',
      'data-[state=open]:animate-in data-[state=open]:fade-in-0',
      'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
      'duration-200',
      className,
    )}
    // Note: no manual `onPointerDown` handler here — Radix's own
    // outside-click detection (via Content's onInteractOutside) needs
    // the pointer event to bubble naturally so click-outside-to-close
    // still works. The CSS class alone is sufficient to block clicks
    // reaching background content.
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/*
 * `hideClose` removes the top-right X icon. Set it on modals that already
 * provide a footer Close button — two close affordances on the same dialog
 * look cluttered and create a "which one?" micro-decision every time. Small
 * confirmation dialogs without a footer action row should leave it on
 * (default true corner-X behaviour) so Escape and the click target both work.
 */
type DialogContentExtraProps = { hideClose?: boolean };

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & DialogContentExtraProps
>(({ className, children, hideClose, onInteractOutside, onPointerDownOutside, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    {/*
     * Manual click-blocking overlay — separate from Radix's
     * DialogOverlay above. We render it as a sibling of DialogContent
     * so it ALWAYS exists in the DOM regardless of Radix's modal-mode
     * decisions. With `modal={false}` Radix tends to omit / disable
     * its own overlay (`pointer-events: none` or skipped entirely),
     * which is why a CSS `!pointer-events-auto` override on
     * DialogOverlay isn't reliable. This sibling guarantees a real
     * fullscreen click-absorber exists.
     *
     * Layered z-index:
     *   z-50 = Radix's DialogOverlay (visual dim; behavior toggled by
     *          modal prop)
     *   z-50 = this manual blocker (always click-capturing)
     *   z-50 = DialogContent (above both, accepts user interaction)
     *
     * All three share z-50 so DOM source order decides stacking.
     * Source order is overlay → blocker → content → blocker stacks
     * above the dim layer but below the modal content. Background
     * page surfaces (z<50) lose to all three. Nested dialogs render
     * their own portal trio at the same z-50 but later in source
     * order, so each new dialog visually + interactively layers on
     * top of the previous.
     *
     * Outside-click semantics: a click on this blocker should still
     * close the dialog (like Radix's overlay normally does). We
     * dispatch a click on the data-radix-dismissable surface via
     * Radix's own outside-click detection — actually simpler than
     * that, just call the onPointerDownOutside callback. But for
     * safety/composition with `onInteractOutside`'s nested-dialog
     * guards above, we let the click on this blocker do nothing —
     * the operator dismisses via the modal's own X / Cancel button.
     * That's the safer default; "click outside to close" can be a
     * footgun for forms-with-unsaved-changes anyway.
     */}
    <div
      data-radix-manual-overlay-blocker=""
      className={cn(
        'fixed inset-0 z-50 pointer-events-auto',
        // Visual dim — Radix's DialogOverlay sibling above renders but
        // typically doesn't paint when modal=false (its bg + blur classes
        // don't apply reliably). The manual blocker becomes the SOLE
        // reliable surface for both click-capture and visual dim of the
        // background. Same `bg-slate-900/75 backdrop-blur-[4px]` as the
        // intended DialogOverlay styling so the look matches what was
        // designed for modal=true dialogs.
        'bg-slate-900/75 backdrop-blur-[4px]',
        // Match DialogOverlay's open/close fade so the manual blocker
        // animates in tandem with the dialog content instead of popping
        // in/out abruptly.
        'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        'duration-200',
      )}
      aria-hidden="true"
    />
    <DialogPrimitive.Content
      ref={ref}
      /*
       * Radix's `DismissableLayer` treats any click whose target isn't
       * a DOM descendant of <Content> as "outside" — including clicks
       * on PORTALED popovers (SearchSelect, SearchMultiSelect, …)
       * which live as body-level siblings of <Content>. Without this
       * override, every click on a popover option closes the dialog
       * or gets eaten before reaching the option's onClick.
       *
       * The fix: portaled popovers carry `data-portal-popover` (see
       * SearchSelect / SearchMultiSelect). When the outside-interaction
       * target sits inside one of those, we `preventDefault()` to
       * keep the dialog open AND let the underlying click propagate
       * to the option handler normally.
       *
       * We override BOTH events because Radix fires `onPointerDownOutside`
       * for pointer/mouse and `onInteractOutside` as a superset (also
       * includes focus). Letting either through closes the dialog.
       */
      onPointerDownOutside={(e) => {
        // Radix's CustomEvent.target points at the layer (not the
        // original click target). The actual target is in
        // `detail.originalEvent.target`. Always read THAT, not e.target.
        const original = (e as unknown as { detail?: { originalEvent?: Event } })
          .detail?.originalEvent?.target as Element | null;
        // Two kinds of "outside click" we want to IGNORE:
        //   1. Click landed inside one of our portaled popovers
        //      (SearchSelect / SearchMultiSelect option list).
        //   2. Click landed inside ANOTHER Radix dialog (e.g. the
        //      "Discard changes?" confirm that opens on Cancel).
        //      With `modal={false}` the parent dialog's
        //      DismissableLayer now sees these clicks as outside its
        //      own content — without this guard, clicking a button
        //      in a nested confirm dialog would close the parent.
        if (
          // Sibling portals we explicitly want to ignore: SearchSelect
          // option lists, toast surfaces, etc. Source of truth lives in
          // src/lib/portal-markers.ts so the producer + consumer
          // cannot drift apart on a rename.
          DIALOG_IGNORED_PORTAL_SELECTORS.some((sel) => original?.closest?.(sel)) ||
          original?.closest?.('[role="dialog"]') ||
          original?.closest?.('[role="alertdialog"]')
        ) {
          e.preventDefault();
          return;
        }
        onPointerDownOutside?.(e);
      }}
      onInteractOutside={(e) => {
        const original = (e as unknown as { detail?: { originalEvent?: Event } })
          .detail?.originalEvent?.target as Element | null;
        if (
          // Sibling portals we explicitly want to ignore: SearchSelect
          // option lists, toast surfaces, etc. Source of truth lives in
          // src/lib/portal-markers.ts so the producer + consumer
          // cannot drift apart on a rename.
          DIALOG_IGNORED_PORTAL_SELECTORS.some((sel) => original?.closest?.(sel)) ||
          original?.closest?.('[role="dialog"]') ||
          original?.closest?.('[role="alertdialog"]')
        ) {
          e.preventDefault();
          return;
        }
        onInteractOutside?.(e);
      }}
      className={cn(
        /*
         * Position + box. `fixed` centering via top/left 50% +
         * translate-50%; max-width + grid container; 24px padding;
         * rounded corners on sm+ viewports (mobile gets full-bleed).
         */
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 sm:rounded-xl',
        /*
         * 3D surface (2026-05-18):
         *   - Layered shadow: outer `shadow-2xl` for depth + an inner
         *     `ring-1 ring-black/5` creates a subtle high-light edge.
         *     Together they give the modal a "lifted" feel without
         *     the cartoon-y bevel of harder shadows.
         *   - `border border-slate-200/80` — soft slate border so the
         *     edge reads in light backgrounds; combines with the ring
         *     for a layered border feel.
         *   - `bg-background` keeps the panel surface neutral.
         */
        'border border-slate-200/80 bg-background',
        'shadow-2xl ring-1 ring-black/5',
        // overflow-hidden so the dark-slate DialogHeader band clips to
        // the panel's rounded corners (the header uses `-mx-6 -mt-6` to
        // sit edge-to-edge; without clipping the band's square top-edge
        // pokes past the rounded container).
        'p-6 overflow-hidden',
        /*
         * Open/close animation. Combines fade + zoom + a tiny
         * downward slide so the dialog feels like it "lands" from
         * just above the centre. 220ms is the snappy-but-noticeable
         * sweet spot — fast enough not to feel laggy, slow enough
         * to read as intentional motion.
         */
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-[2%]',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-top-[2%]',
        'duration-200',
        // Suppresses the default browser focus outline that Radix's
        // auto-focus-on-open paints around the modal — was rendering as
        // a thick blue border on Chromium. Dialog is still announced via
        // role=dialog so a11y stays intact.
        'focus:outline-none focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        // Visible-on-slate close: tinted background pill so the X reads
        // against the dark band (was disappearing as a low-contrast glyph
        // before). Hover bumps to white/15 for clear feedback.
        <DialogPrimitive.Close
          className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white/85 hover:bg-white/20 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/*
 * Header band — Metronic-style dark slate gradient + thin sky accent
 * underline so the band feels lifted and on-brand rather than flat.
 *
 * Layout: negative horizontal/top margins so the coloured band runs
 * edge-to-edge of the modal (DialogContent retains its default p-6 —
 * we couldn't move padding wholesale without breaking every existing
 * modal call site). `-mt-6 + py-3.5` reclaims the DialogContent's top
 * padding so the band sits flush with the top.
 *
 * Visual layering:
 *   - `bg-gradient-to-r from-sidebar via-sidebar-accent to-sidebar`
 *     gives the band a subtle horizontal sheen so the header reads as
 *     a "lit surface" rather than a flat fill.
 *   - `shadow-[inset_0_-2px_0_0_theme(colors.sky.500/0.55)]` paints a
 *     2px sky-500 accent line at the bottom of the band — the
 *     EasyFix-blue tie-in without using an extra DOM node.
 *   - `text-white` for the title region; `DialogDescription` softens to
 *     a slate-200/75 sub-tone for hierarchy.
 *
 * If a call site uses `DialogContent` with `!p-0`, the call site MUST
 * override the negative margins (`!mx-0 !mt-0`) — see [JobModal.tsx]
 * for the standard pattern.
 */
export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-1 text-left',
      '-mx-6 -mt-6 px-6 py-4 mb-5',
      // Pronounced slate gradient (slate-900 → slate-700 → slate-900)
      // gives the band visible depth instead of a flat fill.
      'bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900 text-white',
      // 3px sky-500 underline drawn with a literal rgba inset shadow —
      // Tailwind's `theme()`-with-opacity syntax doesn't reliably
      // resolve in arbitrary values, so we spell the colour out.
      'shadow-[inset_0_-3px_0_0_rgba(14,165,233,0.85)]',
      className,
    )}
    {...props}
  />
);

/*
 * Symmetric footer separator. Same -mx-6 / negative-bottom-margin trick
 * extends the top border edge-to-edge. Caller renders the action buttons
 * as children; the flex layout right-aligns them with a consistent gap.
 * Opt-in: existing modals that hand-roll their footer can switch over
 * when they're next touched.
 */
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex items-center justify-end gap-2',
      '-mx-6 -mb-6 px-6 pt-3 pb-4 mt-1 border-t bg-background',
      className,
    )}
    {...props}
  />
);

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  // Crisp white title; tighter tracking + leading-tight so multi-word
  // titles ("Reassign Technician · Job #123") sit on one line cleanly.
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[15px] font-semibold leading-tight tracking-tight text-white', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  // Soft slate-tint sub-line under the title for context (date range,
  // job reference, etc.). Readable but clearly secondary.
  <DialogPrimitive.Description ref={ref} className={cn('text-[12px] text-slate-300/85', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
