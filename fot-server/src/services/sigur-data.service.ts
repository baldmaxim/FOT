import { SigurServiceBase, ConnectionType, SIGUR_TIMEOUTS } from './sigur-base.service.js';
import { env } from '../config/env.js';

const SIGUR_EVENT_CHUNK_MS = Math.max(
  5 * 60 * 1000,
  Number.parseInt(env.SIGUR_EVENT_CHUNK_MS, 10) || 30 * 60 * 1000,
);
const SIGUR_EVENT_PAGE_SIZE = Math.max(
  100,
  Number.parseInt(env.SIGUR_EVENT_PAGE_SIZE, 10) || 1000,
);
const SIGUR_EVENT_CHUNK_PARALLELISM = Math.max(
  1,
  Math.min(8, Number.parseInt(env.SIGUR_EVENT_CHUNK_PARALLELISM, 10) || 3),
);

export class SigurDataService extends SigurServiceBase {
  private employeeCache: { data: Record<string, unknown>[]; fetchedAt: number; complete: boolean } | null = null;
  private employeeFetchPromise: Promise<Record<string, unknown>[]> | null = null;
  private employeeCountCache: { map: Map<number, number>; fetchedAt: number } | null = null;
  private employeeCountFetchPromise: Promise<Map<number, number>> | null = null;
  private departmentListCache: { data: Record<string, unknown>[]; fetchedAt: number } | null = null;
  private departmentFetchPromise: Promise<Record<string, unknown>[]> | null = null;
  private departmentCache: { map: Map<number, string>; fetchedAt: number } | null = null;
  private accessPointCache: { map: Map<number, string>; fetchedAt: number } | null = null;
  private accessRuleCache: { map: Map<number, string>; fetchedAt: number } | null = null;
  private positionCache: { data: Array<{ id: number; name: string }>; fetchedAt: number } | null = null;
  private cardListCache: { data: Record<string, unknown>[]; fetchedAt: number } | null = null;
  private cardListFetchPromise: Promise<Record<string, unknown>[]> | null = null;
  private readonly CARD_LIST_TTL = 60 * 1000; // 1 минута — карты в Sigur не меняются часто
  // Базовый TTL для employees: 5 мин. Сотрудники добавляются часто; для остальных
  // дифференцированные TTL ниже — структура (отделы, точки, правила) меняется редко,
  // и Socket.IO push при admin CRUD инвалидирует кэш мгновенно.
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly EMPLOYEE_COUNT_CACHE_TTL = 30 * 60 * 1000;
  private readonly DEPARTMENT_CACHE_TTL = 60 * 60 * 1000;
  private readonly ACCESS_POINT_CACHE_TTL = 60 * 60 * 1000;
  private readonly ACCESS_RULE_CACHE_TTL = 4 * 60 * 60 * 1000;
  private readonly POSITION_CACHE_TTL = 4 * 60 * 60 * 1000;
  private readonly EVENT_CHUNK_MS = SIGUR_EVENT_CHUNK_MS;
  private readonly EVENT_CHUNK_OVERLAP_MS = 60 * 1000;
  private static readonly SIGUR_TIMEZONE_OFFSET_MS = 3 * 60 * 60 * 1000;

  invalidateEmployeeCache(): void {
    this.employeeCache = null;
    this.employeeFetchPromise = null;
    this.employeeCountCache = null;
    this.employeeCountFetchPromise = null;
  }

  private setEmployeeCache(data: Record<string, unknown>[], complete: boolean): void {
    this.employeeCache = {
      data: [...data],
      fetchedAt: Date.now(),
      complete,
    };
  }

  invalidateDepartmentCache(): void {
    this.departmentListCache = null;
    this.departmentFetchPromise = null;
    this.departmentCache = null;
    this.employeeCountCache = null;
    this.employeeCountFetchPromise = null;
  }

  invalidateAccessPointCache(): void {
    this.accessPointCache = null;
  }

  invalidateAccessRuleCache(): void {
    this.accessRuleCache = null;
  }

  invalidatePositionCache(): void {
    this.positionCache = null;
  }

  invalidateCardListCache(): void {
    this.cardListCache = null;
    this.cardListFetchPromise = null;
  }

  invalidateLiveAdminCaches(): void {
    this.invalidateEmployeeCache();
    this.invalidateDepartmentCache();
    this.invalidateAccessPointCache();
    this.invalidateAccessRuleCache();
    this.invalidatePositionCache();
    this.invalidateCardListCache();
  }

  async testConnection(
    connection?: ConnectionType,
  ): Promise<{ success: boolean; message: string; connection: ConnectionType }> {
    const connType = await this.resolveConnectionType(connection);

    try {
      await this.authenticate(connType);
      await this.request('/api/v1/departments', { limit: 1 }, connType, SIGUR_TIMEOUTS.quick);
      return {
        success: true,
        message: 'Подключение к Sigur успешно',
        connection: connType,
      };
    } catch (error) {
      const { AxiosError } = await import('axios');
      const message = error instanceof AxiosError
        ? `Ошибка подключения: ${error.message}${error.response?.data ? ' - ' + JSON.stringify(error.response.data) : ''}`
        : `Ошибка: ${(error as Error).message}`;

      return { success: false, message, connection: connType };
    }
  }

  async getEmployees(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated(
      '/api/v1/employees',
      { excludeFields: 'photo', ...(filters || {}) },
      connection,
      3000,
    );
  }

  async getEmployeesPage(
    filters?: Record<string, any>,
    pagination?: { limit?: number; offset?: number },
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>[]> {
    const params = {
      excludeFields: 'photo',
      ...(filters || {}),
      limit: Math.max(1, Math.min(3000, pagination?.limit || 200)),
      offset: Math.max(0, pagination?.offset || 0),
    };
    const response = await this.request<any>('/api/v1/employees', params, connection);
    const items = response?.data || response || [];
    return Array.isArray(items) ? items : [];
  }

  async getEmployeesCount(filters?: Record<string, any>, connection?: ConnectionType): Promise<unknown> {
    return this.request('/api/v1/employees/count', filters, connection);
  }

  private normalizeEmployeeCountGroups(raw: unknown): Map<number, number> {
    const counts = new Map<number, number>();
    if (!Array.isArray(raw)) {
      return counts;
    }

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const rawGroup = row.groupByField ?? row.groupByValue ?? row.departmentId ?? row.department_id ?? null;
      const rawCount = row.employeeCount ?? row.count ?? row.value ?? null;
      const departmentId = typeof rawGroup === 'number'
        ? rawGroup
        : (typeof rawGroup === 'string' && rawGroup.trim() ? Number(rawGroup) : NaN);
      const employeeCount = typeof rawCount === 'number'
        ? rawCount
        : (typeof rawCount === 'string' && rawCount.trim() ? Number(rawCount) : NaN);

      if (!Number.isFinite(departmentId) || departmentId <= 0 || !Number.isFinite(employeeCount)) {
        continue;
      }

      counts.set(departmentId, employeeCount);
    }

    return counts;
  }

