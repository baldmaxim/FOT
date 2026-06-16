import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../config/postgres.js';
import { escapeLike } from '../utils/search.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope, resolveAccessibleEmployeeIds } from '../services/data-scope.service.js';
import { loadCalendarMonth } from '../services/schedule.service.js';

const MAX_CONTENT_LENGTH = 5000;

const submitSchema = z.object({
  kind: z.enum(['suggestion', 'complaint']),
  content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
  is_anonymous: z.boolean().optional().default(false),
});

const normalizeDate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
};

const normalizeUuid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || t === 'null' || t === 'undefined') return null;
  return t;
};

// ============================ Сотрудник: отправка ОС ============================

const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.flatten() });
      return;
    }
    const { kind, content, is_anonymous } = parsed.data;

    const emp = await queryOne<{ org_department_id: string | null }>(
      'SELECT org_department_id FROM employees WHERE id = $1',
      [employeeId],
    );

    const data = await queryOne(
      `INSERT INTO feedback_messages (employee_id, kind, content, is_anonymous, department_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, content, is_anonymous, created_at`,
      [employeeId, kind, content, is_anonymous, emp?.org_department_id ?? null],
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error('feedback.submit error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отправки обращения' });
  }
};

// ---- helper: набор employee_id текущего скоупа в SQL-фильтр ----
type ScopeFilter =
  | { all: true }
  | { all: false; ids: number[] };

const resolveScopeFilter = async (req: AuthenticatedRequest): Promise<ScopeFilter> => {
  const accessible = await resolveAccessibleEmployeeIds(req);
  if (accessible === 'all') return { all: true };
  return { all: false, ids: [...accessible] };
};

// ============================ Админ: список предложений/жалоб ============================

