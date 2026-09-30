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
  /* The legacy "Remark By" resolved by the backend (tbl_user name, else the
   * escalation's job_escalated_by, else the technician). Optional: an older
   * backend does not send it. */
  remark_by?: string | null;
  /*
   * The legacy "Remarks For" bucket, decoded by the backend from comment_on
   * (shapeRow's REMARKS_FOR). Optional for the same reason as remark_by — an
   * older backend omits it, and both readers fall back to LEGACY_REMARKS_FOR.
   *
   * JobModal's RemarkRow ALSO declares this, alongside `accountable`, because
   * that type additionally covers optimistic rows the tab builds locally.
   */
  remarks_for?: string | null;
  /*
   * tbl_job_comment.job_stage — the JOB's status at the moment the remark was
   * filed, which is what answers "at which stage was this rescheduled".
   *
   * NOT to be confused with `stage` above, which is the COMMENT's own bucket
   * (comment_on). Same word, two different domains.
   *
   * Null on every row written before 2026-09-30, because nothing stamped it
   * until reschedule() started to — so treat a null as "not recorded", never as
   * "status 0". Optional because an older backend does not send the field.
   */
  job_stage?: number | null;
  /*
   * The technician app's reschedule ask (comment_on 8) stores its promised time
   * HERE rather than in appointment_on. Optional for the same reason.
   */
  requested_date_time?: string | null;
};
