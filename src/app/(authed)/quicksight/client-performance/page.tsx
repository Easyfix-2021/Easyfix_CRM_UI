'use client';

/*
 * Route wrapper. The report itself lives in ClientPerformanceBody so the new
 * QuickSight "Performance Report" page can render the SAME component in a tab —
 * one implementation, so a fix lands on both surfaces. This standalone route is
 * deliberately kept (existing links, bookmarks and RBAC stay valid).
 */

import { ClientPerformanceBody } from './ClientPerformanceBody';

export default function ClientPerformancePage() {
  return <ClientPerformanceBody />;
}
