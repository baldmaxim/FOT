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
