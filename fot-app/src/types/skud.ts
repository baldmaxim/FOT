// SKUD types
export interface SkudEvent {
  id: number;
  physical_person: string;
  card_number: string;
  event_time: string;
  event_date: string;
  access_point: string | null;
  direction: string | null;
}

/**
 * Ошибочное событие Sigur (PASS_DENY, READER_ERROR, таймаут и т.п.).
 * Не участвует в расчётах табеля — отображается как «лог» с маркером в модалке
 * табеля, карточке сотрудника и админ-вкладке «Ошибочные события».
 */
export interface SkudEventFailure {
  id: number;
  employee_id: number | null;
  physical_person: string | null;
  card_number: string | null;
  event_date: string;
  event_time: string;
  event_at?: string | null;
  access_point: string | null;
  direction: string | null;
  failure_type: string;
  failure_type_id: number | null;
  reason: string | null;
}

export interface IEmployeePresence {
  employee_id: number;
  full_name: string;
  department_name: string | null;
  position_name: string | null;
  status: 'online' | 'offline' | 'unknown';
  since: string | null;
  first_entry: string | null;
  total_hours: number | null;
  exit_count: number;
  time_outside_minutes: number;
  last_access_point: string | null;
  punctuality_percent: number | null;
}

export interface IPresenceObjectEmployee {
  employee_id: number;
  full_name: string;
  position_name: string | null;
  department_name: string | null;
  first_entry: string | null;
  last_access_point: string | null;
  since: string | null;
  is_unsynced: boolean;
}

export interface IPresenceObjectCompany {
  company_id: string;
  company_name: string;
  online_count: number;
  employees: IPresenceObjectEmployee[];
}

export interface IPresenceObjectBucket {
  object_id: string | null;
  object_name: string;
  has_map: boolean;
  online_count: number;
  companies: IPresenceObjectCompany[];
  /** true — «частичный» объект: показаны только сотрудники пользователя (его бригады на
   *  чужом объекте), а не весь онлайн объекта. undefined = полный объект. */
  is_partial?: boolean;
}

export interface IPresenceByObjectResponse {
  generated_at: string;
  total_online: number;
  buckets: IPresenceObjectBucket[];
  /** true → пользователь видит все объекты без ограничений (админ или тех-юзер без employee_id). */
  is_unrestricted: boolean;
  /** Список skud_object_id, к которым приписан текущий пользователь (пустой если is_unrestricted или нет приписок). */
  assigned_object_ids: string[];
  /** Режим выдачи: all — все объекты; object — по приписке объектов; employee — свои
   *  сотрудники на объектах; object_employee — назначенный объект + свои сотрудники на других. */
  scope_mode: 'all' | 'object' | 'employee' | 'object_employee';
}

export interface SkudDailySummary {
  id: number;
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
}

export interface IAccessPointSetting {
  access_point_name: string;
  is_internal: boolean;
}

export interface AccessPointOption {
  name: string;
  id: number | null;
  objectId?: string | null;
  objectName?: string | null;
  hasMapPreview?: boolean;
}

export type SigurConnectionScope = 'internal' | 'external';
export type SigurConnectionSettingsSource = 'system_settings' | 'env' | 'unset';

export interface SigurConnectionPublicConfig {
  url: string;
  username: string;
  hasPassword: boolean;
  source: SigurConnectionSettingsSource;
}

export interface SigurConnectionSettings {
  internal: SigurConnectionPublicConfig;
  external: SigurConnectionPublicConfig;
  archiveDepartmentId: number | null;
  archiveDepartmentName: string | null;
  connections: { internal: boolean; external: boolean };
}

export interface SigurArchiveDepartmentInfo {
  sigurDepartmentId: number;
  localDepartmentId: string | null;
  name: string;
}

export interface SigurEmployeeAccessPointBinding {
  accessPointId: number;
  accessPointName: string | null;
  objectId?: string | null;
  objectName?: string | null;
  hasMapPreview?: boolean;
}

export interface SigurEmployeeCardSummary {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
  issued: boolean | null;
  /** Номер карты в формате W26 (facility,number) с сервера Sigur — для сверки. */
  w26: string | null;
}

export interface SigurEmployeeAccessRuleSummary {
  accessRuleId: number;
  accessRuleName: string | null;
}

export interface SigurEmployeeAccessRulesSaveResult {
  addedIds: number[];
  removedIds: number[];
  bindings: SigurEmployeeAccessRuleSummary[];
}

export interface SigurEmployeeProfileState {
  linked: boolean;
  employeeId: number;
  sigurEmployeeId: number | null;
  profile: {
    fullName: string;
    departmentId: number | null;
    departmentName: string | null;
    positionId: number | null;
    positionName: string | null;
    tabNumber: string | null;
    description: string | null;
    blocked: boolean | null;
  };
  cards: SigurEmployeeCardSummary[];
  accessRules: SigurEmployeeAccessRuleSummary[];
  accessPoints: SigurEmployeeAccessPointBinding[];
}

export interface SigurEmployeeAccessPointsState {
  linked: boolean;
  accessPoints: AccessPointOption[];
  bindings: SigurEmployeeAccessPointBinding[];
}

export interface SigurEmployeeAccessPointsSaveResult {
  addedIds: number[];
  removedIds: number[];
  bindings: SigurEmployeeAccessPointBinding[];
}

export interface SigurDepartmentNode {
  id: number;
  parentId: number | null;
  name: string;
  hasChildren: boolean;
  employeeCount: number;
  employeeCountLoaded?: boolean;
  children?: SigurDepartmentNode[];
}

export interface SigurPositionSummary {
  id: number;
  name: string;
}

export interface SigurEmployeeSummary {
  id: number;
  name: string;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  tabId: string | null;
  blocked: boolean | null;
  passNumber: string | null;
}

export type SigurEmployeeCardAccessState =
  | 'active'
  | 'expired'
  | 'no_card'
  | 'no_expiration'
  | 'unknown';

export interface SigurEmployeeCardAccessStatus {
  employeeId: number;
  state: SigurEmployeeCardAccessState;
  expirationDate: string | null;
  hasCard: boolean;
  w26: string | null;
}

export interface SigurLiveEmployeeProfile {
  sigurEmployeeId: number;
  profile: {
    fullName: string;
    departmentId: number | null;
    departmentName: string | null;
    positionId: number | null;
    positionName: string | null;
    tabNumber: string | null;
    description: string | null;
    blocked: boolean | null;
  };
  cards: SigurEmployeeCardSummary[];
  accessRules: SigurEmployeeAccessRuleSummary[];
  accessRuleOptions: SigurEmployeeAccessRuleSummary[];
  accessPoints: SigurEmployeeAccessPointBinding[];
  accessPointOptions: AccessPointOption[];
}
