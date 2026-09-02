import { query, queryOne, type DbExecutor } from '../config/postgres.js';
import {
  formatDateShift,
  listEmployeeMembershipsForDepartmentPeriod,
  type IEmployeeDepartmentAssignment,
} from './timesheet-department-assignments.service.js';

/**
 * Периоды работы сотрудника по отделам за диапазон табеля — источник строк режима
 * «По сотруднику»: одна строка на период. Границы здесь нужны, чтобы разложить
 * сотрудника по отделам; фактические joined_date/transferred_out_date каждой строки
 * считает getAll через listEmployeeMembershipsForDepartmentPeriod (канонический путь).
 */
export interface IEmployeeDepartmentPeriod {
  org_department_id: string;
  department_name: string | null;
  /** Первый день периода (вкл.), уже обрезан по запрошенному диапазону. */
  from: string;
  /** Последний день периода (вкл.), уже обрезан по запрошенному диапазону. */
  to: string;
}

export interface IEmployeePeriodsMeta {
  hire_date: string | null;
  org_department_id: string | null;
  employment_status: string | null;
  dismissal_date: string | null;
  excluded_from_timesheet: boolean;
  excluded_from_timesheet_date: string | null;
}

interface IRawPeriod {
  org_department_id: string;
  from: string | null;
  to: string | null;
}

/**
 * Вход в отдел — следствие НАСТОЯЩЕГО перевода: встык после закрытого периода
 * в другом отделе (prev.effective_to + 1 = cur.effective_from). Зеркалит
 * transferJoins в listEmployeeMembershipsForDepartmentPeriod: одиночный поздний
 * effective_from от freeze-синхронизации переводом не считается и период не открывает.
 */
const collectTransferJoinDates = (assignments: IEmployeeDepartmentAssignment[]): Set<string> => {
  const joins = new Set<string>();
  for (const cur of assignments) {
    if (!cur.effective_from) continue;
    const expectedPrevTo = formatDateShift(cur.effective_from, -1);
    const hasStitch = assignments.some(prev => (
      prev.id !== cur.id
      && prev.effective_to === expectedPrevTo
      && prev.org_department_id !== cur.org_department_id
    ));
    if (hasStitch) joins.add(cur.effective_from);
  }
  return joins;
};

/**
 * Склейка последовательных назначений: смена только должности внутри отдела новую
 * строку не даёт, соседние и пересекающиеся интервалы одного отдела объединяются.
 * A → B → A остаётся тремя периодами: склеиваем только соседей по порядку.
 */
const mergeAdjacentPeriods = (periods: IRawPeriod[]): IRawPeriod[] => {
  const merged: IRawPeriod[] = [];
  for (const period of periods) {
    const last = merged[merged.length - 1];
    if (!last || last.org_department_id !== period.org_department_id) {
      merged.push({ ...period });
      continue;
    }
    // Разрыв между периодами одного отдела больше одного дня — это возврат (A → B → A).
    const contiguous = last.to == null
      || period.from == null
      || period.from <= formatDateShift(last.to, 1);
    if (!contiguous) {
      merged.push({ ...period });
      continue;
    }
    if (last.to != null && (period.to == null || period.to > last.to)) {
      last.to = period.to;
    }
  }
  return merged;
};

/**
 * То же, что buildEmployeeDepartmentPeriods, но сообщает, сработала ли ветка fallback
 * на employees.org_department_id.
 *
 * Снаружи это иначе не отличить, а публичному методу 1С нужно: отдел, взятый из снимка
 * сотрудника вместо истории назначений, помечается department_history_missing —
 * достоверной историей он не является.
 */
