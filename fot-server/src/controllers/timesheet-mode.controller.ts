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
import { getContractorRootId } from '../config/contractor.js';
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

/** Предел на один пакет: и для чтения режимов, и для массовой записи. */
const MODE_BATCH_LIMIT = 500;

const bulkDepartmentsSchema = z.object({
  department_ids: z.array(z.string().uuid()).min(1),
  mode: z.enum(['current_activity', 'object', 'skud']).nullable(),
  object_id: z.string().uuid().nullable().optional(),
});

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
      // Второй режим выборки — по списку сотрудников: на «Управлении кадрами» людей ищут
      // по ФИО без выбора отдела, и колонка режима должна работать и там.
      const employeeIds = typeof req.query.employee_ids === 'string'
        ? [...new Set(req.query.employee_ids.split(',').map(Number).filter(id => Number.isInteger(id) && id > 0))]
        : [];

      if (!departmentId && employeeIds.length === 0) {
        res.status(400).json({ error: 'нужен department_id или employee_ids' });
        return;
      }
      // Явная ошибка вместо тихой обрезки: молча вернуть часть строк — значит показать
      // пользователю неполную картину, не сообщив об этом.
      if (employeeIds.length > MODE_BATCH_LIMIT) {
        res.status(400).json({ error: `Слишком много сотрудников в запросе (максимум ${MODE_BATCH_LIMIT})` });
        return;
      }
      if (departmentId && !(await canAccessDepartmentInScope(req, departmentId))) {
        res.status(403).json({ error: 'Нет доступа к отделу' });
        return;
      }

      // Скоуп применяется в обоих режимах: строки чужих отделов отсекаются ниже.
      const accessible = await resolveAccessibleDepartmentIds(req);
      const rows = await query<{
        employee_id: number | string;
        full_name: string;
        org_department_id: string | null;
        emp_mode: TimesheetExportMode | null;
        emp_object_id: string | null;
        dept_mode: TimesheetExportMode | null;
        dept_object_id: string | null;
        dept_current_activity: boolean;
      }>(
        `WITH ca AS (
           SELECT id FROM skud_objects
            WHERE lower(btrim(coalesce(alt_name, ''))) = lower($2::text)
         ),
         target AS (
           -- employee_ids приоритетнее: когда фронт прислал список сотрудников страницы,
           -- department_id остаётся только источником метаданных отдела. Иначе OR вернул бы
           -- весь отдел вместо запрошенной страницы.
           SELECT e.id
             FROM employees e
            WHERE e.is_archived = false
              AND ( CASE WHEN $3::int[] IS NOT NULL THEN e.id = ANY($3::int[])
                         ELSE e.org_department_id = $1::uuid END )
         )
         SELECT e.id                                AS employee_id,
                e.full_name,
                e.org_department_id::text           AS org_department_id,
                e.timesheet_export_mode             AS emp_mode,
                e.timesheet_export_object_id::text  AS emp_object_id,
                d.timesheet_export_mode             AS dept_mode,
                d.timesheet_export_object_id::text  AS dept_object_id,
                EXISTS (
                  SELECT 1 FROM department_object_assignment doa
                   WHERE doa.org_department_id = e.org_department_id
                     AND doa.is_active = true
                     AND doa.skud_object_id IN (SELECT id FROM ca)
                )                                   AS dept_current_activity
           FROM employees e
           LEFT JOIN org_departments d ON d.id = e.org_department_id
          WHERE e.id IN (SELECT id FROM target)
          ORDER BY e.full_name`,
        [departmentId || null, CURRENT_ACTIVITY_ADDRESS, employeeIds.length > 0 ? employeeIds : null],
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

      // Режим отдела нужен только в режиме выборки по отделу (для массовой модалки).
      const dept = departmentId
        ? await queryOne<{
          timesheet_export_mode: TimesheetExportMode | null;
          timesheet_export_object_id: string | null;
        }>(
          'SELECT timesheet_export_mode, timesheet_export_object_id::text FROM org_departments WHERE id = $1::uuid',
          [departmentId],
        )
        : null;

      res.json({
        success: true,
        data: {
          department: {
            id: departmentId || null,
            mode: dept?.timesheet_export_mode ?? null,
            object_id: dept?.timesheet_export_object_id ?? null,
          },
          employees: items,
        },
      });
    } catch (error) {
      console.error('timesheetModeController.list error:', error);
      res.status(500).json({ error: 'Не удалось получить режимы табелирования' });
    }
  },

  /**
   * GET /api/admin/timesheet-modes/departments
   * Отделы и бригады в скоупе с их режимом. `effective_mode` обязателен: при mode = null
   * пользователь должен видеть, что действует фактически (ТД или СКУД по legacy), а не
   * только метку «режим не задан».
   */
  async listDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const accessible = await resolveAccessibleDepartmentIds(req);
      // Корень «Подрядные организации» может быть не синхронизирован из Sigur — тогда
      // пустой uuid[] даёт ноль потомков и флаг у всех false. Отдельной ветки не нужно.
      const contractorRootId = await getContractorRootId();
      const rows = await query<{
        id: string;
        name: string;
        kind: string;
        mode: TimesheetExportMode | null;
        object_id: string | null;
        object_name: string | null;
        object_is_active: boolean | null;
        dept_current_activity: boolean;
        is_contractor: boolean;
      }>(
        `WITH ca AS (
           SELECT id FROM skud_objects
            WHERE lower(btrim(coalesce(alt_name, ''))) = lower($1::text)
         ),
         contractor AS (
           SELECT id FROM public.get_descendant_department_ids($2::uuid[])
         )
         SELECT d.id::text,
                d.name,
                d.kind,
                d.timesheet_export_mode            AS mode,
                d.timesheet_export_object_id::text AS object_id,
                o.name                             AS object_name,
                o.is_active                        AS object_is_active,
                EXISTS (
                  SELECT 1 FROM department_object_assignment doa
                   WHERE doa.org_department_id = d.id
                     AND doa.is_active = true
                     AND doa.skud_object_id IN (SELECT id FROM ca)
                )                                  AS dept_current_activity,
                (d.id IN (SELECT id FROM contractor)) AS is_contractor
           FROM org_departments d
           LEFT JOIN skud_objects o ON o.id = d.timesheet_export_object_id
          WHERE d.is_active = true AND d.kind IN ('department', 'brigade')
          ORDER BY d.name`,
        [CURRENT_ACTIVITY_ADDRESS, contractorRootId ? [contractorRootId] : []],
      );

      const scoped = accessible === 'all' ? rows : rows.filter(r => accessible.includes(r.id));

      res.json({
        success: true,
        data: {
          departments: scoped.map(row => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            // Ветка «Подрядные организации» — фильтруется на клиенте, из выдачи не режем.
            is_contractor: row.is_contractor,
            mode: row.mode,
            object_id: row.object_id,
            object_name: row.object_name,
            object_is_active: row.object_is_active,
            // Режим не задан → показываем, что даёт legacy по назначениям объектов отдела.
            effective_mode: row.mode ?? (row.dept_current_activity ? 'current_activity' : 'skud'),
            source: row.mode
              ? 'department_explicit'
              : (row.dept_current_activity ? 'legacy_department' : 'legacy_default'),
          })),
        },
      });
    } catch (error) {
      console.error('timesheetModeController.listDepartments error:', error);
      res.status(500).json({ error: 'Не удалось получить режимы подразделений' });
    }
  },

  /**
   * PUT /api/admin/timesheet-modes/departments
   * Массовая установка режима отделам и бригадам. Весь список проверяется ДО записи:
   * любая осечка — отказ целиком, ни одной строки. Явные режимы сотрудников не трогаются —
   * персональные исключения должны переживать массовую операцию.
   */
  async updateDepartmentsBulk(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = bulkDepartmentsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Некорректные данные', details: parsed.error.issues });
        return;
      }
      const departmentIds = [...new Set(parsed.data.department_ids)];
      if (departmentIds.length > MODE_BATCH_LIMIT) {
        res.status(400).json({ error: `Слишком много подразделений (максимум ${MODE_BATCH_LIMIT})` });
        return;
      }
      const normalized = await normalizeModePayload(parsed.data.mode, parsed.data.object_id);
      if ('error' in normalized) {
        res.status(400).json({ error: normalized.error });
        return;
      }

      // Существование и тип — до скоупа: так пользователь получит понятную 400, а не 403.
      const existing = await query<{ id: string; kind: string }>(
        'SELECT id::text, kind FROM org_departments WHERE id = ANY($1::uuid[])',
        [departmentIds],
      );
      const kindById = new Map(existing.map(r => [r.id, r.kind]));
      const missing = departmentIds.filter(id => !kindById.has(id));
      if (missing.length > 0) {
        res.status(400).json({ error: 'Некоторые подразделения не найдены', details: missing });
        return;
      }
      const wrongKind = departmentIds.filter(id => !['department', 'brigade'].includes(kindById.get(id) ?? ''));
      if (wrongKind.length > 0) {
        res.status(400).json({ error: 'Режим задаётся только отделам и бригадам', details: wrongKind });
        return;
      }
      for (const id of departmentIds) {
        if (!(await canAccessDepartmentInScope(req, id))) {
          res.status(403).json({ error: 'В списке есть подразделения вне вашего доступа' });
          return;
        }
      }

      const affected = await withTransaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);
        const before = await client.query<{
          id: string;
          name: string;
          timesheet_export_mode: TimesheetExportMode | null;
          timesheet_export_object_id: string | null;
        }>(
          `SELECT id::text, name, timesheet_export_mode, timesheet_export_object_id::text
             FROM org_departments WHERE id = ANY($1::uuid[]) FOR UPDATE`,
          [departmentIds],
        );

        await client.query(
          `UPDATE org_departments
              SET timesheet_export_mode = $1,
                  timesheet_export_object_id = $2::uuid
            WHERE id = ANY($3::uuid[])`,
          [normalized.mode, normalized.objectId, departmentIds],
        );

        await auditService.logFromRequestWithClient(
          client, req, req.user.id, AUDIT_ACTIONS.TIMESHEET_MODE_BULK_UPDATED,
          {
            entityType: 'org_department',
            entityId: `bulk:${departmentIds.length}`,
            details: {
              new_mode: normalized.mode,
              new_object_id: normalized.objectId,
              affected_departments: before.rows.map(r => ({
                id: r.id,
                name: r.name,
                old_mode: r.timesheet_export_mode,
                old_object_id: r.timesheet_export_object_id,
              })),
            },
          },
        );
        return before.rowCount ?? 0;
      });

      res.json({ success: true, data: { affected, mode: normalized.mode, object_id: normalized.objectId } });
    } catch (error) {
      console.error('timesheetModeController.updateDepartmentsBulk error:', error);
      res.status(500).json({ error: 'Не удалось сохранить режимы подразделений' });
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
      res.json({ success: true, data: { mode: normalized.mode, object_id: normalized.objectId } });
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
      res.json({ success: true, data: { affected: changed, mode: normalized.mode, object_id: normalized.objectId } });
    } catch (error) {
      console.error('timesheetModeController.updateDepartment error:', error);
      res.status(500).json({ error: 'Не удалось сохранить режим табелирования' });
    }
  },
};
