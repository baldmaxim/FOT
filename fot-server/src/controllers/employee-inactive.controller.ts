/**
 * «Перевести в неактивные» / «Вернуть в активные» (миграция 381) — ручная метка employees.staff_inactive_at.
 *
 * Право — флаг учётки user_profiles.can_manage_staff_inactive (выдаётся только SQL; сейчас — Чепиков П. В.), роль его
 * не даёт и админу тоже. Плюс правка «Управления кадрами» и охват сотрудника (canWriteEmployeeInScope).
 *
 * Каждое действие — один условный UPDATE в транзакции, аудит в ней же: гонка с увольнением, переводом отдела или
 * вторым запросом решается условием UPDATE, а не предварительным чтением. Строку читаем, только если UPDATE ничего
 * не изменил, — чтобы выбрать текст ответа.
 *
 * Перевод закрывает доступ сразу: в той же транзакции token_version + 1 у учёток сотрудника (кроме служебных с
 * login_when_staff_inactive), после коммита — событие account_blocked и отключение сокетов только этих учёток.
 * После «Вернуть в активные» старые токены остаются отозванными — вход заново.
 */
import type { Response } from 'express';
import { queryOne, withTransaction } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { INACTIVE_ACCOUNT_CODE, INACTIVE_ACCOUNT_ERROR } from '../services/account-status.service.js';
import { auditService } from '../services/audit.service.js';
import { canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import { loadAutoInactiveDepartments } from '../services/employee-inactive.service.js';
import { blockUserSockets } from '../socket/io-instance.js';
import type { AuthenticatedRequest } from '../types/index.js';

const NO_RIGHT_ERROR = 'Нет права менять статус «Неактивный»';

/** Право на кнопки — только флаг учётки. */
export async function canManageStaffInactive(userId: string): Promise<boolean> {
  const row = await queryOne<{ allowed: boolean | null }>(
    'SELECT can_manage_staff_inactive AS allowed FROM user_profiles WHERE id = $1::uuid',
    [userId],
  );
  return row?.allowed === true;
}

interface IEmployeeInactiveRow {
  id: number;
  full_name: string | null;
  employment_status: string;
  org_department_id: string | null;
  staff_inactive_at: Date | string | null;
}

const loadEmployeeInactiveRow = (employeeId: number): Promise<IEmployeeInactiveRow | null> => queryOne<IEmployeeInactiveRow>(
  `SELECT id, full_name, employment_status, org_department_id, staff_inactive_at
     FROM employees
    WHERE id = $1`,
  [employeeId],
);

/** id сотрудника из пути; не целое положительное — null. */
const parseEmployeeId = (raw: string | undefined): number | null => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

type GuardResult = { ok: true; employeeId: number } | { ok: false };

/** Общие проверки: id, право учётки, охват сотрудника. Ответ об отказе уже отправлен. */
async function guard(req: AuthenticatedRequest, res: Response): Promise<GuardResult> {
  const employeeId = parseEmployeeId(req.params.id);
  if (employeeId === null) {
    res.status(400).json({ success: false, error: 'Некорректный сотрудник' });
    return { ok: false };
  }
  if (!(await canManageStaffInactive(req.user.id))) {
    res.status(403).json({ success: false, error: NO_RIGHT_ERROR, code: 'STAFF_INACTIVE_FORBIDDEN' });
    return { ok: false };
  }
  if (!(await canWriteEmployeeInScope(req, employeeId))) {
    res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
    return { ok: false };
  }
  return { ok: true, employeeId };
}

const conflict = (res: Response, error: string, code: string): void => {
  res.status(409).json({ success: false, error, code });
};

/** После коммита: кэш карточки и списка «Все пользователи» — статус там обновляется сразу. */
function invalidateAfterChange(employeeId: number): void {
  employeeCache.invalidate(employeeId);
  invalidateCaches('admin:users:list');
}

/** POST /api/employees/:id/deactivate */
export async function deactivateEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const checked = await guard(req, res);
    if (!checked.ok) return;
    const { employeeId } = checked;
    const auto = await loadAutoInactiveDepartments();

    const result = await withTransaction(async (client) => {
      const updated = await client.query<{ id: number; full_name: string | null; staff_inactive_at: Date | string }>(
        `UPDATE employees
            SET staff_inactive_at = now(),
                staff_inactive_by = $2::uuid,
                updated_at = now()
          WHERE id = $1
            AND employment_status <> 'fired'
            AND staff_inactive_at IS NULL
            AND (org_department_id IS NULL OR org_department_id <> ALL($3::uuid[]))
            AND id IS DISTINCT FROM $4::int
          RETURNING id, full_name, staff_inactive_at`,
        [employeeId, req.user.id, auto.ids, req.user.employee_id ?? null],
      );
      const row = updated.rows[0];
      if (!row) return null;
      // Отзыв сессий учёток сотрудника, кроме служебных: неактивность их вход не закрывает.
      const revoked = await client.query<{ id: string }>(
        `UPDATE user_profiles
            SET token_version = token_version + 1, updated_at = now()
          WHERE employee_id = $1
            AND login_when_staff_inactive IS NOT TRUE
          RETURNING id`,
        [employeeId],
      );
      const revokedUserIds = revoked.rows.map(profile => profile.id);
      await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_DEACTIVATED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: { full_name: row.full_name, revoked_user_ids: revokedUserIds },
      });
      return { row, revokedUserIds };
    });

    if (!result) {
      const current = await loadEmployeeInactiveRow(employeeId);
      if (!current) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      } else if (current.employment_status === 'fired') {
        conflict(res, 'Сотрудник уволен', 'EMPLOYEE_FIRED');
      } else if (current.staff_inactive_at) {
        conflict(res, 'Сотрудник уже переведён в неактивные', 'ALREADY_INACTIVE');
      } else if (current.org_department_id && auto.nameById.has(current.org_department_id)) {
        conflict(res, `Сотрудник неактивен по отделу «${auto.nameById.get(current.org_department_id)}»`, 'INACTIVE_BY_DEPARTMENT');
      } else if (req.user.employee_id === employeeId) {
        conflict(res, 'Нельзя перевести в неактивные себя', 'SELF_DEACTIVATION');
      } else {
        // Состояние сменилось между UPDATE и чтением (например, отдел вернули из «Декрета») — пусть повторят.
        conflict(res, 'Состояние сотрудника изменилось — обновите список', 'STATE_CHANGED');
      }
      return;
    }

    invalidateAfterChange(employeeId);
    blockUserSockets(result.revokedUserIds, { code: INACTIVE_ACCOUNT_CODE, message: INACTIVE_ACCOUNT_ERROR });
    const inactiveAt = result.row.staff_inactive_at;
    res.json({
      success: true,
      data: {
        id: employeeId,
        staff_inactive_at: inactiveAt instanceof Date ? inactiveAt.toISOString() : inactiveAt,
      },
    });
  } catch (error) {
    console.error('Deactivate employee error:', error);
    res.status(500).json({ success: false, error: 'Не удалось перевести сотрудника в неактивные' });
  }
}

