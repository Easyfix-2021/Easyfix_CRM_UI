'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ComingSoon } from '@/components/common/ComingSoon';

/*
 * Single generic landing page for every menu item that isn't migrated yet.
 * Sidebar links point here with `?title=…&legacyPath=…` query params rather
 * than each screen having its own .tsx stub file. Swap a WIP sidebar href to
 * the real route whenever a feature ships — no file cleanup needed.
 *
 * Wrapped in Suspense because useSearchParams() opts into client-side
 * rendering and Next's App Router requires the boundary for that.
 */
export default function ComingSoonPage() {
  return (
    <Suspense fallback={<ComingSoon title="Coming Soon" />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const params = useSearchParams();
  const title = params.get('title') || 'Coming Soon';
  const legacyPath = params.get('legacyPath') || undefined;
  const blurb = params.get('blurb') || undefined;
  return <ComingSoon title={title} blurb={blurb} legacyPath={legacyPath} />;
}
