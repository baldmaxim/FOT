/**
 * Вкладка «Выработка» в «Система → Назначения сотрудников» (миграция 342): кому открыт ввод выработки в «Табель →
 * Бригады» и просмотр «Зарплаты по объектам». Вторая галочка (370) — «Ставить КТУ своим бригадам» начальнику участка.
 *
 * Выдают только учётки из списка «Зарплаты»: гарды маршрута — /admin/users/access и /salary/terms. Админ компании
 * выдаёт только в своей зоне, снять может у любого: это только сужает доступ.
 */
import type { Response } from 'express';
import { z } from 'zod';

import { queryOne, withTransaction, query } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { canAccessEmployeeInScope, canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { listSupervisedBrigadeIds } from '../services/brigade-supervisors.service.js';
import {
  loadBrigadeOutputGrant,
  loadSupervisorKtuGrant,
  setBrigadeOutputGrant,
  setSupervisorKtuGrant,
} from '../services/payroll/brigade-output-access.service.js';
import { getIo } from '../socket/io-instance.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Обе галочки необязательны (старый фронт шлёт только granted): поля нет — значение не меняется. */
const bodySchema = z.object({
  granted: z.boolean().optional(),
  supervisor_ktu: z.boolean().optional(),
}).refine(body => body.granted !== undefined || body.supervisor_ktu !== undefined);

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
    const [granted, supervisorKtu, supervised] = await Promise.all([
      loadBrigadeOutputGrant(employeeId),
      loadSupervisorKtuGrant(employeeId),
      listSupervisedBrigadeIds(employeeId),
    ]);
    // supervised_brigades — бригады, где он сейчас начальник участка: по ним панель показывает вторую галочку.
    res.json({
      success: true,
      data: { granted, supervisor_ktu: supervisorKtu, supervised_brigades: supervised.length },
    });
  } catch (err) {
    console.error('brigadeOutputAccess.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки доступа к выработке' });
  }
};

/**
 * PUT /api/admin/employees/:id/brigade-output-access { granted?, supervisor_ktu? } — обе галочки одной транзакцией с
 * аудитом. Выдача любой — только в своей зоне; «КТУ своим бригадам» — только начальнику участка хотя бы одной бригады.
 */
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
  const { granted, supervisor_ktu: supervisorKtu } = parsed.data;
  try {
    const employee = await loadEmployee(employeeId);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if ((granted || supervisorKtu) && !(await canWriteEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
      return;
    }
    if (
      supervisorKtu
      && !(await loadSupervisorKtuGrant(employeeId))
      && (await listSupervisedBrigadeIds(employeeId)).length === 0
    ) {
      res.status(400).json({
        success: false,
        error: 'Сотрудник не начальник участка ни одной бригады',
        code: 'NOT_BRIGADE_SUPERVISOR',
      });
      return;
    }
    const changed = await withTransaction(async (client) => {
      const details = { employee_id: employeeId, employee_name: employee.full_name };
      const outputChanged = granted !== undefined && await setBrigadeOutputGrant(client, employeeId, granted, req.user.id);
      if (outputChanged) {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_BRIGADE_OUTPUT_ACCESS_CHANGED', {
          entityType: 'employee',
          entityId: String(employeeId),
          details: { ...details, granted },
        });
      }
      const ktuChanged = supervisorKtu !== undefined
        && await setSupervisorKtuGrant(client, employeeId, supervisorKtu, req.user.id);
      if (ktuChanged) {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_SUPERVISOR_KTU_ACCESS_CHANGED', {
          entityType: 'employee',
          entityId: String(employeeId),
          details: { ...details, granted: supervisorKtu },
        });
      }
      return outputChanged || ktuChanged;
    });
    if (changed) {
      // Сохранение уже зафиксировано: сбой оповещения не превращается в ошибку — профиль обновится при следующей загрузке.
      await emitAccessChangedForEmployee(employeeId).catch((err: unknown) => {
        console.warn('[brigade-output-access] profile:access_changed emit failed:', err instanceof Error ? err.message : err);
      });
    }
    const [grantedNow, supervisorKtuNow] = await Promise.all([
      granted ?? loadBrigadeOutputGrant(employeeId),
      supervisorKtu ?? loadSupervisorKtuGrant(employeeId),
    ]);
    res.json({ success: true, data: { granted: grantedNow, supervisor_ktu: supervisorKtuNow } });
  } catch (err) {
    console.error('brigadeOutputAccess.set error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доступа к выработке' });
  }
};

export const brigadeOutputAccessController = { get, set };
