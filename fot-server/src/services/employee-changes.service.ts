import { execute, queryOne, withTransaction } from '../config/postgres.js';
import type { PoolClient } from 'pg';
import { employeeCache } from './employee-cache.service.js';
import { settingsService } from './settings.service.js';
import {
  formatDateShift,
  getEmployeeAssignments,
  isAssignmentActiveOnDateInclusive,
} from './timesheet-department-assignments.service.js';
import { tryDeleteTransfer, type IDeleteTransferResult } from './timesheet-transfers.service.js';

/**
 * Доменная ошибка валидации: бизнес-правило не выполнено, не серверный сбой.
 * Контроллер должен мапить такие ошибки в HTTP 400, а не 500.
 */
export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

interface ChangeOpts {
  reason?: string;
  note?: string;
  effectiveDate?: string;
  createdBy?: string | null;
  /**
   * Принудительно вести полную историю переводов даже при включённом freeze_history.
   * Используется в точках увольнения/восстановления/архивации, где история периодов
   * (реальный отдел → «Уволенные» → восстановление) не должна теряться.
   */
  forceHistory?: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

const syncEmployeeSalarySnapshotTx = async (
  client: PoolClient,
  employeeId: number,
  salary: number | null,
): Promise<void> => {
  await client.query(
    `UPDATE employees
        SET current_salary = $1,
            salary_actual = $1,
            updated_at = $2
      WHERE id = $3`,
    [salary, new Date().toISOString(), employeeId],
  );
};

/**
 * Режим заморозки истории переводов: вместо «закрыть старое + создать новое» обновляем
 * единственное открытое назначение сотрудника. Если открытого нет — создаём одно с
 * effective_from = hire_date (или 2020-01-01). Применяется во время чистки списков; после
 * финализации настройка выключается, и переводы снова пишут полноценную историю.
 */
const applyFrozenAssignmentTx = async (
  client: PoolClient,
  employeeId: number,
  patch: { org_department_id?: string | null; position_id?: string | null },
  reason: string,
): Promise<void> => {
  const empResult = await client.query<{
    org_department_id: string | null;
    position_id: string | null;
    hire_date: string | null;
  }>(
    `SELECT org_department_id, position_id, hire_date FROM employees WHERE id = $1`,
    [employeeId],
  );
  const emp = empResult.rows[0] ?? null;

  const nextDeptId = patch.org_department_id !== undefined
    ? patch.org_department_id
    : emp?.org_department_id ?? null;
  const nextPositionId = patch.position_id !== undefined
    ? patch.position_id
    : emp?.position_id ?? null;

  const openResult = await client.query<{ id: string; effective_from: string }>(
    `SELECT id, effective_from
       FROM employee_assignments
      WHERE employee_id = $1 AND effective_to IS NULL
      ORDER BY effective_from ASC`,
    [employeeId],
  );
  const openRows = openResult.rows;
  const open = openRows[0] || null;
  const nowIso = new Date().toISOString();

  if (open) {
    await client.query(
      `UPDATE employee_assignments
          SET org_department_id = $1,
              position_id = $2,
              is_primary = true,
              assignment_type = 'main',
              change_reason = $3,
              updated_at = $4
        WHERE id = $5 AND employee_id = $6`,
      [nextDeptId, nextPositionId, reason, nowIso, open.id, employeeId],
    );

    if (openRows.length > 1) {
      const extraIds = openRows.slice(1).map(r => r.id);
      await client.query(
        `UPDATE employee_assignments
            SET effective_to = $1, updated_at = $2
          WHERE id = ANY($3::uuid[]) AND employee_id = $4`,
        [open.effective_from, nowIso, extraIds, employeeId],
      );
    }
  } else {
    // Открытых нет — у уволенного сотрудника все строки закрыты.
    // Слепой INSERT с hire_date перекрыл бы все закрытые периоды и
    // упал бы по триггеру ensure_no_overlapping_employee_assignments.
    // Поэтому ре-открываем самую свежую закрытую запись (MAX(effective_to)).
    const latestResult = await client.query<{ id: string }>(
      `SELECT id
         FROM employee_assignments
        WHERE employee_id = $1 AND effective_to IS NOT NULL
        ORDER BY effective_to DESC, effective_from DESC
        LIMIT 1`,
      [employeeId],
    );
    const latest = latestResult.rows[0] ?? null;

    if (latest) {
      await client.query(
        `UPDATE employee_assignments
            SET org_department_id = $1,
                position_id = $2,
                effective_to = NULL,
                is_primary = true,
                assignment_type = 'main',
                change_reason = $3,
                updated_at = $4
          WHERE id = $5 AND employee_id = $6`,
        [nextDeptId, nextPositionId, reason, nowIso, latest.id, employeeId],
      );
    } else {
      const effectiveFrom = emp?.hire_date || today();
      await client.query(
        `INSERT INTO employee_assignments
           (employee_id, org_department_id, position_id, effective_from,
            is_primary, assignment_type, change_reason)
         VALUES ($1, $2, $3, $4, true, 'main', $5)`,
        [employeeId, nextDeptId, nextPositionId, effectiveFrom, reason],
      );
    }
  }
};

/**
 * Чтение назначений ЧЕРЕЗ client транзакции: глобальный query() уходит в другой
 * коннект пула и не видит незакоммиченные изменения этой же транзакции — снапшот
 * считался бы по устаревшей истории.
 */
const listAssignmentsForSnapshotTx = async (
  client: PoolClient,
  employeeId: number,
): Promise<Array<{
  org_department_id: string | null;
  position_id: string | null;
  effective_from: string;
  effective_to: string | null;
}>> => {
  const result = await client.query<{
    org_department_id: string | null;
    position_id: string | null;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT org_department_id, position_id,
            effective_from::text AS effective_from,
            effective_to::text AS effective_to
       FROM employee_assignments
      WHERE employee_id = $1
      ORDER BY effective_from ASC, created_at ASC`,
    [employeeId],
  );
  return result.rows;
};

const syncEmployeeAssignmentSnapshotTx = async (
  client: PoolClient,
  employeeId: number,
  referenceDate = today(),
): Promise<void> => {
  const assignments = await listAssignmentsForSnapshotTx(client, employeeId);
  const activeAssignment = [...assignments]
    .reverse()
    .find(assignment => isAssignmentActiveOnDateInclusive(
      assignment.effective_from,
      assignment.effective_to,
      referenceDate,
    )) || null;

  await client.query(
    `UPDATE employees
        SET position_id = $1,
            org_department_id = $2,
            updated_at = $3
      WHERE id = $4`,
    [
      activeAssignment?.position_id || null,
      activeAssignment?.org_department_id || null,
      new Date().toISOString(),
      employeeId,
    ],
  );
};

const syncEmployeeAssignmentSnapshot = async (employeeId: number, referenceDate = today()): Promise<void> => {
  const assignments = await getEmployeeAssignments(employeeId);
  const activeAssignment = [...assignments]
    .reverse()
    .find(assignment => isAssignmentActiveOnDateInclusive(
      assignment.effective_from,
      assignment.effective_to,
      referenceDate,
    )) || null;

  await execute(
    `UPDATE employees
        SET position_id = $1,
            org_department_id = $2,
            updated_at = $3
      WHERE id = $4`,
    [
      activeAssignment?.position_id || null,
      activeAssignment?.org_department_id || null,
      new Date().toISOString(),
      employeeId,
    ],
  );
};

/**
 * Единый сервис для изменений сотрудника с автоматической записью истории.
 * Все контроллеры должны вызывать эти методы вместо прямого UPDATE.
 */
export const employeeChangesService = {
  /**
   * Изменение оклада → salary_history + employees.current_salary snapshot
   */
  async changeSalary(employeeId: number, salary: number, opts: ChangeOpts = {}): Promise<void> {
    const date = opts.effectiveDate || today();

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO salary_history
           (employee_id, salary, effective_date, change_reason, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          employeeId,
          salary,
          date,
          opts.reason || null,
          opts.note || null,
          opts.createdBy || null,
        ],
      );

      const latestResult = await client.query<{ salary: number | null }>(
        `SELECT salary FROM salary_history
          WHERE employee_id = $1
          ORDER BY effective_date DESC, created_at DESC
          LIMIT 1`,
        [employeeId],
      );
      const latest = latestResult.rows[0] ?? null;
      if (latest) {
        await syncEmployeeSalarySnapshotTx(client, employeeId, latest.salary);
      }
    });

    employeeCache.invalidate(employeeId);
  },

  /**
   * Изменение должности → закрыть текущий assignment + новый assignment + employees.position_id
   */
  async changePosition(employeeId: number, positionId: string, opts: ChangeOpts = {}): Promise<void> {
    const { freezeHistory } = await settingsService.getEmployeeTransferConfig();
    const effectiveFreeze = freezeHistory && !opts.forceHistory;

    if (effectiveFreeze) {
      await withTransaction(async (client) => {
        await applyFrozenAssignmentTx(
          client,
          employeeId,
          { position_id: positionId },
          opts.reason || 'Заморозка истории переводов',
        );
        await client.query(
          `UPDATE employees SET position_id = $1, updated_at = $2 WHERE id = $3`,
          [positionId, new Date().toISOString(), employeeId],
        );
      });
      employeeCache.invalidate(employeeId);
      return;
    }

    const date = opts.effectiveDate || today();

    await withTransaction(async (client) => {
      const empRes = await client.query<{ org_department_id: string | null; position_id: string | null }>(
        `SELECT org_department_id, position_id FROM employees WHERE id = $1`,
        [employeeId],
      );
      const emp = empRes.rows[0] ?? null;

      // Симметрично changeDepartment: закрываем текущее назначение и открываем новое с новой
      // должностью (отдел сохраняем). Без закрытия два открытых периода пересеклись бы и
      // триггер ensure_no_overlapping_employee_assignments отклонил бы вставку.
      const assignments = await getEmployeeAssignments(employeeId);
      const previousDay = formatDateShift(date, -1);
      const nextAssignment = assignments.find(assignment => assignment.effective_from > date) || null;
      const sameDayAssignment = assignments.find(assignment => assignment.effective_from === date) || null;
      const activeAssignment = assignments.find(assignment => isAssignmentActiveOnDateInclusive(
        assignment.effective_from,
        assignment.effective_to,
        date,
      )) || null;

      if (activeAssignment && activeAssignment.id !== sameDayAssignment?.id) {
        await client.query(
          `UPDATE employee_assignments
              SET effective_to = $1, updated_at = $2
            WHERE id = $3 AND employee_id = $4`,
          [previousDay, new Date().toISOString(), activeAssignment.id, employeeId],
        );
      }

      const nextEffectiveTo = nextAssignment ? formatDateShift(nextAssignment.effective_from, -1) : null;

      if (sameDayAssignment) {
        await client.query(
          `UPDATE employee_assignments
              SET position_id = $1,
                  effective_to = $2,
                  is_primary = true,
                  assignment_type = 'main',
                  change_reason = $3,
                  created_by = $4,
                  updated_at = $5
            WHERE id = $6 AND employee_id = $7`,
          [
            positionId,
            nextEffectiveTo,
            opts.reason || 'Смена должности',
            opts.createdBy || null,
            new Date().toISOString(),
            sameDayAssignment.id,
            employeeId,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO employee_assignments
             (employee_id, org_department_id, position_id, effective_from,
              effective_to, is_primary, assignment_type, change_reason, created_by)
           VALUES ($1, $2, $3, $4, $5, true, 'main', $6, $7)`,
          [
            employeeId,
            emp?.org_department_id || null,
            positionId,
            date,
            nextEffectiveTo,
            opts.reason || 'Смена должности',
            opts.createdBy || null,
          ],
        );
      }

