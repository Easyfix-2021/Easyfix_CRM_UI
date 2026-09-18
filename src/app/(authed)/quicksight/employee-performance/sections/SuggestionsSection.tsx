'use client';

/*
 * 10. Suggestions / Action Points (dashboard #suggest). Titles, wording and
 * tone come from the server (summary.suggestions). The dashboard's coloured
 * left stripe maps to the brand tokens: crit → urgent, att → warning,
 * pos → success.
 */

import { CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { SuggestionTone } from '../types';
import { SectionCard, emptyTableText, type SummaryProps } from './shared';

const TONE: Record<SuggestionTone, { stripe: string; icon: LucideIcon; iconClass: string; label: string }> = {
  crit: { stripe: 'border-l-urgent', icon: TriangleAlert, iconClass: 'text-urgent-strong', label: 'Critical' },
  att: { stripe: 'border-l-warning', icon: CircleAlert, iconClass: 'text-warning-strong', label: 'Needs Attention' },
  pos: { stripe: 'border-l-success', icon: CircleCheck, iconClass: 'text-success-strong', label: 'Positive' },
};

export function SuggestionsSection({ summary }: SummaryProps) {
  const items = summary.suggestions;
  return (
    <SectionCard title="10. Suggestions / Action Points">
      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {emptyTableText(summary, 'No Suggestions For The Selected Filters')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {items.map((s) => {
            const tone = TONE[s.tone] ?? TONE.pos;
            const Icon = tone.icon;
            return (
              <div key={s.key} className={`rounded-md border border-l-4 bg-card p-3 ${tone.stripe}`}>
                <div className="flex items-center gap-2">
                  <Icon className={`size-4 shrink-0 ${tone.iconClass}`} aria-label={tone.label} />
                  <span className="text-sm font-semibold text-ink-900">{s.title}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
