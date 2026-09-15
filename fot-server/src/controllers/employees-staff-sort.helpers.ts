/**
 * Серверная сортировка «Текущих сотрудников» по столбцам таблицы и курсор (ключ, id).
 *
 * Ключ сортировки — текстовое выражение над строкой employees, собираемое на КАЖДЫЙ запрос:
 * график зависит от «сегодня» по Москве, признак — от id отделов «Декрет», объект — от
 * опубликованного поколения снимка. Пустые значения (NULL) всегда в конце, при любом
 * направлении; тай-брейк — id в том же направлении.
 */
import { getAllDepartmentsTree } from '../services/skud-shared.service.js';
import { loadActiveSnapshotRun } from '../services/employee-main-object-snapshot.service.js';
import { buildSignDepartmentIndex, isInMaternityDepartment } from '../utils/employee-sign.js';
import { moscowTodayIso } from '../utils/date.utils.js';

export const STAFF_SORT_KEYS = [
  'name',
  'department',
  'position',
  'hire_date',
  'birth_date',
  'schedule',
  'main_object',
  'comment',
  'sign',
] as const;

export type StaffSortKey = typeof STAFF_SORT_KEYS[number];
export type StaffSortDir = 'asc' | 'desc';

export interface IStaffSort {
  key: StaffSortKey;
  dir: StaffSortDir;
}

export type StaffSortParseResult = { ok: true; sort: IStaffSort | null } | { ok: false };

/** Нет sort и dir — без сортировки (старый клиент); dir без sort или неизвестное — ошибка. */
export function parseStaffSort(queryParams: Record<string, unknown>): StaffSortParseResult {
  const { sort, dir } = queryParams;
  if (sort === undefined && dir === undefined) return { ok: true, sort: null };
  if (typeof sort !== 'string' || !(STAFF_SORT_KEYS as readonly string[]).includes(sort)) return { ok: false };
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') return { ok: false };
  return { ok: true, sort: { key: sort as StaffSortKey, dir: (dir as StaffSortDir | undefined) ?? 'asc' } };
}

/** Курсор сортированной выдачи: key — значение ключа последней строки (null — пустое). */
export interface IStaffSortCursor {
  key: string | null;
  id: number;
}

export type StaffSortCursorParseResult =
  | { ok: true; after: IStaffSortCursor | null }
  | { ok: false };

/** after_key + after_null + after_id; after_name с сортировкой не принимается. */
export function parseStaffSortCursor(queryParams: Record<string, unknown>): StaffSortCursorParseResult {
  const { after_key: key, after_null: isNull, after_id: idRaw, after_name: legacyName } = queryParams;
  if (legacyName !== undefined) return { ok: false };
  if (key === undefined && isNull === undefined && idRaw === undefined) return { ok: true, after: null };
  if (typeof idRaw !== 'string' || !/^\d+$/.test(idRaw)) return { ok: false };
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false };
  if (isNull === '1') return key === undefined ? { ok: true, after: { key: null, id } } : { ok: false };
  if (isNull === '0' && typeof key === 'string') return { ok: true, after: { key, id } };
  return { ok: false };
}

export class StaffSortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffSortUnavailableError';
  }
}

/** Текстовое значение или NULL: пустая строка сортируется как отсутствие значения. */
const nullIfBlank = (expr: string): string => `NULLIF(btrim(${expr}), '')`;

/**
 * Выражение ключа для строки таблицы employees (без алиаса). Параметры дописываются в params.
 * main_object без опубликованного снимка — StaffSortUnavailableError: считать объект на лету
 * для всей выборки сортировка не умеет.
 */
