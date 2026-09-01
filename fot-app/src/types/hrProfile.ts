/** Типы кадрового модуля («Реквизиты»). Зеркало fot-server: hr-profile.service / hr-documents.service / hr-draft.service. */

export type HrDocumentProfile = 'ru' | 'eaeu' | 'migrant';
export type HrFieldGroup = 'personal' | 'contacts' | 'documents' | 'patent' | 'other';
export type HrRecognitionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'needs_review' | null;

export interface IHrCitizenship {
  id: string;
  name: string;
  iso_code: string | null;
  requires_patent: boolean;
  is_eaeu: boolean;
}

export interface IHrFieldMeta {
  key: string;
  label: string;
  group: HrFieldGroup;
  sensitive?: boolean;
  migrantOnly?: boolean;
  ownedByEmployee?: boolean;
}

export interface IHrCatalog {
  configured: boolean;
  /** Флаг раскатки: пока false — модуль в UI не показывается. */
  enabled: boolean;
  document_types: Array<{ code: string; label: string; ocr_supported: boolean; sort_order: number }>;
  profiles: Record<HrDocumentProfile, string[]>;
  required_documents: Record<HrDocumentProfile, string[]>;
  residence_permit_excluded: string[];
  fields: IHrFieldMeta[];
  field_groups: Record<HrFieldGroup, string>;
  zup_relevant_fields: string[];
  citizenships: IHrCitizenship[];
}

export interface IHrDepartmentsResponse {
  departments: Array<{ id: string; name: string; parent_id: string | null; kind: string | null; sigur_department_id: number | null }>;
  positions: Array<{ id: string; name: string }>;
}

/** Плоские поля профиля (ключи как в HR_PROFILE_FIELDS). */
export interface IHrProfileFields {
  gender: 'male' | 'female' | null;
  citizenship_id: string | null;
  has_residence_permit: boolean;
  birth_date: string | null;
  birth_country_id: string | null;
  birth_region: string | null;
  birth_city: string | null;
  registration_address: string | null;
  email: string | null;
  phone: string | null;
  snils: string | null;
  inn: string | null;
  passport_type: 'russian' | 'foreign' | null;
  passport_number: string | null;
  passport_date: string | null;
  passport_issuer: string | null;
  passport_department_code: string | null;
  passport_expiry_date: string | null;
  bank_account_number: string | null;
  bank_bik: string | null;
  insurance_policy_number: string | null;
  insurance_policy_date: string | null;
  kig: string | null;
  kig_end_date: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_expiry_date: string | null;
  patent_blank_number: string | null;
  planned_exit_date: string | null;
  notes: string | null;
}

export type HrProfileInput = Partial<IHrProfileFields>;

export interface IHrProfileView {
  employee_id: number;
  full_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  employment_status: string;
  hire_date: string | null;
  org_department_id: string | null;
  tab_number: string | null;
  citizenship: IHrCitizenship | null;
  birth_country: { id: string; name: string } | null;
  requires_patent: boolean;
  document_profile: HrDocumentProfile;
  document_slots: { all: string[]; required: string[] };
  masked: boolean;
  fields: IHrProfileFields;
  zup: { is_uploaded: boolean; uploaded_at: string | null; marked_by: string | null; exported_at: string | null };
  passdesk_id: string | null;
  match_rule: string | null;
  created_at: string;
  updated_at: string;
}

export interface IHrListRow {
  employee_id: number;
  full_name: string;
  employment_status: string;
  hire_date: string | null;
  birth_date: string | null;
  department: string | null;
  org_department_id: string | null;
  citizenship: string | null;
  requires_patent: boolean;
  has_residence_permit: boolean;
  planned_exit_date: string | null;
  zup: { is_uploaded: boolean; uploaded_at: string | null; exported_at: string | null };
  files: { count: number; required_filled: number; required_total: number; completeness: 'full' | 'partial' | 'none' };
  open_conflicts: number;
  ocr_pending: number;
  updated_at: string;
}

export interface IHrListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'active' | 'fired' | 'all';
  department_id?: string;
  citizenship_id?: string;
  patent?: 'required' | 'not_required' | '';
  zup?: 'yes' | 'no' | '';
  zupFrom?: string;
  zupTo?: string;
  files?: 'full' | 'partial' | 'none' | '';
}

export interface IHrDocument {
  id: number;
  category: string;
  type_code: string;
  type_label: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  created_at: string;
  uploaded_by: string;
  recognition_status: HrRecognitionStatus;
  recognition_error: string | null;
  recognized_at: string | null;
  ocr_supported: boolean;
}

export interface IHrDocumentSlot {
  code: string;
  label: string;
  required: boolean;
  ocr_supported: boolean;
  files: IHrDocument[];
}

export interface IHrDocumentsResponse {
  slots: IHrDocumentSlot[];
  completeness: { filled: number; required: number; total: number };
}

export interface IHrHistoryItem {
  id: number;
  event_type: 'created' | 'profile_update' | 'file_upload' | 'file_delete' | 'ocr_run' | 'ocr_apply' | 'ocr_dismiss' | 'zup_toggle' | 'zup_export' | 'attach_existing';
  changed_fields: string[] | null;
  old_values: Record<string, unknown> | null;
  document_id: number | null;
  document_name: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_source: 'admin' | 'ocr' | 'import' | 'migration' | 'wizard';
  changed_at: string;
}

export interface IHrOcrConflict {
  id: number;
  field_name: string;
  field_label: string;
  document_id: number | null;
  document_name: string | null;
  document_type: string | null;
  current_value: string | null;
  ocr_value: string | null;
  status: 'open' | 'applied' | 'dismissed';
  created_at: string;
}

export interface IHrDuplicateCandidate {
  employee_id: number;
  full_name: string;
  birth_date: string | null;
  employment_status: string;
  department: string | null;
  has_profile: boolean;
  rule: 'snils' | 'inn' | 'passport_birth' | 'name_birth';
}

export interface IHrEmployeeSearchRow {
  id: number;
  full_name: string;
  birth_date: string | null;
  employment_status: string;
  department: string | null;
  has_profile: boolean;
}

export type HrDraftState = 'draft' | 'employee_created_pending_attach' | 'attached' | 'expired';

export interface IHrDraftPayload {
  full_name?: string | null;
  hire_date?: string | null;
  org_department_id?: string | null;
  position_id?: string | null;
  tab_number?: string | null;
  profile?: HrProfileInput;
}

export interface IHrDraftView {
  id: string;
  state: HrDraftState;
  /** Заполнен, когда сотрудник уже создан и осталось только прикрепить документы. */
  employee_id: number | null;
  attach_error: string | null;
  expires_at: string;
  updated_at: string;
  payload: IHrDraftPayload;
  documents: IHrDocument[];
  ocr_patch: Record<string, string>;
  ocr_sources: Record<string, string>;
}

export interface IHrStagingRow {
  passdesk_id: string;
  full_name: string;
  birth_date: string | null;
  citizenship: string | null;
  counterparty: string | null;
  is_active: boolean | null;
  match_state: 'unmatched' | 'candidate' | 'ambiguous' | 'linked' | 'created';
  candidates: Array<{ id: number; full_name: string; birth_date: string | null; department: string | null; employment_status: string }>;
  files_count: number;
  linked_employee_id: number | null;
  linked_at: string | null;
}
