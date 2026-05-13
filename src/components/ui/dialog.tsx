'use client';
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out', className)}
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
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg sm:rounded-lg',
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
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/*
 * Header gets a bottom border so the header is visually separated from
 * the body. Uses negative horizontal margin + matching padding so the
 * border-b extends edge-to-edge of the modal (DialogContent retains its
 * default p-6 — we couldn't move padding wholesale without breaking
 * every existing modal call site). `-mt-6 + pt-6` reclaims the
 * DialogContent's top padding so the header text sits where it was
 * before, just now with the separator line below it.
 */
export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-1.5 text-center sm:text-left',
      '-mx-6 -mt-6 px-6 pt-5 pb-3 mb-1 border-b',
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
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
