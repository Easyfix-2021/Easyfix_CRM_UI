/*
 * Shared job-related types extracted from JobModal.tsx so dialog
 * components split into their own modules (AddRemarksDialog, etc.) can
 * reference the SAME JobComment shape without re-declaring it.
 */
export type JobComment = {
  id: number;
  job_id: number;
  comments: string;
  comment_on: number;
  stage: string;
  created_on: string;
  appointment_on: string | null;
  commented_by: number | null;
  user_name: string | null;
  efr_id: number | null;
  enum_reason_id: number | null;
  enum_desc: string | null;
};
