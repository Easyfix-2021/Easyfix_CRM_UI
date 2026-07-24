'use client';
import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

type LabelProps = React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean };

function renderChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    const m = children.match(/^(.+?)\s*\*\s*$/);
    if (m) return (<>{m[1]} <span className="text-destructive">*</span></>);
  }
  return children;
}

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  LabelProps
>(({ className, required, children, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-sm font-medium leading-none', className)} {...props}>
    {renderChildren(children)}
    {required && <span className="text-destructive ml-0.5">*</span>}
  </LabelPrimitive.Root>
));
Label.displayName = LabelPrimitive.Root.displayName;