export function buildEmployeeDepartmentPeriodsDetailed(params: {
  assignments: IEmployeeDepartmentAssignment[];
  employee: IEmployeePeriodsMeta;
  dismissalFromDepartmentId: string | null;
  startDate: string;
  endDate: string;
}): {
  periods: Array<{ org_department_id: string; from: string; to: string }>;
  usedSnapshotFallback: boolean;
} {
  const { assignments, employee, dismissalFromDepartmentId, startDate, endDate } = params;

  // Верхняя граница: увольнение и исключение из табеля обрезают любой период.
  let hardEnd = endDate;
  if (employee.employment_status === 'fired' && employee.dismissal_date) {
    if (employee.dismissal_date < hardEnd) hardEnd = employee.dismissal_date;
  }
  if (employee.excluded_from_timesheet && employee.excluded_from_timesheet_date) {
    const excludedLast = formatDateShift(employee.excluded_from_timesheet_date, -1);
    if (excludedLast < hardEnd) hardEnd = excludedLast;
  }
  // Нижняя граница: раньше приёма на работу сотрудника в табеле нет.
  const hardStart = employee.hire_date && employee.hire_date > startDate ? employee.hire_date : startDate;
  if (hardEnd < hardStart) return { periods: [], usedSnapshotFallback: false };

  const transferJoins = collectTransferJoinDates(assignments);

  const ordered = [...assignments]
    .filter(a => Boolean(a.org_department_id) && Boolean(a.effective_from))
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0));

  const raw: IRawPeriod[] = ordered.map((assignment, index) => {
    // «Грязный» effective_from (нет стыка с переводом) у САМОГО РАННЕГО назначения
    // не является реальной датой входа — иначе табель обрезался бы задним числом.
    const isDirtyOpening = index === 0 && !transferJoins.has(assignment.effective_from);
    return {
      org_department_id: assignment.org_department_id as string,
      from: isDirtyOpening ? null : assignment.effective_from,
      to: assignment.effective_to ?? null,
    };
  });

  const merged = mergeAdjacentPeriods(raw);

  const clipped: Array<{ org_department_id: string; from: string; to: string }> = [];
  for (const period of merged) {
    const from = period.from && period.from > hardStart ? period.from : hardStart;
    const to = period.to && period.to < hardEnd ? period.to : hardEnd;
    if (from > to) continue;
    clipped.push({ org_department_id: period.org_department_id, from, to });
  }

  // Fallback на snapshot: назначений нет вовсе, либо они не покрывают диапазон
  // (у ~70% активных членство живо только в employees.org_department_id).
  let usedSnapshotFallback = false;
  if (clipped.length === 0 && employee.org_department_id) {
    clipped.push({ org_department_id: employee.org_department_id, from: hardStart, to: hardEnd });
    usedSnapshotFallback = true;
  }

  // Уволенный: assignments уже переписаны на архивную папку, реальный отдел —
  // в employee_dismissal_events.from_department_id. Зеркалит ветку firedFromDept
  // в listEmployeeMembershipsForDepartmentPeriod.
  if (dismissalFromDepartmentId && employee.dismissal_date && employee.dismissal_date >= startDate) {
    const alreadyCovered = clipped.some(p => p.org_department_id === dismissalFromDepartmentId);
    if (!alreadyCovered) {
      clipped.push({ org_department_id: dismissalFromDepartmentId, from: hardStart, to: hardEnd });
    }
  }

  return {
    periods: clipped.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
    usedSnapshotFallback,
  };
}

/**
 * Чистая сборка периодов — вся дата-логика без обращений к БД (тестируется напрямую).
 */
export function buildEmployeeDepartmentPeriods(params: {
  assignments: IEmployeeDepartmentAssignment[];
  employee: IEmployeePeriodsMeta;
  dismissalFromDepartmentId: string | null;
  startDate: string;
  endDate: string;
}): Array<{ org_department_id: string; from: string; to: string }> {
  return buildEmployeeDepartmentPeriodsDetailed(params).periods;
}

/**
 * Периоды сотрудника по отделам за диапазон. Каждый кандидат сверяется с
 * каноническим membership-сервисом: если он не признаёт сотрудника членом отдела
 * на этом отрезке, период отбрасывается — так режим «По сотруднику» не может
 * показать строку, которой нет в самом отделе.
 */
