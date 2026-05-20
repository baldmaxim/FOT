import { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { settingsService } from '../services/settings.service.js';
import { mtsDataService } from '../services/mts-data.service.js';
import { mtsMappingService } from '../services/mts-mapping.service.js';
import { MtsApiError } from '../services/mts-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';

// Безопасность:
// - Ошибки апстрима МТС не пробрасываются в клиент/Sentry body (могут содержать
//   ПДн абонента). Клиенту — generic message + HTTP/функциональный код, в лог —
//   status/code без message-тела.
// - Доступ super_admin = весь модуль. Прочие роли (если когда-то получат /mts)
//   видят только привязанных абонентов в своём data-scope; авто-подсказки и
//   неназначенные абоненты — только super_admin.
// - Аудит на сохранение настроек и изменение привязок.

const isSuperAdmin = (req: AuthenticatedRequest): boolean => req.user.role_code === 'super_admin';

const sendApiError = (res: Response, error: MtsApiError, fallback: string): void => {
  console.error(`[mts] upstream error: http=${error.status} code=${error.code ?? '-'}`);
  res.status(502).json({
    success: false,
    error: error.code ? `Ошибка МТС (код ${error.code})` : fallback,
  });
};

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsApiError) {
    sendApiError(res, error, fallback);
    return;
  }
  console.error(`[mts] ${fallback}:`, error instanceof Error ? error.message : 'unknown');
  res.status(500).json({ success: false, error: fallback });
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
    try {
      const result = await mtsDataService.testConnection();
      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof MtsApiError) {
        // Тест-эндпоинт: показываем результат «не удалось» без body апстрима.
        res.json({
          success: true,
          data: { ok: false, count: 0, error: error.code ? `код МТС ${error.code}` : 'не удалось' },
        });
        return;
      }
      fail(res, error, 'Ошибка проверки подключения МТС');
    }
  },

  /** Фильтрует список абонентов по data-scope (super_admin видит всё). */
  async getSubscribers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const subs = await mtsDataService.getSubscribers();
      if (isSuperAdmin(req)) {
        res.json({ success: true, data: subs });
        return;
      }
      const mappings = await mtsMappingService.listMappings();
      const allowed = new Set<number>();
      for (const m of mappings) {
        if (m.employeeId == null) continue;
        if (await canAccessEmployeeInScope(req, m.employeeId)) allowed.add(m.subscriberId);
      }
      res.json({ success: true, data: subs.filter(s => allowed.has(s.subscriberID)) });
    } catch (error) {
      fail(res, error, 'Ошибка получения абонентов МТС');
    }
  },

  async getLastLocations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const locations = await mtsDataService.getLastLocations();
      // Снимки шифрованно сохраняем сразу (все, что прислал МТС — это инвентарь).
      await mtsDataService.persistLocationSnapshots(locations);

      if (isSuperAdmin(req)) {
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

  /** IDOR-guard: не super_admin — только если абонент привязан к сотруднику в скоупе. */
  async getTrack(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const subscriberId = Number(req.query.subscriberId);
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      if (!Number.isFinite(subscriberId) || !dateFrom || !dateTo) {
        res.status(400).json({ success: false, error: 'Нужны subscriberId, dateFrom, dateTo' });
        return;
      }

      if (!isSuperAdmin(req)) {
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
   * зашифрован — здесь расшифровывается и возвращается. IDOR: не-super_admin
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

      if (!isSuperAdmin(req)) {
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
   * РУЧНОЙ платный запрос актуального положения. Защита: super_admin + critical 2FA
   * (на уровне роута) + явное { confirmed:true } в body. Аудит обязателен.
   */
  async requestLocation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: 'Доступно только super_admin' });
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
      if (isSuperAdmin(req)) {
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

  /** Авто-подсказки = name-directory; отдаём только super_admin. */
  async getMappingSuggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!isSuperAdmin(req)) {
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
      // Не super_admin не может привязывать абонента к сотруднику вне своего скоупа
      // (закрывает «перепривяжу на себя, чтобы увидеть»).
      if (!isSuperAdmin(req) && empId != null && !(await canAccessEmployeeInScope(req, empId))) {
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
      const visible = isSuperAdmin(req)
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
};