export async function buildStaffSortKeySql(key: StaffSortKey, params: unknown[]): Promise<string> {
  switch (key) {
    case 'name':
      return nullIfBlank('employees.full_name');
    case 'department':
      return `(SELECT ${nullIfBlank('d.name')} FROM org_departments d WHERE d.id = employees.org_department_id)`;
    case 'position':
      return `(SELECT ${nullIfBlank('p.name')} FROM positions p WHERE p.id = employees.position_id)`;
    case 'hire_date':
      return `to_char(employees.hire_date, 'YYYY-MM-DD')`;
    case 'birth_date':
      return `to_char(employees.birth_date, 'YYYY-MM-DD')`;
    case 'schedule': {
      // Как buildScheduleViews на фронте: первое активное на сегодня назначение по дате начала;
      // нет назначения или шаблон удалён — график по умолчанию.
      params.push(moscowTodayIso());
      const todayIdx = params.length;
      return `COALESCE(
        (SELECT ${nullIfBlank('ws.name')}
           FROM (SELECT a.schedule_id
                   FROM employee_schedule_assignments a
                  WHERE a.employee_id = employees.id
                    AND a.effective_from <= $${todayIdx}::date
                    AND (a.effective_to IS NULL OR a.effective_to >= $${todayIdx}::date)
                  ORDER BY a.effective_from DESC, a.id DESC
                  LIMIT 1) cur
           LEFT JOIN work_schedules ws ON ws.id = cur.schedule_id),
        (SELECT ${nullIfBlank('w.name')} FROM work_schedules w WHERE w.is_default ORDER BY w.id LIMIT 1)
      )`;
    }
    case 'main_object': {
      const run = await loadActiveSnapshotRun();
      if (!run) throw new StaffSortUnavailableError('Сортировка по объекту недоступна: снимок объектов ещё не рассчитан');
      params.push(run.id);
      return `(SELECT ${nullIfBlank('s.object_name')} FROM employee_main_object_snapshot s
                WHERE s.run_id = $${params.length} AND s.employee_id = employees.id)`;
    }
    case 'comment':
      return `(SELECT ${nullIfBlank('c.comment')} FROM employee_staff_comments c WHERE c.employee_id = employees.id)`;
    case 'sign': {
      // Как resolveEmployeeSign: уволен → «Уволен»; отдел внутри «Декрет» → «Декрет»; иначе «Работает».
      const deptById = buildSignDepartmentIndex(await getAllDepartmentsTree());
      const maternityIds = [...deptById.keys()].filter(id => isInMaternityDepartment(id, deptById));
      params.push(maternityIds);
      return `(CASE WHEN employees.employment_status = 'fired' THEN 'Уволен'
                    WHEN employees.org_department_id = ANY($${params.length}::uuid[]) THEN 'Декрет'
                    ELSE 'Работает' END)`;
    }
  }
}

/**
 * Условие «строка после курсора» для обёртки с колонками sort_key и id. Строки с NULL-ключом
 * идут после всех непустых, поэтому сравнение раскрыто через OR (сравнение кортежей не
 * подходит: NULL и порядок пустых в конце не совпадают с направлением).
 */
export function buildSortCursorSql(
  alias: string,
  dir: StaffSortDir,
  after: IStaffSortCursor,
  params: unknown[],
): string {
  const op = dir === 'asc' ? '>' : '<';
  const sk = `${alias}.sort_key`;
  params.push(after.id);
  const idIdx = params.length;
  if (after.key === null) return `(${sk} IS NULL AND ${alias}.id ${op} $${idIdx}::int)`;
  params.push(after.key);
  const keyIdx = params.length;
  return `((${sk} IS NOT NULL AND ${sk} ${op} $${keyIdx}::text)
        OR (${sk} IS NOT NULL AND ${sk} = $${keyIdx}::text AND ${alias}.id ${op} $${idIdx}::int)
        OR ${sk} IS NULL)`;
}

export const buildSortOrderSql = (alias: string, dir: StaffSortDir): string => {
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY (${alias}.sort_key IS NULL) ASC, ${alias}.sort_key ${direction}, ${alias}.id ${direction}`;
};
