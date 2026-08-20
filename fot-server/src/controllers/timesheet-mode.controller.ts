/**
 * Режим табелирования для «Единого файла 1С» (миграция 249).
 *
 * Отдельный контроллер и отдельное право `/staff-control/timesheet-mode`: назначения
 * объектов (object-assignment.controller) остаются админской функцией и завязаны на скоуп
 * табельщиц, а режим правит ещё и HR. Смешивать их нельзя.
 */
import { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import {
  canAccessDepartmentInScope,
  canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds,
} from '../services/data-scope.service.js';
import {
  resolveRow,
  TIMESHEET_MODE_LOCK_KEY,
  CURRENT_ACTIVITY_ADDRESS,
  type TimesheetExportMode,
} from '../services/timesheet-export-mode.service.js';

const modeSchema = z.object({
  // null = сбросить явный режим и вернуться к режиму отдела / legacy-фолбэку.
  mode: z.enum(['current_activity', 'object', 'skud']).nullable(),
  object_id: z.string().uuid().nullable().optional(),
  apply_to_subtree: z.boolean().optional(),
});

interface IModeApiRow {
  employee_id: number;
  full_name: string;
  org_department_id: string | null;
  explicit_mode: TimesheetExportMode | null;
  explicit_object_id: string | null;
  effective_mode: TimesheetExportMode;
  effective_object_id: string | null;
  effective_object_name: string | null;
  effective_object_address: string | null;
  effective_object_is_active: boolean | null;
  source: string;
}

/**
 * Нормализация пары (mode, object_id) под инвариант БД: объект обязателен ровно для
 * режима «object» и запрещён для остальных. Возвращает готовые значения или текст ошибки.
 */
async function normalizeModePayload(
  mode: TimesheetExportMode | null,
  objectId: string | null | undefined,
): Promise<{ mode: TimesheetExportMode | null; objectId: string | null } | { error: string }> {
  if (mode !== 'object') return { mode, objectId: null };
  if (!objectId) return { error: 'Для режима «объект» нужно выбрать закреплённый объект' };
  // Активность требуется только на запись: уже настроенный объект может стать неактивным,
  // и выгрузка обязана продолжать работать.
  const obj = await queryOne<{ id: string; is_active: boolean }>(
    'SELECT id, is_active FROM skud_objects WHERE id = $1::uuid',
    [objectId],
  );
  if (!obj) return { error: 'Объект не найден' };
  if (!obj.is_active) return { error: 'Объект неактивен — выберите другой' };
  return { mode, objectId };
}

export const timesheetModeController = {
  /**
   * GET /api/admin/timesheet-modes?department_id=…
   * Явный и эффективный режим сотрудников отдела. Скоуп проверяется всегда: read-only
   * запрос — не повод доверять переданному department_id.
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : '';
      if (!departmentId) {
        res.status(400).json({ error: 'department_id обязателен' });
        return;
      }
      if (!(await canAccessDepartmentInScope(req, departmentId))) {
        res.status(403).json({ error: 'Нет доступа к отделу' });
        return;
      }

      const accessible = await resolveAccessibleDepartmentIds(req);
      const rows = await query<{
        employee_id: number | string;
        full_name: string;
        org_department_id: string | null;
        emp_mode: TimesheetExportMode | null;
        emp_object_id: string | null;
        dept_mode: TimesheetExportMode | null;
        dept_object_id: string | null;
        has_personal_assignment: boolean;
        personal_current_activity: boolean;
        dept_current_activity: boolean;
      }>(
        `WITH ca AS (
           SELECT id FROM skud_objects
            WHERE lower(btrim(coalesce(alt_name, ''))) = lower($2::text)
         ),
         personal AS (
           SELECT eoa.employee_id,
                  bool_or(eoa.skud_object_id IN (SELECT id FROM ca)) AS is_current
             FROM employee_object_assignment eoa
             JOIN employees e2 ON e2.id = eoa.employee_id
            WHERE eoa.is_active = true AND e2.org_department_id = $1::uuid
            GROUP BY eoa.employee_id
         )
         SELECT e.id                                AS employee_id,
                e.full_name,
                e.org_department_id::text           AS org_department_id,
                e.timesheet_export_mode             AS emp_mode,
                e.timesheet_export_object_id::text  AS emp_object_id,
                d.timesheet_export_mode             AS dept_mode,
                d.timesheet_export_object_id::text  AS dept_object_id,
                (p.employee_id IS NOT NULL)         AS has_personal_assignment,
                COALESCE(p.is_current, false)       AS personal_current_activity,
                EXISTS (
                  SELECT 1 FROM department_object_assignment doa
                   WHERE doa.org_department_id = e.org_department_id
                     AND doa.is_active = true
                     AND doa.skud_object_id IN (SELECT id FROM ca)
                )                                   AS dept_current_activity
           FROM employees e
           LEFT JOIN org_departments d ON d.id = e.org_department_id
           LEFT JOIN personal p        ON p.employee_id = e.id
          WHERE e.org_department_id = $1::uuid
            AND e.is_archived = false
          ORDER BY e.full_name`,
        [departmentId, CURRENT_ACTIVITY_ADDRESS],
      );

      // Дополнительная страховка: сотрудник мог оказаться вне доступного поддерева.
      const scoped = accessible === 'all'
        ? rows
        : rows.filter(r => r.org_department_id && accessible.includes(r.org_department_id));

      const objectIds = new Set<string>();
      for (const row of scoped) {
        if (row.emp_object_id) objectIds.add(row.emp_object_id);
        if (row.dept_object_id) objectIds.add(row.dept_object_id);
      }
      const objects = objectIds.size > 0
        ? await query<{ id: string; name: string; alt_name: string | null; is_active: boolean }>(
          'SELECT id, name, alt_name, is_active FROM skud_objects WHERE id = ANY($1::uuid[])',
          [[...objectIds]],
        )
        : [];
      const objectById = new Map(objects.map(o => [o.id, o]));

      const items: IModeApiRow[] = scoped.map(row => {
        const resolved = resolveRow(row);
        const obj = resolved.pinnedObjectId ? objectById.get(resolved.pinnedObjectId) : undefined;
        return {
          employee_id: Number(row.employee_id),
          full_name: row.full_name,
          org_department_id: row.org_department_id,
          explicit_mode: row.emp_mode,
          explicit_object_id: row.emp_object_id,
          effective_mode: resolved.mode,
          effective_object_id: resolved.pinnedObjectId,
          effective_object_name: obj?.name ?? null,
          effective_object_address: obj ? (obj.alt_name?.trim() || obj.name) : null,
          effective_object_is_active: obj ? obj.is_active : null,
          source: resolved.source,
        };
      });

      const dept = await queryOne<{
        timesheet_export_mode: TimesheetExportMode | null;
        timesheet_export_object_id: string | null;
      }>(
        'SELECT timesheet_export_mode, timesheet_export_object_id::text FROM org_departments WHERE id = $1::uuid',
        [departmentId],
      );

      res.json({
        department: {
          id: departmentId,
          mode: dept?.timesheet_export_mode ?? null,
          object_id: dept?.timesheet_export_object_id ?? null,
        },
        employees: items,
      });
    } catch (error) {
      console.error('timesheetModeController.list error:', error);
      res.status(500).json({ error: 'Не удалось получить режимы табелирования' });
    }
  },

  /** PUT /api/admin/timesheet-modes/employees/:id */
  async updateEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        res.status(400).json({ error: 'Некорректный id сотрудника' });
        return;
      }
      const parsed = modeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Некорректные данные', details: parsed.error.issues });
        return;
      }
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ error: 'Нет доступа к сотруднику' });
        return;
      }
      const normalized = await normalizeModePayload(parsed.data.mode, parsed.data.object_id);
      if ('error' in normalized) {
        res.status(400).json({ error: normalized.error });
        return;
      }

      const updated = await withTransaction(async client => {
        // Тот же ключ берёт настроечный скрипт — иначе они не увидят друг друга.
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);
        const before = await client.query<{
          timesheet_export_mode: TimesheetExportMode | null;
          timesheet_export_object_id: string | null;
          full_name: string;
        }>(
          `SELECT timesheet_export_mode, timesheet_export_object_id::text, full_name
             FROM employees WHERE id = $1::int FOR UPDATE`,
          [employeeId],
        );
        if (before.rowCount === 0) return null;

        await client.query(
          `UPDATE employees
              SET timesheet_export_mode = $1,
                  timesheet_export_object_id = $2::uuid,
                  updated_at = now()
            WHERE id = $3::int`,
          [normalized.mode, normalized.objectId, employeeId],
        );

        await auditService.logFromRequestWithClient(client, req, req.user.id, AUDIT_ACTIONS.TIMESHEET_MODE_UPDATED, {
          entityType: 'employee',
          entityId: String(employeeId),
          details: {
            employee_name: before.rows[0].full_name,
            old_mode: before.rows[0].timesheet_export_mode,
            new_mode: normalized.mode,
            old_object_id: before.rows[0].timesheet_export_object_id,
            new_object_id: normalized.objectId,
          },
        });
        return true;
      });

      if (!updated) {
        res.status(404).json({ error: 'Сотрудник не найден' });
        return;
      }
      res.json({ success: true, mode: normalized.mode, object_id: normalized.objectId });
    } catch (error) {
      console.error('timesheetModeController.updateEmployee error:', error);
      res.status(500).json({ error: 'Не удалось сохранить режим табелирования' });
    }
  },

  /**
   * PUT /api/admin/timesheet-modes/departments/:id
   * apply_to_subtree = true записывает режим во ВСЕ существующие дочерние отделы одной
   * транзакцией. Новые дочерние отделы режим не наследуют — наследования по дереву нет.
   */
  async updateDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = req.params.id;
      const parsed = modeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Некорректные данные', details: parsed.error.issues });
        return;
      }
      if (!(await canAccessDepartmentInScope(req, departmentId))) {
        res.status(403).json({ error: 'Нет доступа к отделу' });
        return;
      }
      const normalized = await normalizeModePayload(parsed.data.mode, parsed.data.object_id);
      if ('error' in normalized) {
        res.status(400).json({ error: normalized.error });
        return;
      }

      let targetIds = [departmentId];
      if (parsed.data.apply_to_subtree) {
        const subtree = await query<{ id: string }>(
          `WITH RECURSIVE tree AS (
             SELECT id FROM org_departments WHERE id = $1::uuid
             UNION ALL
             SELECT d.id FROM org_departments d JOIN tree t ON d.parent_id = t.id
           ) SELECT id FROM tree`,
          [departmentId],
        );
        targetIds = subtree.map(r => r.id);
        // Скоуп проверяется по КАЖДОМУ потомку — иначе bulk обошёл бы ограничение доступа.
        for (const id of targetIds) {
          if (!(await canAccessDepartmentInScope(req, id))) {
            res.status(403).json({ error: 'В поддереве есть отделы вне вашего доступа' });
            return;
          }
        }
      }

      const changed = await withTransaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);
        const before = await client.query<{
          id: string;
          name: string;
          timesheet_export_mode: TimesheetExportMode | null;
          timesheet_export_object_id: string | null;
        }>(
          `SELECT id, name, timesheet_export_mode, timesheet_export_object_id::text
             FROM org_departments WHERE id = ANY($1::uuid[]) FOR UPDATE`,
          [targetIds],
        );
        if (before.rowCount === 0) return null;

        await client.query(
          `UPDATE org_departments
              SET timesheet_export_mode = $1,
                  timesheet_export_object_id = $2::uuid
            WHERE id = ANY($3::uuid[])`,
          [normalized.mode, normalized.objectId, targetIds],
        );

        await auditService.logFromRequestWithClient(
          client,
          req,
          req.user.id,
          parsed.data.apply_to_subtree ? AUDIT_ACTIONS.TIMESHEET_MODE_BULK_UPDATED : AUDIT_ACTIONS.TIMESHEET_MODE_UPDATED,
          {
            entityType: 'org_department',
            entityId: departmentId,
            details: {
              new_mode: normalized.mode,
              new_object_id: normalized.objectId,
              apply_to_subtree: Boolean(parsed.data.apply_to_subtree),
              affected_departments: before.rows.map(r => ({
                id: r.id,
                name: r.name,
                old_mode: r.timesheet_export_mode,
                old_object_id: r.timesheet_export_object_id,
              })),
            },
          },
        );
        return before.rowCount;
      });

      if (changed === null) {
        res.status(404).json({ error: 'Отдел не найден' });
        return;
      }
      res.json({ success: true, affected: changed, mode: normalized.mode, object_id: normalized.objectId });
    } catch (error) {
      console.error('timesheetModeController.updateDepartment error:', error);
      res.status(500).json({ error: 'Не удалось сохранить режим табелирования' });
    }
  },
};