const listMessages = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const kind = req.query.kind === 'complaint' ? 'complaint' : 'suggestion';
    const scope = await resolveScopeFilter(req);
    if (!scope.all && scope.ids.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const where: string[] = ['f.kind = $1'];
    const params: unknown[] = [kind];
    if (!scope.all) {
      params.push(scope.ids);
      where.push(`f.employee_id = ANY($${params.length}::int[])`);
    }

    const dept = normalizeUuid(req.query.department);
    if (dept) {
      params.push(dept);
      where.push(`e.org_department_id = $${params.length}::uuid`);
    }
    const from = normalizeDate(req.query.from);
    if (from) {
      params.push(from);
      where.push(`f.created_at >= $${params.length}::date`);
    }
    const to = normalizeDate(req.query.to);
    if (to) {
      params.push(to);
      where.push(`f.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    // Поиск по ФИО применяется только к НЕ-анонимным (иначе раскрыли бы автора).
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      where.push(`(f.is_anonymous = false AND e.full_name ILIKE $${params.length})`);
    }

    const rows = await query<{
      id: number; content: string; is_anonymous: boolean; created_at: string;
      full_name: string | null; department_name: string | null;
    }>(
      `SELECT f.id, f.content, f.is_anonymous, f.created_at,
              e.full_name, d.name AS department_name
         FROM feedback_messages f
         JOIN employees e ON e.id = f.employee_id
         LEFT JOIN org_departments d ON d.id = e.org_department_id
        WHERE ${where.join(' AND ')}
        ORDER BY f.created_at DESC
        LIMIT 1000`,
      params,
    );

    // Анонимные обращения отдаём без ФИО и без отдела (отдел может косвенно выдать автора).
    const data = rows.map(r => ({
      id: r.id,
      content: r.content,
      created_at: r.created_at,
      author: r.is_anonymous ? 'Анонимно' : (r.full_name ?? '—'),
      department_name: r.is_anonymous ? null : r.department_name,
      is_anonymous: r.is_anonymous,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('feedback.listMessages error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения обращений' });
  }
};

// ============================ Админ: задачи сотрудников + статистика ============================

const listTasks = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolveScopeFilter(req);
    if (!scope.all && scope.ids.length === 0) {
      res.json({ success: true, data: { rows: [], stats: [], daily: [], workingDays: 0 } });
      return;
    }

    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (!scope.all) {
      params.push(scope.ids);
      where.push(`t.employee_id = ANY($${params.length}::int[])`);
    }
    const dept = normalizeUuid(req.query.department);
    if (dept) {
      params.push(dept);
      where.push(`e.org_department_id = $${params.length}::uuid`);
    }
    const from = normalizeDate(req.query.from);
    if (from) {
      params.push(from);
      where.push(`t.task_date >= $${params.length}::date`);
    }
    const to = normalizeDate(req.query.to);
    if (to) {
      params.push(to);
      where.push(`t.task_date <= $${params.length}::date`);
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      where.push(`e.full_name ILIKE $${params.length}`);
    }

    const rows = await query<{
      id: number; content: string; task_date: string; updated_at: string;
      full_name: string | null; department_name: string | null;
    }>(
      `SELECT t.id, t.content, t.task_date, t.updated_at,
              e.full_name, d.name AS department_name
         FROM daily_tasks t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN org_departments d ON d.id = e.org_department_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.task_date DESC, e.full_name
        LIMIT 2000`,
      params,
    );

    // Статистика по отделам в человеко-днях: заполнено (сотрудник×день) / (активные × рабочие дни).
    // За один день вырождается в «сколько заполнили / всего». Без периода — fallback «хотя бы раз».
    let stats;
    let daily: Array<{ date: string; count: number }> = [];
    let workingDays = 0;
    if (from && to) {
      const dates = await workingDatesInRange(from, to);
      workingDays = dates.length;
      stats = await buildTaskDepartmentStats(req, scope, dates);
      daily = await buildDailySeries(req, scope, from, to);
    } else {
      stats = await buildDepartmentStats(req, scope, {
        filledExpr: 'EXISTS (SELECT 1 FROM daily_tasks dt WHERE dt.employee_id = e.id)',
      });
    }

    res.json({ success: true, data: { rows, stats, daily, workingDays } });
  } catch (err) {
    console.error('feedback.listTasks error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения задач' });
  }
};

// Статистика «заполнили / всего» по отделам в скоупе.
// from/to уже валидированы через normalizeDate (формат YYYY-MM-DD), поэтому
// безопасно интерполируются в filledExpr.
async function buildDepartmentStats(
  req: AuthenticatedRequest,
  scope: ScopeFilter,
  opts: { filledExpr: string },
): Promise<Array<{ department_id: string | null; department_name: string; total: number; filled: number }>> {
  const where: string[] = ["e.employment_status = 'active'", 'e.is_archived = false'];
  const params: unknown[] = [];
  if (!scope.all) {
    params.push(scope.ids);
    where.push(`e.id = ANY($${params.length}::int[])`);
  }
  const dept = normalizeUuid(req.query.department);
  if (dept) {
    params.push(dept);
    where.push(`e.org_department_id = $${params.length}::uuid`);
  }

  return query(
    `SELECT e.org_department_id AS department_id,
            COALESCE(d.name, 'Не определён') AS department_name,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ${opts.filledExpr})::int AS filled
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE ${where.join(' AND ')}
      GROUP BY e.org_department_id, d.name
      ORDER BY department_name`,
    params,
  );
}

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Рабочие даты диапазона: Пн–Пт минус праздники производственного календаря.
// Для одного дня возвращаем сам день (заполнение возможно и в выходной).
async function workingDatesInRange(from: string, to: string): Promise<string[]> {
  if (from === to) return [from];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  // Праздники по всем месяцам диапазона.
  const holidays = new Set<string>();
  let y = start.getFullYear();
  let m = start.getMonth();
  const ey = end.getFullYear();
  const em = end.getMonth();
  while (y < ey || (y === ey && m <= em)) {
    const cal = await loadCalendarMonth(y, m + 1);
    if (cal) {
      for (const h of cal.holidays) holidays.add(h);
      for (const h of cal.mandatory_holidays) holidays.add(h);
    }
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  const out: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const iso = isoOf(d);
    if (holidays.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

// Статистика задач в человеко-днях: filled = заполнено (сотрудник×день) на рабочих датах,
// total = активные сотрудники × число рабочих дат. Один день → total = число активных.
async function buildTaskDepartmentStats(
  req: AuthenticatedRequest,
  scope: ScopeFilter,
  dates: string[],
): Promise<Array<{ department_id: string | null; department_name: string; total: number; filled: number }>> {
  const where: string[] = ["e.employment_status = 'active'", 'e.is_archived = false'];
  const params: unknown[] = [];
  if (!scope.all) {
    params.push(scope.ids);
    where.push(`e.id = ANY($${params.length}::int[])`);
  }
  const dept = normalizeUuid(req.query.department);
  if (dept) {
    params.push(dept);
    where.push(`e.org_department_id = $${params.length}::uuid`);
  }
  params.push(dates);
  const datesIdx = params.length;

  const rows = await query<{ department_id: string | null; department_name: string; emp_count: number; filled: number }>(
    `SELECT e.org_department_id AS department_id,
            COALESCE(d.name, 'Не определён') AS department_name,
            COUNT(DISTINCT e.id)::int AS emp_count,
            COUNT(dt.id)::int AS filled
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN daily_tasks dt ON dt.employee_id = e.id AND dt.task_date = ANY($${datesIdx}::date[])
      WHERE ${where.join(' AND ')}
      GROUP BY e.org_department_id, d.name
      ORDER BY department_name`,
    params,
  );

  const slots = dates.length || 1;
  return rows.map(r => ({
    department_id: r.department_id,
    department_name: r.department_name,
    total: r.emp_count * slots,
    filled: r.filled,
  }));
}

// Заполнений по дням за период (для графика активности).
async function buildDailySeries(
  req: AuthenticatedRequest,
  scope: ScopeFilter,
  from: string,
  to: string,
): Promise<Array<{ date: string; count: number }>> {
  const where: string[] = [
    "e.employment_status = 'active'",
    'e.is_archived = false',
    'dt.task_date >= $1::date',
    'dt.task_date <= $2::date',
  ];
  const params: unknown[] = [from, to];
  if (!scope.all) {
    params.push(scope.ids);
    where.push(`e.id = ANY($${params.length}::int[])`);
  }
  const dept = normalizeUuid(req.query.department);
  if (dept) {
    params.push(dept);
    where.push(`e.org_department_id = $${params.length}::uuid`);
  }

  return query<{ date: string; count: number }>(
    `SELECT to_char(dt.task_date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
       FROM daily_tasks dt
       JOIN employees e ON e.id = dt.employee_id
      WHERE ${where.join(' AND ')}
      GROUP BY dt.task_date
      ORDER BY dt.task_date`,
    params,
  );
}

// ============================ Админ: удаление обращения ============================

const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }
    const msg = await queryOne<{ employee_id: number }>(
      'SELECT employee_id FROM feedback_messages WHERE id = $1',
      [id],
    );
    if (!msg) {
      res.status(404).json({ success: false, error: 'Обращение не найдено' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, msg.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }
    await execute('DELETE FROM feedback_messages WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('feedback.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления обращения' });
  }
};

// ============================ Админ: детализация отдела (ростер + заполнения) ============================

const getDepartmentTasks = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const departmentId = normalizeUuid(req.params.id);
    const from = normalizeDate(req.query.from);
    const to = normalizeDate(req.query.to);
    if (!departmentId) {
      res.status(400).json({ success: false, error: 'Некорректный отдел' });
      return;
    }
    if (!from || !to) {
      res.status(400).json({ success: false, error: 'Не указан период' });
      return;
    }

    const scope = await resolveScopeFilter(req);
    const deptRow = await queryOne<{ name: string | null }>(
      'SELECT name FROM org_departments WHERE id = $1::uuid',
      [departmentId],
    );
    const base = {
      department_name: deptRow?.name ?? null,
      from,
      to,
      workingDates: [] as string[],
      employees: [] as Array<{ id: number; full_name: string | null; fills: Array<{ date: string; content: string }> }>,
    };
    if (!scope.all && scope.ids.length === 0) {
      res.json({ success: true, data: base });
      return;
    }

    const empWhere: string[] = [
      "e.employment_status = 'active'",
      'e.is_archived = false',
      'e.org_department_id = $1::uuid',
    ];
    const empParams: unknown[] = [departmentId];
    if (!scope.all) {
      empParams.push(scope.ids);
      empWhere.push(`e.id = ANY($${empParams.length}::int[])`);
    }
    const employees = await query<{ id: number; full_name: string | null }>(
      `SELECT e.id, e.full_name FROM employees e WHERE ${empWhere.join(' AND ')} ORDER BY e.full_name`,
      empParams,
    );

    const byEmp = new Map<number, Array<{ date: string; content: string }>>();
    if (employees.length) {
      const fills = await query<{ employee_id: number; date: string; content: string }>(
        `SELECT employee_id, to_char(task_date, 'YYYY-MM-DD') AS date, content
           FROM daily_tasks
          WHERE employee_id = ANY($1::int[]) AND task_date >= $2::date AND task_date <= $3::date
          ORDER BY task_date`,
        [employees.map(e => e.id), from, to],
      );
      for (const f of fills) {
        const arr = byEmp.get(f.employee_id) ?? [];
        arr.push({ date: f.date, content: f.content });
        byEmp.set(f.employee_id, arr);
      }
    }

    const workingDates = await workingDatesInRange(from, to);
    res.json({
      success: true,
      data: {
        ...base,
        workingDates,
        employees: employees.map(e => ({ id: e.id, full_name: e.full_name, fills: byEmp.get(e.id) ?? [] })),
      },
    });
  } catch (err) {
    console.error('feedback.getDepartmentTasks error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения задач отдела' });
  }
};

export const feedbackController = {
  submit,
  listMessages,
  listTasks,
  getDepartmentTasks,
  remove,
  buildDepartmentStats,
};
