import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';
import type {
  SkudEvent,
  SkudEventFailure,
  SkudDailySummary,
  IEmployeePresence,
  IPresenceByObjectResponse,
  IAccessPointSetting,
  IDashboardStats,
  AccessPointOption,
} from '../types';
import { readSseResponse } from '../components/skud/sigur-settings.utils';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

interface ImportResult {
  imported: number;
  matched: number;
  errors: string[];
}

interface SkudFilters {
  startDate?: string;
  endDate?: string;
  accessPoint?: string;
  employeeId?: string;
  search?: string;
}

interface DownloadFileResult {
  blob: Blob;
  filename: string;
}

export type KpiMetric = 'attendance' | 'sick' | 'unpaid';
export type KpiSeverity = 'green' | 'yellow' | 'red';

export interface IKpiAttendance {
  lateCount: number;
  lateMinutes: number;
  earlyCount: number;
  underworkCount: number;
  absenceCount: number;
  workedHours: number;
  normHours: number;
  severity: KpiSeverity;
}

export interface IKpiLeaveCase {
  startDate: string;
  endDate: string;
  days: number;
  isMonFri: boolean;
  isAfterHoliday: boolean;
  isShort: boolean;
  retroactive: boolean;
}

export interface IKpiSick {
  totalDays: number;
  caseCount: number;
  shortCaseCount: number;
  monFriCount: number;
  afterHolidayCount: number;
  workedSickDays: number;
  cases: IKpiLeaveCase[];
  severity: KpiSeverity;
}

export interface IKpiUnpaid {
  totalDays: number;
  caseCount: number;
  retroactiveCaseCount: number;
  daysThisYear: number;
  overLimit: boolean;
  cases: IKpiLeaveCase[];
  severity: KpiSeverity;
}

export interface IKpiPending {
  sickDays: number;
  unpaidDays: number;
}

export interface IDisciplineKpiRow {
  employeeId: number;
  name: string;
  department: string;
  attendance: IKpiAttendance | null;
  sick: IKpiSick | null;
  unpaid: IKpiUnpaid | null;
  pending: IKpiPending;
  severity: KpiSeverity;
}

export interface IDisciplineKpiTotals {
  employeeCount: number;
  attendance: Omit<IKpiAttendance, 'severity'> | null;
  sick: Omit<IKpiSick, 'cases' | 'severity'> | null;
  unpaid: { totalDays: number; caseCount: number; retroactiveCaseCount: number; overLimitEmployees: number } | null;
  pending: IKpiPending;
}

export interface IDisciplineKpiResult {
  scope: 'employee' | 'department';
  subject: string;
  startMonth: string;
  endMonth: string;
  metrics: KpiMetric[];
  totals: IDisciplineKpiTotals;
  rows: IDisciplineKpiRow[];
  overallSeverity: KpiSeverity;
}

interface IDisciplineKpiParams {
  scope: 'employee' | 'department';
  employeeId?: number;
  departmentId?: string;
  startMonth: string;
  endMonth: string;
  metrics: KpiMetric[];
}

const buildKpiParams = (params: IDisciplineKpiParams): URLSearchParams => {
  const search = new URLSearchParams({
    scope: params.scope,
    startMonth: params.startMonth,
    endMonth: params.endMonth,
    metrics: params.metrics.join(','),
  });
  if (params.scope === 'employee' && params.employeeId != null) search.append('employee_id', String(params.employeeId));
  if (params.scope === 'department' && params.departmentId) search.append('department_id', params.departmentId);
  return search;
};

const normalizeAccessPointName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const parseAccessPointNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
};

const toAccessPointOption = (value: unknown): AccessPointOption | null => {
  if (typeof value === 'string') {
    const name = normalizeAccessPointName(value);
    return name ? { name, id: null } : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as { name?: unknown; id?: unknown };
  const name = normalizeAccessPointName(candidate.name);
  if (!name) return null;

  const record = value as Record<string, unknown>;
  const directKeys = ['id', 'accessPointId', 'accesspointId', 'number', 'accessPointNumber', 'objectNumber', 'tabId'];
  let parsedId: number | null = null;

  for (const key of directKeys) {
    parsedId = parseAccessPointNumber(record[key]);
    if (parsedId != null) break;
  }

  if (parsedId == null && record.data && typeof record.data === 'object') {
    for (const key of directKeys) {
      parsedId = parseAccessPointNumber((record.data as Record<string, unknown>)[key]);
      if (parsedId != null) break;
    }
  }

  return {
    name,
    id: parsedId,
  };
};

const normalizeAccessPointOptions = (value: unknown): AccessPointOption[] => {
  if (!Array.isArray(value)) return [];

  const byName = new Map<string, number | null>();
  for (const item of value) {
    const option = toAccessPointOption(item);
    if (!option) continue;

    if (!byName.has(option.name) || (byName.get(option.name) == null && option.id != null)) {
      byName.set(option.name, option.id);
    }
  }

  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'ru'))
    .map(([name, id]) => ({ name, id }));
};

