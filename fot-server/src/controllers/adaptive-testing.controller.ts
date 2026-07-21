import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { adaptiveTestingService } from '../services/adaptive-testing.service.js';
import { adaptiveTestingLlmService } from '../services/adaptive-testing-llm.service.js';
import { settingsService } from '../services/settings.service.js';
import { canAccessEmployeeInScope, resolveAccessibleEmployeeIds } from '../services/data-scope.service.js';

const getHttpStatus = (err: unknown): number =>
  (err as { httpStatus?: number }).httpStatus ?? 500;

const handleError = (res: Response, err: unknown, route: string): void => {
  const status = getHttpStatus(err);
  if (status >= 500) {
    console.error(`adaptive-testing ${route} error:`, err);
    Sentry.captureException(err, { tags: { route: `adaptive-testing:${route}` } });
  }
  res.status(status).json({
    success: false,
    error: err instanceof Error ? err.message : 'Внутренняя ошибка',
    code: (err as { code?: string }).code,
  });
};

const parsePagination = (req: AuthenticatedRequest): { limit: number; offset: number } => {
  const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const offset = Number.parseInt(String(req.query.offset ?? ''), 10);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 25,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
};

export const adaptiveTestingController = {
  // ─── Сотрудник ───

  async getAvailability(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await adaptiveTestingService.getAvailability(req.user.email, req.user.employee_id);
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'availability');
    }
  },

  async startSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.status(409).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
        return;
      }
      const data = await adaptiveTestingService.startSession(req.user.email, req.user.employee_id, req.user.id);
      res.status(202).json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'start');
    }
  },

  async getCurrent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.json({ success: true, data: { state: 'none', canStartNew: false } });
        return;
      }
      const data = await adaptiveTestingService.getCurrentSession(req.user.employee_id);
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'current');
    }
  },

  /** Разбор уже отвеченного вопроса — правильные варианты и рубрика. */
  async getAnswerReveal(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.status(409).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
        return;
      }
      const data = await adaptiveTestingService.getAnswerReveal(
        req.user.employee_id, String(req.params.sessionId), String(req.params.questionId),
      );
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'reveal');
    }
  },

  async submitAnswer(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.status(409).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
        return;
      }
      const sessionId = String(req.params.sessionId);
      const body = (req.body ?? {}) as { questionId?: unknown; answer?: unknown };
      if (typeof body.questionId !== 'string') {
        res.status(400).json({ success: false, error: 'questionId обязателен' });
        return;
      }
      const data = await adaptiveTestingService.submitAnswer(
        req.user.employee_id, sessionId, body.questionId, body.answer,
      );
      res.status(202).json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный формат ответа' });
        return;
      }
      handleError(res, err, 'answer');
    }
  },

  async retrySession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.status(409).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
        return;
      }
      const data = await adaptiveTestingService.retrySession(req.user.employee_id);
      res.status(202).json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'retry');
    }
  },

  async cancelSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.status(409).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
        return;
      }
      await adaptiveTestingService.cancelSession(req.user.employee_id);
      res.json({ success: true });
    } catch (err) {
      handleError(res, err, 'cancel');
    }
  },

  async listMyResults(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user.employee_id) {
        res.json({ success: true, data: [] });
        return;
      }
      const { limit, offset } = parsePagination(req);
      const data = await adaptiveTestingService.listResultsForEmployee(req.user.employee_id, limit, offset);
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'my-results');
    }
  },

  async getMyResultDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const detail = await adaptiveTestingService.getResultDetail(String(req.params.sessionId), true);
      // Только владелец.
      if (!detail || detail.employeeId !== req.user.employee_id) {
        res.status(404).json({ success: false, error: 'Результат не найден' });
        return;
      }
      res.json({ success: true, data: detail });
    } catch (err) {
      handleError(res, err, 'my-result-detail');
    }
  },

  // ─── Руководитель / админ ───

  async listResults(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveAccessibleEmployeeIds(req);
      const { limit, offset } = parsePagination(req);
      const data = await adaptiveTestingService.listResultsScoped(scope, limit, offset);
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'results');
    }
  },

  async getResultDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Полные ответы видит только админ; руководитель — итог и компетенции.
      const includeAnswers = req.user.is_admin === true;
      const detail = await adaptiveTestingService.getResultDetail(String(req.params.sessionId), includeAnswers);
      if (!detail) {
        res.status(404).json({ success: false, error: 'Результат не найден' });
        return;
      }
      const allowed = await canAccessEmployeeInScope(req, detail.employeeId);
      if (!allowed) {
        res.status(403).json({ success: false, error: 'Нет доступа к этому результату' });
        return;
      }
      res.json({ success: true, data: detail });
    } catch (err) {
      handleError(res, err, 'result-detail');
    }
  },

  async getCoverage(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await adaptiveTestingService.getCoverageReport();
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'coverage');
    }
  },

  // ─── Skill-профили ───

  async listProfiles(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await adaptiveTestingService.listProfiles();
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'profiles');
    }
  },

  async createProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await adaptiveTestingService.saveProfile(req.body, req.user.id);
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ success: false, error: err.issues.map(i => i.message).join('; ') });
        return;
      }
      handleError(res, err, 'profile-create');
    }
  },

  async updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await adaptiveTestingService.saveProfile(req.body, req.user.id, String(req.params.profileId));
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ success: false, error: err.issues.map(i => i.message).join('; ') });
        return;
      }
      handleError(res, err, 'profile-update');
    }
  },

  // ─── Настройки LLM (страница «Система») ───

  async getSettings(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await settingsService.getAdaptiveTestingSettings();
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'settings-get');
    }
  },

  async putSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = (req.body ?? {}) as Parameters<typeof settingsService.setAdaptiveTestingSettings>[0];
      const data = await settingsService.setAdaptiveTestingSettings(body, req.user.id);
      res.json({ success: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      res.status(400).json({ success: false, error: message });
    }
  },

  async healthCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const zdr = Boolean((req.body as { zdr?: unknown } | undefined)?.zdr);
      // Инициатор журналируется (требование безопасности).
      console.log(`[adaptive] health-check by user=${req.user.id} zdr=${zdr}`);
      const data = await adaptiveTestingLlmService.runHealthCheck({ zdr });
      if (data.ok && zdr) {
        await settingsService.markAdaptiveZdrVerified(req.user.id);
      }
      res.json({ success: true, data });
    } catch (err) {
      handleError(res, err, 'health-check');
    }
  },
};
