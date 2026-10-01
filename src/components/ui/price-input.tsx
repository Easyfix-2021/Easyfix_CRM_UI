import * as React from 'react';
import { Input } from '@/components/ui/input';

/**
 * Rupee amount field: a ₹ adornment over the shared number `Input`.
 *
 * Prop-transparent on purpose — callers own `value`/`onChange`, so both
 * string-state forms (Monthly Revenue) and number|null state (material
 * prices) use it unchanged. Defaults to a non-negative paise-precision
 * amount; pass `step={1}` for whole rupees. `className` sizes the wrapper.
 *
 * Wheel-scroll over a focused field is neutralised app-wide by
 * NUMBER_WHEEL_GUARD_SCRIPT in the root layout — no per-field onWheel.
 */
export const PriceInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => (
    <div className={`relative ${className ?? ''}`}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">₹</span>
      <Input ref={ref} type="number" min={0} step="0.01" inputMode="decimal" {...props} className="pl-6" />
    </div>
  )
);
PriceInput.displayName = 'PriceInput';
