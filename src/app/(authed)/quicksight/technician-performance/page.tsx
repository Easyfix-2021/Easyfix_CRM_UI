'use client';

/*
 * Route wrapper. The report itself lives in TechnicianPerformanceBody so the new
 * QuickSight "Performance Report" page can render the SAME component in a tab —
 * one implementation, so a fix lands on both surfaces. This standalone route is
 * deliberately kept (existing links, bookmarks and RBAC stay valid).
 */

import { TechnicianPerformanceBody } from './TechnicianPerformanceBody';

export default function TechnicianPerformancePage() {
  return <TechnicianPerformanceBody />;
}
