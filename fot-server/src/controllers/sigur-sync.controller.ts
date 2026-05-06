import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { buildInclusiveDateRange } from '../utils/date.utils.js';
import { parseFIO } from '../utils/fio.utils.js';
import {
  acquirePresencePollingLock,
  acquireSigurEventsSyncLock,
  ManualSyncInProgressError,
  releasePresencePollingLock,
  releaseSigurEventsSyncLock,
} from '../services/presence-polling.service.js';
import {
  SYNC_ALL_STEP_ORDER,
  seedPositionsLogic,
  syncDepartmentsLogic,
  syncEmployeesLogic,
  syncEventsLogic,
  syncPositionsFromSigurLogic,
  type ISyncContext,
  type SyncAllStepName,
} from '../services/sigur-sync.service.js';
import { invalidateStructureCache, invalidateOrgStructureCaches } from '../services/employee-mapper.service.js';
import {
  isSigurRuntimeNotAllowedError,
  type SigurRuntimeNotAllowedError,
} from '../services/sigur-runtime-guard.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { notifySkudRealtimeChanged } from '../services/skud-realtime.service.js';

type ConnectionType = 'external' | 'internal';

function createSseSender(res: Response) {
  let msgCount = 0;
  return (data: Record<string, unknown>) => {
    msgCount++;
    if (data.type === 'events_day') {
      console.log(`[SSE #${msgCount}] events_day: day=${data.day} percent=${data.percent}%`);
    }
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

function sendManualSyncConflict(res: Response, error: ManualSyncInProgressError): void {
  res.status(409).json({
    success: false,
    error: error.message,
    code: 'SYNC_IN_PROGRESS',
  });
}

function sendSigurRuntimeNotAllowed(res: Response, error: SigurRuntimeNotAllowedError): void {
  res.status(error.status).json({
    success: false,
    error: error.message,
    code: error.code,
  });
}

async function safeReleasePresencePollingLock(context: string): Promise<void> {
  try {
    await releasePresencePollingLock();
  } catch (error) {
    console.error(`[${context}] releasePresencePollingLock error:`, error);
  }
}

async function safeReleaseSigurEventsSyncLock(context: string): Promise<void> {
  try {
    await releaseSigurEventsSyncLock();
  } catch (error) {
    console.error(`[${context}] releaseSigurEventsSyncLock error:`, error);
  }
}

export const sigurSyncController = {
  async sync(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let sendProgress: ReturnType<typeof createSseSender> | null = null;

    try {
      if (!(await sigurService.isConfigured())) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      keepAliveTimer = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15_000);
      res.on('close', () => {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      });

      sendProgress = createSseSender(res);

      await acquireSigurEventsSyncLock({
        onWait: update => {
          sendProgress?.({
            type: 'waiting',
            reason: update.kind,
            waitedMs: update.waitedMs,
            message: update.message,
          });
        },
      });
      lockAcquired = true;

      const connection = (req.body.connection as ConnectionType) || undefined;
      const context: ISyncContext = {};

      const result = await syncEventsLogic(
        startDate,
        endDate,
        connection,
        sendProgress,
        context,
      );

      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
          dateRange: { startDate, endDate },
          ...result,
        },
      });

      notifySkudRealtimeChanged({
        source: 'manual_sync',
        from: startDate,
        to: endDate,
        insertedCount: result.imported,
        recalculatedCount: result.matched,
      });

      sendProgress({ type: 'done', ...result });
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      res.end();
    } catch (error) {
      if (isManualSyncConflict(error)) {
        if (res.headersSent && sendProgress) {
          try {
            sendProgress({
              type: 'error',
              code: 'SYNC_IN_PROGRESS',
              message: error.message,
            });
            res.end();
          } catch {
            // Ignore SSE write failures after disconnect
          }
        } else {
          sendManualSyncConflict(res, error);
        }
        return;
      }
      if (isSigurRuntimeNotAllowedError(error)) {
        if (res.headersSent && sendProgress) {
          try {
            sendProgress({
              type: 'error',
              code: error.code,
              message: error.message,
            });
            res.end();
          } catch {
            // Ignore SSE write failures after disconnect
          }
        } else {
          sendSigurRuntimeNotAllowed(res, error);
        }
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
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
      }
      if (lockAcquired) {
        await safeReleaseSigurEventsSyncLock('sigur.sync');
      }
    }
  },

  async syncEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const connection = (req.body.connection as ConnectionType) || undefined;

      await acquirePresencePollingLock();
      lockAcquired = true;

      sigurService.invalidateEmployeeCache();
      sigurService.invalidateDepartmentCache();
      const result = await syncEmployeesLogic(connection, undefined, {});
      res.json({ success: true, data: result });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res, error);
        return;
      }
      if (isSigurRuntimeNotAllowedError(error)) {
        sendSigurRuntimeNotAllowed(res, error);
        return;
      }

      console.error('Sigur syncEmployees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта сотрудников из Sigur' });
    } finally {
      if (lockAcquired) {
        await safeReleasePresencePollingLock('sigur.syncEmployees');
      }
    }
  },

  async syncDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const connection = (req.body.connection as ConnectionType) || undefined;

      await acquirePresencePollingLock();
      lockAcquired = true;

      sigurService.invalidateDepartmentCache();
      const result = await syncDepartmentsLogic(connection, {});
      invalidateOrgStructureCaches();
      res.json({ success: true, data: result });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res, error);
        return;
      }
      if (isSigurRuntimeNotAllowedError(error)) {
        sendSigurRuntimeNotAllowed(res, error);
        return;
      }

      console.error('Sigur syncDepartments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта отделов из Sigur' });
    } finally {
      if (lockAcquired) {
        await safeReleasePresencePollingLock('sigur.syncDepartments');
      }
    }
  },

  async syncPositions(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;

    try {
      const connection = (req.body.connection as ConnectionType) || undefined;

      await acquirePresencePollingLock();
      lockAcquired = true;

      sigurService.invalidatePositionCache();
      const result = await syncPositionsFromSigurLogic(connection, {});
      invalidateStructureCache();
      res.json({ success: true, data: result });
    } catch (error) {
      if (isManualSyncConflict(error)) {
        sendManualSyncConflict(res, error);
        return;
      }
      if (isSigurRuntimeNotAllowedError(error)) {
        sendSigurRuntimeNotAllowed(res, error);
        return;
      }

      console.error('Sigur syncPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта должностей из Sigur' });
    } finally {
      if (lockAcquired) {
        await safeReleasePresencePollingLock('sigur.syncPositions');
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
        sendManualSyncConflict(res, error);
        return;
      }
      if (isSigurRuntimeNotAllowedError(error)) {
        sendSigurRuntimeNotAllowed(res, error);
        return;
      }

      console.error('Clear events error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления событий' });
    } finally {
      if (lockAcquired) {
        await safeReleasePresencePollingLock('sigur.clearEvents');
      }
    }
  },

  async syncAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    let lockAcquired = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let sendProgress: ReturnType<typeof createSseSender> | null = null;

    try {
      if (!(await sigurService.isConfigured())) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const steps = normalizeSelectedSteps(req.body.steps);
      if (steps.length === 0) {
        res.status(400).json({ success: false, error: 'Не выбраны шаги синхронизации' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      keepAliveTimer = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15_000);
      res.on('close', () => {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
        }
      });

      sendProgress = createSseSender(res);

      await acquirePresencePollingLock({
        onWait: update => {
          sendProgress?.({
            type: 'waiting',
            reason: update.kind,
            waitedMs: update.waitedMs,
            message: update.message,
          });
        },
      });
      lockAcquired = true;

      if (steps.includes('departments') || steps.includes('employees')) {
        sigurService.invalidateDepartmentCache();
      }
      if (steps.includes('employees')) {
        sigurService.invalidateEmployeeCache();
      }
      if (steps.includes('positions')) {
        sigurService.invalidatePositionCache();
      }

      const progressSender = sendProgress || undefined;
      const connection = (req.body.connection as ConnectionType) || undefined;
      const context: ISyncContext = {};

      const stepDefinitions: Array<{
        id: number;
        name: SyncAllStepName;
        label: string;
        fn: () => Promise<Record<string, unknown>>;
      }> = [
        {
          id: 1,
          name: 'departments' as SyncAllStepName,
          label: 'Импорт отделов (иерархия)',
          fn: async () => syncDepartmentsLogic(connection, context) as unknown as Record<string, unknown>,
        },
        {
          id: 2,
          name: 'positions' as SyncAllStepName,
          label: 'Импорт должностей',
          fn: async () => {
            const fromSigur = await syncPositionsFromSigurLogic(connection, context);
            const seeded = await seedPositionsLogic();
            return { ...fromSigur, seeded: seeded.created };
          },
        },
        {
          id: 3,
          name: 'employees' as SyncAllStepName,
          label: 'Импорт сотрудников',
          fn: async () => syncEmployeesLogic(connection, progressSender, context, true) as unknown as Record<string, unknown>,
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

      // Сбрасываем кэш структуры если были шаги структуры/сотрудников.
      // Если синхронизировались departments/employees — инвалидируем все три
      // (employee-mapper + dept tree + sync filter), иначе только лёгкий name-кэш.
      if (steps.includes('departments') || steps.includes('employees')) {
        invalidateOrgStructureCaches();
      } else if (steps.includes('positions')) {
        invalidateStructureCache();
      }

      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
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
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      res.end();
    } catch (error) {
      if (isManualSyncConflict(error)) {
        if (res.headersSent && sendProgress) {
          try {
            sendProgress({
              type: 'error',
              code: 'SYNC_IN_PROGRESS',
              message: error.message,
            });
            res.end();
          } catch {
            // Ignore SSE write failures after disconnect
          }
        } else {
          sendManualSyncConflict(res, error);
        }
        return;
      }
      if (isSigurRuntimeNotAllowedError(error)) {
        if (res.headersSent && sendProgress) {
          try {
            sendProgress({
              type: 'error',
              code: error.code,
              message: error.message,
            });
            res.end();
          } catch {
            // Ignore SSE write failures after disconnect
          }
        } else {
          sendSigurRuntimeNotAllowed(res, error);
        }
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
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
      }
      if (lockAcquired) {
        await safeReleasePresencePollingLock('sigur.syncAll');
      }
    }
  },

  async matchEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { matches, createNew } = req.body as {
        matches?: Array<{ sigurId: number; employeeId: number }>;
        createNew?: Array<{ sigurId?: number; name: string; orgDepartmentId?: string; positionId?: string }>;
      };

      let linked = 0;
      let created = 0;
      const errors: string[] = [];

      // Привязка существующих сотрудников к Sigur ID
      if (matches && matches.length > 0) {
        for (const m of matches) {
          const { error } = await supabase
            .from('employees')
            .update({ sigur_employee_id: m.sigurId })
            .eq('id', m.employeeId);

          if (error) {
            errors.push(`Привязка #${m.employeeId}: ${error.message}`);
          } else {
            linked++;
          }
        }
      }

      // Создание новых сотрудников
      if (createNew && createNew.length > 0) {
        for (const emp of createNew) {
          const fio = parseFIO(emp.name);
          const { error } = await supabase.from('employees').insert({
            full_name: emp.name.trim(),
            last_name: fio.lastName,
            first_name: fio.firstName || null,
            middle_name: fio.middleName || null,
            hire_date: new Date().toISOString().slice(0, 10),
            sigur_employee_id: emp.sigurId || null,
            org_department_id: emp.orgDepartmentId || null,
            position_id: emp.positionId || null,
          });

          if (error) {
            errors.push(`Создание ${emp.name}: ${error.message}`);
          } else {
            created++;
          }
        }
      }

      await auditService.logFromRequest(req, req.user.id, 'MATCH_EMPLOYEES', {
        details: { linked, created, errors },
      });

      res.json({ success: true, data: { linked, created, errors } });
    } catch (error) {
      console.error('matchEmployees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сопоставления сотрудников' });
    }
  },
};