const parseDownloadFilename = (contentDisposition: string | null, fallbackName: string): string => {
  if (!contentDisposition) return fallbackName;

  const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch {
      return utfMatch[1];
    }
  }

  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) {
    try {
      return decodeURIComponent(plainMatch[1]);
    } catch {
      return plainMatch[1];
    }
  }

  return fallbackName;
};

const fetchExportFile = async (endpoint: string, fallbackName: string): Promise<DownloadFileResult> => {
  const response = await fetch(buildApiUrl(endpoint), {
    credentials: 'include',
    headers: buildAuthHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Ошибка экспорта');
  }

  return {
    blob: await response.blob(),
    filename: parseDownloadFilename(response.headers.get('Content-Disposition'), fallbackName),
  };
};

export const skudService = {
  async getEvents(filters?: SkudFilters, signal?: AbortSignal): Promise<SkudEvent[]> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.accessPoint) params.append('accessPoint', filters.accessPoint);
    if (filters?.employeeId) params.append('employeeId', filters.employeeId);
    if (filters?.search) params.append('search', filters.search);

    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]>>(`/skud/events${query ? `?${query}` : ''}`, { signal });
    return response.data || [];
  },

  async getEmployeeEvents(employeeId: number, startDate?: string, endDate?: string): Promise<SkudEvent[]> {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]>>(
      `/skud/employee-events/${employeeId}${query ? `?${query}` : ''}`
    );
    return response.data || [];
  },

  /**
   * Возвращает успешные события и ошибочные события Sigur (PASS_DENY и т.п.) одним
   * запросом. Используется в модалке табеля и карточке сотрудника, чтобы пометить
   * «неудачные» проходы — расчёты табеля их игнорируют.
   */
  async getEmployeeEventsWithFailures(
    employeeId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<{ events: SkudEvent[]; failures: SkudEventFailure[] }> {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]> & { failures?: SkudEventFailure[] }>(
      `/skud/employee-events/${employeeId}${query ? `?${query}` : ''}`,
    );
    return {
      events: response.data || [],
      failures: response.failures || [],
    };
  },

  /**
   * Список ошибочных событий Sigur с фильтрами. Для админ-вкладки «Ошибочные
   * события» в SigurRawDataPage.
   */
  async getEventFailures(filters?: {
    startDate?: string;
    endDate?: string;
    employeeId?: string | number;
    failureType?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }, signal?: AbortSignal): Promise<{ data: SkudEventFailure[]; total: number }> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.employeeId != null) params.append('employeeId', String(filters.employeeId));
    if (filters?.failureType) params.append('failureType', filters.failureType);
    if (filters?.search) params.append('search', filters.search);
    if (filters?.limit != null) params.append('limit', String(filters.limit));
    if (filters?.offset != null) params.append('offset', String(filters.offset));
    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEventFailure[]> & { total?: number }>(
      `/skud/event-failures${query ? `?${query}` : ''}`,
      { signal },
    );
    return {
      data: response.data || [],
      total: response.total ?? (response.data?.length ?? 0),
    };
  },

  async getDailySummary(date: string, signal?: AbortSignal): Promise<SkudDailySummary[]> {
    const params = new URLSearchParams({ date });
    const response = await apiClient.get<ApiResponse<SkudDailySummary[]>>(`/skud/daily-summary?${params.toString()}`, { signal });
    return response.data || [];
  },

  async importEvents(file: File): Promise<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiClient.post<ApiResponse<ImportResult>>('/skud/import', formData);
    return response.data;
  },

  async getAccessPoints(connection?: 'internal' | 'external'): Promise<string[]> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.get<ApiResponse<unknown>>(`/skud/access-points${params}`);
    return normalizeAccessPointOptions(response.data).map(option => option.name);
  },

  async getAccessPointOptions(connection?: 'internal' | 'external'): Promise<AccessPointOption[]> {
    try {
      const sigurParams = connection ? `?connection=${connection}` : '';
      const sigurResponse = await apiClient.get<{ data?: unknown }>(`/sigur/access-points${sigurParams}`);
      const normalizedSigur = normalizeAccessPointOptions(sigurResponse.data);
      if (normalizedSigur.length > 0) {
        return normalizedSigur;
      }
    } catch {
      // Fallback to cached SKUD access points when live Sigur list is unavailable.
    }

    const params = new URLSearchParams({ includeMeta: '1' });
    if (connection) params.append('connection', connection);
    const response = await apiClient.get<ApiResponse<unknown>>(`/skud/access-points?${params.toString()}`);
    return normalizeAccessPointOptions(response.data);
  },

  async getPresence(departmentId?: string): Promise<IEmployeePresence[]> {
    const params = departmentId ? `?department_id=${departmentId}` : '';
    const response = await apiClient.get<ApiResponse<IEmployeePresence[]>>(`/skud/presence${params}`);
    return response.data || [];
  },

  async getPresenceByObject(signal?: AbortSignal): Promise<IPresenceByObjectResponse> {
    const response = await apiClient.get<ApiResponse<IPresenceByObjectResponse>>(
      '/skud/presence-by-object',
      { signal },
    );
    return response.data;
  },

  async syncEmployee(
    employeeId: number,
    startDate: string,
    endDate: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ inserted: number; skipped: number; total: number }> {
    const response = await fetch(buildApiUrl('/skud/sync-employee'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(),
      },
      body: JSON.stringify({ employeeId, startDate, endDate }),
    });

    let result = { inserted: 0, skipped: 0, total: 0 };
    let sseError: string | null = null;

    await readSseResponse(response, (data) => {
      if (data.type === 'day_start' && onProgress) {
        onProgress(`День ${data.day} (${data.percent}%)...`);
      }
      if (data.type === 'done') {
        result = {
          inserted: Number(data.inserted || 0),
          skipped: Number(data.skipped || 0),
          total: Number(data.total || 0),
        };
      }
      if (data.type === 'error') {
        sseError = String(data.error || 'Ошибка синхронизации');
      }
    });

    if (sseError) throw new Error(sseError);
    return result;
  },

  async getAccessPointSettings(departmentId?: string): Promise<IAccessPointSetting[]> {
    const params = departmentId ? `?department_id=${departmentId}` : '';
    const response = await apiClient.get<ApiResponse<IAccessPointSetting[]>>(
      `/skud/access-point-settings${params}`
    );
    return response.data || [];
  },

  async saveAccessPointSettings(settings: IAccessPointSetting[], departmentId?: string): Promise<void> {
    await apiClient.put<ApiResponse<null>>('/skud/access-point-settings', {
      ...(departmentId ? { department_id: departmentId } : {}),
      settings,
    });
  },

  async syncAccessPoints(connection?: 'internal' | 'external'): Promise<{ accessPoints: string[]; removed: string[]; settingsRemoved: number }> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.post<ApiResponse<{ accessPoints: string[]; removed: string[]; settingsRemoved: number }>>(
      `/skud/sync-access-points${params}`
    );
    return response.data;
  },

  async getDashboardStats(
    departmentId: string,
    period = 'today',
    signal?: AbortSignal,
    month?: string,
    force?: boolean,
  ): Promise<IDashboardStats> {
    let url = `/skud/dashboard-stats?department_id=${departmentId}&period=${period}`;
    if (month) url += `&month=${month}`;
    if (force) url += '&force=1';
    const response = await apiClient.get<ApiResponse<IDashboardStats>>(url, { signal });
    return response.data;
  },

  async getDisciplineViolations(period: { startMonth: string; endMonth?: string }, signal?: AbortSignal): Promise<{
    violations: Array<{
      employee_id: number;
      date: string;
      type: 'late' | 'underwork' | 'early' | 'absence';
      first_entry: string | null;
      last_exit: string | null;
      total_hours: number | null;
      deviation: string;
    }>;
    employees: Record<number, { full_name: string; position: string | null; department_id: string | null; worked_hours: number; norm_hours: number }>;
    departments: Record<string, string>;
  }> {
    const params = new URLSearchParams({ startMonth: period.startMonth });
    if (period.endMonth) params.append('endMonth', period.endMonth);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response shape validated by return type
    const response = await apiClient.get<ApiResponse<any>>(`/skud/discipline?${params.toString()}`, { signal });
    return response.data;
  },

  async exportEmployeeEvents(employeeId: number, startDate: string, endDate: string): Promise<DownloadFileResult> {
    const params = new URLSearchParams({ startDate, endDate });
    return fetchExportFile(
      `/skud/employee-events/${employeeId}/export?${params.toString()}`,
      `skud_${employeeId}_${startDate}_${endDate}.xlsx`,
    );
  },

  async exportDiscipline(filters: {
    startMonth: string;
    endMonth?: string;
    tab?: 'all' | 'late' | 'underwork' | 'early' | 'absence';
    departmentIds?: string[];
    onlyViolations?: boolean;
    search?: string;
  }): Promise<DownloadFileResult> {
    const params = new URLSearchParams({ startMonth: filters.startMonth });
    if (filters.endMonth) params.append('endMonth', filters.endMonth);
    if (filters.tab && filters.tab !== 'all') params.append('tab', filters.tab);
    if (filters.departmentIds && filters.departmentIds.length > 0) params.append('department_ids', filters.departmentIds.join(','));
    if (filters.onlyViolations) params.append('only_violations', '1');
    if (filters.search?.trim()) params.append('search', filters.search.trim());

    return fetchExportFile(
      `/skud/discipline/export?${params.toString()}`,
      `discipline_${filters.startMonth}_${filters.endMonth || filters.startMonth}.xlsx`,
    );
  },

  async getDisciplineKpi(params: IDisciplineKpiParams, signal?: AbortSignal): Promise<IDisciplineKpiResult> {
    const search = buildKpiParams(params);
    const response = await apiClient.get<ApiResponse<IDisciplineKpiResult>>(
      `/skud/discipline/kpi?${search.toString()}`,
      { signal },
    );
    return response.data;
  },

  async exportDisciplineKpi(params: IDisciplineKpiParams): Promise<DownloadFileResult> {
    const search = buildKpiParams(params);
    return fetchExportFile(
      `/skud/discipline/kpi/export?${search.toString()}`,
      `kpi_discipline_${params.startMonth}_${params.endMonth}.xlsx`,
    );
  },

};