      await syncEmployeeAssignmentSnapshotTx(client, employeeId);
    });

    employeeCache.invalidate(employeeId);
  },

  /**
   * Изменение отдела → закрыть текущий assignment + новый assignment + employees.org_department_id
   */
  async changeDepartment(employeeId: number, departmentId: string, opts: ChangeOpts & { lockDepartment?: boolean } = {}): Promise<void> {
    const { freezeHistory } = await settingsService.getEmployeeTransferConfig();
    const effectiveFreeze = freezeHistory && !opts.forceHistory;

    if (effectiveFreeze) {
      await withTransaction(async (client) => {
        await applyFrozenAssignmentTx(
          client,
          employeeId,
          { org_department_id: departmentId },
          opts.reason || 'Заморозка истории переводов',
        );

        const updateData: Record<string, unknown> = {
          org_department_id: departmentId,
          updated_at: new Date().toISOString(),
        };
        if (opts.lockDepartment !== undefined) {
          updateData.department_locked = opts.lockDepartment;
        }
        const keys = Object.keys(updateData);
        const params: unknown[] = keys.map(k => updateData[k]);
        const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        params.push(employeeId);
        await client.query(
          `UPDATE employees SET ${setSql} WHERE id = $${params.length}`,
          params,
        );
      });

      employeeCache.invalidate(employeeId);
      return;
    }

    const date = opts.effectiveDate || today();

    await withTransaction(async (client) => {
      const empRes = await client.query<{ position_id: string | null; org_department_id: string | null }>(
        `SELECT position_id, org_department_id FROM employees WHERE id = $1`,
        [employeeId],
      );
      const emp = empRes.rows[0] ?? null;

      const assignments = await getEmployeeAssignments(employeeId);
      const previousDay = formatDateShift(date, -1);
      const nextAssignment = assignments.find(assignment => assignment.effective_from > date) || null;
      const sameDayAssignment = assignments.find(assignment => assignment.effective_from === date) || null;
      const activeAssignment = assignments.find(assignment => isAssignmentActiveOnDateInclusive(
        assignment.effective_from,
        assignment.effective_to,
        date,
      )) || null;

      if (activeAssignment && activeAssignment.id !== sameDayAssignment?.id) {
        await client.query(
          `UPDATE employee_assignments
              SET effective_to = $1, updated_at = $2
            WHERE id = $3 AND employee_id = $4`,
          [previousDay, new Date().toISOString(), activeAssignment.id, employeeId],
        );
      }

      const nextEffectiveTo = nextAssignment ? formatDateShift(nextAssignment.effective_from, -1) : null;

      if (sameDayAssignment) {
        await client.query(
          `UPDATE employee_assignments
              SET org_department_id = $1,
                  position_id = $2,
                  effective_to = $3,
                  is_primary = true,
                  assignment_type = 'main',
                  change_reason = $4,
                  created_by = $5,
                  updated_at = $6
            WHERE id = $7 AND employee_id = $8`,
          [
            departmentId,
            emp?.position_id || null,
            nextEffectiveTo,
            opts.reason || 'Перевод в другой отдел',
            opts.createdBy || null,
            new Date().toISOString(),
            sameDayAssignment.id,
            employeeId,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO employee_assignments
             (employee_id, org_department_id, position_id, effective_from,
              effective_to, is_primary, assignment_type, change_reason, created_by)
           VALUES ($1, $2, $3, $4, $5, true, 'main', $6, $7)`,
          [
            employeeId,
            departmentId,
            emp?.position_id || null,
            date,
            nextEffectiveTo,
            opts.reason || 'Перевод в другой отдел',
            opts.createdBy || null,
          ],
        );
      }

      // Бэкдейт-перевод заполняет только период до следующего существующего
      // назначения. Если «сегодня» сотрудник после этого остаётся в другом
      // отделе (позднее назначение, например от синка Sigur), доводим перевод
      // до сегодняшнего дня — иначе история навсегда расходится со снапшотом
      // employees.org_department_id, а фоновый синк расхождение уже не видит
      // (возвраты Тендерный↔ОСА 08.07.2026: назначения ОСА остались открытыми).
      const todayIso = today();
      if (date < todayIso) {
        const activeTodayResult = await client.query<{
          id: string;
          org_department_id: string | null;
          effective_from: string;
        }>(
          `SELECT id, org_department_id, effective_from::text AS effective_from
             FROM employee_assignments
            WHERE employee_id = $1
              AND effective_from <= $2
              AND (effective_to IS NULL OR effective_to >= $2)
            ORDER BY effective_from DESC
            LIMIT 1`,
          [employeeId, todayIso],
        );
        const activeToday = activeTodayResult.rows[0] ?? null;

        if (activeToday && activeToday.org_department_id !== departmentId) {
          if (activeToday.effective_from === todayIso) {
            // Назначение стартует сегодня: закрытие в today-1 дало бы to < from.
            await client.query(
              `UPDATE employee_assignments
                  SET org_department_id = $1,
                      change_reason = $2,
                      created_by = $3,
                      updated_at = $4
                WHERE id = $5 AND employee_id = $6`,
              [
                departmentId,
                opts.reason || 'Перевод в другой отдел',
                opts.createdBy || null,
                new Date().toISOString(),
                activeToday.id,
                employeeId,
              ],
            );
          } else {
            await client.query(
              `UPDATE employee_assignments
                  SET effective_to = $1, updated_at = $2
                WHERE id = $3 AND employee_id = $4`,
              [formatDateShift(todayIso, -1), new Date().toISOString(), activeToday.id, employeeId],
            );

            const nextAfterTodayResult = await client.query<{ effective_from: string }>(
              `SELECT effective_from::text AS effective_from
                 FROM employee_assignments
                WHERE employee_id = $1 AND effective_from > $2
                ORDER BY effective_from ASC
                LIMIT 1`,
              [employeeId, todayIso],
            );
            const nextAfterToday = nextAfterTodayResult.rows[0]?.effective_from ?? null;

            await client.query(
              `INSERT INTO employee_assignments
                 (employee_id, org_department_id, position_id, effective_from,
                  effective_to, is_primary, assignment_type, change_reason, created_by)
               VALUES ($1, $2, $3, $4, $5, true, 'main', $6, $7)`,
              [
                employeeId,
                departmentId,
                emp?.position_id || null,
                todayIso,
                nextAfterToday ? formatDateShift(nextAfterToday, -1) : null,
                opts.reason || 'Перевод в другой отдел',
                opts.createdBy || null,
              ],
            );
          }
        }
      }

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (opts.lockDepartment !== undefined) {
        updateData.department_locked = opts.lockDepartment;
      }
      const keys = Object.keys(updateData);
      const params: unknown[] = keys.map(k => updateData[k]);
      const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      params.push(employeeId);
      await client.query(
        `UPDATE employees SET ${setSql} WHERE id = $${params.length}`,
        params,
      );

      await syncEmployeeAssignmentSnapshotTx(client, employeeId);
    });

    employeeCache.invalidate(employeeId);
  },

  /**
   * Обновить запись salary_history
   */
  async updateSalaryHistory(
    historyId: number,
    employeeId: number,
    updates: { salary?: number; effective_date?: string; change_reason?: string; note?: string },
  ): Promise<void> {
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.salary !== undefined) updateData.salary = updates.salary;
    if (updates.effective_date !== undefined) updateData.effective_date = updates.effective_date;
    if (updates.change_reason !== undefined) updateData.change_reason = updates.change_reason;
    if (updates.note !== undefined) updateData.note = updates.note;

    await withTransaction(async (client) => {
      const keys = Object.keys(updateData);
      const params: unknown[] = keys.map(k => updateData[k]);
      const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      params.push(historyId);
      params.push(employeeId);
      const updResult = await client.query<{ id: number }>(
        `UPDATE salary_history SET ${setSql}
          WHERE id = $${params.length - 1} AND employee_id = $${params.length}
          RETURNING id`,
        params,
      );
      if (updResult.rows.length === 0) {
        throw new Error('Salary history record not found');
      }

      const latestRes = await client.query<{ salary: number | null }>(
        `SELECT salary FROM salary_history
          WHERE employee_id = $1
          ORDER BY effective_date DESC, created_at DESC
          LIMIT 1`,
        [employeeId],
      );
      const latest = latestRes.rows[0] ?? null;
      if (latest) {
        await syncEmployeeSalarySnapshotTx(client, employeeId, latest.salary);
      }
    });

    employeeCache.invalidate(employeeId);
  },

  /**
   * Удалить запись salary_history
   */
  async deleteSalaryHistory(historyId: number, employeeId: number): Promise<void> {
    await withTransaction(async (client) => {
      const delResult = await client.query<{ id: number }>(
        `DELETE FROM salary_history
          WHERE id = $1 AND employee_id = $2
          RETURNING id`,
        [historyId, employeeId],
      );
      if (delResult.rows.length === 0) {
        throw new DomainValidationError('Salary history record not found');
      }

      const latestRes = await client.query<{ salary: number | null }>(
        `SELECT salary FROM salary_history
          WHERE employee_id = $1
          ORDER BY effective_date DESC, created_at DESC
          LIMIT 1`,
        [employeeId],
      );
      const latest = latestRes.rows[0] ?? null;
      await syncEmployeeSalarySnapshotTx(client, employeeId, latest?.salary ?? null);
    });

    employeeCache.invalidate(employeeId);
  },

  /**
   * Обновить запись employee_assignments
   */
  async updateAssignment(
    assignmentId: string,
    employeeId: number,
    updates: { position_id?: string; org_department_id?: string; effective_from?: string; change_reason?: string },
  ): Promise<void> {
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.position_id !== undefined) updateData.position_id = updates.position_id;
    if (updates.org_department_id !== undefined) updateData.org_department_id = updates.org_department_id;
    if (updates.effective_from !== undefined) updateData.effective_from = updates.effective_from;
    if (updates.change_reason !== undefined) updateData.change_reason = updates.change_reason;

    await withTransaction(async (client) => {
      const keys = Object.keys(updateData);
      const params: unknown[] = keys.map(k => updateData[k]);
      const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      params.push(assignmentId);
      params.push(employeeId);
      const updResult = await client.query<{ id: string }>(
        `UPDATE employee_assignments SET ${setSql}
          WHERE id = $${params.length - 1} AND employee_id = $${params.length}
          RETURNING id`,
        params,
      );
      if (updResult.rows.length === 0) {
        throw new DomainValidationError('Assignment record not found');
      }

      await syncEmployeeAssignmentSnapshotTx(client, employeeId);
    });

    employeeCache.invalidate(employeeId);
  },

  /**
   * Удалить запись employee_assignments.
   *
   * Логика:
   * 1. Если удаляем закрытое назначение — просто удаляем.
   * 2. Если удаляем открытое и оно НЕ единственное открытое (теоретически, схема блокирует
   *    оверлап через триггер) — просто удаляем.
   * 3. Если удаляем единственное открытое у активного сотрудника:
   *    - Пробуем «откат перевода»: переоткрыть последнее закрытое назначение и удалить
   *      это (то же, что делает страница «Переводы и исключения»).
   *    - Если парного закрытого нет (свежий найм без истории) — кидаем DomainValidationError:
   *      сотрудник останется «без отдела», табель ломается, Sigur sync создаст gap.
   */
  async deleteAssignment(
    assignmentId: string,
    employeeId: number,
  ): Promise<{ reverted: IDeleteTransferResult | null }> {
    const target = await queryOne<{ id: string; effective_to: string | null }>(
      `SELECT id, effective_to
         FROM employee_assignments
        WHERE id = $1 AND employee_id = $2
        LIMIT 1`,
      [assignmentId, employeeId],
    );
    if (!target) throw new DomainValidationError('Assignment record not found');

    if (target.effective_to == null) {
      const emp = await queryOne<{ employment_status: string; is_archived: boolean }>(
        `SELECT employment_status, is_archived FROM employees WHERE id = $1`,
        [employeeId],
      );
      const isActive = !!emp && emp.employment_status === 'active' && !emp.is_archived;
      if (isActive) {
        const cntRow = await queryOne<{ cnt: string }>(
          `SELECT count(*)::text AS cnt
             FROM employee_assignments
            WHERE employee_id = $1 AND effective_to IS NULL`,
          [employeeId],
        );
        const count = Number(cntRow?.cnt ?? 0);
        if (count <= 1) {
          const reverted = await tryDeleteTransfer(assignmentId);
          if (!reverted) {
            throw new DomainValidationError(
              'Нельзя удалить единственное открытое назначение у активного сотрудника. '
              + 'Сначала создайте новое назначение или уволите/архивируйте сотрудника.',
            );
          }
          await syncEmployeeAssignmentSnapshot(employeeId);
          employeeCache.invalidate(employeeId);
          return { reverted };
        }
      }
    }

    await withTransaction(async (client) => {
      const delResult = await client.query<{ id: string }>(
        `DELETE FROM employee_assignments
          WHERE id = $1 AND employee_id = $2
          RETURNING id`,
        [assignmentId, employeeId],
      );
      if (delResult.rows.length === 0) {
        throw new DomainValidationError('Assignment record not found');
      }

      await syncEmployeeAssignmentSnapshotTx(client, employeeId);
    });

    employeeCache.invalidate(employeeId);
    return { reverted: null };
  },
};
