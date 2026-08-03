/*
 * Response contract for the public shared-job page — GET /public/shared-job/:token.
 * Intentionally NON-CONFIDENTIAL by construction: no customer name/number/email,
 * no SPOC/coordinator, no pricing. Server builder: EasyFix_Backend
 * services/job-share.service.js::fetchShareDetails.
 */
export type ShareJobService = {
  service_type_name: string | null;
  service_catg_name: string | null;
};

export type ShareJobResponse = {
  job_id: number;
  order_status: number | null;
  client_name: string | null;
  service_requested: ShareJobService[];
  job_desc: string | null;
  schedule: {
    requested_date_time: string | null;
    /** Date only — 'Tue, 5 Aug 2026'. */
    requested_date_label: string | null;
    /** 12-hour appointment time — '5:30 AM'. Null on a date-only booking. */
    requested_time_label: string | null;
    /**
     * The band the appointment ACTUALLY falls in, NOT the raw stored
     * `tbl_job.time_slot`. The server resolves it (job-share.service.js
     * resolveDisplaySlot) because the column is derived from
     * requested_date_time and re-derived on every write, so a stored value
     * contradicting the appointment is one the next save discards.
     */
    time_slot: string | null;
    /**
     * The composed appointment line — 'Tue, 5 Aug 2026, 5:30 AM · After Hours',
     * or 'Tue, 5 Aug 2026 · 3PM to 7PM' for a date-only booking.
     *
     * RENDER THIS, do not re-join the fields above. The server builds the same
     * string into the WhatsApp/share-sheet blurb (buildShareMessage), so
     * composing a second version here is how the link and the page it points at
     * drift into quoting different windows — which is exactly what happened.
     */
    appointment_label: string | null;
  };
  address: {
    address: string | null;
    building: string | null;
    landmark: string | null;
    city_id: number | null;
    city_name: string | null;
    pin_code: string | null;
    gps_location: string | null;
    address_instruction: string | null;
  };
  maps_link: string | null;
};