  async getEmployeeCountByDepartmentCached(connection?: ConnectionType): Promise<Map<number, number>> {
    if (this.employeeCountCache && (Date.now() - this.employeeCountCache.fetchedAt) < this.EMPLOYEE_COUNT_CACHE_TTL) {
      return new Map(this.employeeCountCache.map);
    }

    if (this.employeeCountFetchPromise) {
      return new Map(await this.employeeCountFetchPromise);
    }

    this.employeeCountFetchPromise = this.getEmployeesCount({ groupBy: 'departmentId' }, connection)
      .then(rawCounts => {
        const map = this.normalizeEmployeeCountGroups(rawCounts);
        this.employeeCountCache = { map: new Map(map), fetchedAt: Date.now() };
        return map;
      })
      .finally(() => {
        this.employeeCountFetchPromise = null;
      });

    return new Map(await this.employeeCountFetchPromise);
  }

  private async fetchEmployeesForDepartment(
    departmentId: number,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>[]> {
    const pageSizes = [1000, 250, 50];
    let lastError: unknown = null;

    for (const pageSize of pageSizes) {
      try {
        if (pageSize !== pageSizes[0]) {
          console.warn(
            `[sigur] retrying department ${departmentId} employees with smaller page size ${pageSize}`,
          );
        }

        return await this.fetchAllPaginated<Record<string, unknown>>(
          '/api/v1/employees',
          { departmentId, excludeFields: 'photo' },
          connection,
          pageSize,
        );
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to fetch employees for department ${departmentId}`);
  }

  async getEmployeesByDepartments(
    departmentIds: number[],
    connection?: ConnectionType,
    onProgress?: (loaded: number, deptIndex: number, totalDepts: number) => void,
  ): Promise<Record<string, unknown>[]> {
    const allEmployees: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    const total = departmentIds.length;

    if (total === 0) return allEmployees;

    const concurrency = Math.min(16, total);
    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= total) return;

        const deptId = departmentIds[currentIndex];
        let items: Record<string, unknown>[] = [];
        try {
          items = await this.fetchEmployeesForDepartment(deptId, connection);
        } catch (error) {
          console.warn(`[sigur] failed to fetch employees for department ${deptId}:`, error);
        }

        for (const employee of items) {
          const id = employee.id as number;
          if (id && !seen.has(id)) {
            seen.add(id);
            allEmployees.push(employee);
          }
        }

        completed++;
        if (completed % 12 === 0 || items.length > 0 || completed === total) {
          this.setEmployeeCache(allEmployees, false);
        }
        if (onProgress) onProgress(allEmployees.length, completed, total);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    console.log(`[sigur] fetched ${allEmployees.length} employees from ${total} departments`);
    return allEmployees;
  }

  private async getDepartmentIds(connection?: ConnectionType): Promise<number[]> {
    const departments = await this.getDepartmentsCached(connection);
    return departments
      .map(department => typeof department.id === 'number' ? department.id : Number(department.id))
      .filter((id): id is number => Number.isFinite(id) && id > 0);
  }

  async getEmployeesLimited(maxItems = 3000, connection?: ConnectionType) {
    const response = await this.request<any>(
      '/api/v1/employees',
      { limit: maxItems, excludeFields: 'photo' },
      connection,
    );
    const items = response?.data || response || [];
    return Array.isArray(items) ? items : [];
  }

  async getEmployeesCached(connection?: ConnectionType): Promise<Record<string, unknown>[]> {
    if (
      this.employeeCache
      && this.employeeCache.complete
      && (Date.now() - this.employeeCache.fetchedAt) < this.CACHE_TTL
    ) {
      return this.employeeCache.data;
    }

    if (this.employeeFetchPromise) {
      console.log('[sigur] waiting for ongoing employee fetch...');
      return this.employeeFetchPromise;
    }

    console.log('[sigur] fetching employees (no cache)...');
    this.setEmployeeCache([], false);
    this.employeeFetchPromise = (async () => {
      let employees: Record<string, unknown>[] = [];

      // Быстрый путь: один пагинированный запрос /api/v1/employees без departmentId
      try {
        const fullListTimeoutMs = 60_000;
        const fullList = await Promise.race([
          this.getEmployees(undefined, connection) as Promise<Record<string, unknown>[]>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('full employees endpoint timeout')), fullListTimeoutMs),
          ),
        ]);
        if (Array.isArray(fullList) && fullList.length > 0) {
          employees = fullList;
          console.log(`[sigur] employees fetched via full endpoint: ${employees.length}`);
        } else {
          console.warn('[sigur] full employees endpoint returned 0; falling back to per-department scan');
        }
      } catch (error) {
        console.warn(
          '[sigur] full employees endpoint failed, falling back to per-department scan:',
          (error as Error).message,
        );
      }

      // Медленный fallback: пагинация по каждому отделу
      if (employees.length === 0) {
        const departmentIds = await this.getDepartmentIds(connection);
        if (departmentIds.length > 0) {
          console.log(`[sigur] building employee cache from ${departmentIds.length} departments`);
          employees = await this.getEmployeesByDepartments(departmentIds, connection);
        } else {
          console.warn('[sigur] no departments found; employee cache will be empty');
        }
      }

      this.setEmployeeCache(employees, true);
      console.log('[sigur] cached', employees.length, 'employees');
      return employees;
    })().finally(() => {
      this.employeeFetchPromise = null;
    });

    return this.employeeFetchPromise;
  }

  findEmployeeInCache(id: number): Record<string, unknown> | null {
    if (!this.employeeCache || (Date.now() - this.employeeCache.fetchedAt) >= this.CACHE_TTL) {
      return null;
    }

    return this.employeeCache.data.find(employee => employee.id === id) || null;
  }

  getEmployeesCacheSnapshot(): Record<string, unknown>[] | null {
    if (!this.employeeCache || (Date.now() - this.employeeCache.fetchedAt) >= this.CACHE_TTL) {
      return null;
    }

    return this.employeeCache.data;
  }

  isEmployeeCacheLoading(): boolean {
    return this.employeeFetchPromise !== null;
  }

  getEmployeesCacheMeta(): { count: number; loading: boolean; complete: boolean } {
    const isFresh = !!this.employeeCache && (Date.now() - this.employeeCache.fetchedAt) < this.CACHE_TTL;
    return {
      count: isFresh ? this.employeeCache?.data.length || 0 : 0,
      loading: this.isEmployeeCacheLoading(),
      complete: isFresh ? this.employeeCache?.complete === true : false,
    };
  }

  warmEmployeesCache(connection?: ConnectionType): void {
    void this.getEmployeesCached(connection).catch(error => {
      console.warn('[sigur] failed to warm employee cache:', error);
    });
  }

  async getDepartmentMapCached(connection?: ConnectionType): Promise<Map<number, string>> {
    if (this.departmentCache && (Date.now() - this.departmentCache.fetchedAt) < this.DEPARTMENT_CACHE_TTL) {
      return this.departmentCache.map;
    }

    console.log('[sigur] fetching departments for cache...');
    const items = await this.getDepartmentsCached(connection);
    const map = new Map<number, string>();

    if (Array.isArray(items)) {
      for (const department of items) {
        if (typeof department.id === 'number' && typeof department.name === 'string') {
          map.set(department.id, department.name);
        }
      }
    }

    this.departmentCache = { map, fetchedAt: Date.now() };
    console.log('[sigur] cached', map.size, 'departments');
    return map;
  }

  async getDepartmentsCached(connection?: ConnectionType): Promise<Record<string, unknown>[]> {
    if (this.departmentListCache && (Date.now() - this.departmentListCache.fetchedAt) < this.DEPARTMENT_CACHE_TTL) {
      return this.departmentListCache.data;
    }

    if (this.departmentFetchPromise) {
      console.log('[sigur] waiting for ongoing department fetch...');
      return this.departmentFetchPromise;
    }

    console.log('[sigur] fetching departments list (no cache)...');
    this.departmentFetchPromise = this.getDepartments(connection)
      .then(items => {
        const data = items as Record<string, unknown>[];
        this.departmentListCache = { data, fetchedAt: Date.now() };
        return data;
      })
      .finally(() => {
        this.departmentFetchPromise = null;
      });

    return this.departmentFetchPromise;
  }

  async getDepartments(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/departments', undefined, connection);
  }

  async getCards(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/cards', filters, connection);
  }

  /** Кэшированная версия getCards без фильтров — для матчинга карт. TTL 60с. */
  async getCardsCached(connection?: ConnectionType): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    if (this.cardListCache && (now - this.cardListCache.fetchedAt) < this.CARD_LIST_TTL) {
      return this.cardListCache.data;
    }
    if (this.cardListFetchPromise) {
      return this.cardListFetchPromise;
    }
    this.cardListFetchPromise = (async () => {
      const data = await this.getCards(undefined, connection) as Record<string, unknown>[];
      this.cardListCache = { data, fetchedAt: Date.now() };
      return data;
    })().finally(() => {
      this.cardListFetchPromise = null;
    });
    return this.cardListFetchPromise;
  }

  async getCardBindings(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/bindings/employees-cards', filters, connection);
  }

  async getAccessPoints(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/accesspoints', undefined, connection);
  }

  async getAccessPointMapCached(connection?: ConnectionType): Promise<Map<number, string>> {
    if (this.accessPointCache && (Date.now() - this.accessPointCache.fetchedAt) < this.ACCESS_POINT_CACHE_TTL) {
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

  async getAccessPointOptionsCached(connection?: ConnectionType): Promise<Array<{ id: number; name: string }>> {
    const accessPointMap = await this.getAccessPointMapCached(connection);
    return [...accessPointMap.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  }

  async getAccessRules(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/accessrules', undefined, connection);
  }

  async getAccessRuleMapCached(connection?: ConnectionType): Promise<Map<number, string>> {
    if (this.accessRuleCache && (Date.now() - this.accessRuleCache.fetchedAt) < this.ACCESS_RULE_CACHE_TTL) {
      return this.accessRuleCache.map;
    }

    console.log('[sigur] fetching access rules for cache...');
    const accessRules = await this.getAccessRules(connection) as Record<string, unknown>[];
    const map = new Map<number, string>();

    for (const rule of accessRules) {
      if (typeof rule.id === 'number' && typeof rule.name === 'string') {
        map.set(rule.id, rule.name);
      }
    }

    this.accessRuleCache = { map, fetchedAt: Date.now() };
    console.log('[sigur] cached', map.size, 'access rules');
    return map;
  }

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

    const beforeFilter = rawEvents.length;
    const passEvents = rawEvents.filter(raw => this.isRawPassEvent(raw));
    const dropped = beforeFilter - passEvents.length;

    if (dropped > 0) {
      const reasons = { noDir: 0, badDir: 0, noAOId: 0, badAOIdType: 0, noTs: 0 };
      const samples: string[] = [];

      for (const raw of rawEvents) {
        if (this.isRawPassEvent(raw)) continue;

        if (!raw.direction) reasons.noDir++;
        else if (raw.direction !== 'IN' && raw.direction !== 'OUT') reasons.badDir++;

        if (raw.accessObjectId === undefined) reasons.noAOId++;
        else if (typeof raw.accessObjectId !== 'number') reasons.badAOIdType++;

        if (typeof raw.timestamp !== 'string') reasons.noTs++;

        if (samples.length < 3) {
          samples.push(
            `id=${raw.id} dir=${raw.direction} aoId=${raw.accessObjectId}(${typeof raw.accessObjectId}) ts=${typeof raw.timestamp}`,
          );
        }
      }

      console.log(
        `[enrichRawEvents] dropped ${dropped}/${beforeFilter} by isRawPassEvent: ${JSON.stringify(reasons)} samples: ${samples.join(' | ')}`,
      );
    }

    let unmatchedEmployeeIds = 0;
    const unmatchedIdSamples: number[] = [];

    const result = passEvents.map(raw => {
      const employeeId = raw.accessObjectId as number;
      const employee = employeeById.get(employeeId);
      const accessPointId = typeof raw.accessPointId === 'number' ? raw.accessPointId : null;
      const employeeName = typeof employee?.name === 'string' ? employee.name : '';

      if (!employee) {
        unmatchedEmployeeIds++;
        if (unmatchedIdSamples.length < 10) unmatchedIdSamples.push(employeeId);
      }

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
              name: employeeName,
              position: typeof employee?.position === 'string' ? employee.position : undefined,
            },
          },
          accessPoint: accessPointId != null
            ? {
                id: accessPointId,
                name: accessPointMap.get(accessPointId) || null,
              }
            : undefined,
        },
      };
    });

    if (unmatchedEmployeeIds > 0) {
      console.log(
        `[enrichRawEvents] ${unmatchedEmployeeIds}/${passEvents.length} events have no employee match. Unmatched accessObjectIds: [${unmatchedIdSamples.join(', ')}]`,
      );
    }

    console.log(
      `[enrichRawEvents] pipeline: raw=${rawEvents.length} -> passFilter=${passEvents.length} -> enriched=${result.length} (employeeCache=${employeeById.size})`,
    );

    return result;
  }

  private parseEventBoundary(time?: string): Date | null {
    if (!time) return null;

    const parsed = new Date(this.ensureTimezone(time));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private formatSigurDateTime(date: Date): string {
    const shifted = new Date(date.getTime() + SigurDataService.SIGUR_TIMEZONE_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    const hours = String(shifted.getUTCHours()).padStart(2, '0');
    const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
    const seconds = String(shifted.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  }

  private dedupeEventsById<T extends Record<string, unknown>>(events: T[]): T[] {
    const deduped: T[] = [];
    const seen = new Set<string>();

    for (const event of events) {
      const key = typeof event.id === 'number' || typeof event.id === 'string'
        ? String(event.id)
        : JSON.stringify([
            event.timestamp,
            event.accessObjectId,
            event.direction,
            event.accessPointId,
          ]);

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }

    return deduped;
  }

  private async fetchEventsByChunks<T extends Record<string, unknown>>(
    startTime: string | undefined,
    endTime: string | undefined,
    params: Record<string, any>,
    connection?: ConnectionType,
    pageSize = 3000,
  ): Promise<T[]> {
    const startDate = this.parseEventBoundary(startTime);
    const endDate = this.parseEventBoundary(endTime);

    if (!startDate || !endDate || endDate.getTime() <= startDate.getTime()) {
      return this.fetchAllByLastId<T>('/api/v1/events', params, connection, pageSize);
    }

    const baseParams = { ...params };
    delete baseParams.startTime;
    delete baseParams.endTime;

    const rangeStart = startDate.getTime();
    const rangeEnd = endDate.getTime();

    // Сначала собираем план chunks (без HTTP), затем запускаем воркер-пул.
    // Каждый chunk тащит fetchAllByLastId с ретраями, sigurLimiter сериализует
    // фактические HTTP, поэтому суммарный RPS не растёт — wall-clock падает,
    // пока один chunk ждёт ответа Sigur, другой воркер успевает занять слот.
    interface ChunkPlan {
      index: number;
      params: Record<string, unknown>;
      startLabel: string;
      endLabel: string;
    }
    const plans: ChunkPlan[] = [];
    let chunkStart = rangeStart;
    while (chunkStart <= rangeEnd) {
      const chunkEnd = Math.min(chunkStart + this.EVENT_CHUNK_MS - 1, rangeEnd);
      const startLabel = this.ensureTimezone(this.formatSigurDateTime(new Date(chunkStart)));
      const endLabel = this.ensureTimezone(this.formatSigurDateTime(new Date(chunkEnd)));
      plans.push({
        index: plans.length + 1,
        params: { ...baseParams, startTime: startLabel, endTime: endLabel },
        startLabel,
        endLabel,
      });
      if (chunkEnd >= rangeEnd) break;
      chunkStart = Math.max(chunkEnd + 1 - this.EVENT_CHUNK_OVERLAP_MS, rangeStart);
    }

    const CHUNK_MAX_ATTEMPTS = 3;
    const CHUNK_RETRY_BASE_MS = 500;
    const results: T[][] = new Array(plans.length).fill(null).map(() => []);
    let failedChunks = 0;
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= plans.length) return;
        const plan = plans[i];
        console.log(
          `[sigur chunk] window ${plan.index}: ${plan.startLabel} -> ${plan.endLabel}`,
        );
        let done = false;
        for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS && !done; attempt++) {
          try {
            const events = await this.fetchAllByLastId<T>(
              '/api/v1/events',
              plan.params,
              connection,
              pageSize,
            );
            console.log(
              `[sigur chunk] window ${plan.index} attempt ${attempt} got ${events.length} events`,
            );
            results[i] = events;
            done = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (attempt < CHUNK_MAX_ATTEMPTS) {
              const backoff = CHUNK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
              console.warn(
                `[sigur chunk] window ${plan.index} attempt ${attempt} failed: ${message}. Retrying in ${backoff}ms`,
              );
              await new Promise(resolve => setTimeout(resolve, backoff));
            } else {
              failedChunks++;
              console.warn(
                `[sigur chunk] window ${plan.index} FAILED permanently after ${attempt} attempts (${plan.startLabel} -> ${plan.endLabel}): ${message}`,
              );
            }
          }
        }
      }
    };

    const workerCount = Math.min(SIGUR_EVENT_CHUNK_PARALLELISM, plans.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    const allEvents: T[] = results.flat();
    const dedupedEvents = this.dedupeEventsById(allEvents);
    console.log(
      `[sigur chunk] combined ${allEvents.length} events into ${dedupedEvents.length} unique events (chunks=${plans.length} parallelism=${workerCount}` +
        (failedChunks > 0 ? `, failed=${failedChunks}` : '') +
        `)`,
    );

    return dedupedEvents;
  }

  async getRawEvents(
    startTime?: string,
    endTime?: string,
    connection?: ConnectionType,
    extraParams?: Record<string, any>,
  ) {
    const pageSize = extraParams?.pageSize || SIGUR_EVENT_PAGE_SIZE;
    const params: Record<string, any> = {};

    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);

    if (extraParams) {
      const { pageSize: _pageSize, ...rest } = extraParams;
      if (Object.keys(rest).length > 0) Object.assign(params, rest);
    }

    return this.fetchEventsByChunks(startTime, endTime, params, connection, pageSize);
  }

  private static readonly EVENT_TYPE_ID_MAP: Record<string, number> = {
    PASS_DETECTED: 6,
    PASS_DENY: 12,
  };

  // Обратная карта id → имя для известных типов. Для незнакомых id маппер
  // использует строку 'TYPE_<id>' — такие события всё равно попадают в
  // skud_event_failures, и оператор увидит реальный тип после ручной классификации.
  private static readonly EVENT_NAME_BY_ID: Record<number, string> = (() => {
    const map: Record<number, string> = {};
    for (const [name, id] of Object.entries(SigurDataService.EVENT_TYPE_ID_MAP)) {
      map[id] = name;
    }
    return map;
  })();

  /**
   * Обогащает raw-события Sigur и делит их на success (PASS_DETECTED) и failures
   * (всё остальное). В отличие от `enrichRawEvents`, не отбрасывает события с
   * `direction not in ('IN','OUT')` или с отсутствующим `accessObjectId` — для
   * PASS_DENY и таймаутов эти поля часто пустые.
   *
   * Возвращаемые объекты имеют тот же формат, что и enrichRawEvents (eventType,
   * timestamp, data, additionalData), и совместимы с `mapSigurEvent`.
   */
  private async enrichAllRawEvents(
    rawEvents: Record<string, unknown>[],
    connection?: ConnectionType,
  ): Promise<{ pass: Record<string, unknown>[]; failures: Record<string, unknown>[] }> {
    if (rawEvents.length === 0) return { pass: [], failures: [] };

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

    const pass: Record<string, unknown>[] = [];
    const failures: Record<string, unknown>[] = [];

    for (const raw of rawEvents) {
      const isPass = this.isRawPassEvent(raw);
      const accessObjectId = typeof raw.accessObjectId === 'number' ? raw.accessObjectId : null;
      const employee = accessObjectId != null ? employeeById.get(accessObjectId) : undefined;
      const accessPointId = typeof raw.accessPointId === 'number' ? raw.accessPointId : null;
      const employeeName = typeof employee?.name === 'string' ? employee.name : '';

      // Имя типа: для известных id — каноническое имя; иначе TYPE_<id> (или null).
      const rawTypeId = typeof raw.eventTypeId === 'number' ? raw.eventTypeId : null;
      const knownName = rawTypeId != null ? SigurDataService.EVENT_NAME_BY_ID[rawTypeId] : undefined;
      const eventType = isPass ? 'PASS_DETECTED' : (knownName ?? (rawTypeId != null ? `TYPE_${rawTypeId}` : 'UNKNOWN'));

      const enriched: Record<string, unknown> = {
        id: raw.id,
        eventType,
        eventTypeId: rawTypeId,
        timestamp: raw.timestamp,
        description: typeof raw.description === 'string' ? raw.description : null,
        data: {
          direction: raw.direction,
          employeeId: accessObjectId,
          accessPointId,
          cardKey: typeof raw.cardKey === 'string' ? raw.cardKey : null,
          reason: typeof (raw as Record<string, any>).reason === 'string' ? (raw as Record<string, any>).reason : null,
          failureReason: typeof (raw as Record<string, any>).failureReason === 'string' ? (raw as Record<string, any>).failureReason : null,
        },
        additionalData: {
          accessObject: accessObjectId != null
            ? {
                type: 'EMPLOYEE',
                data: {
                  id: accessObjectId,
                  name: employeeName,
                  position: typeof employee?.position === 'string' ? employee.position : undefined,
                },
              }
            : undefined,
          accessPoint: accessPointId != null
            ? {
                id: accessPointId,
                name: accessPointMap.get(accessPointId) || null,
              }
            : undefined,
        },
      };

      if (isPass) pass.push(enriched);
      else failures.push(enriched);
    }

    console.log(
      `[enrichAllRawEvents] raw=${rawEvents.length} -> pass=${pass.length} failures=${failures.length}`,
    );
    return { pass, failures };
  }

  async getEvents(
    startTime?: string,
    endTime?: string,
    connection?: ConnectionType,
    eventType?: string,
    extraParams?: Record<string, any>,
  ) {
    const pageSize = extraParams?.pageSize || SIGUR_EVENT_PAGE_SIZE;
    const params: Record<string, any> = {};

    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);

    if (eventType) {
      const typeId = SigurDataService.EVENT_TYPE_ID_MAP[eventType];
      if (typeId) params.eventTypeId = typeId;
    }

    if (extraParams) {
      const { pageSize: _pageSize, ...rest } = extraParams;
      if (Object.keys(rest).length > 0) Object.assign(params, rest);
    }

    const rawEvents = await this.fetchEventsByChunks<Record<string, unknown>>(
      startTime,
      endTime,
      params,
      connection,
      pageSize,
    );

    console.log(`[sigur] getEvents raw: ${rawEvents.length} events`);
    return this.enrichRawEvents(rawEvents, connection);
  }

  /**
   * Incremental polling: запрашивает события строго с id > lastEventId.
   * Sigur использует индексный seek по PK, без фильтра по timestamp — на пустых
   * тиках возвращает [] за миллисекунды. Полная замена window-by-time для polling.
   */
  async getEventsByLastId(
    lastEventId: number,
    eventType?: string,
    connection?: ConnectionType,
    pageSize?: number,
  ): Promise<Record<string, unknown>[]> {
    const params: Record<string, any> = { lastId: lastEventId };
    if (eventType) {
      const typeId = SigurDataService.EVENT_TYPE_ID_MAP[eventType];
      if (typeId) params.eventTypeId = typeId;
    }
    const effectivePageSize = pageSize ?? SIGUR_EVENT_PAGE_SIZE;
    const rawEvents = await this.fetchAllByLastId<Record<string, unknown>>(
      '/api/v1/events',
      params,
      connection,
      effectivePageSize,
    );
    console.log(`[sigur] getEventsByLastId raw: ${rawEvents.length} events (since id=${lastEventId})`);
    return this.enrichRawEvents(rawEvents, connection);
  }

  /**
   * Получает все события Sigur за период (без фильтра по eventType) и делит их
   * на pass / failures. Используется sync-events и presence-polling, когда мы
   * хотим параллельно собрать и успешные проходы, и ошибочные события.
   */
  async getEventsWithFailures(
    startTime?: string,
    endTime?: string,
    connection?: ConnectionType,
    extraParams?: Record<string, any>,
  ): Promise<{ pass: Record<string, unknown>[]; failures: Record<string, unknown>[] }> {
    const pageSize = extraParams?.pageSize || SIGUR_EVENT_PAGE_SIZE;
    const params: Record<string, any> = {};

    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);

    if (extraParams) {
      const { pageSize: _pageSize, ...rest } = extraParams;
      if (Object.keys(rest).length > 0) Object.assign(params, rest);
    }

    const rawEvents = await this.fetchEventsByChunks<Record<string, unknown>>(
      startTime,
      endTime,
      params,
      connection,
      pageSize,
    );

    console.log(`[sigur] getEventsWithFailures raw: ${rawEvents.length} events`);
    return this.enrichAllRawEvents(rawEvents, connection);
  }

  /**
   * Incremental polling: запрашивает события строго с id > lastEventId, без
   * фильтра по eventType. Делит на pass / failures. Полная замена
   * `getEventsByLastId` для сценария, где нужны и успешные, и ошибочные события.
   */
  async getEventsByLastIdWithFailures(
    lastEventId: number,
    connection?: ConnectionType,
    pageSize?: number,
  ): Promise<{ pass: Record<string, unknown>[]; failures: Record<string, unknown>[] }> {
    const params: Record<string, any> = { lastId: lastEventId };
    const effectivePageSize = pageSize ?? SIGUR_EVENT_PAGE_SIZE;
    const rawEvents = await this.fetchAllByLastId<Record<string, unknown>>(
      '/api/v1/events',
      params,
      connection,
      effectivePageSize,
    );
    console.log(
      `[sigur] getEventsByLastIdWithFailures raw: ${rawEvents.length} events (since id=${lastEventId})`,
    );
    return this.enrichAllRawEvents(rawEvents, connection);
  }

  async getEventsLimited(
    startTime?: string,
    endTime?: string,
    maxItems = 200,
    connection?: ConnectionType,
  ) {
    const params: Record<string, any> = { limit: maxItems };

    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);

    const response = await this.request<any>('/api/v1/events/parsed', params, connection);
    const items = response?.data || response || [];
    return Array.isArray(items) ? items.slice(0, maxItems) : [];
  }

  async getEventTypes(connection?: ConnectionType) {
    return this.request('/api/v1/events/types', undefined, connection);
  }

  async getPositions(connection?: ConnectionType): Promise<Record<string, unknown>[] | null> {
    try {
      return await this.fetchAllPaginated('/api/v1/positions', undefined, connection) as Record<string, unknown>[];
    } catch {
      console.warn('[sigur] /api/v1/positions not available');
      return null;
    }
  }

  async getPositionOptionsCached(connection?: ConnectionType): Promise<Array<{ id: number; name: string }>> {
    if (this.positionCache && (Date.now() - this.positionCache.fetchedAt) < this.POSITION_CACHE_TTL) {
      return this.positionCache.data;
    }

    const positions = await this.getPositions(connection);
    const data = (positions || [])
      .map(position => ({
        id: typeof position.id === 'number' ? position.id : Number(position.id),
        name: typeof position.name === 'string' ? position.name.trim() : '',
      }))
      .filter(position => Number.isFinite(position.id) && position.name)
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

    if (data.length > 0) {
      this.positionCache = { data, fetchedAt: Date.now() };
      return data;
    }

    // Fallback: derive positions from employees when /api/v1/positions returns empty or not available
    try {
      const employees = await this.getEmployeesCached(connection);
      const unique = new Map<number, string>();
      for (const employee of employees) {
        const rawId = employee.positionId;
        const id = typeof rawId === 'number' ? rawId : Number(rawId);
        const name = typeof employee.positionName === 'string' ? employee.positionName.trim() : '';
        if (!Number.isFinite(id) || id <= 0 || !name) continue;
        if (!unique.has(id)) unique.set(id, name);
      }

      const derived = [...unique.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

      if (derived.length > 0) {
        console.log(`[sigur] positions derived from employees cache: ${derived.length} unique`);
        // Shorter TTL so a restored /api/v1/positions endpoint is picked up quickly
        this.positionCache = { data: derived, fetchedAt: Date.now() - (this.POSITION_CACHE_TTL - 60_000) };
        return derived;
      }
    } catch (error) {
      console.warn('[sigur] positions fallback via employees failed:', (error as Error).message);
    }

    this.positionCache = { data, fetchedAt: Date.now() };
    return data;
  }

  async getDepartmentById(id: number, connection?: ConnectionType) {
    return this.request<Record<string, unknown>>(`/api/v1/departments/${id}`, undefined, connection);
  }

  async getEmployeeById(id: number, connection?: ConnectionType) {
    return this.request<Record<string, unknown>>(`/api/v1/employees/${id}`, undefined, connection);
  }

  async updateEmployee(
    id: number,
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>> {
    return this.mutate<Record<string, unknown>>('put', `/api/v1/employees/${id}`, body, undefined, connection);
  }

  async createEmployee(
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>> {
    return this.mutate<Record<string, unknown>>('post', '/api/v1/employees', body, undefined, connection);
  }

  async deleteEmployee(id: number, connection?: ConnectionType): Promise<void> {
    await this.mutate<void>('delete', `/api/v1/employees/${id}`, undefined, undefined, connection);
  }

  async blockEmployee(id: number, connection?: ConnectionType): Promise<void> {
    await this.mutate<void>('put', `/api/v1/employees/${id}/block`, undefined, undefined, connection);
  }

  async unblockEmployee(id: number, connection?: ConnectionType): Promise<void> {
    await this.mutate<void>('put', `/api/v1/employees/${id}/unblock`, undefined, undefined, connection);
  }

  async createDepartment(
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>> {
    return this.mutate<Record<string, unknown>>('post', '/api/v1/departments', body, undefined, connection);
  }

  async updateDepartment(
    id: number,
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>> {
    return this.mutate<Record<string, unknown>>('put', `/api/v1/departments/${id}`, body, undefined, connection);
  }

  async deleteDepartment(id: number, connection?: ConnectionType): Promise<void> {
    await this.mutate<void>('delete', `/api/v1/departments/${id}`, undefined, undefined, connection);
  }

  async createPosition(
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>> {
    return this.mutate<Record<string, unknown>>('post', '/api/v1/positions', body, undefined, connection);
  }

  async updatePosition(
    id: number,
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>> {
    return this.mutate<Record<string, unknown>>('put', `/api/v1/positions/${id}`, body, undefined, connection);
  }

  async deletePosition(id: number, connection?: ConnectionType): Promise<void> {
    await this.mutate<void>('delete', `/api/v1/positions/${id}`, undefined, undefined, connection);
  }

  async getEmployeeAccessPointBindings(
    filters?: Record<string, any>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await this.fetchAllPaginated<Record<string, unknown>>(
        '/api/v1/bindings/employees-accesspoints',
        filters,
        connection,
      );
    } catch {
      return [];
    }
  }

  async getEmployeeAccessRuleBindings(
    filters?: Record<string, any>,
    connection?: ConnectionType,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await this.fetchAllPaginated<Record<string, unknown>>(
        '/api/v1/bindings/employees-accessrules',
        filters,
        connection,
      );
    } catch {
      return [];
    }
  }

  async addEmployeeAccessRuleBinding(
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.mutate<void>('post', '/api/v1/bindings/employees-accessrules', body, undefined, connection);
  }

  async deleteEmployeeAccessRuleBinding(
    body: Record<string, unknown>,
    connection?: ConnectionType,
  ): Promise<void> {
    await this.mutate<void>('post', '/api/v1/bindings/employees-accessrules/delete', body, undefined, connection);
  }

  async createEmployeeAccessPointBindings(
    employeeIds: number[],
    accessPointIds: number[],
    connection?: ConnectionType,
  ): Promise<void> {
    // Sigur ожидает массив объектов вида [{ employeeId, accessPointId }]
    // (как у /bindings/employees-cards). Прежний формат
    // { employeeIds: [...], accessPointIds: [...] } валит API с
    // 400 invalid.request. GET по тому же endpoint возвращает singular-поля.
    const items: Array<{ employeeId: number; accessPointId: number }> = [];
    for (const employeeId of employeeIds) {
      for (const accessPointId of accessPointIds) {
        items.push({ employeeId, accessPointId });
      }
    }
    if (items.length === 0) return;
    await this.mutate<void>(
      'post',
      '/api/v1/bindings/employees-accesspoints',
      items,
      undefined,
      connection,
    );
  }

  async deleteEmployeeAccessPointBindings(
    employeeIds: number[],
    accessPointIds: number[],
    connection?: ConnectionType,
  ): Promise<void> {
    const items: Array<{ employeeId: number; accessPointId: number }> = [];
    for (const employeeId of employeeIds) {
      for (const accessPointId of accessPointIds) {
        items.push({ employeeId, accessPointId });
      }
    }
    if (items.length === 0) return;
    await this.mutate<void>(
      'post',
      '/api/v1/bindings/employees-accesspoints/delete',
      items,
      undefined,
      connection,
    );
  }

  async updateEmployeeCardBindingExpiration(
    employeeId: number,
    cardId: number,
    expirationDate: string,
    connection?: ConnectionType,
  ): Promise<void> {
    // Sigur ожидает массив объектов — не единичный объект.
    await this.mutate<void>(
      'put',
      '/api/v1/bindings/employees-cards',
      [{ employeeId, cardId, expirationDate }],
      undefined,
      connection,
    );
  }

  async patchEmployeeCardBinding(
    employeeId: number,
    cardId: number,
    startDate: string,
    expirationDate: string,
    connection?: ConnectionType,
    format?: string,
  ): Promise<void> {
    const item: Record<string, unknown> = { employeeId, cardId, startDate, expirationDate };
    if (format) item.format = format;
    await this.mutate<void>(
      'patch',
      '/api/v1/bindings/employees-cards',
      [item],
      undefined,
      connection,
    );
  }

  async createEmployeeCardBinding(
    employeeId: number,
    cardId: number,
    startDate: string,
    expirationDate: string,
    connection?: ConnectionType,
    format?: string,
  ): Promise<void> {
    const item: Record<string, unknown> = { employeeId, cardId, startDate, expirationDate };
    if (format) item.format = format;
    await this.mutate<void>(
      'post',
      '/api/v1/bindings/employees-cards',
      [item],
      undefined,
      connection,
    );
  }

  async deleteEmployeeCardBinding(
    employeeId: number,
    cardId: number,
    format: string,
    connection?: ConnectionType,
  ): Promise<void> {
    // Sigur API: POST /bindings/employees-cards/delete с массивом, format обязателен.
    await this.mutate<void>(
      'post',
      '/api/v1/bindings/employees-cards/delete',
      [{ employeeId, cardId, format }],
      undefined,
      connection,
    );
  }

  async findCardsByNumber(cardNumber: string, connection?: ConnectionType) {
    const all = await this.getCardsCached(connection);
    const target = cardNumber.trim().toUpperCase();
    return all.filter(card => {
      const num = String(
        card.number ?? card.Number ?? card.cardNumber ?? card.card_number ?? card.serialNumber ?? '',
      ).trim().toUpperCase();
      return num === target;
    });
  }

  static buildCardNumberVariants(rawNumber: string): Set<string> {
    const variants = new Set<string>();
    if (typeof rawNumber !== 'string') return variants;
    const trimmed = rawNumber.trim();
    if (!trimmed) return variants;

    const upper = trimmed.toUpperCase();
    variants.add(upper);
    const stripped = upper.replace(/^0+/, '');
    if (stripped) variants.add(stripped);

    const addNumberRepresentations = (n: number | bigint): void => {
      const big = typeof n === 'bigint' ? n : BigInt(n);
      if (big < BigInt(0)) return;
      variants.add(big.toString(10));
      const hex = big.toString(16).toUpperCase();
      variants.add(hex);
      variants.add(hex.padStart(4, '0'));
      variants.add(hex.padStart(6, '0'));
      variants.add(hex.padStart(8, '0'));
      variants.add(hex.padStart(16, '0'));
    };

    const w26Match = upper.match(/^(\d+),(\d+)$/);
    if (w26Match) {
      const fac = Number(w26Match[1]);
      const num = Number(w26Match[2]);
      if (Number.isFinite(fac) && Number.isFinite(num) && fac >= 0 && num >= 0) {
        // combined int (3 байта): (fac<<16) | num
        const combined = ((fac & 0xFF) << 16) | (num & 0xFFFF);
        addNumberRepresentations(combined);
        // combined int (4 байта): включая trailing 00 в младшем байте
        const combined4 = combined << 8;
        addNumberRepresentations(combined4 >>> 0);
        // num отдельно — Sigur может хранить только num
        addNumberRepresentations(num);
        // Альтернативные разделители (строкой)
        variants.add(`${fac}:${num}`);
        variants.add(`${fac} ${num}`);
        variants.add(`${fac}.${num}`);
      }
    }

    if (/^[0-9A-F]+$/.test(upper) && upper.length <= 16) {
      try {
        const big = BigInt('0x' + upper);
        addNumberRepresentations(big);
        const padded = upper.length % 2 === 0 ? upper : '0' + upper;
        const bytes = padded.match(/.{2}/g);
        if (bytes) {
          const leHex = bytes.slice().reverse().join('');
          variants.add(leHex);
          if (/^[0-9A-F]+$/.test(leHex)) {
            try { addNumberRepresentations(BigInt('0x' + leHex)); } catch { /* noop */ }
          }
        }
      } catch { /* noop */ }
    }

    if (/^\d+$/.test(upper)) {
      try {
        const big = BigInt(upper);
        addNumberRepresentations(big);
      } catch { /* noop */ }
    }

    return variants;
  }

  /** Whitelist полей карты Sigur, в которых может лежать номер. Сравнение case-insensitive. */
  private static readonly CARD_NUMBER_FIELDS_LOWER = new Set<string>([
    'number', 'cardnumber', 'card_number',
    'serialnumber', 'serial_number', 'serial',
    'wiegandcode', 'wiegand_code', 'wiegand',
    'code', 'cardcode', 'card_code',
    'value', 'cardvalue', 'formattedvalue', 'formatted_value',
    'hex', 'cardhex',
    'rfid', 'rfidcode',
    'uid',
  ]);

  /** Возвращает все плоские строковые/числовые значения карты, которые могут быть номером. */
  static collectCardSearchableValues(card: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const [key, value] of Object.entries(card)) {
      if (!SigurDataService.CARD_NUMBER_FIELDS_LOWER.has(key.toLowerCase())) continue;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) out.push(trimmed);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        out.push(String(value));
      } else if (typeof value === 'bigint') {
        out.push(value.toString(10));
      }
    }
    return out;
  }

  /**
   * Компактный список поисковых ключей по кандидату — то, что имеет смысл подсунуть в Sigur ?value=.
   * Возвращает максимум 4 ключа: для W26 «fac,num» — combined-hex без zeros, formattedValue, num-hex; для hex/dec — hex с/без trailing zeros.
   */
  private static buildSearchKeys(candidate: string): string[] {
    const keys: string[] = [];
    const upper = candidate.trim().toUpperCase();
    if (!upper) return keys;

    const w26 = upper.match(/^(\d+),(\d+)$/);
    if (w26) {
      const fac = Number(w26[1]);
      const num = Number(w26[2]);
      if (Number.isFinite(fac) && Number.isFinite(num) && fac >= 0 && num >= 0) {
        const combined = ((fac & 0xFF) << 16) | (num & 0xFFFF);
        const combinedHex = combined.toString(16).toUpperCase();
        keys.push(combinedHex);
        keys.push(`${fac},${num}`);
        keys.push(num.toString(16).toUpperCase());
      }
      return keys;
    }

    if (/^[0-9A-F]+$/.test(upper)) {
      keys.push(upper);
      const stripped = upper.replace(/^0+/, '');
      if (stripped && stripped !== upper) keys.push(stripped);
      const trailingStripped = upper.replace(/0+$/, '');
      if (trailingStripped && trailingStripped !== upper && trailingStripped !== stripped) {
        keys.push(trailingStripped);
      }
      return keys;
    }

    if (/^\d+$/.test(upper)) {
      try {
        const big = BigInt(upper);
        const hex = big.toString(16).toUpperCase();
        keys.push(hex);
        const trailingStripped = hex.replace(/0+$/, '');
        if (trailingStripped && trailingStripped !== hex) keys.push(trailingStripped);
      } catch { /* noop */ }
      return keys;
    }

    keys.push(upper);
    return keys;
  }

  async findCardByCandidates(
    candidates: string[],
    connection?: ConnectionType,
  ): Promise<{ matches: Record<string, unknown>[]; tried: string[]; sample: Record<string, unknown>[] }> {
    const allCandidateVariants = new Set<string>();
    const tried: string[] = [];
    const searchKeys = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      tried.push(trimmed);
      for (const variant of SigurDataService.buildCardNumberVariants(trimmed)) {
        allCandidateVariants.add(variant);
      }
      for (const key of SigurDataService.buildSearchKeys(trimmed)) {
        searchKeys.add(key);
      }
    }

    if (allCandidateVariants.size === 0) {
      return { matches: [], tried, sample: [] };
    }

    // Быстрый путь: точечный запрос ?value=<key> к Sigur (сервер фильтрует — отдаёт 1 карту вместо 20890).
    // Если Sigur не понял фильтр и вернул всю базу — переходим к кэшированному локальному матчингу.
    for (const key of searchKeys) {
      try {
        const found = await this.getCards({ value: key }, connection) as Record<string, unknown>[];
        if (found.length === 0) continue;
        if (found.length > 50) {
          // Фильтр не сработал на этом ключе — Sigur вернул весь список.
          break;
        }
        // Доп. валидация: совпадает ли реально хотя бы одно поле карты с нашими variants.
        const verified = found.filter(card => {
          const searchable = SigurDataService.collectCardSearchableValues(card);
          for (const value of searchable) {
            const cardVariants = SigurDataService.buildCardNumberVariants(value);
            for (const v of cardVariants) {
              if (allCandidateVariants.has(v)) return true;
            }
          }
          return false;
        });
        if (verified.length > 0) {
          return { matches: verified, tried, sample: verified.slice(0, 3) };
        }
      } catch {
        break;
      }
    }

    // Fallback: грузим все карты с кэшем и матчим вручную.
    const all = await this.getCardsCached(connection);
    const matches = all.filter(card => {
      const searchable = SigurDataService.collectCardSearchableValues(card);
      for (const value of searchable) {
        const cardVariants = SigurDataService.buildCardNumberVariants(value);
        for (const v of cardVariants) {
          if (allCandidateVariants.has(v)) return true;
        }
      }
      return false;
    });

    return { matches, tried, sample: all.slice(0, 3) };
  }
}
