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
    requested_date_label: string | null;
    time_slot: string | null;
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
