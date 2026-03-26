import { SigurServiceBase, ConnectionType } from './sigur-base.service.js';

/**
 * Расширение SigurService с методами получения данных.
 */
export class SigurDataService extends SigurServiceBase {
  private employeeCache: { data: Record<string, unknown>[]; fetchedAt: number } | null = null;
  private employeeFetchPromise: Promise<Record<string, unknown>[]> | null = null;
  private departmentCache: { map: Map<number, string>; fetchedAt: number } | null = null;
  private accessPointCache: { map: Map<number, string>; fetchedAt: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 минут

  /** Проверка подключения к Sigur */
  async testConnection(connection?: ConnectionType): Promise<{ success: boolean; message: string; connection: ConnectionType }> {
    const connType = this.resolveConnectionType(connection);
    try {
      await this.authenticate(connType);
      await this.request('/api/v1/departments', { limit: 1 }, connType);
      return { success: true, message: 'Подключение к Sigur успешно', connection: connType };
    } catch (error) {
      const { AxiosError } = await import('axios');
      const message = error instanceof AxiosError
        ? `Ошибка подключения: ${error.message}${error.response?.data ? ' — ' + JSON.stringify(error.response.data) : ''}`
        : `Ошибка: ${(error as Error).message}`;
      return { success: false, message, connection: connType };
    }
  }

  /** Получить список сотрудников */
  async getEmployees(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/employees', filters, connection, 1000);
  }

  /** Получить сотрудников по списку отделов */
  async getEmployeesByDepartments(
    departmentIds: number[],
    connection?: ConnectionType,
    onProgress?: (loaded: number, deptIndex: number, totalDepts: number) => void,
  ): Promise<Record<string, unknown>[]> {
    const allEmployees: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    const total = departmentIds.length;
    if (total === 0) return allEmployees;

    const CONCURRENCY = Math.min(8, total);
    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= total) return;

        const deptId = departmentIds[currentIndex];
        const items = await this.fetchAllPaginated<Record<string, unknown>>(
          '/api/v1/employees',
          { departmentId: deptId },
          connection,
          1000,
        );

        for (const emp of items) {
          const id = emp.id as number;
          if (id && !seen.has(id)) {
            seen.add(id);
            allEmployees.push(emp);
          }
        }

        completed++;
        if (onProgress) onProgress(allEmployees.length, completed, total);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    console.log(`[sigur] fetched ${allEmployees.length} employees from ${total} departments`);
    return allEmployees;
  }

  /** Получить сотрудников одним запросом (для preview) */
  async getEmployeesLimited(maxItems = 3000, connection?: ConnectionType) {
    const response = await this.request<any>('/api/v1/employees', { limit: maxItems }, connection);
    const items = response?.data || response || [];
    return Array.isArray(items) ? items : [];
  }

  /** Получить сотрудников с кэшем (TTL 5 мин, дедупликация запросов) */
  async getEmployeesCached(connection?: ConnectionType): Promise<Record<string, unknown>[]> {
    if (this.employeeCache && (Date.now() - this.employeeCache.fetchedAt) < this.CACHE_TTL) {
      return this.employeeCache.data;
    }
    if (this.employeeFetchPromise) {
      console.log('[sigur] waiting for ongoing employee fetch...');
      return this.employeeFetchPromise;
    }
    console.log('[sigur] fetching employees (no cache)...');
    this.employeeFetchPromise = this.getEmployees(undefined, connection)
      .then(data => {
        const employees = data as Record<string, unknown>[];
        this.employeeCache = { data: employees, fetchedAt: Date.now() };
        console.log('[sigur] cached', employees.length, 'employees');
        return employees;
      })
      .finally(() => {
        this.employeeFetchPromise = null;
      });
    return this.employeeFetchPromise;
  }

  /** Получить справочник отделов с кэшем: departmentId → name */
  async getDepartmentMapCached(connection?: ConnectionType): Promise<Map<number, string>> {
    if (this.departmentCache && (Date.now() - this.departmentCache.fetchedAt) < this.CACHE_TTL) {
      return this.departmentCache.map;
    }
    console.log('[sigur] fetching departments for cache...');
    const response = await this.request<any>('/api/v1/departments', { limit: 500 }, connection);
    const items = response?.data || response || [];
    const map = new Map<number, string>();
    if (Array.isArray(items)) {
      for (const dept of items) {
        if (typeof dept.id === 'number' && typeof dept.name === 'string') {
          map.set(dept.id, dept.name);
        }
      }
    }
    this.departmentCache = { map, fetchedAt: Date.now() };
    console.log('[sigur] cached', map.size, 'departments');
    return map;
  }

  /** Получить список отделов */
  async getDepartments(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/departments', undefined, connection);
  }

  /** Получить список карт доступа */
  async getCards(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/cards', filters, connection);
  }

  /** Получить привязки сотрудников к картам */
  async getCardBindings(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/bindings/employees-cards', undefined, connection);
  }

  /** Получить список точек доступа */
  async getAccessPoints(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/accesspoints', undefined, connection);
  }

  async getAccessPointMapCached(connection?: ConnectionType): Promise<Map<number, string>> {
    if (this.accessPointCache && (Date.now() - this.accessPointCache.fetchedAt) < this.CACHE_TTL) {
      return this.accessPointCache.map;
    }

    console.log('[sigur] fetching access points for cache...');
    const accessPoints = await this.getAccessPoints(connection) as Record<string, unknown>[];
    const map = new Map<number, string>();

    for (const point of accessPoints) {
      if (typeof point.id === 'number' && typeof point.name === 'string') {
        map.set(point.id, point.name);
      }
    }

    this.accessPointCache = { map, fetchedAt: Date.now() };
    console.log('[sigur] cached', map.size, 'access points');
    return map;
  }

