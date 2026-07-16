import { Response } from 'express';
import { z } from 'zod';
import { auditService } from '../services/audit.service.js';
import { settingsService } from '../services/settings.service.js';
import { assertNewdbBaseUrlAllowed } from '../services/settings.service.js';
import {
  runChecksForPass,
  runChecksBulk,
  refreshPendingForPass,
  listPassesForDepartment,
  listContractorOrgs,
  getResultsForPass,
  getRawResponse,
  BULK_LIMIT,
  type CheckType,
} from '../services/newdb-check.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const saveSettingsSchema = z.object({
  baseUrl: z.string().trim().url().optional().nullable(),
  token: z.string().trim().min(1).optional().nullable(),
});

const runSchema = z.object({
  passId: z.string().uuid(),
  types: z.array(z.enum(['rkl', 'patent_msk', 'patent'])).min(1),
});

const runBulkSchema = z.object({
  passIds: z.array(z.string().uuid()).min(1).max(BULK_LIMIT),
  types: z.array(z.enum(['rkl', 'patent_msk', 'patent'])).min(1),
});

function handleZodError(error: unknown, res: Response): boolean {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Validation failed' });
    return true;
  }
  return false;
}

export const adminChecksController = {
  async getConnectionSettings(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const settings = await settingsService.getNewdbConnectionSettings();
      res.json({ success: true, data: settings });
    } catch (error) {
      console.error('newdb getConnectionSettings error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить настройки' });
    }
  },

  async saveConnectionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const payload = saveSettingsSchema.parse(req.body);
      const settings = await settingsService.setNewdbConnectionSettings(
        { baseUrl: payload.baseUrl ?? undefined, token: payload.token ?? undefined },
        req.user.id,
      );
      await auditService.logFromRequest(req, req.user.id, 'NEWDB_SETTINGS_UPDATED', {
        entityType: 'system_settings',
        entityId: 'newdb',
        details: { baseUrl: settings.baseUrl, tokenChanged: payload.token !== undefined },
      });
      res.json({ success: true, data: settings });
    } catch (error) {
      if (handleZodError(error, res)) return;
      const message = error instanceof Error ? error.message : 'Ошибка сохранения';
      res.status(400).json({ success: false, error: message });
    }
  },

  /** Локальная валидация настроек БЕЗ внешнего платного запроса. */
  async validateConnection(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const settings = await settingsService.getNewdbConnectionSettings();
      const problems: string[] = [];
      if (!settings.hasToken) problems.push('токен не задан');
      try {
        assertNewdbBaseUrlAllowed(settings.baseUrl);
      } catch (e) {
        problems.push(e instanceof Error ? e.message : 'некорректный base URL');
      }
      res.json({
        success: true,
        data: { ok: problems.length === 0, baseUrl: settings.baseUrl, hasToken: settings.hasToken, problems },
      });
    } catch (error) {
      console.error('newdb validateConnection error:', error);
      res.status(500).json({ success: false, error: 'Ошибка валидации настроек' });
    }
  },

  async listOrgs(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgs = await listContractorOrgs();
      res.json({ success: true, data: orgs });
    } catch (error) {
      console.error('newdb listOrgs error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить список организаций' });
    }
  },

  async listPasses(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgDepartmentId = String(req.query.orgDepartmentId || '').trim();
      if (!orgDepartmentId) {
        res.status(400).json({ success: false, error: 'orgDepartmentId обязателен' });
        return;
      }
      const passes = await listPassesForDepartment(orgDepartmentId);
      res.json({ success: true, data: passes });
    } catch (error) {
      console.error('newdb listPasses error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить список пропусков' });
    }
  },

  async run(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const payload = runSchema.parse(req.body);
      const results = await runChecksForPass(payload.passId, payload.types as CheckType[], req.user.id);
      await auditService.logFromRequest(req, req.user.id, 'NEWDB_CHECK_RUN', {
        entityType: 'contractor_pass',
        entityId: payload.passId,
        details: { types: payload.types, statuses: results.map(r => `${r.check_type}:${r.status}`) },
      });
      res.json({ success: true, data: results });
    } catch (error) {
      if (handleZodError(error, res)) return;
      const status = (error as { status?: number })?.status;
      const message = error instanceof Error ? error.message : 'Ошибка запуска проверки';
      res.status(status && status >= 400 && status < 600 ? status : 500).json({ success: false, error: message });
    }
  },

  async runBulk(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const payload = runBulkSchema.parse(req.body);
      const { items, skipped } = await runChecksBulk(payload.passIds, payload.types as CheckType[], req.user.id);
      await auditService.logFromRequest(req, req.user.id, 'NEWDB_CHECK_RUN', {
        entityType: 'contractor_pass',
        entityId: 'bulk',
        details: { requested: payload.passIds.length, processed: items.length, skipped: skipped.length, types: payload.types },
      });
      res.json({ success: true, data: { items, skipped } });
    } catch (error) {
      if (handleZodError(error, res)) return;
      const status = (error as { status?: number })?.status;
      const message = error instanceof Error ? error.message : 'Ошибка массовой проверки';
      res.status(status && status >= 400 && status < 600 ? status : 500).json({ success: false, error: message });
    }
  },

  async refresh(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const passId = String(req.body?.passId || '').trim();
      if (!passId) {
        res.status(400).json({ success: false, error: 'passId обязателен' });
        return;
      }
      const summary = await refreshPendingForPass(passId);
      res.json({ success: true, data: summary });
    } catch (error) {
      console.error('newdb refresh error:', error);
      res.status(500).json({ success: false, error: 'Ошибка обновления результатов' });
    }
  },

  async getResults(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const passId = String(req.query.contractorPassId || '').trim();
      if (!passId) {
        res.status(400).json({ success: false, error: 'contractorPassId обязателен' });
        return;
      }
      const results = await getResultsForPass(passId);
      res.json({ success: true, data: results });
    } catch (error) {
      console.error('newdb getResults error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить историю проверок' });
    }
  },

  async getRaw(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const raw = await getRawResponse(req.params.id);
      if (raw == null) {
        res.status(404).json({ success: false, error: 'Ответ не найден' });
        return;
      }
      res.json({ success: true, data: raw });
    } catch (error) {
      console.error('newdb getRaw error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить сырой ответ' });
    }
  },
};
