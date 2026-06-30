/**
 * Контроллер общего пула пропусков подрядчиков.
 * Все эндпоинты — для системного администратора.
 *
 * Маршруты подключаются в contractor-admin.routes.ts под префиксом
 * /pool/* и /sigur-departments.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { Sentry } from '../instrument.js';
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { resolveCompanyScope } from '../services/data-scope.service.js';
import {
  addPassesToPool,
  assignPoolPassesByCount,
  assignPoolPassesToContractor,
  cancelProvisioningFailedPasses,
  enqueueRevoke,
  getFreePasses,
  getFreePoolDepartmentId,
  getPoolMatrix,
  getPoolRanges,
  listFailedSyncs,
  listPool,
  PoolNotConfiguredError,
  retryRevokeSync,
  retryStuckPoolPasses,
  setFreePoolDepartmentId,
} from '../services/contractor-pool.service.js';
import { kickContractorPassSync } from '../services/contractor-pass-sync.scheduler.js';
import { sigurService } from '../services/sigur.service.js';
import { ContractorScopeError } from '../services/contractor-scope.service.js';
import { isContractorSigurDryRun } from '../config/contractor.js';

const ensureSystemAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<boolean> => {
  const scope = await resolveCompanyScope(req);
  if (scope.roots !== 'all') {
    res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
    return false;
  }
  return true;
};

const sendPoolNotConfigured = (res: Response): void => {
  res.status(400).json({
    success: false,
    error: 'Папка общего пула не настроена. Выберите её на вкладке «Общий пул».',
    code: 'POOL_NOT_CONFIGURED',
  });
};

interface ISigurDepartmentRaw {
  id: number;
  name: string;
  parentId?: number | null;
  parent_id?: number | null;
}

export const contractorPoolController = {
  /** GET /pool/settings — текущая выбранная папка пула. */
  async getSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const id = await getFreePoolDepartmentId();
      let name: string | null = null;
      if (id != null && !isContractorSigurDryRun()) {
        try {
          const map = await sigurService.getDepartmentMapCached();
          name = map.get(id) ?? null;
        } catch (e) {
          console.error('Pool getSettings: resolve dept name error', e);
        }
      }
      res.json({ success: true, data: { sigur_department_id: id, name } });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.getSettings' } });
      console.error('Pool getSettings error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить настройки пула' });
    }
  },

  /** PUT /pool/settings — сохранить выбранную папку пула. Body: { sigur_department_id|null }. */
  async setSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const { sigur_department_id } = z.object({
        sigur_department_id: z.number().int().positive().nullable(),
      }).parse(req.body);

      // Валидация: проверяем что отдел существует в Sigur.
      if (sigur_department_id != null && !isContractorSigurDryRun()) {
        const map = await sigurService.getDepartmentMapCached();
        if (!map.has(sigur_department_id)) {
          res.status(400).json({ success: false, error: 'Отдел не найден в Sigur' });
          return;
        }
      }

      await setFreePoolDepartmentId(sigur_department_id, req.user.id);
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_SETTINGS_CHANGED, {
        entityType: 'system_settings',
        entityId: 'contractor.free_pool.sigur_department_id',
        details: { sigur_department_id },
      });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      Sentry.captureException(error, { tags: { route: 'contractor.pool.setSettings' } });
      console.error('Pool setSettings error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить настройки' });
    }
  },

  /** GET /sigur-departments — все отделы Sigur (id, name, parentId) для TreeSelect. */
  async listSigurDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      if (isContractorSigurDryRun()) {
        res.json({ success: true, data: [] });
        return;
      }
      const raw = await sigurService.getDepartmentsCached();
      const data = (raw as unknown as ISigurDepartmentRaw[])
        .map(d => ({
          id: typeof d.id === 'number' ? d.id : null,
          name: typeof d.name === 'string' ? d.name : null,
          parent_id: d.parentId ?? d.parent_id ?? null,
        }))
        .filter(d => d.id != null && d.name != null);
      res.json({ success: true, data });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.listSigurDepartments' } });
      console.error('Pool listSigurDepartments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить отделы Sigur' });
    }
  },

  /** GET /pool?limit=&offset=&search= — пропуска в общем пуле (пагинация). */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const limitRaw = Number(req.query.limit);
      const offsetRaw = Number(req.query.offset);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
      const data = await listPool({ search, limit, offset });
      res.json({ success: true, data });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.list' } });
      console.error('Pool list error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить пул' });
    }
  },

  /** GET /pool/ranges — диапазоны для шапки вкладки «Общий пул». */
  async getRanges(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const data = await getPoolRanges();
      res.json({ success: true, data });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.getRanges' } });
      console.error('Pool getRanges error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить диапазоны пула' });
    }
  },

  /** GET /pool/matrix — все пропуска пула (ячейка на номер) с цветом по статусу. */
  async matrix(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const data = await getPoolMatrix();
      res.json({ success: true, data });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.matrix' } });
      console.error('Pool matrix error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить матрицу пула' });
    }
  },

  /**
   * POST /pool/issue — добавить пакет карт в пул.
   * Body: { from, to?, cards: [{uid, sequence}] }.
   */
  async issueToPool(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const body = z.object({
        from: z.number().int().positive(),
        to: z.number().int().positive().optional(),
        cards: z.array(z.object({
          uid: z.string().trim().min(1),
          sequence: z.number().int().nonnegative(),
        })).min(1).max(100),
      }).parse(req.body);

      const result = await addPassesToPool({
        from: body.from,
        to: body.to,
        cards: body.cards,
        createdBy: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ADDED, {
        entityType: 'contractor_pool',
        entityId: 'pool',
        details: {
          created: result.created.length,
          failed: result.failed.length,
          warnings: result.warnings.length,
          // Конкретные не выпущенные номера и контрольный missing — чтобы дыру
          // можно было найти по аудиту (раньше падал «какой-то один» без следа).
          failed_numbers: result.failed.map(f => f.pass_number),
          missing: result.missing,
        },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof PoolNotConfiguredError) {
        sendPoolNotConfigured(res);
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      Sentry.captureException(error, {
        tags: { route: 'contractor.pool.issueToPool' },
        extra: { userId: req.user?.id },
      });
      console.error('Pool issueToPool error:', error);
      res.status(500).json({ success: false, error: 'Не удалось добавить пропуска в пул' });
    }
  },

  /**
   * POST /pool/retry-provisioning — повторить выпуск «застрявших» строк пула
   * (provisioning_failed + stale provisioning). Body: { pass_numbers?: string[] }.
   * Без pass_numbers — обрабатывает все застрявшие; иначе только указанные номера.
   */
  async retryProvisioning(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const body = z.object({
        pass_numbers: z.array(z.string().trim().min(1)).max(500).optional(),
      }).parse(req.body ?? {});

      const result = await retryStuckPoolPasses(body.pass_numbers);

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ADDED, {
        entityType: 'contractor_pool',
        entityId: 'pool',
        details: {
          action: 'retry_provisioning',
          retried: result.retried,
          recovered: result.created.length,
          failed: result.failed.length,
          failed_numbers: result.failed.map(f => f.pass_number),
        },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof PoolNotConfiguredError) {
        sendPoolNotConfigured(res);
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      Sentry.captureException(error, {
        tags: { route: 'contractor.pool.retryProvisioning' },
        extra: { userId: req.user?.id },
      });
      console.error('Pool retryProvisioning error:', error);
      res.status(500).json({ success: false, error: 'Не удалось перезапустить выпуск пропусков' });
    }
  },

  /**
   * POST /pool/cancel-provisioning — отменить «застрявший» выпуск по номерам:
   * удалить строки provisioning/provisioning_failed (org IS NULL) + подчистить
   * placeholder-профиль в Sigur. Освобождает номер. Body: { pass_numbers: string[] }.
   */
  async cancelProvisioning(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const body = z.object({
        pass_numbers: z.array(z.string().trim().min(1)).min(1).max(500),
      }).parse(req.body ?? {});

      const result = await cancelProvisioningFailedPasses(body.pass_numbers);

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ADDED, {
        entityType: 'contractor_pool',
        entityId: 'pool',
        details: {
          action: 'cancel_provisioning',
          cancelled: result.cancelled,
          failed_numbers: result.failed.map(f => f.pass_number),
        },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      Sentry.captureException(error, {
        tags: { route: 'contractor.pool.cancelProvisioning' },
        extra: { userId: req.user?.id },
      });
      console.error('Pool cancelProvisioning error:', error);
      res.status(500).json({ success: false, error: 'Не удалось отменить выпуск пропусков' });
    }
  },

  /**
   * POST /pool/assign — назначить выбранные пропуска пула подрядчику.
   * Body: { pass_ids: [uuid], org_department_id: uuid, notify? }.
   */
  async assign(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const body = z.object({
        pass_ids: z.array(z.string().uuid()).min(1).max(500),
        org_department_id: z.string().uuid(),
      }).parse(req.body);

      let result;
      try {
        result = await assignPoolPassesToContractor({
          passIds: body.pass_ids,
          orgDepartmentId: body.org_department_id,
          userId: req.user.id,
        });
      } catch (e) {
        if (e instanceof ContractorScopeError) {
          res.status(e.status).json({ success: false, error: e.message });
          return;
        }
        throw e;
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ASSIGNED, {
        entityType: 'contractor_org',
        entityId: body.org_department_id,
        details: { assigned: result.assigned.length, failed: result.failed.length },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      Sentry.captureException(error, {
        tags: { route: 'contractor.pool.assign' },
        extra: { userId: req.user?.id },
      });
      console.error('Pool assign error:', error);
      res.status(500).json({ success: false, error: 'Не удалось назначить пропуска' });
    }
  },

  /**
   * POST /admin/contractor/passes/:id/revoke — отозвать пропуск, отправленный
   * подрядчику, обратно в общий пул. Быстрый путь: пропуск МГНОВЕННО возвращается
   * в пул в БД, ответ 200 сразу; перенос/блокировка профиля в Sigur делается
   * фоновым шедулером (kickContractorPassSync — немедленный триггер).
   */
  async revokePass(req: AuthenticatedRequest, res: Response): Promise<void> {
    const passId = typeof req.params.id === 'string' ? req.params.id : undefined;
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const parsedPassId = z.string().uuid().parse(req.params.id);
      let result;
      try {
        result = await enqueueRevoke({ passId: parsedPassId, userId: req.user.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/не найден|уже в пуле|отозван/i.test(msg)) {
          res.status(400).json({ success: false, error: msg });
          return;
        }
        throw e;
      }

      kickContractorPassSync();

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ADDED, {
        entityType: 'contractor_pass',
        entityId: parsedPassId,
        details: { action: 'revoked_to_pool', pass_number: result.pass_number },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id пропуска' });
        return;
      }
      Sentry.captureException(error, {
        tags: { route: 'contractor.revokePass' },
        extra: { passId, userId: req.user?.id },
      });
      console.error('Pool revokePass error:', error);
      res.status(500).json({ success: false, error: 'Не удалось отозвать пропуск' });
    }
  },

  /**
   * GET /passes/sync-failed — пропуска с застрявшей досинхронизацией отзыва в Sigur
   * (sigur_sync_state='failed'): профиль в Sigur мог остаться в чужой папке/под старым
   * ФИО/разблокированным, хотя в БД пропуск уже «в пуле». Для индикатора в «Мониторинге».
   */
  async syncFailed(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const data = await listFailedSyncs();
      res.json({ success: true, data });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.syncFailed' } });
      console.error('Pool syncFailed error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить проблемы синхронизации' });
    }
  },

  /** POST /passes/:id/retry-sync — повторить застрявшую досинхронизацию отзыва. */
  async retrySync(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const passId = z.string().uuid().parse(req.params.id);
      const ok = await retryRevokeSync(passId);
      if (!ok) {
        res.status(409).json({ success: false, error: 'Пропуск не в статусе «ошибка синхронизации»' });
        return;
      }
      kickContractorPassSync();
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ADDED, {
        entityType: 'contractor_pass',
        entityId: passId,
        details: { action: 'retry_revoke_sync' },
      });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id пропуска' });
        return;
      }
      Sentry.captureException(error, { tags: { route: 'contractor.pool.retrySync' } });
      console.error('Pool retrySync error:', error);
      res.status(500).json({ success: false, error: 'Не удалось перезапустить синхронизацию' });
    }
  },

  /** GET /pool/free — все свободные пропуска (id+номер) для матрицы выбора. */
  async free(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const data = await getFreePasses();
      res.json({ success: true, data });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.free' } });
      console.error('Pool free error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить свободные пропуска' });
    }
  },

  /**
   * POST /pool/assign-count — назначить подрядчику первые N свободных пропусков.
   * Body: { count, org_department_id }.
   */
  async assignCount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const body = z.object({
        count: z.number().int().positive().max(500),
        org_department_id: z.string().uuid(),
      }).parse(req.body);

      let result;
      try {
        result = await assignPoolPassesByCount({
          count: body.count,
          orgDepartmentId: body.org_department_id,
          userId: req.user.id,
        });
      } catch (e) {
        if (e instanceof ContractorScopeError) {
          res.status(e.status).json({ success: false, error: e.message });
          return;
        }
        throw e;
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_POOL_PASSES_ASSIGNED, {
        entityType: 'contractor_org',
        entityId: body.org_department_id,
        details: { requested: body.count, assigned: result.assigned.length, failed: result.failed.length },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      Sentry.captureException(error, {
        tags: { route: 'contractor.pool.assignCount' },
        extra: { userId: req.user?.id },
      });
      console.error('Pool assignCount error:', error);
      res.status(500).json({ success: false, error: 'Не удалось назначить пропуска' });
    }
  },

  /** GET /pool/next-number — следующий свободный номер для нового пакета. */
  async getNextNumber(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      // MAX по ВСЕМ строкам пула (org IS NULL), включая provisioning/
      // provisioning_failed: reserve материализует строку до Sigur, поэтому
      // сорвавшийся выпуск больше не «теряет» номер — MAX его учитывает.
      const rows = await query<{ max_num: number | null }>(
        `SELECT MAX(pass_number::int) AS max_num FROM contractor_passes
          WHERE org_department_id IS NULL`,
      );
      const max = rows[0]?.max_num ?? null;
      res.json({ success: true, data: { next: max ? max + 1 : 1 } });
    } catch (error) {
      Sentry.captureException(error, { tags: { route: 'contractor.pool.getNextNumber' } });
      console.error('Pool getNextNumber error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить номер' });
    }
  },
};
