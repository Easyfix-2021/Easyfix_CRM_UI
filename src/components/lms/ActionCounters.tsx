'use client';

/**
 * The four B-01 counters: Overdue · Pending · Paused and waiting · Needs decision.
 *
 * WHY THE UNIT IS ON THE TILE
 *
 * The first two count ASSIGNMENTS; "Paused & Waiting" counts TECHNICIANS —
 * one person owing three modules is one person not earning, not three. Four
 * bare numbers side by side quietly invite the reader to add them up, and the
 * sum would be meaningless. So each tile names what it counts.
 *
 * Overdue and Pending also PARTITION: Pending deliberately excludes Overdue.
 * Nested counters would sum to more than the population, and the first
 * question anyone asks is which of the two is the real number.
 *
 * Every tile is a link into the drilldown with the matching filter, so no
 * counter is a dead end — the spec's premise is that each row tells you what
 * to do next, and a number you cannot click does not.
 */

import Link from 'next/link';
import { COUNTER_META, type ActionCounters as Counters } from '@/lib/lms-action';
import { Card, CardContent } from '@/components/ui/card';

const TONE_PLATE: Record<string, string> = {
  urgent: 'bg-urgent-tint text-urgent-strong',
  warning: 'bg-warning-tint text-warning-strong',
  info: 'bg-info-tint text-info-strong',
  gold: 'bg-gold-tint text-gold-strong',
};

const TONE_VALUE: Record<string, string> = {
  urgent: 'text-urgent-strong',
  warning: 'text-warning-strong',
  info: 'text-info-strong',
  gold: 'text-gold-strong',
};

export function ActionCounters({
  counters,
  basePath = '/lms/action/pending',
}: {
  counters: Counters;
  basePath?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {COUNTER_META.map((meta) => {
        const value = counters[meta.key] ?? 0;
        const href = meta.chip ? `${basePath}?status=${meta.chip}` : basePath;
        return (
          <Link key={meta.key} href={href} className="block">
            <Card className="h-full transition-colors hover:border-primary/40">
              <CardContent className="flex h-full flex-col gap-1 p-4">
                <div className="flex items-baseline gap-2">
                  <span className={`text-2xl font-semibold tabular-nums ${TONE_VALUE[meta.tone]}`}>
                    {value.toLocaleString('en-IN')}
                  </span>
                  {/* Naming the unit is what stops the four being added up. */}
                  <span className="text-xs text-muted-foreground">{meta.unit}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${TONE_PLATE[meta.tone]}`}>
                    {meta.label}
                  </span>
                </div>
                <p className="mt-auto pt-1 text-xs leading-snug text-muted-foreground">{meta.hint}</p>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}

export default ActionCounters;
