/*
 * Employee Performance — native section components, in dashboard order.
 * Sections 2 and 6 take { summary, v, filters }; the rest take { summary }.
 * (Section 0, the Team panel and its member dialog, lives in the body.)
 */

export { RevenuePerformanceSection } from './RevenuePerformanceSection';
export { OpenJobRecordSection } from './OpenJobRecordSection';
export { ClientWiseSection } from './ClientWiseSection';
export { CityWiseSection } from './CityWiseSection';
export { TatSdaSection } from './TatSdaSection';
export { ZonalSection } from './ZonalSection';
export { ProductivitySection } from './ProductivitySection';
export { PerformanceSection } from './PerformanceSection';
export { ShortSummarySection } from './ShortSummarySection';
export { SuggestionsSection } from './SuggestionsSection';
export type { PagedSectionProps, Summary, SummaryProps } from './shared';
