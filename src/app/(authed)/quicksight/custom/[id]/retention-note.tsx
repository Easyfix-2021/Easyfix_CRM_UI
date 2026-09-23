'use client';

import { Info } from 'lucide-react';
import { RETENTION_NOTE } from './types';

/*
 * The 30-day retention note — verbatim contract copy. Shown on the report
 * view page, inside the upload dialog, and on the public share page. A
 * single component so the three surfaces can never drift on wording.
 */
export function RetentionNote({ className }: { className?: string }) {
  return (
    <p className={`flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground ${className ?? ''}`}>
      <Info className="mt-0.5 size-4 shrink-0" />
      <span>{RETENTION_NOTE}</span>
    </p>
  );
}
