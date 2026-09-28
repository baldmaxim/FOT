/**
 * Вкладка «Зарплата» в «Система → Назначения сотрудников»: персональный доступ сотрудника
 * к разделу «Зарплата» (миграция 288, payroll-access.service).
 *
 * Оба метода — только системный администратор (гард requireSystemAdmin в admin.routes):
 * доступ открывает условия оплаты всего штата, и админ компании выдал бы право шире
 * своего охвата.
 */
import type { Response } from 'express';
import { z } from 'zod';

import { query, queryOne } from '../config/postgres.js';
import { getIo } from '../socket/io-instance.js';
import { auditService } from '../services/audit.service.js';
import {
  loadPayrollAccessLevel,
  setPayrollAccessLevel,
} from '../services/payroll/payroll-access.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const bodySchema = z.object({
  level: z.enum(['view', 'edit']).nullable(),
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
 * Обновить меню и права у всех учёток сотрудника без перелогина. Уникального индекса по
 * user_profiles.employee_id нет — встречаются два профиля на одного человека.
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

/** GET /api/admin/employees/:id/payroll-access — текущий уровень: view | edit | null. */
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
    res.json({ success: true, data: { level: await loadPayrollAccessLevel(employeeId) } });
  } catch (err) {
    console.error('payrollAccess.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки доступа к «Зарплате»' });
  }
};

/** PUT /api/admin/employees/:id/payroll-access — выдать, сменить или снять (level: null). */
const set = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const employeeId = parseEmployeeId(req.params.id);
  if (!employeeId) {
    res.status(400).json({ success: false, error: 'Некорректный сотрудник' });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Некорректный уровень доступа' });
    return;
  }
  const { level } = parsed.data;

  try {
    const employee = await loadEmployee(employeeId);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }

    let changed = false;
    await setPayrollAccessLevel(employeeId, level, req.user.id, async (client, previous) => {
      changed = true;
      await auditService.logFromRequestWithClient(client, req, req.user.id, 'PAYROLL_ACCESS_CHANGED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_id: employeeId,
          employee_name: employee.full_name,
          from: previous,
          to: level,
        },
      });
    });

    if (changed) {
      // Сохранение уже зафиксировано: сбой оповещения не должен превращаться в ошибку —
      // права у получателя обновятся при следующей загрузке профиля.
      await emitAccessChangedForEmployee(employeeId).catch((err: unknown) => {
        console.warn('[payroll-access] profile:access_changed emit failed:', err instanceof Error ? err.message : err);
      });
    }

    res.json({ success: true, data: { level } });
  } catch (err) {
    console.error('payrollAccess.set error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доступа к «Зарплате»' });
  }
};

export const payrollAccessController = { get, set };