  /** Получить список режимов доступа */
  async getAccessRules(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/accessrules', undefined, connection);
  }

  /** Получить список зон доступа */
  async getZones(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/zones', undefined, connection);
  }

  private isRawPassEvent(raw: Record<string, unknown>): boolean {
    const direction = raw.direction;
    const accessObjectId = raw.accessObjectId;
    const timestamp = raw.timestamp;

    return (
      (direction === 'IN' || direction === 'OUT') &&
      typeof accessObjectId === 'number' &&
      typeof timestamp === 'string'
    );
  }

  private async enrichRawEvents(
    rawEvents: Record<string, unknown>[],
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>[]> {
    if (rawEvents.length === 0) return [];

    const [employees, accessPointMap] = await Promise.all([
      this.getEmployeesCached(connection),
      this.getAccessPointMapCached(connection),
    ]);

    const employeeById = new Map<number, Record<string, unknown>>();
    for (const employee of employees) {
      if (typeof employee.id === 'number') {
        employeeById.set(employee.id, employee);
      }
    }

    return rawEvents
      .filter(raw => this.isRawPassEvent(raw))
      .map(raw => {
        const employeeId = raw.accessObjectId as number;
        const employee = employeeById.get(employeeId);
        const accessPointId = typeof raw.accessPointId === 'number' ? raw.accessPointId : null;
        const empName = typeof employee?.name === 'string' ? employee.name : '';

        return {
          id: raw.id,
          eventType: 'PASS_DETECTED',
          timestamp: raw.timestamp,
          data: {
            direction: raw.direction,
            employeeId,
            accessPointId,
            cardKey: null,
          },
          additionalData: {
            accessObject: {
              type: 'EMPLOYEE',
              data: {
                id: employeeId,
                name: empName,
                position: typeof employee?.position === 'string' ? employee.position : undefined,
              },
            },
            accessPoint: accessPointId != null ? {
              id: accessPointId,
              name: accessPointMap.get(accessPointId) || null,
            } : undefined,
          },
        };
      });
  }

  async getRawEvents(startTime?: string, endTime?: string, connection?: ConnectionType, extraParams?: Record<string, any>) {
    const pageSize = extraParams?.pageSize || 1000;
    const params: Record<string, any> = {};
    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);
    if (extraParams) {
      const { pageSize: _, ...rest } = extraParams;
      if (Object.keys(rest).length > 0) Object.assign(params, rest);
    }
    return this.fetchAllByLastId('/api/v1/events', params, connection, pageSize);
  }

  /** Маппинг строковых eventType → числовых eventTypeId для raw API */
  private static readonly EVENT_TYPE_ID_MAP: Record<string, number> = {
    'PASS_DETECTED': 6,
    'PASS_DENY': 12,
  };

  /** Получить события с фильтрами по времени.
   *  Использует raw /events + enrichment (parsed endpoint ненадёжен). */
  async getEvents(startTime?: string, endTime?: string, connection?: ConnectionType, eventType?: string, extraParams?: Record<string, any>) {
    const pageSize = extraParams?.pageSize || 3000;
    const params: Record<string, any> = {};
    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);
    if (eventType) {
      const typeId = SigurDataService.EVENT_TYPE_ID_MAP[eventType];
      if (typeId) params.eventTypeId = typeId;
    }
    if (extraParams) {
      const { pageSize: _, ...rest } = extraParams;
      if (Object.keys(rest).length > 0) Object.assign(params, rest);
    }
    const rawEvents = await this.fetchAllByLastId<Record<string, unknown>>('/api/v1/events', params, connection, pageSize);
    console.log(`[sigur] getEvents raw: ${rawEvents.length} events`);
    return this.enrichRawEvents(rawEvents, connection);
  }

  /** Получить ограниченное кол-во событий (для preview) */
  async getEventsLimited(startTime?: string, endTime?: string, maxItems = 200, connection?: ConnectionType) {
    const params: Record<string, any> = { limit: maxItems };
    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);
    const response = await this.request<any>('/api/v1/events/parsed', params, connection);
    const items = response?.data || response || [];
    return Array.isArray(items) ? items.slice(0, maxItems) : [];
  }

  /** Получить типы событий */
  async getEventTypes(connection?: ConnectionType) {
    return this.request('/api/v1/events/types', undefined, connection);
  }

  /** Попытка получить должности из Sigur */
  async getPositions(connection?: ConnectionType): Promise<Record<string, unknown>[] | null> {
    try {
      return await this.fetchAllPaginated('/api/v1/positions', undefined, connection) as Record<string, unknown>[];
    } catch {
      console.warn('[sigur] /api/v1/positions not available');
      return null;
    }
  }

  /** Получить один отдел по ID */
  async getDepartmentById(id: number, connection?: ConnectionType) {
    return this.request<Record<string, unknown>>(`/api/v1/departments/${id}`, undefined, connection);
  }

  /** Получить одного сотрудника по ID */
  async getEmployeeById(id: number, connection?: ConnectionType) {
    return this.request<Record<string, unknown>>(`/api/v1/employees/${id}`, undefined, connection);
  }
}
