/*
 * Shared wire types for the new-reg2 profile experience.
 *
 * VerificationPayload mirrors the subset of GET /admin/easyfixers/:id/verification
 * the profile tabs actually read (the full type is declared inline in the legacy
 * verification page). ProfileListRow mirrors the fields of the GET
 * /admin/easyfixers list row we surface in the header + Overview tiles.
 */
import { type LifecycleRowFields } from '@/lib/easyfixer-lifecycle';

export type VComment = { id?: number; text: string; author: string | null; createdAt: string | null };

export type VerificationPayload = {
  header: {
    efr_id: number;
    first_name: string | null; last_name: string | null; full_name: string;
    city_name: string | null;
    is_active: boolean; is_technician_verified: boolean; is_existing_easyfixer: boolean;
    mobile: string | null;
  };
  lead: {
    eligibility: {
      primary_mobile: string | null;
      first_name: string | null; last_name: string | null;
      pincode: string | null; state_name: string | null; district: string | null;
      city_name: string | null; efr_cityId: number | null;
    };
    gps_location: string | null;
    registration: {
      tx_id: number; tx_applied_on: string | null; state_user: string | null;
      approved_by: string | null; approved_on: string | null;
    };
    status: { personal_details_filled: number | null; progress: number };
    comments: VComment[];
  };
  registrationVerification: {
    overall_progress: number;
    is_verified: boolean;
    proceed_allowed: boolean;
    professional: {
      progress: number; is_verified: boolean;
      experience_id: number | null; experience_name: string | null;
      skill_rating: number | null; tool_rating: number | null;
      skill_rating_comment: string | null; tool_rating_comment: string | null;
      service_category: string | null; service_type: string | null;
      have_bike: boolean; use_whatsapp: boolean;
      updated_by_name: string | null; update_date: string | null;
      comments: VComment[];
    };
    personal: {
      progress: number; is_verified: boolean;
      date_of_birth: string | null; marital_status: string | null;
      children_count: number | null; emergency_mobile: string | null;
      health_insurance: boolean; accidental_insurance: boolean;
      hobbies: string | null; email: string | null; is_email_verified: boolean;
      verification_comment: string | null;
      updated_by_name: string | null; update_date: string | null;
      comments: VComment[];
    };
    banking: {
      progress: number; is_verified: boolean; verification_status: number | null;
      bank_name: string | null; account_number: string | null;
      account_holder_name: string | null; ifsc_code: string | null;
      mode_of_payment: string | null; is_verified_by_app: boolean;
      cancelled_cheque_img: string | null;
      verification_comment: string | null;
      updated_by_name: string | null; update_date: string | null;
      comments: VComment[];
    };
    identity: {
      progress: number; is_verified: boolean; verification_status: number | null;
      adhaar_card_number: string | null; pan_card_number: string | null;
      driving_lisence_img: string | null;
      rejected_reason: string | null;
      updated_by_name: string | null; update_date: string | null;
      comments: VComment[];
    };
  };
  activation: {
    progress: number; is_activated: boolean;
    payment: {
      easyfix_bank_name_id: number; easyfix_bank_name: string | null;
      beneficiary_id: string | null; is_locked: boolean;
    };
    bgv: { is_done: boolean };
    sidebar: {
      profile_img: string | null;
      registration_age_days: number | null;
      ec_date: string | null; bgv_report_done: boolean;
      finance_updated_by: string | null; finance_updated_on: string | null;
    };
    comments: VComment[];
  };
  additional: {
    deep_skills_count: number;
    serviceable_pincodes_count: number;
    progress: number;
    is_complete: boolean;
  };
};

export type ProfileListRow = LifecycleRowFields & {
  efr_id: number;
  efr_name: string;
  efr_no: string;
  efr_email: string | null;
  city_name: string | null;
  state_name: string | null;
  efr_service_category: string | null;
  efr_service_type: string | null;
  efr_profile_perc: number | null;
  efr_status: number;
  efr_status_label: 'Active' | 'Inactive' | 'Idle' | 'Not Eligible' | 'Not Suitable' | 'Registration In Progress';
  is_technician_verified: boolean | number | null;
  insert_date: string;
  profile_activation_date_time: string | null;
  current_balance: number | string | null;
  total_earnings: number;
  job_count: number;
  avg_rating: number | null;
  options_mapped_count: number;
  clients_mapped: number;
  serviceable_pincodes_csv?: string;
  zonal_manager_user_id: number | null;
  ef_account: 'Under Master' | 'Master' | 'Individual';
};

/** POST /admin/easyfixers/aggregates → { items: AggregateRow[] } */
export type AggregateRow = {
  efr_id: number;
  clients_mapped: number;
  total_earnings: number;
  job_count: number;
  avg_rating: number | null;
  options_mapped_count: number;
  serviceable_pincodes_csv: string;
};

/** GET /admin/easyfixers/:id/transactions */
export type EfTransaction = {
  transaction_id: number;
  transaction_date: string | null;
  appointment_date_time: string | null;
  completion_date_time: string | null;
  amount: number | string | null;
  balance: number | string | null;
  customer_name: string | null;
  customer_address: string | null;
  location: string | null;
  transaction_by: string | null;
  description: string | null;
  transaction_type: number | null; // 1 = DEBIT, 2 = CREDIT
};

/** GET /admin/easyfixers/:id/option-mappings */
export type OptionMapping = {
  mapping_id: number;
  category_id: number; category_name: string | null;
  service_type_id: number; service_type_name: string | null;
  deep_skill_id: number; deep_skill_name: string | null;
  option_id: number; option_name: string | null;
};

/** GET /admin/easyfixers/:id/serviceable-pincodes */
export type PincodeChip = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_name: string | null;
  state_name: string | null;
};
