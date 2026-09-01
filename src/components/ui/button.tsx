import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // No focus ring: the visible blue ring previously painted on every
  // click (mouse OR keyboard) was distracting and the user explicitly
  // asked us to remove it. `focus:outline-none` is also set so the
  // browser's default outline doesn't take over once Tailwind's ring
  // utility is gone. Buttons still have a clear hover state via the
  // variant-specific `hover:bg-*` classes; keyboard users still see the
  // disabled / hover affordances on Tab navigation through those.
  //
  // Typography is fixed at `text-sm font-medium` on the BASE class and
  // intentionally not overridden by any size variant — earlier the `sm`
  // size dropped to `text-xs`, which made rows that mix default-sized
  // and small-sized buttons (e.g. the JobModal footer with Close +
  // Edit + Cancel + Reschedule …) look mismatched. Sizes now only
  // differ by height + horizontal padding; typography stays consistent.
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        /*
         * `hover:bg-destructive-strong`, NOT `hover:bg-destructive/90`.
         *
         * An alpha hover composites the fill against whatever sits behind it,
         * so the SAME class does opposite things per theme: measured, /90 goes
         * lum 0.0936 -> 0.1212 on a white page (it LIGHTENS on hover, and white
         * text drops 7.31 -> 6.13) while darkening to 0.0791 on the dark one. A
         * hover that brightens a destructive button reads as disabled-becoming-
         * active, which is backwards for the one control you want people to
         * hesitate over.
         *
         * destructive-strong is red-700 in BOTH maps, so it darkens either way
         * (lum 0.0558, white text 9.92) and cannot drift with its backdrop. The
         * other 19 destructive fills already use it; this makes the shared
         * Button agree with them.
         */
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive-strong',
        // text-foreground is explicit (not inherited) so outline buttons
        // stay legible when placed inside dark-text-context containers
        // like the dark-slate DialogHeader band — without it, the white
        // bg would render with inherited white text and disappear.
        outline: 'border border-input bg-background text-foreground hover:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-muted',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        // Same `text-sm` as default (no `text-xs` override). `h-8`
        // keeps the button compact for rows of secondary actions; the
        // height differential is what reads "smaller", not the font.
        sm: 'h-8 rounded-md px-3',
        lg: 'h-10 rounded-md px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = 'Button';

export { buttonVariants };
