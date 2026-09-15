/**
 * «Управление кадрами»: комментарий к сотруднику, счётчики «устроены/уволены с начала месяца»
 * и выгрузка текущей таблицы. Фильтр — общий со списком (employees-staff-filter.helpers).
 */
import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { loadMainObjects } from '../services/employee-main-object-snapshot.service.js';
import { saveStaffComment, STAFF_COMMENT_MAX_LENGTH } from '../services/employee-staff-comment.service.js';
import { MAX_EXPORT_EMPLOYEES } from '../services/employees-export.service.js';
import { buildStaffViewWorkbook, type IStaffViewExportRow } from '../services/employees-staff-view-excel.service.js';
import { sanitizeExportFileName } from '../services/skud-export.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveExportPeriod } from './employees-export.controller.js';
import {
  buildStaffBaseFilter,
  parseStaffPeriod,
  parseStaffStatus,
  periodConditionSql,
  resolveMonthRange,
  statusConditionSql,
} from './employees-staff-filter.helpers.js';
import {
  buildSortOrderSql,
  buildStaffSortKeySql,
  parseStaffSort,
  StaffSortUnavailableError,
} from './employees-staff-sort.helpers.js';

const staffCommentBodySchema = z.object({
  comment: z.string().max(STAFF_COMMENT_MAX_LENGTH * 2).transform(value => value.trim())
    .refine(value => value.length <= STAFF_COMMENT_MAX_LENGTH, { message: `Не более ${STAFF_COMMENT_MAX_LENGTH} символов` }),
  // Обязательное поле: null — клиент видел отсутствие комментария.
  expected_updated_at: z.string().min(1).max(64).nullable(),
});

const SECTION_LABELS: Record<string, string> = {
  su10: 'СУ-10', sm: 'СМ', brigades: 'Бригады', contractors: 'Подрядные', all: 'Все',
};
const STATUS_LABELS: Record<string, string> = { active: 'Действующие', fired: 'Уволенные', excluded: 'Исключённые' };

