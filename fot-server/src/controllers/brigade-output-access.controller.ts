/**
 * Вкладка «Выработка» в «Система → Назначения сотрудников» (миграция 342): кому открыт ввод выработки в «Табель →
 * Бригады» и просмотр «Зарплаты по объектам».
 *
 * Выдают только учётки из списка «Зарплаты»: гарды маршрута — /admin/users/access и /salary/terms. Админ компании
 * выдаёт только в своей зоне, снять может у любого: это только сужает доступ.
 */
import type { Response } from 'express';
import { z } from 'zod';

import { queryOne, withTransaction, query } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { canAccessEmployeeInScope, canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { loadBrigadeOutputGrant, setBrigadeOutputGrant } from '../services/payroll/brigade-output-access.service.js';
import { getIo } from '../socket/io-instance.js';
import type { AuthenticatedRequest } from '../types/index.js';

const bodySchema = z.object({ granted: z.boolean() });

const parseEmployeeId = (raw: unknown): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const loadEmployee = (employeeId: number) => queryOne<{ id: number; full_name: string | null }>(
  'SELECT id, full_name FROM employees WHERE id = $1',
  [employeeId],
);

/** Кнопки в табеле появляются и пропадают без перезахода. Уникального индекса по employee_id нет — шлём всем учёткам. */
async function emitAccessChangedForEmployee(employeeId: number): Promise<void> {
  const io = getIo();
  if (!io) return;
  const rows = await query<{ id: string }>('SELECT id FROM user_profiles WHERE employee_id = $1', [employeeId]);
  for (const row of rows) {
    io.to(`user:${row.id}`).emit('profile:access_changed');
  }
}

/** GET /api/admin/employees/:id/brigade-output-access */
const get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const employeeId = parseEmployeeId(req.params.id);
  if (!employeeId) {
    res.status(400).json({ success: false, error: 'Некорректный сотрудник' });
    return;
  }
  try {
    if (!(await loadEmployee(employeeId))) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
      return;
    }
    res.json({ success: true, data: { granted: await loadBrigadeOutputGrant(employeeId) } });
  } catch (err) {
    console.error('brigadeOutputAccess.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки доступа к выработке' });
  }
};

/** PUT /api/admin/employees/:id/brigade-output-access { granted } */
const set = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const employeeId = parseEmployeeId(req.params.id);
  if (!employeeId) {
    res.status(400).json({ success: false, error: 'Некорректный сотрудник' });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Некорректное значение доступа' });
    return;
  }
  const { granted } = parsed.data;
  try {
    const employee = await loadEmployee(employeeId);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (granted && !(await canWriteEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
      return;
    }
    const changed = await withTransaction(async (client) => {
      const result = await setBrigadeOutputGrant(client, employeeId, granted, req.user.id);
      if (result) {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_BRIGADE_OUTPUT_ACCESS_CHANGED', {
          entityType: 'employee',
          entityId: String(employeeId),
          details: { employee_id: employeeId, employee_name: employee.full_name, granted },
        });
      }
      return result;
    });
    if (changed) {
      // Сохранение уже зафиксировано: сбой оповещения не превращается в ошибку — профиль обновится при следующей загрузке.
      await emitAccessChangedForEmployee(employeeId).catch((err: unknown) => {
        console.warn('[brigade-output-access] profile:access_changed emit failed:', err instanceof Error ? err.message : err);
      });
    }
    res.json({ success: true, data: { granted } });
  } catch (err) {
    console.error('brigadeOutputAccess.set error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доступа к выработке' });
  }
};

export const brigadeOutputAccessController = { get, set };
