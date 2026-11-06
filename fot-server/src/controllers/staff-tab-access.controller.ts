/**
 * Вкладки «Проживание» и «Удержания» в «Система → Назначения сотрудников» (миграция 351): персональная галочка
 * открывает сотруднику правку вкладки «Управления кадрами» по всей организации.
 *
 * Гарды маршрута: /admin/users/access (GET — view, PUT — edit) и правка вкладки ПО РОЛИ (requireRolePageAccess) —
 * получивший галочку не может раздавать её дальше. Здесь же — охват «вся организация» у выдающего, и на выдачу, и на
 * снятие: галочка даёт всю организацию, распоряжаться ею может только тот, кто сам видит всю.
 */
import type { Response } from 'express';
import { z } from 'zod';

import { query, queryOne, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { resolveAccessibleDepartmentIds } from '../services/data-scope.service.js';
import { getEmployeeState } from '../services/dormitory-stays.service.js';
import { loadStaffTabGrant, setStaffTabGrant } from '../services/staff-tab-access.service.js';
import { getIo } from '../socket/io-instance.js';
import type { AuthenticatedRequest, StaffTab } from '../types/index.js';

const bodySchema = z.object({ granted: z.boolean() });

const TAB_LABELS: Record<StaffTab, string> = {
  dormitory: 'Проживание',
  deductions: 'Удержания',
};

const NOT_ORG_WIDE = { success: false, error: 'Выдавать доступ может только тот, кто видит всю организацию' };

const parseEmployeeId = (raw: unknown): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const loadEmployee = (employeeId: number) => queryOne<{ id: number; full_name: string | null }>(
  'SELECT id, full_name FROM employees WHERE id = $1',
  [employeeId],
);

/** Охват «вся организация» у выдающего: админ без ограничения по компании, кадровый админ. */
const isOrgWide = async (req: AuthenticatedRequest): Promise<boolean> => (
  (await resolveAccessibleDepartmentIds(req)) === 'all'
);

/** Причина отказа в выдаче: галочку получает только работающий сотрудник, не из архива и не подрядчик. */
const grantRefusal = async (employeeId: number): Promise<string | null> => {
  const state = await getEmployeeState(employeeId);
  if (!state || state.employment_status !== 'active' || state.is_archived) {
    return 'Доступ можно выдать только работающему сотруднику';
  }
  if (state.is_contractor) return 'Подрядчику доступ выдать нельзя';
  return null;
};

/** Вкладка появляется и пропадает без перезахода. Уникального индекса по employee_id нет — шлём всем учёткам. */
async function emitAccessChangedForEmployee(employeeId: number): Promise<void> {
  const io = getIo();
  if (!io) return;
  const rows = await query<{ id: string }>('SELECT id FROM user_profiles WHERE employee_id = $1', [employeeId]);
  for (const row of rows) {
    io.to(`user:${row.id}`).emit('profile:access_changed');
  }
}

const makeController = (tab: StaffTab) => {
  const label = TAB_LABELS[tab];

  /** GET /api/admin/employees/:id/{dormitory|deductions}-access */
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
      if (!(await isOrgWide(req))) {
        res.status(403).json(NOT_ORG_WIDE);
        return;
      }
      res.json({ success: true, data: { granted: await loadStaffTabGrant(employeeId, tab) } });
    } catch (err) {
      console.error(`staffTabAccess.get(${tab}) error:`, err);
      res.status(500).json({ success: false, error: `Ошибка загрузки доступа к вкладке «${label}»` });
    }
  };

  /** PUT /api/admin/employees/:id/{dormitory|deductions}-access { granted } */
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
      if (!(await isOrgWide(req))) {
        res.status(403).json(NOT_ORG_WIDE);
        return;
      }
      // Снятие — без проверки статуса: отозвать доступ можно всегда.
      if (granted) {
        const refusal = await grantRefusal(employeeId);
        if (refusal) {
          res.status(400).json({ success: false, error: refusal });
          return;
        }
      }
      const changed = await withTransaction(async (client) => {
        const result = await setStaffTabGrant(client, employeeId, tab, granted, req.user.id);
        if (result) {
          await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_STAFF_TAB_ACCESS_CHANGED', {
            entityType: 'employee',
            entityId: String(employeeId),
            details: { employee_id: employeeId, employee_name: employee.full_name, tab, granted },
          });
        }
        return result;
      });
      if (changed) {
        // Сохранение уже зафиксировано: сбой оповещения не превращается в ошибку — профиль обновится при следующей загрузке.
        await emitAccessChangedForEmployee(employeeId).catch((err: unknown) => {
          console.warn('[staff-tab-access] profile:access_changed emit failed:', err instanceof Error ? err.message : err);
        });
      }
      res.json({ success: true, data: { granted } });
    } catch (err) {
      console.error(`staffTabAccess.set(${tab}) error:`, err);
      res.status(500).json({ success: false, error: `Ошибка сохранения доступа к вкладке «${label}»` });
    }
  };

  return { get, set };
};

export const staffTabAccessController = {
  dormitory: makeController('dormitory'),
  deductions: makeController('deductions'),
};