const formatFileDay = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export const employeesStaffController = {
  /** PUT /api/employees/:id/staff-comment { comment, expected_updated_at } */
  async updateStaffComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = Number(req.params.id);
      if (!Number.isSafeInteger(employeeId) || employeeId <= 0) {
        res.status(400).json({ success: false, error: 'Некорректный id сотрудника' });
        return;
      }
      const parsed = staffCommentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные', code: 'VALIDATION_ERROR' });
        return;
      }
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      const result = await saveStaffComment({
        req,
        userId: req.user.id,
        employeeId,
        comment: parsed.data.comment,
        expectedUpdatedAt: parsed.data.expected_updated_at,
      });
      if (result.status === 'not_found') {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (result.status === 'conflict') {
        res.status(409).json({
          success: false,
          error: 'Комментарий уже изменили — проверьте актуальный текст',
          code: 'STAFF_COMMENT_CONFLICT',
          data: { current: result.current },
        });
        return;
      }
      res.json({
        success: true,
        data: {
          changed: result.changed,
          comment: result.current?.comment ?? null,
          updated_at: result.current?.updated_at ?? null,
          updated_by_name: result.current?.updated_by_name ?? null,
        },
      });
    } catch (error) {
      console.error('Update staff comment error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить комментарий' });
    }
  },

  /** GET /api/employees/month-movement — устроены/уволены с 1-го числа по текущим фильтрам (без статуса). */
  async getMonthMovement(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const range = resolveMonthRange();
      const filter = await buildStaffBaseFilter(req);
      if (filter.kind === 'error') {
        res.status(filter.status).json(filter.body);
        return;
      }
      if (filter.kind === 'empty') {
        res.json({ success: true, data: { month_start: range.monthStart, today: range.today, hired: 0, fired: 0 } });
        return;
      }
      const { whereParts, params } = filter;
      params.push(range.monthStart);
      const fromIdx = params.length;
      params.push(range.today);
      const toIdx = params.length;
      const row = await queryOne<{ hired: number | string; fired: number | string }>(
        `SELECT count(*) FILTER (WHERE employment_status <> 'fired'
                                   AND hire_date BETWEEN $${fromIdx}::date AND $${toIdx}::date)::int AS hired,
                count(*) FILTER (WHERE employment_status = 'fired'
                                   AND dismissal_date BETWEEN $${fromIdx}::date AND $${toIdx}::date)::int AS fired
           FROM employees
          WHERE ${whereParts.join(' AND ')}`,
        params,
      );
      res.json({
        success: true,
        data: {
          month_start: range.monthStart,
          today: range.today,
          hired: Number(row?.hired ?? 0),
          fired: Number(row?.fired ?? 0),
        },
      });
    } catch (error) {
      console.error('Get month movement error:', error);
      res.status(500).json({ success: false, error: 'Не удалось посчитать движение сотрудников' });
    }
  },

  /** GET /api/employees/export-view — xlsx текущей таблицы (фильтры, статус, период, сортировка). */
  async exportView(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const statusParsed = parseStaffStatus(req.query.status);
      if (!statusParsed.ok) {
        res.status(400).json({ success: false, error: 'Некорректный статус', code: 'INVALID_STATUS' });
        return;
      }
      const periodParsed = parseStaffPeriod(req.query.period);
      if (!periodParsed.ok) {
        res.status(400).json({ success: false, error: 'Некорректный период', code: 'INVALID_PERIOD' });
        return;
      }
      const sortParsed = parseStaffSort(req.query);
      if (!sortParsed.ok) {
        res.status(400).json({ success: false, error: 'Некорректная сортировка', code: 'INVALID_SORT' });
        return;
      }
      const sort = sortParsed.sort ?? { key: 'name' as const, dir: 'asc' as const };
      const status = statusParsed.value;
      const period = periodParsed.value;

      const filter = await buildStaffBaseFilter(req);
      if (filter.kind === 'error') {
        res.status(filter.status).json(filter.body);
        return;
      }
      if (filter.kind === 'empty') {
        res.status(400).json({ success: false, error: 'Сотрудников для выгрузки не найдено', code: 'NO_DATA' });
        return;
      }
      const { whereParts, params } = filter;
      const statusSql = statusConditionSql(status);
      if (statusSql) whereParts.push(statusSql);
      if (period) whereParts.push(periodConditionSql(period, resolveMonthRange(), params));

      let sortKeySql: string;
      try {
        sortKeySql = await buildStaffSortKeySql(sort.key, params);
      } catch (err) {
        if (err instanceof StaffSortUnavailableError) {
          res.status(409).json({ success: false, error: err.message, code: 'SORT_UNAVAILABLE' });
          return;
        }
        throw err;
      }
      // Те же выражения, что у сортировки, — значения в файле совпадают с порядком строк.
      const scheduleSql = await buildStaffSortKeySql('schedule', params);
      const signSql = await buildStaffSortKeySql('sign', params);
      params.push(MAX_EXPORT_EMPLOYEES + 1);

      const rows = await query<{
        id: number; full_name: string | null; hire_date: string | null; birth_date: string | null;
        department_name: string | null; position_name: string | null; schedule_name: string | null;
        staff_comment: string | null; sign: string;
      }>(
        `SELECT s.id, s.full_name, s.hire_date, s.birth_date, s.department_name, s.position_name,
                s.schedule_name, s.staff_comment, s.sign
           FROM (SELECT employees.id, employees.full_name,
                        to_char(employees.hire_date, 'YYYY-MM-DD') AS hire_date,
                        to_char(employees.birth_date, 'YYYY-MM-DD') AS birth_date,
                        (SELECT d.name FROM org_departments d WHERE d.id = employees.org_department_id) AS department_name,
                        (SELECT p.name FROM positions p WHERE p.id = employees.position_id) AS position_name,
                        ${scheduleSql} AS schedule_name,
                        (SELECT c.comment FROM employee_staff_comments c WHERE c.employee_id = employees.id) AS staff_comment,
                        ${signSql} AS sign,
                        ${sortKeySql} AS sort_key
                   FROM employees
                  WHERE ${whereParts.join(' AND ')}) s
          ${buildSortOrderSql('s', sort.dir)}
          LIMIT $${params.length}`,
        params,
      );

      if (rows.length === 0) {
        res.status(400).json({ success: false, error: 'Сотрудников для выгрузки не найдено', code: 'NO_DATA' });
        return;
      }
      if (rows.length > MAX_EXPORT_EMPLOYEES) {
        res.status(400).json({
          success: false,
          error: `Слишком много сотрудников для выгрузки (более ${MAX_EXPORT_EMPLOYEES}).`,
          code: 'EXPORT_TOO_LARGE',
        });
        return;
      }

      const objects = await loadMainObjects(rows.map(row => Number(row.id)), resolveExportPeriod());
      const exportRows: IStaffViewExportRow[] = rows.map(row => ({
        fullName: row.full_name ?? '',
        department: row.department_name ?? '',
        position: row.position_name ?? '',
        hireDate: row.hire_date,
        birthDate: row.birth_date,
        schedule: row.schedule_name ?? '',
        object: objects.objects.get(Number(row.id)) ?? '',
        comment: row.staff_comment ?? '',
        sign: row.sign,
      }));
      const buffer = Buffer.from(await buildStaffViewWorkbook(exportRows).xlsx.writeBuffer());

      const section = typeof req.query.section === 'string' && req.query.section ? req.query.section : 'all';
      const today = resolveMonthRange().today;
      const fileName = sanitizeExportFileName(
        `Сотрудники_${SECTION_LABELS[section] ?? 'Все'}_${STATUS_LABELS[status]}_${formatFileDay(today)}.xlsx`,
      );

      // Строгий аудит до отправки файла: ошибка записи — 500 без файла.
      await withTransaction(async client => {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'EXPORT_EMPLOYEES_VIEW', {
          details: {
            kind: 'staff_view',
            count: exportRows.length,
            section,
            department_id: filter.departmentId,
            search: typeof req.query.search === 'string' ? req.query.search.trim() || null : null,
            schedule_id: typeof req.query.schedule_id === 'string' ? req.query.schedule_id || null : null,
            status,
            period,
            sort: sort.key,
            dir: sort.dir,
            object_source: objects.source,
          },
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.send(buffer);
    } catch (error) {
      console.error('Export staff view error:', error);
      res.status(500).json({ success: false, error: 'Ошибка формирования выгрузки' });
    }
  },
};
