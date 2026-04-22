export interface ISyncResult {
  imported: number;
  skipped: number;
  matched: number;
  errors: string[];
  sigurTotal: number;
  droppedNoName?: number;
  droppedNoOrg?: number;
  filteredByDept?: number;
  // Расширенная диагностика
  unmatchedEmployees?: number;
  matchedEvents?: number;
  unmatchedEvents?: number;
  truncatedDays?: number;
  paginatedDays?: number;
  matchedBySigurId?: number;
  matchedByName?: number;
}

export interface IPreviewData {
  data: Record<string, unknown>[];
  sampleFields: string[];
  totalFetched: number;
  mappedCount?: number;
}

export type SyncStepName = 'departments' | 'positions' | 'employees';

export interface ISyncAllStep {
  id: number;
  name: SyncStepName;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: Record<string, unknown>;
  error?: string;
}

export interface IEventsProgressState {
  percent: number;
  day: string;
  dayIndex: number;
  totalDays: number;
}

export interface IEmployeesProgressState {
  percent: number;
  current: number;
  total: number;
  phase?: string;
}

export interface IUnmatchedSigurEmployee {
  sigurId: number | undefined;
  name: string;
  departmentName: string;
  positionName: string;
  orgDepartmentId: string | null;
  positionId: string | null;
}

export interface ISyncAllSummary {
  hasErrors: boolean;
  failedSteps: SyncStepName[];
  completedSteps: number;
}

export interface ISseMessage extends Record<string, unknown> {
  type?: string;
}

export type SettingsTab = 'settings' | 'access-points' | 'objects' | 'travel-config' | 'sync-filter';
