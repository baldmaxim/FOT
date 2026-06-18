import { Response } from 'express';
import { AxiosError } from 'axios';
import { queryOne } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import {
  ensureArchiveSigurDepartment,
  getEmployeeAccessPointBindings,
  replaceEmployeeAccessPointBindings,
} from '../services/sigur-linked-employees.service.js';
import { settingsService } from '../services/settings.service.js';
import { getSigurMonitorStatus } from '../services/sigur-monitor.service.js';
import { sigurService } from '../services/sigur.service.js';
import { resolveField } from '../services/sigur-sync-shared.js';
import { createCache } from '../utils/cache.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import {
  loadAccessPointObjectMetaMap,
  normalizeAccessPointKey,
  type IAccessPointObjectMeta,
} from '../services/sigur-access-point-meta.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface IEnrichedAccessPointBinding {
  accessPointId: number;
  accessPointName: string | null;
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

interface IEnrichedAccessPointOption {
  id: number | null;
  name: string;
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

interface IEmployeeProfileResponse {
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
  cards: Array<{
    cardId: number;
    cardNumber: string | null;
    status: string | null;
    expirationDate: string | null;
    w26: string | null;
  }>;
  accessRules: Array<{ accessRuleId: number; accessRuleName: string | null }>;
  accessPoints: IEnrichedAccessPointBinding[];
}

const SIGUR_EMPLOYEE_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const PASSIVE_CONNECTION_STATUS_TTL_MS = 15 * 60 * 1000;

const employeeProfileCache = createCache<{ data: IEmployeeProfileResponse }>({
  max: 500,
  ttlMs: SIGUR_EMPLOYEE_PROFILE_CACHE_TTL_MS,
});
const employeeProfileInFlight = new Map<string, Promise<IEmployeeProfileResponse>>();

async function ensureSigurConfigured(
  res: Response,
  customMessage?: string,
): Promise<boolean> {
  if (await sigurService.isConfigured()) {
    return true;
  }

  res.status(503).json({
    success: false,
    error: customMessage || 'Sigur не настроен. Укажите параметры подключения во временных настройках или в .env',
    connections: await sigurService.getAvailableConnections(),
  });
  return false;
}

function parseOptionalIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildEmployeeProfileCacheKey(employeeId: number, connection?: 'external' | 'internal'): string {
  return `${employeeId}:${connection || 'default'}`;
}

function invalidateEmployeeProfileCache(employeeId: number): void {
  for (const connectionKey of ['default', 'internal', 'external']) {
    const key = `${employeeId}:${connectionKey}`;
    employeeProfileCache.delete(key);
    employeeProfileInFlight.delete(key);
  }
}

function enrichAccessPointBinding(
  binding: { accessPointId: number; accessPointName: string | null },
  metaMap: Map<string, IAccessPointObjectMeta>,
): IEnrichedAccessPointBinding {
  const meta = binding.accessPointName ? metaMap.get(normalizeAccessPointKey(binding.accessPointName)) : undefined;
  return {
    accessPointId: binding.accessPointId,
    accessPointName: binding.accessPointName,
    objectId: meta?.objectId || null,
    objectName: meta?.objectName || null,
    hasMapPreview: meta?.hasMapPreview === true,
  };
}

function toAccessPointOption(
  raw: Record<string, unknown>,
  metaMap?: Map<string, IAccessPointObjectMeta>,
): IEnrichedAccessPointOption | null {
  const id = resolveField<number>(raw, 'id', 'ID', 'Id') ?? null;
  const name = String(resolveField<string>(raw, 'name', 'Name', 'title') || '').trim();
  if (!name) return null;
  const meta = metaMap?.get(normalizeAccessPointKey(name));
  return {
    id,
    name,
    objectId: meta?.objectId || null,
    objectName: meta?.objectName || null,
    hasMapPreview: meta?.hasMapPreview === true,
  };
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
}

function normalizeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toSigurCard(raw: Record<string, unknown>): {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
} | null {
  const cardId = normalizeInt(resolveField(raw, 'id', 'ID', 'Id', 'cardId', 'card_id', 'cardID'));
  if (!cardId) return null;

  const cardNumber = String(
    resolveField<string | number>(raw, 'number', 'Number', 'cardNumber', 'card_number', 'serialNumber', 'serial_number')
    ?? '',
  ).trim() || null;
  const status = String(resolveField<string>(raw, 'status', 'Status', 'state') || '').trim() || null;
  const format = String(resolveField<string>(raw, 'format', 'Format', 'cardFormat') || '').trim() || null;
  const startDate = String(
    resolveField<string>(raw, 'startDate', 'start_date', 'validFrom', 'startAt')
    || '',
  ).trim() || null;
  const expirationDate = String(
    resolveField<string>(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'expiryDate', 'validTo')
    || '',
  ).trim() || null;

  return {
    cardId,
    cardNumber,
    status,
    format,
    startDate,
    expirationDate,
  };
}

function toCardBinding(raw: Record<string, unknown>): {
  employeeId: number;
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
} | null {
  const employeeId = normalizeInt(resolveField(raw, 'employeeId', 'employee_id'));
  const cardId = normalizeInt(resolveField(raw, 'cardId', 'card_id', 'cardID', 'cardid'));
  if (!employeeId || !cardId) return null;

  return {
    employeeId,
    cardId,
    cardNumber: String(
      resolveField<string | number>(raw, 'cardNumber', 'card_number', 'number', 'Number')
      ?? '',
    ).trim() || null,
    status: String(resolveField<string>(raw, 'status', 'Status', 'state') || '').trim() || null,
    format: String(resolveField<string>(raw, 'format', 'Format', 'cardFormat') || '').trim() || null,
    startDate: String(
      resolveField<string>(raw, 'startDate', 'start_date', 'validFrom', 'startAt')
      || '',
    ).trim() || null,
    expirationDate: String(
      resolveField<string>(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'expiryDate', 'validTo')
      || '',
    ).trim() || null,
  };
}

function toCardSummary(raw: Record<string, unknown>): {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
} | null {
  const binding = toCardBinding(raw);
  if (binding) {
    return {
      cardId: binding.cardId,
      cardNumber: binding.cardNumber,
      status: binding.status,
      format: binding.format,
      startDate: binding.startDate,
      expirationDate: binding.expirationDate,
    };
  }

  return toSigurCard(raw);
}

function toAccessRuleBinding(raw: Record<string, unknown>): { employeeId: number; accessRuleId: number } | null {
  const employeeId = normalizeInt(resolveField(raw, 'employeeId', 'employee_id'));
  const accessRuleId = normalizeInt(resolveField(
    raw,
    'accessRuleId',
    'access_rule_id',
    'accessruleId',
    'accessRuleID',
  ));

  if (!employeeId || !accessRuleId) return null;
  return { employeeId, accessRuleId };
}

async function buildEmployeeProfileData(
  employeeId: number,
  connection?: 'external' | 'internal',
  refresh = false,
): Promise<IEmployeeProfileResponse> {
  const employee = await queryOne<{
    id: number;
    full_name: string | null;
    position_id: string | null;
    sigur_employee_id: number | null;
    tab_number: string | null;
  }>(
    `SELECT id, full_name, position_id, sigur_employee_id, tab_number
     FROM employees WHERE id = $1 LIMIT 1`,
    [employeeId],
  );

  if (!employee) {
    const error = new Error('Сотрудник не найден');
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  if (!employee.sigur_employee_id) {
    return {
      linked: false,
      employeeId,
      sigurEmployeeId: null,
      profile: {
        fullName: employee.full_name || '',
        departmentId: null,
        departmentName: null,
        positionId: null,
        positionName: null,
        tabNumber: employee.tab_number || null,
        description: null,
        blocked: null,
      },
      cards: [],
      accessRules: [],
      accessPoints: [],
    };
  }

  const accessPointObjectMetaPromise = loadAccessPointObjectMetaMap();
  const cachedRemoteEmployee = sigurService.findEmployeeInCache(employee.sigur_employee_id);
  if (!cachedRemoteEmployee) {
    sigurService.warmEmployeesCache(connection);
  }

  const [remoteEmployeeRaw, departmentMap, accessPointObjectMeta, accessRuleCatalog, cardBindingsResult, accessRuleBindingsResult, accessPointsResult] = await Promise.all([
    cachedRemoteEmployee
      ? Promise.resolve(cachedRemoteEmployee)
      : sigurService.getEmployeeById(employee.sigur_employee_id, connection),
    sigurService.getDepartmentMapCached(connection),
    accessPointObjectMetaPromise,
    sigurService.getAccessRuleMapCached(connection).catch((catalogError) => {
      console.warn('Sigur get employee profile access rules catalog warning:', catalogError);
      return null;
    }),
    sigurService.getCardBindings({ employeeId: employee.sigur_employee_id }, connection)
      .then(value => ({ status: 'fulfilled', value }) as const)
      .catch(reason => ({ status: 'rejected', reason }) as const),
    sigurService.getEmployeeAccessRuleBindings({ employeeId: employee.sigur_employee_id }, connection)
      .then(value => ({ status: 'fulfilled', value }) as const)
      .catch(reason => ({ status: 'rejected', reason }) as const),
    getEmployeeAccessPointBindings(employee.sigur_employee_id, connection, refresh)
      .then(value => ({ status: 'fulfilled', value }) as const)
      .catch(reason => ({ status: 'rejected', reason }) as const),
  ]);

  const remoteFullName = String(
    resolveField<string>(remoteEmployeeRaw, 'name', 'NAME', 'Name', 'fullName', 'full_name')
    || employee.full_name
    || '',
  ).trim();
  const departmentId = normalizeInt(resolveField(
    remoteEmployeeRaw,
    'departmentId',
    'department_id',
    'DEPARTMENTID',
    'DepartmentId',
  )) || null;
  const positionId = normalizeInt(resolveField(
    remoteEmployeeRaw,
    'positionId',
    'position_id',
    'POSITIONID',
    'PositionId',
  )) || null;
  const positionName = String(
    resolveField<string>(
      remoteEmployeeRaw,
      'position',
      'positionName',
      'position_name',
      'POSITION',
      'jobTitle',
    )
    || '',
  ).trim() || null;
  const tabNumber = String(
    resolveField<string | number>(
      remoteEmployeeRaw,
      'tabId',
      'tabID',
      'tab_id',
      'tabNumber',
      'tab_number',
      'TabId',
    )
    ?? employee.tab_number
    ?? '',
  ).trim() || null;

  const cardsRaw = cardBindingsResult.status === 'fulfilled'
    ? cardBindingsResult.value as Record<string, unknown>[]
    : [];
  if (cardBindingsResult.status === 'rejected') {
    console.warn('Sigur get employee profile cards warning:', cardBindingsResult.reason);
  }

  const cardsBase = cardsRaw
    .map(card => toCardSummary(card))
    .filter((card): card is NonNullable<ReturnType<typeof toCardSummary>> => !!card)
    .sort((left, right) => (left.cardNumber || '').localeCompare(right.cardNumber || '', 'ru'));

  // W26 каждой карты берём из фактического номера на сервере Sigur (formattedValue),
  // чтобы можно было сверять. Привязка несёт только cardId — подтягиваем по кэшу карт.
  const hexValueToW26 = (value: string): string | null => {
    const hex = value.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
    if (hex.length < 4) return null;
    const v = hex.length >= 6 ? hex.slice(-6) : hex.padStart(6, '0');
    const facility = parseInt(v.slice(0, 2), 16);
    const number = parseInt(v.slice(2), 16);
    if (!Number.isFinite(facility) || !Number.isFinite(number)) return null;
    return `${facility},${number}`;
  };
  let cards: Array<typeof cardsBase[number] & { w26: string | null }> =
    cardsBase.map(card => ({ ...card, w26: null }));
  if (cardsBase.length > 0) {
    try {
      const allCards = await sigurService.getCardsCached(connection);
      const cardById = new Map<number, Record<string, unknown>>();
      for (const rawCard of allCards) {
        const id = normalizeInt(resolveField(rawCard, 'id', 'cardId', 'card_id'));
        if (id) cardById.set(id, rawCard);
      }
      cards = cardsBase.map(card => {
        const sigurCard = cardById.get(card.cardId);
        let w26: string | null = null;
        if (sigurCard) {
          const formatted = String(resolveField(sigurCard, 'formattedValue', 'formatted_value') ?? '').trim();
          w26 = formatted || hexValueToW26(String(resolveField(sigurCard, 'value') ?? ''));
        }
        return { ...card, w26 };
      });
    } catch (cardsListError) {
      console.warn('Sigur get employee profile W26 enrichment warning:', cardsListError);
    }
  }

  const accessRuleBindingsRaw = accessRuleBindingsResult.status === 'fulfilled'
    ? accessRuleBindingsResult.value as Record<string, unknown>[]
    : [];
  if (accessRuleBindingsResult.status === 'rejected') {
    console.warn('Sigur get employee profile access rules warning:', accessRuleBindingsResult.reason);
  }

  let accessRules: Array<{ accessRuleId: number; accessRuleName: string | null }> = [];
  if (accessRuleBindingsRaw.length > 0) {
    const normalizedAccessRuleBindings = accessRuleBindingsRaw
      .map(binding => toAccessRuleBinding(binding))
      .filter((binding): binding is NonNullable<ReturnType<typeof toAccessRuleBinding>> => !!binding);

    if (accessRuleCatalog) {
      accessRules = normalizedAccessRuleBindings
        .map(binding => ({
          accessRuleId: binding.accessRuleId,
          accessRuleName: accessRuleCatalog.get(binding.accessRuleId) || null,
        }))
        .sort((left, right) => (left.accessRuleName || '').localeCompare(right.accessRuleName || '', 'ru'));
    } else {
      accessRules = normalizedAccessRuleBindings
        .map(binding => ({
          accessRuleId: binding.accessRuleId,
          accessRuleName: null,
        }))
        .sort((left, right) => left.accessRuleId - right.accessRuleId);
    }
  }

  const accessPoints = accessPointsResult.status === 'fulfilled'
    ? accessPointsResult.value.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta))
    : [];
  if (accessPointsResult.status === 'rejected') {
    console.warn('Sigur get employee profile access points warning:', accessPointsResult.reason);
  }