/** POST /api/employees/:id/reactivate — снимает только ручную метку. */
export async function reactivateEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const checked = await guard(req, res);
    if (!checked.ok) return;
    const { employeeId } = checked;

    const result = await withTransaction(async (client) => {
      const updated = await client.query<{ id: number; full_name: string | null; org_department_id: string | null }>(
        `UPDATE employees
            SET staff_inactive_at = NULL,
                staff_inactive_by = NULL,
                updated_at = now()
          WHERE id = $1
            AND employment_status <> 'fired'
            AND staff_inactive_at IS NOT NULL
          RETURNING id, full_name, org_department_id`,
        [employeeId],
      );
      const row = updated.rows[0];
      if (!row) return null;
      await auditService.logFromRequestWithClient(client, req, req.user.id, 'EMPLOYEE_REACTIVATED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: { full_name: row.full_name },
      });
      return row;
    });

    if (!result) {
      const current = await loadEmployeeInactiveRow(employeeId);
      if (!current) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      } else if (current.employment_status === 'fired') {
        conflict(res, 'Сотрудник уволен', 'EMPLOYEE_FIRED');
      } else {
        conflict(res, 'Сотрудник не переведён в неактивные вручную', 'NOT_INACTIVE_MANUALLY');
      }
      return;
    }

    invalidateAfterChange(employeeId);
    // Метка снята, но отдел «Декрет»/«Архив» оставляет сотрудника неактивным — фронт предупреждает.
    const auto = await loadAutoInactiveDepartments();
    const inactiveDepartmentName = result.org_department_id ? auto.nameById.get(result.org_department_id) ?? null : null;
    res.json({ success: true, data: { id: employeeId, inactive_department_name: inactiveDepartmentName } });
  } catch (error) {
    console.error('Reactivate employee error:', error);
    res.status(500).json({ success: false, error: 'Не удалось вернуть сотрудника в активные' });
  }
}
