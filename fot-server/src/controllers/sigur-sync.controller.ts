import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { buildInclusiveDateRange } from '../utils/date.utils.js';
import {
  acquirePresencePollingLock,
  ManualSyncInProgressError,
  releasePresencePollingLock,
} from '../services/presence-polling.service.js';
import {
  SYNC_ALL_STEP_ORDER,
  cleanDuplicateOrganizationsLogic,
  seedPositionsLogic,
  syncDepartmentsLogic,
  syncEmployeesLogic,
  syncEventsLogic,
  syncOrganizationsLogic,
  syncPositionsFromSigurLogic,
  type ISyncContext,
  type SyncAllStepName,
} from '../services/sigur-sync.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

type ConnectionType = 'external' | 'internal';

async function resolveOrganizationId(req: AuthenticatedRequest): Promise<string | null> {
  const requestedOrgId = req.body.organization_id || req.query.organization_id || req.user.organization_id;
  if (requestedOrgId) {
    return requestedOrgId;
  }

  const { data: orgs } = await supabase.from('organizations').select('id').limit(1);
  return orgs?.[0]?.id || null;
}

function createSseSender(res: Response) {
  return (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

function normalizeSelectedSteps(rawSteps: unknown): SyncAllStepName[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return ['departments', 'positions', 'employees'];
  }

  const selected = rawSteps.filter((step): step is SyncAllStepName =>
    typeof step === 'string' && SYNC_ALL_STEP_ORDER.includes(step as SyncAllStepName),
  );

  return SYNC_ALL_STEP_ORDER.filter(step => selected.includes(step));
}

function isManualSyncConflict(error: unknown): error is ManualSyncInProgressError {
  return error instanceof ManualSyncInProgressError;
}

function sendManualSyncConflict(res: Response): void {
  res.status(409).json({
    success: false,
    error: 'Ручная синхронизация уже выполняется. Дождитесь завершения текущего запуска.',
    code: 'SYNC_IN_PROGRESS',
  });
}

export const sigurSyncController = {
  async sync(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны' });
        return;
      }

      const organizationId = await resolveOrganizationId(req);
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      await acquirePresencePollingLock();
      lockAcquired = true;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sendProgress = createSseSender(res);
      const connection = (req.body.connection as ConnectionType) || undefined;
      const context: ISyncContext = {};

      const result = await syncEventsLogic(
        organizationId,
        startDate,
        endDate,
        connection,
        sendProgress,
        context,
      );

      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
          organizationId,
          dateRange: { startDate, endDate },
          ...result,
        },
      });

      sendProgress({ type: 'done', ...result });
      res.end();
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res);
        return;
      }

      console.error('Sigur sync error:', error);
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Ошибка синхронизации данных из Sigur' })}\n\n`);
          res.end();
        } catch {
          // Ignore SSE write failures after disconnect
        }
      } else {
        res.status(500).json({ success: false, error: 'Ошибка синхронизации данных из Sigur' });
      }
    } finally {
      if (lockAcquired) {
        releasePresencePollingLock();
      }
    }
  },

  async syncEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const organizationId = await resolveOrganizationId(req);
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const connection = (req.body.connection as ConnectionType) || undefined;

      await acquirePresencePollingLock();
      lockAcquired = true;

      const result = await syncEmployeesLogic(organizationId, connection, undefined, {});
      res.json({ success: true, data: result });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res);
        return;
      }

      console.error('Sigur syncEmployees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта сотрудников из Sigur' });
    } finally {
      if (lockAcquired) {
        releasePresencePollingLock();
      }
    }
  },

  async syncDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const organizationId = await resolveOrganizationId(req);
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const connection = (req.body.connection as ConnectionType) || undefined;

      await acquirePresencePollingLock();
      lockAcquired = true;

      const result = await syncDepartmentsLogic(organizationId, connection, {});
      res.json({ success: true, data: result });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res);
        return;
      }

      console.error('Sigur syncDepartments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта отделов из Sigur' });
    } finally {
      if (lockAcquired) {
        releasePresencePollingLock();
      }
    }
  },

  async syncPositions(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const organizationId = await resolveOrganizationId(req);
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const connection = (req.body.connection as ConnectionType) || undefined;

      await acquirePresencePollingLock();
      lockAcquired = true;

      const result = await syncPositionsFromSigurLogic(organizationId, connection, {});
      res.json({ success: true, data: result });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res);
        return;
      }

      console.error('Sigur syncPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта должностей из Sigur' });
    } finally {
      if (lockAcquired) {
        releasePresencePollingLock();
      }
    }
  },

  async clearEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны' });
        return;
      }

      await acquirePresencePollingLock();
      lockAcquired = true;

      const days = buildInclusiveDateRange(startDate, endDate);
      let totalDeleted = 0;
      const errors: string[] = [];

      for (const day of days) {
        const { count, error: deleteError } = await supabase
          .from('skud_events')
          .delete({ count: 'exact' })
          .eq('event_date', day);

        if (deleteError) {
          errors.push(`[${day}] ${deleteError.message}`);
        } else {
          totalDeleted += count || 0;
        }
      }

      await supabase
        .from('skud_daily_summary')
        .delete()
        .gte('date', startDate)
        .lte('date', endDate);

      await auditService.logFromRequest(req, req.user.id, 'CLEAR_SKUD', {
        details: { startDate, endDate, deletedCount: totalDeleted, errors },
      });

      res.json({ success: true, data: { deleted: totalDeleted, errors } });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res);
        return;
      }

      console.error('Clear events error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления событий' });
    } finally {
      if (lockAcquired) {
        releasePresencePollingLock();
      }
    }
  },

  async syncAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const organizationId = await resolveOrganizationId(req);
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const steps = normalizeSelectedSteps(req.body.steps);
      if (steps.length === 0) {
        res.status(400).json({ success: false, error: 'Не выбраны шаги синхронизации' });
        return;
      }

      await acquirePresencePollingLock();
      lockAcquired = true;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sendProgress = createSseSender(res);
      const connection = (req.body.connection as ConnectionType) || undefined;
      const context: ISyncContext = {};

      console.log(`[syncAll] resolved organizationId: ${organizationId}, user.organization_id: ${req.user.organization_id}`);

      const stepDefinitions: Array<{
        id: number;
        name: SyncAllStepName;
        label: string;
        fn: () => Promise<Record<string, unknown>>;
      }> = [
        {
          id: 1,
          name: 'organizations' as SyncAllStepName,
          label: 'Импорт организаций',
          fn: async () => syncOrganizationsLogic(connection, context) as unknown as Record<string, unknown>,
        },
        {
          id: 2,
          name: 'clean-duplicates' as SyncAllStepName,
          label: 'Очистка дублей',
          fn: async () => cleanDuplicateOrganizationsLogic() as unknown as Record<string, unknown>,
        },
        {
          id: 3,
          name: 'departments' as SyncAllStepName,
          label: 'Импорт отделов (иерархия)',
          fn: async () => syncDepartmentsLogic(organizationId, connection, context) as unknown as Record<string, unknown>,
        },
        {
          id: 4,
          name: 'positions' as SyncAllStepName,
          label: 'Импорт должностей',
          fn: async () => {
            const fromSigur = await syncPositionsFromSigurLogic(organizationId, connection, context);
            const seeded = await seedPositionsLogic(organizationId);
            return { ...fromSigur, seeded: seeded.created };
          },
        },
        {
          id: 5,
          name: 'employees' as SyncAllStepName,
          label: 'Импорт сотрудников',
          fn: async () => syncEmployeesLogic(organizationId, connection, sendProgress, context) as unknown as Record<string, unknown>,
        },
      ].filter(step => steps.includes(step.name));

      const results: Record<string, unknown> = {};
      const failedSteps: SyncAllStepName[] = [];
      sendProgress({ type: 'start', steps });

      for (const step of stepDefinitions) {
        const startedAt = Date.now();
        sendProgress({ type: 'step', step: step.id, name: step.name, label: step.label, status: 'running' });

        try {
          const result = await step.fn();
          const durationMs = Date.now() - startedAt;
          const resultWithDuration = { ...result, durationMs };
          results[step.name] = resultWithDuration;
          console.log(`[syncAll] step ${step.name} done in ${durationMs}ms`);
          sendProgress({ type: 'step', step: step.id, name: step.name, label: step.label, status: 'done', result: resultWithDuration });
        } catch (error) {
          const message = (error as Error).message;
          const durationMs = Date.now() - startedAt;
          results[step.name] = { error: message, durationMs };
          failedSteps.push(step.name);
          console.error(`[syncAll] step ${step.name} failed in ${durationMs}ms: ${message}`);
          sendProgress({ type: 'step', step: step.id, name: step.name, label: step.label, status: 'error', error: message, durationMs });
        }
      }

      const hasErrors = failedSteps.length > 0;

      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
          organizationId,
          steps,
          hasErrors,
          failedSteps,
          results,
        },
      });

      sendProgress({
        type: 'done',
        results,
        steps,
        hasErrors,
        failedSteps,
        completedSteps: stepDefinitions.length - failedSteps.length,
      });
      res.end();
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res);
        return;
      }

      console.error('Sigur syncAll error:', error);
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Ошибка полной синхронизации' })}\n\n`);
          res.end();
        } catch {
          // Ignore SSE write failures after disconnect
        }
      } else {
        res.status(500).json({ success: false, error: 'Ошибка полной синхронизации' });
      }
    } finally {
      if (lockAcquired) {
        releasePresencePollingLock();
      }
    }
  },
};