  return {
    linked: true,
    employeeId,
    sigurEmployeeId: employee.sigur_employee_id,
    profile: {
      fullName: remoteFullName,
      departmentId,
      departmentName: departmentId ? (departmentMap.get(departmentId) || null) : null,
      positionId,
      positionName,
      tabNumber,
      description: String(
        resolveField<string>(remoteEmployeeRaw, 'description', 'Description', 'comment', 'Comment')
        || '',
      ).trim() || null,
      blocked: normalizeBoolean(
        resolveField<unknown>(remoteEmployeeRaw, 'blocked', 'isBlocked', 'IsBlocked', 'is_blocked'),
      ),
    },
    cards,
    accessRules,
    accessPoints,
  };
}

export const sigurController = {
  async getConnectionSettings(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [settings, connections] = await Promise.all([
        settingsService.getSigurConnectionSettings(),
        sigurService.getAvailableConnections(),
      ]);

      res.json({
        success: true,
        data: {
          ...settings,
          connections,
        },
      });
    } catch (error) {
      console.error('Sigur get connection settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения настроек подключения Sigur' });
    }
  },

  async getConnectionStatus(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connections = await sigurService.getAvailableConnections();
      const isConfigured = connections.external || connections.internal;

      if (!isConfigured) {
        res.json({
          success: true,
          data: {
            connected: false,
            latestCheckStatus: null,
            lastCheckedAt: null,
            lastSuccessfulSignalAt: null,
            lastError: null,
            connections,
          },
        });
        return;
      }

      const monitorStatus = await getSigurMonitorStatus();
      const now = Date.now();
      const latestCheck = monitorStatus.latestCheck;
      const latestCheckAt = parseOptionalIsoDate(latestCheck?.checked_at || null);
      const latestCheckIsFresh = latestCheckAt
        ? now - latestCheckAt.getTime() <= PASSIVE_CONNECTION_STATUS_TTL_MS
        : false;
      const lastSuccessfulSignalAt = parseOptionalIsoDate(monitorStatus.lastSuccessfulSignalAt);
      const hasRecentSuccess = lastSuccessfulSignalAt
        ? now - lastSuccessfulSignalAt.getTime() <= PASSIVE_CONNECTION_STATUS_TTL_MS
        : false;
      const hasOpenFailureIncident = Boolean(
        monitorStatus.activeIncident && monitorStatus.activeIncident.detected_by !== 'silence_detector',
      );

      let connected: boolean | null = null;
      if (latestCheckIsFresh && latestCheck?.status === 'failure') {
        connected = false;
      } else if (latestCheckIsFresh && (latestCheck?.status === 'success' || latestCheck?.status === 'silence')) {
        connected = true;
      } else if (hasOpenFailureIncident) {
        connected = false;
      } else if (hasRecentSuccess) {
        connected = true;
      } else {
        // Не валим UI в "Нет связи", если у нас просто нет свежего health-signal.
        connected = true;
      }

      res.json({
        success: true,
        data: {
          connected,
          latestCheckStatus: latestCheck?.status || null,
          lastCheckedAt: latestCheck?.checked_at || null,
          lastSuccessfulSignalAt: monitorStatus.lastSuccessfulSignalAt,
          lastError: latestCheck?.status === 'failure'
            ? (latestCheck.error_message || monitorStatus.activeIncident?.error_message || null)
            : null,
          connections,
        },
      });
    } catch (error) {
      console.error('Sigur get connection status error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения статуса подключения Sigur' });
    }
  },

  async saveConnectionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        internal,
        external,
        archiveDepartmentId,
        archiveDepartmentName,
      } = req.body as {
        internal?: { url?: string | null; username?: string | null; password?: string | null };
        external?: { url?: string | null; username?: string | null; password?: string | null };
        archiveDepartmentId?: number | null;
        archiveDepartmentName?: string | null;
      };

      const settings = await settingsService.setSigurConnectionSettings({
        internal,
        external,
        archiveDepartmentId,
        archiveDepartmentName,
      }, req.user.id);

      sigurService.invalidateConnectionState();

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_settings',
        entityId: 'connection',
        details: {
          updatedScopes: [
            internal ? 'internal' : null,
            external ? 'external' : null,
            archiveDepartmentId !== undefined || archiveDepartmentName !== undefined ? 'archive' : null,
          ].filter(Boolean),
        },
      });

      res.json({
        success: true,
        data: {
          ...settings,
          connections: await sigurService.getAvailableConnections(),
        },
      });
    } catch (error) {
      console.error('Sigur save connection settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сохранения настроек подключения Sigur' });
    }
  },

  async ensureArchiveDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const archive = await ensureArchiveSigurDepartment(req.user.id, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_settings',
        entityId: 'archive_department',
        details: archive,
      });

      res.json({ success: true, data: archive });
    } catch (error) {
      console.error('Sigur ensure archive department error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания архивного отдела Sigur' });
    }
  },

  /**
   * GET /api/sigur/test
   * Проверка соединения с Sigur
   */
  async testConnection(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(
        res,
        'Sigur не настроен. Укажите параметры подключения во временных настройках или в .env',
      ))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const result = await sigurService.testConnection(connection);

      res.json({
        success: result.success,
        message: result.message,
        connection: result.connection,
        connections: await sigurService.getAvailableConnections(),
      });
    } catch (error) {
      console.error('Sigur test connection error:', error);
      res.status(500).json({ success: false, error: 'Ошибка проверки подключения к Sigur' });
    }
  },

  /**
   * GET /api/sigur/stream?type=employees
   * SSE-стриминг данных с прогрессом
   */
  async stream(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const type = req.query.type as string;
      const ENTITIES: Record<string, string> = {
        employees: '/api/v1/employees',
        departments: '/api/v1/departments',
        events: '/api/v1/events/parsed',
        'access-points': '/api/v1/accesspoints',
        cards: '/api/v1/cards',
        zones: '/api/v1/zones',
        'access-rules': '/api/v1/accessrules',
      };

      const endpoint = ENTITIES[type];
      if (!endpoint) {
        res.status(400).json({ success: false, error: 'Неизвестный тип данных' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const employeeId = req.query.employeeId as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      send({ type: 'start' });

      // Для events с датами — используем getEvents (с фильтрацией по датам на стороне Sigur)
      if (type === 'events' && (startDate || endDate || employeeId)) {
        send({ type: 'progress', loaded: 0, page: 0, pageSize: 0 });

        const startTime = startDate ? `${startDate}T00:00:00` : undefined;
        const endTime = endDate ? `${endDate}T23:59:59` : undefined;

        const allEvents = await sigurService.getEvents(startTime, endTime, connection);

        const filtered = employeeId
          ? (allEvents as Record<string, unknown>[]).filter(
              (e: Record<string, unknown>) => {
                const data = e.data as Record<string, unknown> | undefined;
                return String(data?.employeeId) === employeeId;
              }
            )
          : allEvents;

        send({ type: 'done', data: filtered, total: (filtered as unknown[]).length });
      } else {
        const allData = await sigurService.fetchWithProgress(
          endpoint,
          (loaded, page, pageItems) => {
            send({ type: 'progress', loaded, page, pageSize: pageItems.length });
          },
          undefined,
          connection,
        );

        send({ type: 'done', data: allData, total: allData.length });
      }
      res.end();
    } catch (error) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`);
        res.end();
      } catch { /* headers already sent */ }
    }
  },

  /**
   * GET /api/sigur/employees
   * Получить список сотрудников из Sigur
   */
  async getEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getEmployees(undefined, connection);

      console.log('[sigur employees] sample (first 2):', JSON.stringify(data.slice(0, 2), null, 2));

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get employees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения сотрудников из Sigur' });
    }
  },

  /**
   * GET /api/sigur/departments
   * Получить список отделов из Sigur
   */
  async getDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      if (req.query.force === '1') {
        sigurService.invalidateDepartmentCache();
      }
      const data = await sigurService.getDepartments(connection);

      console.log('[sigur departments] sample (first 2):', JSON.stringify(data.slice(0, 2), null, 2));

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get departments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения отделов из Sigur' });
    }
  },

  /**
   * GET /api/sigur/access-points
   * Получить список точек доступа из Sigur
   */
  async getAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const accessPointObjectMeta = await loadAccessPointObjectMetaMap();
      const data = (await sigurService.getAccessPointOptionsCached(connection))
        .map(point => toAccessPointOption(point as unknown as Record<string, unknown>, accessPointObjectMeta))
        .filter((point): point is IEnrichedAccessPointOption => !!point);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get access points error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения точек доступа из Sigur' });
    }
  },

  /**
   * GET /api/sigur/events
   * Получить события из Sigur (query: startTime, endTime)
   */
  async getEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const { startTime, endTime, connection: conn } = req.query;
      const connection = (conn as 'external' | 'internal') || undefined;

      const data = await sigurService.getEvents(
        startTime as string | undefined,
        endTime as string | undefined,
        connection,
      );

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get events error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения событий из Sigur' });
    }
  },

  /**
   * GET /api/sigur/events/types
   * Получить типы событий из Sigur
   */
  async getEventTypes(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getEventTypes(connection);

      res.json({ success: true, data });
    } catch (error) {
      console.error('Sigur get event types error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения типов событий из Sigur' });
    }
  },

  /**
   * GET /api/sigur/cards
   * Получить карты доступа из Sigur
   */
  async getCards(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getCards(undefined, connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get cards error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения карт из Sigur' });
    }
  },

  /**
   * GET /api/sigur/zones
   * Получить зоны доступа из Sigur
   */
  async getZones(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getZones(connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get zones error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения зон из Sigur' });
    }
  },

  /**
   * GET /api/sigur/access-rules
   * Получить режимы доступа из Sigur
   */
  async getAccessRules(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getAccessRules(connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get access rules error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения режимов доступа из Sigur' });
    }
  },

  /**
   * GET /api/sigur/discover
   * Диагностика: показывает ВСЕ доступные поля из Sigur API
   */
  async discover(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const result: Record<string, unknown> = {};

      // 1. Берём все отделы и показываем первые 3
      try {
        const depts = await sigurService.getDepartments(connection) as Record<string, unknown>[];
        result.departmentsTotal = depts.length;
        result.departmentSamples = depts.slice(0, 5);
        result.departmentFields = depts.length > 0 ? Object.keys(depts[0]) : [];

        // Ищем поля иерархии
        const hierarchyFields = ['parentId', 'parentDepartmentId', 'parent_id', 'parent'];
        const foundHierarchy: Record<string, unknown> = {};
        for (const field of hierarchyFields) {
          const hasField = depts.some(d => d[field] !== undefined);
          if (hasField) {
            foundHierarchy[field] = depts.filter(d => d[field] != null).slice(0, 3).map(d => ({
              id: d.id, name: d.name, [field]: d[field],
            }));
          }
        }
        result.departmentHierarchyFields = foundHierarchy;

        // Проверяем один отдел по ID
        if (depts.length > 0 && typeof depts[0].id === 'number') {
          try {
            const singleDept = await sigurService.getDepartmentById(depts[0].id as number, connection);
            result.singleDepartmentFull = singleDept;
          } catch { result.singleDepartmentFull = 'Ошибка запроса'; }
        }
      } catch (e) { result.departmentsError = (e as Error).message; }

      // 2. Берём сотрудников
      try {
        const emps = await sigurService.getEmployeesLimited(10, connection);
        result.employeesTotal = emps.length;
        result.employeeSamples = emps.slice(0, 5);
        result.employeeFields = emps.length > 0 ? Object.keys(emps[0]) : [];

        // Ищем поля должности
        const positionFields = ['positionId', 'positionName', 'position', 'jobTitle'];
        const foundPositions: Record<string, unknown> = {};
        for (const field of positionFields) {
          const hasField = emps.some(e => e[field] !== undefined);
          if (hasField) {
            foundPositions[field] = emps.filter(e => e[field] != null).slice(0, 3).map(e => ({
              id: e.id, name: e.name, [field]: e[field],
            }));
          }
        }
        result.employeePositionFields = foundPositions;

        // Проверяем одного сотрудника по ID
        if (emps.length > 0 && typeof emps[0].id === 'number') {
          try {
            const singleEmp = await sigurService.getEmployeeById(emps[0].id as number, connection);
            result.singleEmployeeFull = singleEmp;
          } catch { result.singleEmployeeFull = 'Ошибка запроса'; }
        }
      } catch (e) { result.employeesError = (e as Error).message; }

      // 3. Пробуем эндпоинт должностей
      try {
        const positions = await sigurService.getPositions(connection);
        if (positions) {
          result.positionsEndpoint = { available: true, total: positions.length, samples: positions.slice(0, 5) };
        } else {
          result.positionsEndpoint = { available: false };
        }
      } catch { result.positionsEndpoint = { available: false }; }

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur discover error:', error);
      res.status(500).json({ success: false, error: 'Ошибка диагностики Sigur API' });
    }
  },

  /**
   * GET /api/sigur/preview
   * Предпросмотр событий из Sigur — показывает замапленные поля
   */
  async preview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const { startTime, endTime, connection: conn, departmentId: deptIdFilter } = req.query;
      const connection = (conn as 'external' | 'internal') || undefined;

      console.log('[sigur preview] fetching events (paginated):', { startTime, endTime, connection });

      // Забираем ограниченное кол-во событий для предпросмотра
      const rawData = await sigurService.getEventsLimited(
        startTime as string | undefined,
        endTime as string | undefined,
        500,
        connection,
      );

      console.log('[sigur preview] rawData count:', rawData.length);

      if (rawData.length > 0) {
        console.log('[sigur preview] RAW event sample:', JSON.stringify(rawData[0], null, 2));
      }

      // Маппим и фильтруем по дате
      const startDateStr = (startTime as string)?.split('T')[0];
      const endDateStr = (endTime as string)?.split('T')[0];
      console.log('[sigur preview] date filter:', { startDateStr, endDateStr });

      let mapped = rawData
        .map((raw: unknown) => mapSigurEvent(raw as Record<string, unknown>))
        .filter(Boolean)
        .filter(evt => {
          if (!startDateStr || !endDateStr) return true;
          return evt!.eventDate >= startDateStr && evt!.eventDate <= endDateStr;
        }) as import('../utils/sigur.mapper.js').IMappedSigurEvent[];

      // Фильтр по отделу + обогащение
      const filterDeptId = typeof deptIdFilter === 'string' ? Number(deptIdFilter) : NaN;
      try {
        if (!isNaN(filterDeptId)) {
          // Загружаем сотрудников конкретного отдела через Sigur API
          const deptEmployees = await sigurService.fetchAllPaginated<Record<string, unknown>>(
            '/api/v1/employees',
            { departmentId: filterDeptId },
            connection,
            1000,
          );
          const allowedIds = new Set<number>();
          for (const emp of deptEmployees) {
            if (typeof emp.id === 'number') allowedIds.add(emp.id as number);
          }
          console.log('[sigur preview] dept filter:', filterDeptId, 'employees found:', allowedIds.size);
          if (deptEmployees.length > 0) {
            console.log('[sigur preview] emp sample:', JSON.stringify(deptEmployees[0], null, 2));
          }
          console.log('[sigur preview] allowedIds sample:', [...allowedIds].slice(0, 5));
          console.log('[sigur preview] mapped employeeIds sample:', mapped.slice(0, 5).map(e => e.employeeId));
          mapped = mapped.filter(evt => evt.employeeId != null && allowedIds.has(evt.employeeId));
          console.log('[sigur preview] after dept filter:', mapped.length);

          // Ставим department name (только для pass-событий — у failure поля department нет)
          const deptMap = await sigurService.getDepartmentMapCached(connection);
          const deptName = deptMap.get(filterDeptId) || null;
          for (const evt of mapped) {
            if (evt.kind === 'pass') {
              evt.department = deptName;
            }
          }
        }
      } catch (e) {
        console.warn('[sigur preview] enrichment failed:', (e as Error).message);
      }

      const totalMapped = mapped.length;
      mapped = mapped.slice(0, 20);

      const sampleFields = ['physicalPerson', 'eventDate', 'eventTime', 'direction', 'accessPoint', 'cardNumber', 'department', 'blocked'];

      res.json({
        success: true,
        data: mapped,
        sampleFields,
        totalFetched: rawData.length,
        mappedCount: totalMapped,
      });
    } catch (error) {
      console.error('Sigur preview error:', error);
      res.status(500).json({ success: false, error: 'Ошибка предварительного просмотра данных Sigur' });
    }
  },

  async getEmployeeAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const employee = await queryOne<{ id: number; sigur_employee_id: number | null }>(
        'SELECT id, sigur_employee_id FROM employees WHERE id = $1 LIMIT 1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const includeOptions = req.query.includeOptions === 'true';
      const accessPointObjectMeta = await loadAccessPointObjectMetaMap();

      if (!employee.sigur_employee_id) {
        res.json({
          success: true,
          data: {
            linked: false,
            accessPoints: [],
            bindings: [],
          },
        });
        return;
      }

      const [bindings, accessPoints] = await Promise.all([
        getEmployeeAccessPointBindings(employee.sigur_employee_id, connection, refresh),
        includeOptions
          ? sigurService.getAccessPointOptionsCached(connection)
            .then(options => options
              .map(point => toAccessPointOption(point as unknown as Record<string, unknown>, accessPointObjectMeta))
              .filter((point): point is IEnrichedAccessPointOption => !!point))
          : Promise.resolve([]),
      ]);

      res.json({
        success: true,
        data: {
          linked: true,
          accessPoints,
          bindings: bindings.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta)),
        },
      });
    } catch (error) {
      console.error('Sigur get employee access points error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения точек доступа сотрудника из Sigur' });
    }
  },

  async getEmployeeProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const cacheKey = buildEmployeeProfileCacheKey(employeeId, connection);

      if (!refresh) {
        const cached = employeeProfileCache.get(cacheKey);
        if (cached) {
          res.json({ success: true, data: cached.data });
          return;
        }

        const inFlight = employeeProfileInFlight.get(cacheKey);
        if (inFlight) {
          const data = await inFlight;
          res.json({ success: true, data });
          return;
        }
      }

      if (refresh) {
        const data = await buildEmployeeProfileData(employeeId, connection, true)
        .then(data => {
          employeeProfileCache.set(cacheKey, { data });
          return data;
        });
        res.json({ success: true, data });
        return;
      }

      const loadPromise = buildEmployeeProfileData(employeeId, connection, false)
        .then(data => {
          employeeProfileCache.set(cacheKey, { data });
          return data;
        })
        .finally(() => {
          employeeProfileInFlight.delete(cacheKey);
        });

      employeeProfileInFlight.set(cacheKey, loadPromise);
      const data = await loadPromise;
      res.json({ success: true, data });
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      console.error('Sigur get employee profile error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения профиля сотрудника из Sigur' });
    }
  },

  async updateEmployeeCardExpiration(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      const cardId = Number(req.params.cardId);
      if (
        !Number.isInteger(employeeId)
        || !Number.isInteger(cardId)
        || !(await canAccessEmployeeInScope(req, employeeId))
      ) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const { expirationDate } = req.body as { expirationDate?: unknown };
      if (typeof expirationDate !== 'string' || !expirationDate.trim()) {
        res.status(400).json({ success: false, error: 'expirationDate обязателен' });
        return;
      }

      const parsedExpirationDate = new Date(expirationDate);
      if (Number.isNaN(parsedExpirationDate.getTime())) {
        res.status(400).json({ success: false, error: 'Некорректная дата срока действия' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const employee = await queryOne<{ id: number; sigur_employee_id: number | null }>(
        'SELECT id, sigur_employee_id FROM employees WHERE id = $1 LIMIT 1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (!employee.sigur_employee_id) {
        res.status(400).json({ success: false, error: 'Сотрудник не связан с Sigur' });
        return;
      }

      await sigurService.updateEmployeeCardBindingExpiration(
        employee.sigur_employee_id,
        cardId,
        parsedExpirationDate.toISOString(),
        connection,
      );

      const cardsRaw = await sigurService.getCardBindings(
        { employeeId: employee.sigur_employee_id },
        connection,
      ) as Record<string, unknown>[];

      const card = cardsRaw
        .map(rawCard => toCardSummary(rawCard))
        .filter((rawCard): rawCard is NonNullable<ReturnType<typeof toCardSummary>> => !!rawCard)
        .find(rawCard => rawCard.cardId === cardId) || null;

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_card_binding',
        entityId: `${employeeId}:${cardId}`,
        details: {
          employeeId,
          sigurEmployeeId: employee.sigur_employee_id,
          cardId,
          expirationDate: parsedExpirationDate.toISOString(),
        },
      });

      invalidateEmployeeProfileCache(employeeId);

      res.json({
        success: true,
        data: card || {
          cardId,
          cardNumber: null,
          status: null,
          format: null,
          startDate: null,
          expirationDate: parsedExpirationDate.toISOString(),
        },
      });
    } catch (error) {
      console.error('Sigur update employee card expiration error:', error);
      const status = error instanceof AxiosError && error.response?.status ? error.response.status : 500;
      const data = error instanceof AxiosError ? error.response?.data as Record<string, unknown> | string | undefined : undefined;
      let message = 'Ошибка обновления срока действия пропуска';
      if (typeof data === 'string' && data.trim()) {
        message = data.trim();
      } else if (typeof data === 'object' && data) {
        const msg = data.message ?? data.error ?? data.detail;
        if (typeof msg === 'string' && msg.trim()) message = msg.trim();
      }
      res.status(status).json({ success: false, error: message });
    }
  },

  async updateEmployeeCardBinding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      const cardId = Number(req.params.cardId);
      if (
        !Number.isInteger(employeeId)
        || !Number.isInteger(cardId)
        || !(await canAccessEmployeeInScope(req, employeeId))
      ) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const { startDate, expirationDate } = req.body as { startDate?: unknown; expirationDate?: unknown };
      if (typeof startDate !== 'string' || !startDate.trim()) {
        res.status(400).json({ success: false, error: 'startDate обязателен' });
        return;
      }
      if (typeof expirationDate !== 'string' || !expirationDate.trim()) {
        res.status(400).json({ success: false, error: 'expirationDate обязателен' });
        return;
      }

      const parsedStartDate = new Date(startDate);
      if (Number.isNaN(parsedStartDate.getTime())) {
        res.status(400).json({ success: false, error: 'Некорректная дата начала доступа' });
        return;
      }
      const parsedExpirationDate = new Date(expirationDate);
      if (Number.isNaN(parsedExpirationDate.getTime())) {
        res.status(400).json({ success: false, error: 'Некорректная дата срока действия' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const format = typeof req.body.format === 'string' && req.body.format ? req.body.format as string : undefined;
      const employee = await queryOne<{ id: number; sigur_employee_id: number | null }>(
        'SELECT id, sigur_employee_id FROM employees WHERE id = $1 LIMIT 1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (!employee.sigur_employee_id) {
        res.status(400).json({ success: false, error: 'Сотрудник не связан с Sigur' });
        return;
      }

      await sigurService.patchEmployeeCardBinding(
        employee.sigur_employee_id,
        cardId,
        parsedStartDate.toISOString(),
        parsedExpirationDate.toISOString(),
        connection,
        format,
      );

      const cardsRaw = await sigurService.getCardBindings(
        { employeeId: employee.sigur_employee_id },
        connection,
      ) as Record<string, unknown>[];

      const card = cardsRaw
        .map(rawCard => toCardSummary(rawCard))
        .filter((rawCard): rawCard is NonNullable<ReturnType<typeof toCardSummary>> => !!rawCard)
        .find(rawCard => rawCard.cardId === cardId) || null;

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_card_binding',
        entityId: `${employeeId}:${cardId}`,
        details: {
          employeeId,
          sigurEmployeeId: employee.sigur_employee_id,
          cardId,
          startDate: parsedStartDate.toISOString(),
          expirationDate: parsedExpirationDate.toISOString(),
        },
      });

      invalidateEmployeeProfileCache(employeeId);

      res.json({
        success: true,
        data: card || {
          cardId,
          cardNumber: null,
          status: null,
          format: null,
          startDate: parsedStartDate.toISOString(),
          expirationDate: parsedExpirationDate.toISOString(),
        },
      });
    } catch (error) {
      console.error('Sigur update employee card binding error:', error);
      const status = error instanceof AxiosError && error.response?.status ? error.response.status : 500;
      const data = error instanceof AxiosError ? error.response?.data as Record<string, unknown> | string | undefined : undefined;
      let message = 'Ошибка обновления дат карты доступа';
      if (typeof data === 'string' && data.trim()) {
        message = data.trim();
      } else if (typeof data === 'object' && data) {
        const msg = data.message ?? data.error ?? data.detail;
        if (typeof msg === 'string' && msg.trim()) message = msg.trim();
      }
      res.status(status).json({ success: false, error: message });
    }
  },

  async saveEmployeeAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      if (!(await ensureSigurConfigured(res))) {
        return;
      }

      const { accessPointIds } = req.body as { accessPointIds?: unknown };
      if (!Array.isArray(accessPointIds) || accessPointIds.some(value => !Number.isInteger(value))) {
        res.status(400).json({ success: false, error: 'accessPointIds должен быть массивом целых чисел' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const employee = await queryOne<{ id: number; sigur_employee_id: number | null }>(
        'SELECT id, sigur_employee_id FROM employees WHERE id = $1 LIMIT 1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (!employee.sigur_employee_id) {
        res.status(409).json({ success: false, error: 'Сотрудник не связан с Sigur' });
        return;
      }

      const result = await replaceEmployeeAccessPointBindings(
        employee.sigur_employee_id,
        accessPointIds as number[],
        connection,
      );
      const accessPointObjectMeta = await loadAccessPointObjectMetaMap();
      const enrichedBindings = result.bindings.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta));

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          source: 'sigur_access_points',
          addedIds: result.addedIds,
          removedIds: result.removedIds,
        },
      });
      invalidateEmployeeProfileCache(employeeId);

      res.json({
        success: true,
        data: {
          ...result,
          bindings: enrichedBindings,
        },
      });
    } catch (error) {
      console.error('Sigur save employee access points error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сохранения точек доступа сотрудника в Sigur' });
    }
  },

};