export async function listEmployeeDepartmentPeriods(
  employeeId: number,
  startDate: string,
  endDate: string,
): Promise<IEmployeeDepartmentPeriod[]> {
  const employee = await queryOne<IEmployeePeriodsMeta>(
    `SELECT hire_date::text AS hire_date,
            org_department_id,
            employment_status,
            dismissal_date::text AS dismissal_date,
            excluded_from_timesheet,
            excluded_from_timesheet_date::text AS excluded_from_timesheet_date
       FROM employees
      WHERE id = $1 AND is_archived = false`,
    [employeeId],
  );
  if (!employee) return [];

  const [assignmentRows, dismissalRow] = await Promise.all([
    query<{
      id: string;
      org_department_id: string | null;
      position_id: string | null;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT id, org_department_id, position_id,
              effective_from::text AS effective_from,
              effective_to::text AS effective_to
         FROM employee_assignments
        WHERE employee_id = $1
        ORDER BY effective_from ASC, created_at ASC`,
      [employeeId],
    ),
    queryOne<{ from_department_id: string | null }>(
      `SELECT from_department_id
         FROM employee_dismissal_events
        WHERE employee_id = $1
          AND dismissal_date IS NOT NULL
          AND dismissal_date >= $2::date
          AND cancelled = false
        ORDER BY created_at DESC
        LIMIT 1`,
      [employeeId, startDate],
    ),
  ]);

  const assignments: IEmployeeDepartmentAssignment[] = assignmentRows.map(row => ({
    id: String(row.id),
    employee_id: employeeId,
    org_department_id: row.org_department_id ?? null,
    position_id: row.position_id ?? null,
    effective_from: String(row.effective_from),
    effective_to: row.effective_to ?? null,
  }));

  const candidates = buildEmployeeDepartmentPeriods({
    assignments,
    employee,
    dismissalFromDepartmentId: dismissalRow?.from_department_id ?? null,
    startDate,
    endDate,
  });
  if (candidates.length === 0) return [];

  const confirmed: IEmployeeDepartmentPeriod[] = [];
  for (const candidate of candidates) {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(
      candidate.org_department_id,
      candidate.from,
      candidate.to,
    );
    if (!memberships.some(m => m.employee_id === employeeId)) continue;
    confirmed.push({ ...candidate, department_name: null });
  }
  if (confirmed.length === 0) return [];

  const deptIds = [...new Set(confirmed.map(p => p.org_department_id))];
  const departments = await query<{ id: string; name: string | null }>(
    'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
    [deptIds],
  );
  const nameById = new Map<string, string | null>();
  for (const dept of departments) nameById.set(String(dept.id), dept.name ?? null);

  return confirmed.map(period => ({
    ...period,
    department_name: nameById.get(period.org_department_id) ?? null,
  }));
}

/** Отдел сотрудника в рамках табеля + признаки качества истории. */
export interface IEmployeePeriodResolution {
  /** Отдел на конец периода (для уволенного — на последний допустимый рабочий день). */
  org_department_id: string | null;
  /** Внутри периода был НАСТОЯЩИЙ перевод: история достоверна, отделов было два. */
  changedDuringPeriod: boolean;
  /** Отдел взят из employees.org_department_id — назначения диапазон не покрыли. */
  usedSnapshotFallback: boolean;
}

/**
 * Периоды отделов сразу по списку сотрудников, через клиент транзакции.
 *
 * Зачем batch: снимок версии обязан читаться из одного среза БД, а поштучная
 * listEmployeeDepartmentPeriods ходит в пул и делает по несколько запросов на человека.
 *
 * Отличия от поштучной версии — намеренные:
 *   - НЕ фильтрует is_archived: согласованный ростер выгружается целиком, включая
 *     архивных, и отбрасывать их значит терять отдел там, где он известен;
 *   - НЕ сверяет кандидатов через listEmployeeMembershipsForDepartmentPeriod: там это
 *     нужно, чтобы строка «По сотруднику» не появилась без строки в самом отделе, здесь
 *     же состав уже зафиксирован снимком подачи, а сверка стоила бы запроса на кандидата.
 */
export async function listEmployeeDepartmentPeriodsBulk(
  employeeIds: readonly number[],
  startDate: string,
  endDate: string,
  exec?: DbExecutor,
): Promise<Map<number, IEmployeePeriodResolution>> {
  const result = new Map<number, IEmployeePeriodResolution>();
  const ids = [...new Set(employeeIds.filter(id => Number.isFinite(id)))];
  if (ids.length === 0) return result;

  // employees.id — BIGINT, поэтому bigint[], а не int[].
  const run = async <T extends import('pg').QueryResultRow>(
    sql: string, params: readonly unknown[],
  ): Promise<T[]> => (
    exec ? (await exec.query<T>(sql, params as unknown[])).rows : query<T>(sql, params)
  );

  const [metaRows, assignmentRows, dismissalRows] = await Promise.all([
    run<IEmployeePeriodsMeta & { id: string | number }>(
      `SELECT id,
              hire_date::text AS hire_date,
              org_department_id,
              employment_status,
              dismissal_date::text AS dismissal_date,
              excluded_from_timesheet,
              excluded_from_timesheet_date::text AS excluded_from_timesheet_date
         FROM employees
        WHERE id = ANY($1::bigint[])`,
      [ids],
    ),
    run<{
      id: string; employee_id: string | number; org_department_id: string | null;
      position_id: string | null; effective_from: string; effective_to: string | null;
    }>(
      `SELECT id, employee_id, org_department_id, position_id,
              effective_from::text AS effective_from,
              effective_to::text   AS effective_to
         FROM employee_assignments
        WHERE employee_id = ANY($1::bigint[])
        ORDER BY employee_id ASC, effective_from ASC, created_at ASC`,
      [ids],
    ),
    run<{ employee_id: string | number; from_department_id: string | null }>(
      `SELECT DISTINCT ON (employee_id) employee_id, from_department_id
         FROM employee_dismissal_events
        WHERE employee_id = ANY($1::bigint[])
          AND dismissal_date IS NOT NULL
          AND dismissal_date >= $2::date
          AND cancelled = false
        ORDER BY employee_id, created_at DESC`,
      [ids, startDate],
    ),
  ]);

  const assignmentsByEmployee = new Map<number, IEmployeeDepartmentAssignment[]>();
  for (const row of assignmentRows) {
    const employeeId = Number(row.employee_id);
    const list = assignmentsByEmployee.get(employeeId) ?? [];
    list.push({
      id: String(row.id),
      employee_id: employeeId,
      org_department_id: row.org_department_id ?? null,
      position_id: row.position_id ?? null,
      effective_from: String(row.effective_from),
      effective_to: row.effective_to ?? null,
    });
    assignmentsByEmployee.set(employeeId, list);
  }

  const dismissalByEmployee = new Map<number, string | null>();
  for (const row of dismissalRows) {
    dismissalByEmployee.set(Number(row.employee_id), row.from_department_id ?? null);
  }

  for (const meta of metaRows) {
    const employeeId = Number(meta.id);
    const built = buildEmployeeDepartmentPeriodsDetailed({
      assignments: assignmentsByEmployee.get(employeeId) ?? [],
      employee: meta,
      dismissalFromDepartmentId: dismissalByEmployee.get(employeeId) ?? null,
      startDate,
      endDate,
    });

    // Периоды отсортированы по from — берём последний: это отдел на конец диапазона,
    // а для уволенного диапазон уже обрезан hardEnd по дате увольнения.
    const last = built.periods[built.periods.length - 1];
    const distinctDepartments = new Set(built.periods.map(p => p.org_department_id));

    result.set(employeeId, {
      org_department_id: last?.org_department_id ?? null,
      changedDuringPeriod: distinctDepartments.size > 1,
      usedSnapshotFallback: built.usedSnapshotFallback,
    });
  }

  return result;
}
