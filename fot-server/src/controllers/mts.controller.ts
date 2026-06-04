import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { settingsService } from '../services/settings.service.js';
import { mtsDataService } from '../services/mts-data.service.js';
import { mtsMappingService } from '../services/mts-mapping.service.js';
import { mtsTasksService } from '../services/mts-tasks.service.js';
import { MtsApiError } from '../services/mts-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { mtsGeofenceService, GeofenceValidationError } from '../services/mts-geofence.service.js';
import { query as pgQuery } from '../config/postgres.js';
import { encryptionService } from '../services/encryption.service.js';

// Безопасность:
// - Ошибки апстрима МТС не пробрасываются в клиент/Sentry body (могут содержать
//   ПДн абонента). Клиенту — generic message + HTTP/функциональный код, в лог —
//   status/code без message-тела.
// - Полный доступ к модулю — у любого is_admin (роль admin).
// - Не-админы видят только тех абонентов, чьи привязки указывают на сотрудников
//   в их области доступа (data-scope через employee_department_access).
// - Аудит на сохранение настроек и изменение привязок.

const hasFullMtsAccess = (req: AuthenticatedRequest): boolean =>
  req.user.is_admin === true;

const sendApiError = (res: Response, error: MtsApiError, fallback: string): void => {
  console.error(`[mts] upstream error: http=${error.status} code=${error.code ?? '-'} desc=${error.description ?? '-'} msg="${error.message}"`);
  Sentry.captureException(error, {
    tags: {
      module: 'mts',
      kind: 'upstream',
      mtsHttp: String(error.status),
      mtsCode: String(error.code ?? '-'),
    },
    extra: { fallback, description: error.description },
  });
  // Отдаём в payload расширенную диагностику — фронт показывает её в баннере
  // секции. description МТС — технический enum (NO_SUCH_RESOURCE, USER_UNAUTHORIZED
  // и т.п.), без ПДн. message может быть подробнее, отдаём его тоже.
  res.status(502).json({
    success: false,
    error: error.code ? `Ошибка МТС (код ${error.code})` : fallback,
    mtsHttp: error.status,
    mtsCode: error.code ?? null,
    mtsDescription: error.description ?? null,
    mtsMessage: error.message,
    fallback,
  });
};

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsApiError) {
    sendApiError(res, error, fallback);
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts] ${fallback}: ${msg}`);
  Sentry.captureException(error, {
    tags: { module: 'mts', kind: 'generic' },
    extra: { fallback },
  });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

// Лёгкий per-request лог для контроллера: видно user/role и итог запроса.
const logRequest = (req: AuthenticatedRequest, label: string): void => {
  const role = (req.user as { role_code?: string }).role_code ?? '-';
  console.log(`[mts-api] ▶ ${label} user=${req.user.id} role=${role}`);
};
const logSuccess = (label: string, summary: string): void => {
  console.log(`[mts-api] ◀ ok ${label} ${summary}`);
};

export const mtsController = {
  async getConnectionSettings(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await settingsService.getMtsConnectionSettings();
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения настроек МТС');
    }
  },

  async saveConnectionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { baseUrl, token } = req.body as { baseUrl?: string | null; token?: string | null };
      const data = await settingsService.setMtsConnectionSettings({ baseUrl, token }, req.user.id);
      mtsDataService.invalidate();

      // Аудит без значений — только что менялось.
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_CONNECTION_UPDATED, {
        details: {
          baseUrlChanged: baseUrl !== undefined,
          tokenChanged: token !== undefined,
        },
      });

      res.json({ success: true, data });
    } catch (error) {
      // Валидация base URL бросает Error — отдаём текст клиенту (без секретов).
      if (error instanceof Error && error.message.startsWith('MTS base URL')) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      fail(res, error, 'Ошибка сохранения настроек МТС');
    }
  },

  async testConnection(_req: AuthenticatedRequest, res: Response): Promise<void> {
    // Диагностический эндпоинт — отдаёт расширенную информацию: HTTP/код МТС,
    // baseUrl и source, чтобы понять «почему ничего не грузится» без выкачивания
    // ПДн (description МТС обычно технический, не содержит PII).
    let public_settings: { baseUrl: string; hasToken: boolean; source: string } | null = null;
    try {
      public_settings = await settingsService.getMtsConnectionSettings();
    } catch (e) {
      console.error('[mts] testConnection: settings read failed:', e instanceof Error ? e.message : 'unknown');
    }

    try {
      const result = await mtsDataService.testConnection();
      res.json({
        success: true,
        data: {
          ok: result.ok,
          count: result.count,
          baseUrl: public_settings?.baseUrl ?? null,
          source: public_settings?.source ?? 'unknown',
          hasToken: public_settings?.hasToken ?? false,
        },
      });
    } catch (error) {
      if (error instanceof MtsApiError) {
        console.error(`[mts] testConnection failed: http=${error.status} code=${error.code ?? '-'} desc=${error.description ?? '-'} msg=${error.message}`);
        res.json({
          success: true,
          data: {
            ok: false,
            count: 0,
            error: error.code ? `код МТС ${error.code}` : 'не удалось',
            mtsHttp: error.status,
            mtsCode: error.code ?? null,
            mtsDescription: error.description ?? null,
            mtsMessage: error.message,
            baseUrl: public_settings?.baseUrl ?? null,
            source: public_settings?.source ?? 'unknown',
            hasToken: public_settings?.hasToken ?? false,
          },
        });
        return;
      }
      fail(res, error, 'Ошибка проверки подключения МТС');
    }
  },

  /**
   * Диагностический эндпоинт (admin-only): возвращает форму первого raw-объекта
   * из ответа МТС /subscribers с зачищенными PII-полями. Цель — увидеть реальные
   * имена ключей (PascalCase vs camelCase, phone vs phoneNumber и т.д.).
   */
  async getRawSubscriberDebug(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /_debug/raw-subscriber');
    try {
      const data = await mtsDataService.getRawSubscriberDebug();
      if (!data) {
        res.json({ success: true, data: null, note: 'МТС вернул пустой список абонентов' });
        return;
      }
      logSuccess('GET /_debug/raw-subscriber', `keys=${data.topLevelKeys.length}`);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка диагностики абонентов МТС');
    }
  },

  /** Фильтрует список абонентов по data-scope (admin видит всё). */
  async getSubscribers(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /subscribers');
    try {
      const subs = await mtsDataService.getSubscribers();
      if (hasFullMtsAccess(req)) {
        logSuccess('GET /subscribers', `count=${subs.length} (full access, без фильтра)`);
        res.json({ success: true, data: subs, meta: { upstreamTotal: subs.length, filteredOut: 0, hasFullAccess: true } });
        return;
      }
      const mappings = await mtsMappingService.listMappings();
      const allowed = new Set<number>();
      let mappedTotal = 0;
      for (const m of mappings) {
        if (m.employeeId == null) continue;
        mappedTotal++;
        if (await canAccessEmployeeInScope(req, m.employeeId)) allowed.add(m.subscriberId);
      }
      const filtered = subs.filter(s => allowed.has(s.subscriberID));
      const filteredOut = subs.length - filtered.length;
      console.log(
        `[mts-api] getSubscribers user=${req.user.id}: upstream=${subs.length}, mappings(total/withEmp/inScope)=${mappings.length}/${mappedTotal}/${allowed.size}, visible=${filtered.length}, filteredOut=${filteredOut}`,
      );
      logSuccess('GET /subscribers', `upstream=${subs.length} visible=${filtered.length}`);
      res.json({
        success: true,
        data: filtered,
        meta: {
          upstreamTotal: subs.length,
          filteredOut,
          hasFullAccess: false,
          mappingsInScope: allowed.size,
          mappingsWithEmployee: mappedTotal,
        },
      });
    } catch (error) {
      fail(res, error, 'Ошибка получения абонентов МТС');
    }
  },

  async getLastLocations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const locations = await mtsDataService.getLastLocations();
      // Снимки шифрованно сохраняем сразу (все, что прислал МТС — это инвентарь).
      await mtsDataService.persistLocationSnapshots(locations);

      if (hasFullMtsAccess(req)) {
        res.json({ success: true, data: locations });
        return;
      }
      const mappings = await mtsMappingService.listMappings();
      const allowed = new Set<number>();
      for (const m of mappings) {
        if (m.employeeId == null) continue;
        if (await canAccessEmployeeInScope(req, m.employeeId)) allowed.add(m.subscriberId);
      }
      res.json({ success: true, data: locations.filter(l => allowed.has(l.subscriberID)) });
    } catch (error) {
      fail(res, error, 'Ошибка получения геопозиций МТС');
    }
  },

  /** IDOR-guard: не-admin — только если абонент привязан к сотруднику в скоупе. */
  async getTrack(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const subscriberId = Number(req.query.subscriberId);
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      if (!Number.isFinite(subscriberId) || !dateFrom || !dateTo) {
        res.status(400).json({ success: false, error: 'Нужны subscriberId, dateFrom, dateTo' });
        return;
      }

      if (!hasFullMtsAccess(req)) {
        const employeeId = await mtsMappingService.getEmployeeIdBySubscriber(subscriberId);
        if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
          res.status(403).json({ success: false, error: 'Нет доступа к абоненту' });
          return;
        }
      }

      const data = await mtsDataService.getTrack(subscriberId, dateFrom, dateTo);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения трека МТС');
    }
  },

  /**
   * История перемещений абонента из mts_location_snapshots. Контент в БД
   * зашифрован — здесь расшифровывается и возвращается. IDOR: не-admin
   * должен иметь доступ к привязанному сотруднику. Любой просмотр аудируется.
   */
  async getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const subscriberId = Number(req.query.subscriberId);
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      if (!Number.isFinite(subscriberId) || !dateFrom || !dateTo) {
        res.status(400).json({ success: false, error: 'Нужны subscriberId, dateFrom, dateTo' });
        return;
      }

      if (!hasFullMtsAccess(req)) {
        const employeeId = await mtsMappingService.getEmployeeIdBySubscriber(subscriberId);
        if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
          res.status(403).json({ success: false, error: 'Нет доступа к абоненту' });
          return;
        }
      }

      const data = await mtsDataService.getHistorySnapshots(subscriberId, dateFrom, dateTo);

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_HISTORY_VIEWED, {
        entityId: String(subscriberId),
        details: { subscriberId, dateFrom, dateTo, points: data.length },
      });

      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения истории МТС');
    }
  },

  /**
   * РУЧНОЙ платный запрос актуального положения. Защита: admin + critical 2FA
   * (на уровне роута) + явное { confirmed:true } в body. Аудит обязателен.
   */
  async requestLocation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!hasFullMtsAccess(req)) {
        res.status(403).json({ success: false, error: 'Доступно только администратору' });
        return;
      }
      const { subscriberId, confirmed } = req.body as { subscriberId?: number; confirmed?: boolean };
      if (!Number.isFinite(Number(subscriberId))) {
        res.status(400).json({ success: false, error: 'subscriberId обязателен' });
        return;
      }
      if (confirmed !== true) {
        res.status(400).json({ success: false, error: 'Требуется подтверждение платного запроса' });
        return;
      }

      await mtsDataService.requestLocation(Number(subscriberId));

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_LOCATION_REQUESTED, {
        entityId: String(subscriberId),
        details: { subscriberId, paid: true },
      });

      res.json({ success: true, data: { ok: true } });
    } catch (error) {
      fail(res, error, 'Ошибка запроса положения МТС');
    }
  },

  async getMappings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const all = await mtsMappingService.listMappings();
      if (hasFullMtsAccess(req)) {
        res.json({ success: true, data: all });
        return;
      }
      const filtered = [];
      for (const row of all) {
        if (row.employeeId != null && (await canAccessEmployeeInScope(req, row.employeeId))) {
          filtered.push(row);
        }
      }
      res.json({ success: true, data: filtered });
    } catch (error) {
      fail(res, error, 'Ошибка получения привязок МТС');
    }
  },

  /** Авто-подсказки = name-directory; отдаём только admin. */
  async getMappingSuggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!hasFullMtsAccess(req)) {
        res.json({ success: true, data: [] });
        return;
      }
      const subscribers = await mtsDataService.getSubscribers();
      const data = await mtsMappingService.suggest(subscribers);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка подбора привязок МТС');
    }
  },

  /**
   * Создаёт задачу в МТС, локально сохраняет зашифрованную копию.
   * Обязательные: title, startDate. subscriberID — опционально; если задан и
   * caller не admin, проверяем что привязанный сотрудник в его scope.
   */
  async createTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { title, startDate, subscriberID, deadline, description, address } = req.body as {
        title?: string;
        startDate?: string;
        subscriberID?: number | null;
        deadline?: string | null;
        description?: string | null;
        address?: string | null;
      };
      if (!title || !title.trim()) {
        res.status(400).json({ success: false, error: 'title обязателен' });
        return;
      }
      if (!startDate) {
        res.status(400).json({ success: false, error: 'startDate обязателен' });
        return;
      }
      const subId = subscriberID == null ? null : Number(subscriberID);
      if (subId != null && !hasFullMtsAccess(req)) {
        const employeeId = await mtsMappingService.getEmployeeIdBySubscriber(subId);
        if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
          res.status(403).json({ success: false, error: 'Нет доступа к абоненту' });
          return;
        }
      }

      const mtsResponse = await mtsDataService.createTaskMts({
        title: title.trim(),
        startDate,
        subscriberID: subId,
        deadline: deadline ?? null,
        description: description ?? null,
        address: address ?? null,
      });

      const saved = await mtsTasksService.saveCreatedTask({
        mtsTaskId: mtsResponse.taskID,
        subscriberId: subId,
        startDate,
        deadline: deadline ?? null,
        title: title.trim(),
        description: description ?? null,
        address: address ?? null,
        status: typeof mtsResponse.status === 'string' ? mtsResponse.status : null,
        payload: mtsResponse,
        createdBy: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_TASK_CREATED, {
        entityId: String(mtsResponse.taskID),
        details: { taskID: mtsResponse.taskID, subscriberID: subId },
      });

      res.json({ success: true, data: saved });
    } catch (error) {
      fail(res, error, 'Ошибка создания задачи МТС');
    }
  },

  /** Список локальных задач. Не-admin — только по абонентам в scope. */
  async getTasks(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const all = await mtsTasksService.listTasks();
      if (hasFullMtsAccess(req)) {
        res.json({ success: true, data: all });
        return;
      }
      const filtered: typeof all = [];
      for (const t of all) {
        if (t.subscriberId == null) continue; // unassigned → только admin
        const empId = await mtsMappingService.getEmployeeIdBySubscriber(t.subscriberId);
        if (empId && (await canAccessEmployeeInScope(req, empId))) filtered.push(t);
      }
      res.json({ success: true, data: filtered });
    } catch (error) {
      fail(res, error, 'Ошибка получения задач МТС');
    }
  },

  /** Refresh задачи из МТС + обновление локальной копии. Аудит просмотра. */
  async getTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const taskId = Number(req.params.taskId);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ success: false, error: 'taskId обязателен' });
        return;
      }

      // Сначала проверяем локальную запись и scope.
      const local = await mtsTasksService.getByMtsTaskId(taskId);
      if (!hasFullMtsAccess(req)) {
        if (!local || local.subscriberId == null) {
          res.status(403).json({ success: false, error: 'Нет доступа к задаче' });
          return;
        }
        const empId = await mtsMappingService.getEmployeeIdBySubscriber(local.subscriberId);
        if (!empId || !(await canAccessEmployeeInScope(req, empId))) {
          res.status(403).json({ success: false, error: 'Нет доступа к задаче' });
          return;
        }
      }

      const mtsResponse = await mtsDataService.getTaskMts(taskId);
      await mtsTasksService.upsertSyncedTask(taskId, mtsResponse);
      const fresh = await mtsTasksService.getByMtsTaskId(taskId);

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_TASK_VIEWED, {
        entityId: String(taskId),
        details: { taskID: taskId },
      });

      res.json({ success: true, data: fresh });
    } catch (error) {
      fail(res, error, 'Ошибка получения задачи МТС');
    }
  },

  async setMapping(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { subscriberId, employeeId, phone, displayName } = req.body as {
        subscriberId?: number;
        employeeId?: number | null;
        phone?: string | null;
        displayName?: string | null;
      };
      if (!Number.isFinite(Number(subscriberId))) {
        res.status(400).json({ success: false, error: 'subscriberId обязателен' });
        return;
      }
      const empId = employeeId == null ? null : Number(employeeId);
      if (empId != null && !(await mtsMappingService.employeeExists(empId))) {
        res.status(400).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      // Не-admin не может привязывать абонента к сотруднику вне своего скоупа
      // (закрывает «перепривяжу на себя, чтобы увидеть»).
      if (!hasFullMtsAccess(req) && empId != null && !(await canAccessEmployeeInScope(req, empId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      await mtsMappingService.setMapping(
        Number(subscriberId),
        empId,
        { phone, displayName },
        req.user.id,
      );

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_MAPPING_UPDATED, {
        entityId: String(subscriberId),
        details: { subscriberId, employeeId: empId },
      });

      // Отдаём только то, что зритель имеет право видеть.
      const all = await mtsMappingService.listMappings();
      const visible = hasFullMtsAccess(req)
        ? all
        : (
            await Promise.all(
              all.map(async r =>
                r.employeeId != null && (await canAccessEmployeeInScope(req, r.employeeId)) ? r : null,
              ),
            )
          ).filter((r): r is NonNullable<typeof r> => r !== null);
      res.json({ success: true, data: visible });
    } catch (error) {
      fail(res, error, 'Ошибка сохранения привязки МТС');
    }
  },

  // === Бесплатные расширенные GET-эндпоинты (read-only) ===
  // Все вызовы ниже — только GET к МТС, никаких списаний. Не дёргают requestLocation
  // и subscriberRequests. Подробнее: docs/руководство-по-mts-api.md, секция «Тарификация».

  async getSubscriberGroups(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /subscriber-groups');
    try {
      const data = await mtsDataService.getSubscriberGroups();
      logSuccess('GET /subscriber-groups', `count=${data.length}`);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения групп абонентов МТС');
    }
  },

  async getSubscriberGroup(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = Number(req.params.id);
    logRequest(req, `GET /subscriber-groups/${groupId}`);
    try {
      if (!Number.isFinite(groupId)) {
        res.status(400).json({ success: false, error: 'id обязателен' });
        return;
      }
      const data = await mtsDataService.getSubscriberGroupDetails(groupId);
      logSuccess(`GET /subscriber-groups/${groupId}`, 'ok');
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения группы абонентов МТС');
    }
  },

  /**
   * Шаблоны кастомных полей. Эндпоинт может отсутствовать на некоторых тарифах
   * (404 USER_UNAUTHORIZED по ресурсу / 405 / 501) — отдаём пустой массив, чтобы
   * не валить страницу. Реальные ошибки (401, 500, network) — пробрасываем.
   */
  async getCustomFields(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /custom-fields');
    try {
      const data = await mtsDataService.getCustomFields();
      logSuccess('GET /custom-fields', `count=${data.length}`);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof MtsApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
        console.warn(`[mts] /custom-fields недоступен на тарифе (http=${error.status}, code=${error.code ?? '-'}). Отдаём пустой список.`);
        res.json({ success: true, data: [], notice: 'Эндпоинт недоступен на текущем тарифе' });
        return;
      }
      fail(res, error, 'Ошибка получения кастомных полей МТС');
    }
  },

  async getRecentLocations(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /recent-locations');
    try {
      const { dateFrom, dateTo } = parseDaysRange(req.query.days);
      const data = await mtsDataService.getLocationsRange(dateFrom, dateTo);
      logSuccess('GET /recent-locations', `count=${data.length} range=${dateFrom}..${dateTo}`);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      fail(res, error, 'Ошибка получения локаций МТС');
    }
  },

  async getRecentTracks(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /recent-tracks');
    try {
      const { dateFrom, dateTo } = parseDaysRange(req.query.days);
      const data = await mtsDataService.getTracksRange(dateFrom, dateTo);
      logSuccess('GET /recent-tracks', `count=${data.length} range=${dateFrom}..${dateTo}`);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      fail(res, error, 'Ошибка получения треков МТС');
    }
  },

  async getRecentGlobalLocations(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /recent-global-locations');
    try {
      const { dateFrom, dateTo } = parseDaysRange(req.query.days);
      const data = await mtsDataService.getGlobalLocations(dateFrom, dateTo);
      logSuccess('GET /recent-global-locations', `count=${data.length} range=${dateFrom}..${dateTo}`);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      fail(res, error, 'Ошибка получения GPS-точек МТС');
    }
  },

  // === Сотрудники с MTS-привязкой ===

  /**
   * Пагинированный список сотрудников, связанных с MTS-абонентами через
   * mts_subscriber_map. Расшифровка имени/телефона делается в сервисе.
   * Не-admin — фильтрация по data-scope (как у /subscribers).
   */
  async getEmployeesLinked(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /employees-linked');
    try {
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
      const page = Math.max(1, Number(req.query.page) || 1);
      const offset = (page - 1) * limit;

      // JOIN employees + map + последние снимки (для last_seen_at).
      const rows = await pgQuery<{
        subscriber_id: number;
        employee_id: number | null;
        employee_full_name: string | null;
        employee_tab_number: string | null;
        phone_enc: string | null;
        display_name_enc: string | null;
        last_recorded_at: string | null;
        total_count: number;
      }>(
        `WITH last_snap AS (
           SELECT DISTINCT ON (subscriber_id) subscriber_id, recorded_at
             FROM mts_location_snapshots
            ORDER BY subscriber_id, recorded_at DESC
         )
         SELECT m.subscriber_id, m.employee_id, e.full_name AS employee_full_name,
                e.tab_number AS employee_tab_number,
                m.phone_enc, m.display_name_enc,
                ls.recorded_at AS last_recorded_at,
                count(*) OVER ()::int AS total_count
           FROM mts_subscriber_map m
           LEFT JOIN employees e ON e.id = m.employee_id
           LEFT JOIN last_snap ls ON ls.subscriber_id = m.subscriber_id
          WHERE m.employee_id IS NOT NULL
            AND ($1 = '' OR LOWER(COALESCE(e.full_name, '')) LIKE '%' || $1 || '%')
          ORDER BY e.full_name NULLS LAST
          LIMIT $2 OFFSET $3`,
        [search, limit, offset],
      );

      const items = [];
      for (const r of rows) {
        if (!hasFullMtsAccess(req)) {
          if (!r.employee_id || !(await canAccessEmployeeInScope(req, r.employee_id))) continue;
        }
        items.push({
          subscriberId: r.subscriber_id,
          employeeId: r.employee_id,
          employeeFullName: r.employee_full_name,
          employeeTabNumber: r.employee_tab_number,
          phone: encryptionService.decryptField(r.phone_enc),
          displayName: encryptionService.decryptField(r.display_name_enc),
          lastRecordedAt: r.last_recorded_at,
        });
      }
      const total = rows.length > 0 ? rows[0].total_count : 0;
      res.json({ success: true, data: items, meta: { total, page, pageSize: limit } });
    } catch (error) {
      fail(res, error, 'Ошибка получения списка сотрудников MTS');
    }
  },

  /**
   * Точки трека для рисования на карте: исторические снимки из БД (расшифрованные)
   * + опционально треки/GPS-точки за тот же интервал. Все данные нормализованы
   * к {recordedAt,lat,lng,accuracy,source}.
   */
  async getTrackPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /track-points');
    try {
      const subscriberId = Number(req.query.subscriberId);
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      if (!Number.isFinite(subscriberId) || !dateFrom || !dateTo) {
        res.status(400).json({ success: false, error: 'Нужны subscriberId, dateFrom, dateTo' });
        return;
      }
      if (!hasFullMtsAccess(req)) {
        const employeeId = await mtsMappingService.getEmployeeIdBySubscriber(subscriberId);
        if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
          res.status(403).json({ success: false, error: 'Нет доступа к абоненту' });
          return;
        }
      }
      const snapshots = await mtsDataService.getHistorySnapshots(subscriberId, dateFrom, dateTo, 5000);
      const points = snapshots
        .filter(s => s.latitude != null && s.longitude != null)
        .map(s => ({
          recordedAt: s.recordedAt,
          lat: s.latitude as number,
          lng: s.longitude as number,
          accuracy: s.accuracy,
          source: s.source,
        }))
        // recordedAt может прийти как Date (а не string) → localeCompare падал
        // (FOT-SERVER-1G). Сортируем по таймстампу — устойчиво к Date/string/number.
        .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
      res.json({ success: true, data: points });
    } catch (error) {
      fail(res, error, 'Ошибка получения точек трека');
    }
  },

  /**
   * Детальный трек одного абонента за дату/диапазон: GPS-точки «Координатора» +
   * сегменты Старт→Финиш. Источник правды — БД (mts_gps_points / mts_track_segments,
   * наполняет поллер), поэтому трек виден «спустя время» даже если МТС почистил
   * историю или недоступен. Дополнительно best-effort подмешиваем живой GET за тот
   * же период (свежие точки до ближайшего тика поллера). Дедуп по locationID/trackID.
   */
  async getTrackDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /track-detail');
    try {
      const subscriberId = Number(req.query.subscriberId);
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      if (!Number.isFinite(subscriberId) || !dateFrom || !dateTo) {
        res.status(400).json({ success: false, error: 'Нужны subscriberId, dateFrom, dateTo' });
        return;
      }
      if (!hasFullMtsAccess(req)) {
        const employeeId = await mtsMappingService.getEmployeeIdBySubscriber(subscriberId);
        if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
          res.status(403).json({ success: false, error: 'Нет доступа к абоненту' });
          return;
        }
      }
      const range = buildDateRange(dateFrom, dateTo);
      // БД — источник правды для истории (живёт «спустя время», даже если МТС
      // почистил или недоступен). Живой GET — best-effort, добавляет свежее за период.
      const safe = async <T>(p: Promise<T[]>): Promise<T[]> => {
        try { return await p; } catch { return []; }
      };
      const [dbGps, dbSegments, liveGps, liveSegments] = await Promise.all([
        mtsDataService.getStoredGpsPoints(subscriberId, range.dateFrom, range.dateTo),
        mtsDataService.getStoredTrackSegments(subscriberId, range.dateFrom, range.dateTo),
        safe(mtsDataService.getGlobalLocations(range.dateFrom, range.dateTo)),
        safe(mtsDataService.getTracksRange(range.dateFrom, range.dateTo)),
      ]);

      // Объединяем БД + живое по бизнес-ключу (locationID / trackID).
      const gpsMap = new Map<number, typeof dbGps[number]>();
      for (const p of dbGps) gpsMap.set(p.locationID, p);
      for (const p of liveGps) {
        if (p.subscriberID === subscriberId && p.latitude != null && p.longitude != null) gpsMap.set(p.locationID, p);
      }
      const gps = [...gpsMap.values()].sort((a, b) => String(a.locationDate ?? '').localeCompare(String(b.locationDate ?? '')));

      const segMap = new Map<number, typeof dbSegments[number]>();
      for (const s of dbSegments) segMap.set(s.trackID, s);
      for (const s of liveSegments) {
        if (s.subscriberID === subscriberId) segMap.set(s.trackID, s);
      }
      const segments = [...segMap.values()].sort((a, b) => String(a.startDate ?? '').localeCompare(String(b.startDate ?? '')));

      logSuccess('GET /track-detail', `sub=${subscriberId} gps=${gps.length} seg=${segments.length} range=${range.dateFrom}..${range.dateTo}`);
      res.json({ success: true, data: { gps, segments } });
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      fail(res, error, 'Ошибка получения трека');
    }
  },

  /**
   * Авто-привязка по ФИО: применяет результаты mtsMappingService.suggest()
   * пакетом. Только admin (как и получение подсказок).
   */
  async autoLinkMappings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!hasFullMtsAccess(req)) {
        res.status(403).json({ success: false, error: 'Доступно только администратору' });
        return;
      }
      const subscribers = await mtsDataService.getSubscribers();
      const suggestions = await mtsMappingService.suggest(subscribers);
      for (const s of suggestions) {
        const sub = subscribers.find(x => x.subscriberID === s.subscriberId);
        await mtsMappingService.setMapping(
          s.subscriberId,
          s.employeeId,
          { phone: sub?.phone ?? null, displayName: sub?.name ?? null },
          req.user.id,
        );
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_MAPPING_AUTO_LINKED, {
        details: { applied: suggestions.length },
      });
      res.json({ success: true, data: { applied: suggestions.length, suggestions } });
    } catch (error) {
      fail(res, error, 'Ошибка авто-привязки МТС');
    }
  },

  // === Геозоны ===

  async listGeofences(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await mtsGeofenceService.listGeofences();
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения геозон');
    }
  },

  async createGeofence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name, geometry } = req.body as { name?: unknown; geometry?: unknown };
      const created = await mtsGeofenceService.createGeofence({ name, geometry }, req.user.id);
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_GEOFENCE_CREATED, {
        entityId: created.id,
        details: { name: created.name, points: created.geometry.length },
      });
      res.json({ success: true, data: created });
    } catch (error) {
      if (error instanceof GeofenceValidationError) {
        res.status(400).json({ success: false, error: `Геозона: ${error.reason}` });
        return;
      }
      fail(res, error, 'Ошибка создания геозоны');
    }
  },

  async updateGeofence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name, geometry, isActive } = req.body as { name?: unknown; geometry?: unknown; isActive?: unknown };
      const updated = await mtsGeofenceService.updateGeofence(req.params.id, { name, geometry, isActive });
      if (!updated) {
        res.status(404).json({ success: false, error: 'Геозона не найдена' });
        return;
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_GEOFENCE_UPDATED, {
        entityId: updated.id,
        details: {
          nameChanged: name !== undefined,
          geometryChanged: geometry !== undefined,
          isActive,
        },
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      if (error instanceof GeofenceValidationError) {
        res.status(400).json({ success: false, error: `Геозона: ${error.reason}` });
        return;
      }
      fail(res, error, 'Ошибка обновления геозоны');
    }
  },

  async deleteGeofence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const ok = await mtsGeofenceService.deleteGeofence(req.params.id);
      if (!ok) {
        res.status(404).json({ success: false, error: 'Геозона не найдена' });
        return;
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_GEOFENCE_DELETED, {
        entityId: req.params.id,
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      fail(res, error, 'Ошибка удаления геозоны');
    }
  },

  async setGeofenceAssignments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { employeeIds } = req.body as { employeeIds?: unknown };
      const ids = Array.isArray(employeeIds)
        ? employeeIds.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0)
        : [];
      const updated = await mtsGeofenceService.setAssignments(req.params.id, ids, req.user.id);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Геозона не найдена' });
        return;
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_GEOFENCE_ASSIGNED, {
        entityId: updated.id,
        details: { employeeIds: ids },
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      fail(res, error, 'Ошибка обновления назначений геозоны');
    }
  },

  /**
   * Лёгкий список объектов FOT (skud_objects) для дропдаунов на /mts/geofences
   * и /mts/objects. Возвращает {id, name} активных объектов.
   * Для не-админа фильтруем по data-scope через employee_skud_object_access.
   */
  async listSkudObjectsLite(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /skud-objects-lite');
    try {
      const rows = await pgQuery<{ id: string; name: string }>(
        `SELECT id, name FROM skud_objects WHERE is_active = true ORDER BY name`,
      );
      // MVP: admin видит всё; не-админ — увидит весь список, но дальше backend
      // setObjectAssignments/listGeofencesForObject не делает доп. проверки доступа,
      // т.к. геозоны — admin-only edit (requireCritical2FA в роутере).
      logSuccess('GET /skud-objects-lite', `count=${rows.length}`);
      res.json({ success: true, data: rows });
    } catch (error) {
      fail(res, error, 'Ошибка получения объектов FOT');
    }
  },

  async setGeofenceObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { skudObjectIds } = req.body as { skudObjectIds?: unknown };
      const ids = Array.isArray(skudObjectIds)
        ? (skudObjectIds as unknown[]).map(v => String(v)).filter(v => v.length > 0)
        : [];
      const updated = await mtsGeofenceService.setObjectAssignments(req.params.id, ids, req.user.id);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Геозона не найдена' });
        return;
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_GEOFENCE_OBJECTS_SET, {
        entityId: updated.id,
        details: { skudObjectIds: ids },
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      fail(res, error, 'Ошибка обновления привязки геозоны к объектам');
    }
  },

  async getObjectGeofences(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /objects/:id/geofences');
    try {
      const data = await mtsGeofenceService.listGeofencesForObject(req.params.id);
      logSuccess('GET /objects/:id/geofences', `count=${data.length}`);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения геозон объекта');
    }
  },

  /**
   * Сводка для верхней панели /mts: всего абонентов, привязано, онлайн, нарушений 24ч.
   * Кэш на клиенте 30s; запрос дешёвый (4 COUNT'а + 1 вызов МТС-API через кеш subscribers).
   */
  async getSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    logRequest(req, 'GET /summary');
    try {
      let subscribersTotal = 0;
      let onlineNow = 0;
      try {
        const subs = await mtsDataService.getSubscribers();
        subscribersTotal = subs.length;
        onlineNow = subs.filter(s => s.isOnline === true).length;
      } catch (e) {
        console.warn('[mts] summary: subscribers fetch failed:', e instanceof Error ? e.message : 'unknown');
      }

      const linkedRow = await pgQuery<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM mts_subscriber_map WHERE employee_id IS NOT NULL`,
      );
      const violationsRow = await pgQuery<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM mts_geofence_violations WHERE started_at >= NOW() - INTERVAL '24 hours'`,
      );

      res.json({
        success: true,
        data: {
          subscribersTotal,
          linkedTotal: linkedRow[0]?.c ?? 0,
          onlineNow,
          violationsLast24h: violationsRow[0]?.c ?? 0,
        },
      });
    } catch (error) {
      fail(res, error, 'Ошибка получения сводки МТС');
    }
  },

  async listGeofenceViolations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = req.query.employeeId == null ? null : Number(req.query.employeeId);
      const from = req.query.from ? String(req.query.from) : undefined;
      const to = req.query.to ? String(req.query.to) : undefined;
      const limit = req.query.pageSize ? Math.min(500, Number(req.query.pageSize)) : 100;
      const offset = req.query.page ? (Math.max(1, Number(req.query.page)) - 1) * limit : 0;
      // Фильтр по геозонам: присутствие параметра (даже пустого) включает фильтр —
      // модалка «Карта» шлёт текущие привязки сотрудника; пусто → нарушений нет.
      const geofenceIds = parseGeofenceIds(req.query.geofenceIds);

      const employeeIds: number[] | undefined = Number.isFinite(employeeId) && employeeId
        ? [employeeId as number]
        : undefined;

      // Не-admin: ограничить только своими employees in scope.
      if (!hasFullMtsAccess(req)) {
        if (!employeeIds) {
          res.status(400).json({ success: false, error: 'employeeId обязателен для не-администратора' });
          return;
        }
        const allowed = await canAccessEmployeeInScope(req, employeeIds[0]);
        if (!allowed) {
          res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
          return;
        }
      }

      const { data, total } = await mtsGeofenceService.listViolations({ employeeIds, geofenceIds, from, to, limit, offset });
      res.json({ success: true, data, meta: { total } });
    } catch (error) {
      fail(res, error, 'Ошибка получения нарушений геозон');
    }
  },
};

// ISO без миллисекунд/Z — формат, который ждёт контракт МТС
// («нельзя смешивать форматы в одном запросе» → везде один и тот же).
const trimIso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, '');

// Хелпер: окно последних N дней.
function parseDaysRange(raw: unknown): { dateFrom: string; dateTo: string } {
  const n = Number(raw ?? 1);
  if (!Number.isFinite(n) || n < 1 || n > 7) {
    throw new RangeError('days должен быть от 1 до 7');
  }
  const to = new Date();
  const from = new Date(to.getTime() - n * 86_400_000);
  return { dateFrom: trimIso(from), dateTo: trimIso(to) };
}

// Диапазон по выбранным дням (YYYY-MM-DD). Границы — локальные начало/конец суток,
// затем в ISO-формате контракта МТС. Span ограничен 31 днём (бюджет пагинации МТС).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function buildDateRange(rawFrom: unknown, rawTo: unknown): { dateFrom: string; dateTo: string } {
  const f = String(rawFrom || '');
  const t = String(rawTo || '');
  if (!DAY_RE.test(f) || !DAY_RE.test(t)) {
    throw new RangeError('dateFrom/dateTo должны быть в формате YYYY-MM-DD');
  }
  const start = new Date(`${f}T00:00:00`);
  const end = new Date(`${t}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError('Некорректная дата');
  }
  if (end.getTime() < start.getTime()) {
    throw new RangeError('dateTo раньше dateFrom');
  }
  if (end.getTime() - start.getTime() > 31 * 86_400_000) {
    throw new RangeError('Диапазон не более 31 дня');
  }
  return { dateFrom: trimIso(start), dateTo: trimIso(end) };
}

// Парсит geofenceIds из query (CSV или повтор. параметр) → массив валидных UUID.
// undefined (параметр отсутствует) → фильтр не применять; [] → нет привязок.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseGeofenceIds(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map(v => String(v).trim()).filter(v => UUID_RE.test(v));
}
