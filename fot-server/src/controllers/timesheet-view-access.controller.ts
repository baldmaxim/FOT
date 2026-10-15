/**
 * Вкладка «Просмотр табеля» в «Система → Назначения сотрудников» (миграция 309,
 * employee-timesheet-view-access.service): кому чей табель открыт только на чтение.
 *
 * Права — как у соседней вкладки «Объекты»: '/admin/users/access' (view — чтение, edit —
 * сохранение). Админ компании назначает только в пределах своей компании: и смотрящий, и
 * каждый добавляемый сотрудник проверяются canWriteEmployeeInScope — как в назначении
 * прямых подчинённых (direct-reports.controller).
 */
import type { Response } from 'express';
import { z } from 'zod';

import { query, queryOne, withTransaction } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { auditService } from '../services/audit.service.js';
import {
  canAccessEmployeeInScope,
  canWriteEmployeeInScope,
  resolveAccessibleDepartmentIds,
} from '../services/data-scope.service.js';
import {
  listTimesheetViewAssignments,
  listTimesheetViewEmployeeIds,
  replaceTimesheetViewEmployees,
} from '../services/employee-timesheet-view-access.service.js';
import { getIo } from '../socket/io-instance.js';
import type { AuthenticatedRequest } from '../types/index.js';

const bodySchema = z.object({
  employee_ids: z.array(z.number().int().positive()).max(5000),
});

const parseEmployeeId = (raw: unknown): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const loadEmployee = (employeeId: number) => queryOne<{ id: number; full_name: string | null }>(
  'SELECT id, full_name FROM employees WHERE id = $1',
  [employeeId],
);

/**
 * Обновить профиль смотрящего без перелогина (флаг has_timesheet_view_employees, грид
 * «Мои сотрудники»). Уникального индекса по user_profiles.employee_id нет — шлём всем.
 */
async function emitAccessChangedForEmployee(employeeId: number): Promise<void> {
  const io = getIo();
  if (!io) return;
  const rows = await query<{ id: string }>(
    'SELECT id FROM user_profiles WHERE employee_id = $1',
    [employeeId],
  );
  for (const row of rows) {
    io.to(`user:${row.id}`).emit('profile:access_changed');
  }
}

/** GET /api/admin/employees/:id/timesheet-view-employees — кого смотрит сотрудник. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const viewerId = parseEmployeeId(req.params.id);
  if (!viewerId) {
    res.status(400).json({ success: false, error: 'Некорректный сотрудник' });
    return;
  }
  try {
    if (!(await loadEmployee(viewerId))) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, viewerId))) {
      res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
      return;
    }
    res.json({ success: true, data: await listTimesheetViewAssignments(viewerId) });
  } catch (err) {
    console.error('timesheetViewAccess.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки «Просмотра табеля»' });
  }
};

/** PUT /api/admin/employees/:id/timesheet-view-employees — полная замена списка. */
const replace = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const viewerId = parseEmployeeId(req.params.id);
  if (!viewerId) {
    res.status(400).json({ success: false, error: 'Некорректный сотрудник' });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Некорректный список сотрудников' });
    return;
  }
  const employeeIds = [...new Set(parsed.data.employee_ids)];
  if (employeeIds.includes(viewerId)) {
    res.status(400).json({ success: false, error: 'Нельзя назначить сотруднику его самого' });
    return;
  }

  try {
    const viewer = await loadEmployee(viewerId);
    if (!viewer) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (employeeIds.length > 0) {
      const existing = await query<{ id: number | string }>(
        'SELECT id FROM employees WHERE id = ANY($1::bigint[])',
        [employeeIds],
      );
      const existingIds = new Set(existing.map(row => Number(row.id)));
      const missing = employeeIds.filter(id => !existingIds.has(id));
      if (missing.length > 0) {
        res.status(400).json({ success: false, error: 'Сотрудник не найден', details: { missing_employee_ids: missing } });
        return;
      }
    }

    // Админ компании: и смотрящий, и каждый добавляемый — в его зоне. Снимать можно любого
    // из уже назначенных: это только сужает доступ.
    if ((await resolveAccessibleDepartmentIds(req)) !== 'all') {
      const current = new Set(await listTimesheetViewEmployeeIds(viewerId));
      const added = employeeIds.filter(id => !current.has(id));
      const checks = await Promise.all([viewerId, ...added].map(id => canWriteEmployeeInScope(req, id)));
      if (checks.some(ok => !ok)) {
        res.status(403).json({ success: false, error: 'Сотрудники вне вашей зоны доступа' });
        return;
      }
    }

    const diff = await withTransaction(async (client) => {
      const result = await replaceTimesheetViewEmployees(client, viewerId, employeeIds, req.user.id);
      if (result.added.length > 0 || result.removed.length > 0) {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_TIMESHEET_VIEW_ACCESS_CHANGED', {
          entityType: 'employee',
          entityId: String(viewerId),
          details: {
            viewer_employee_id: viewerId,
            viewer_name: viewer.full_name,
            added: result.added,
            removed: result.removed,
          },
        });
      }
      return result;
    });

    if (diff.added.length > 0 || diff.removed.length > 0) {
      // Состав грида «Мои сотрудники» и поиск «По сотруднику» кэшируются на сервере до 5 мин.
      invalidateCaches(
        'timesheet',
        'timesheet:today',
        'timesheet:overview',
        'timesheet:overview:today',
        'timesheet:search',
        'timesheet:employee-search',
      );
      // Сохранение уже зафиксировано: сбой оповещения не превращается в ошибку —
      // профиль обновится при следующей загрузке.
      await emitAccessChangedForEmployee(viewerId).catch((err: unknown) => {
        console.warn('[timesheet-view-access] profile:access_changed emit failed:', err instanceof Error ? err.message : err);
      });
    }

    res.json({ success: true, data: await listTimesheetViewAssignments(viewerId) });
  } catch (err) {
    console.error('timesheetViewAccess.replace error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения «Просмотра табеля»' });
  }
};

export const timesheetViewAccessController = { list, replace };
