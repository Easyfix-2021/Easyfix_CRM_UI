import { redirect } from 'next/navigation';

/*
 * Employee Performance now lives as the "Employee" tab of the Performance
 * report (see EmployeePerformanceBody). This route stays so existing links and
 * bookmarks land in the right place.
 */
export default function EmployeePerformancePage() {
  redirect('/quicksight/performance?tab=employee');
}
