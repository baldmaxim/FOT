/**
 * «Свод» на «Расчётах»: суммы «Оплачено» (ЗУП, payroll_paid_amounts) за выбранные месяцы — по объектам и
 * категориям (ИТР / Офис / Рабочие). Только чтение.
 *
 * Кто попадает: все, кому за месяц есть суммы — работающие, уволенные, архивные (им платили); без
 * подрядчиков (текущий отдел или отдел подачи месяца — в поддереве подрядных организаций). Охват
 * пользователя: сотрудник виден, если в охвате его текущий отдел или отдел его подачи за месяц.
 *
 * Объект и отдел месяца — из объектной разбивки последней редакции каждой подачи месяца
 * (payroll-summary.attribution.ts); категория — из условий оплаты месяца, иначе по отделу месяца.
 */
import { query } from '../../config/postgres.js';
import { resolveExportModes, type IResolvedExportMode } from '../timesheet-export-mode.service.js';
import { loadStaffCategoryResolver } from './payroll-staff-category.js';
import type { StaffCategory } from './payroll-terms.service.js';
import {
  centsToAmount,
  fallbackSummaryObject,
  pickMainObject,
  pickMonthDepartment,
  toCents,
  type ISummaryBreakdownRow,
  type ISummaryObject,
  type ISummaryObjectMeta,
} from './payroll-summary.attribution.js';

export interface IPayrollSummaryScope {
  contractorRootId: string | null;
  /** Отделы охвата; null — все. */
  departmentIds: string[] | null;
}

/** Строка «Свода»: сотрудник на объекте в категории, суммы статей сложены за выбранные месяцы. */
export interface IPayrollSummaryRow {
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  category: StaffCategory;
  object_key: string;
  object_name: string;
  /** Статья → сумма (NUMERIC строкой, может быть 0 или отрицательной). Статьи без сумм нет. */
  amounts: Record<string, string>;
}

export interface IPayrollSummary {
  /** Месяцы, вошедшие в «Свод» (YYYY-MM, по возрастанию). */
  months: string[];
  rows: IPayrollSummaryRow[];
}

interface IPaidRow {
  employee_id: number;
  month: string;
  item: string;
  amount: string;
}

interface IBreakdownSqlRow extends ISummaryBreakdownRow {
  month: string;
  employee_id: number;
}

interface IEmployeeRow {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  position: string | null;
}

const pairKey = (employeeId: number, month: string): string => `${employeeId}|${month}`;

const loadPaid = (monthStarts: string[] | null): Promise<IPaidRow[]> => query<IPaidRow>(
  `SELECT p.employee_id, to_char(p.month, 'YYYY-MM') AS month, p.item_code AS item, p.amount::text AS amount
     FROM payroll_paid_amounts p
    WHERE $1::date[] IS NULL OR p.month = ANY($1::date[])
    ORDER BY p.employee_id, p.month, p.item_code`,
  [monthStarts],
);

/**
 * Разбивка подач месяцев: последняя редакция каждой подачи, строка — часы сотрудника на объекте.
 * Сотрудник в подаче без объектов — одна строка с object_key NULL и нулём часов (виден отдел подачи).
 */
const loadBreakdown = (monthStarts: string[], employeeIds: number[]): Promise<IBreakdownSqlRow[]> => query<IBreakdownSqlRow>(
  `WITH latest AS (
     SELECT DISTINCT ON (v.approval_id) v.id, v.department_id, v.start_date
       FROM timesheet_versions v
      WHERE date_trunc('month', v.start_date)::date = ANY($1::date[])
      ORDER BY v.approval_id, v.revision DESC
   )
   SELECT to_char(l.start_date, 'YYYY-MM') AS month,
          (emp->>'employee_id')::int AS employee_id,
          l.id::int AS version_id,
          l.department_id::text AS department_id,
          obj->>'object_key' AS object_key,
          obj->>'object_id' AS object_id,
          obj->>'object_name' AS object_name,
          obj->>'object_address' AS object_address,
          COALESCE((obj->>'total_hours')::float8, 0) AS hours
     FROM latest l
     JOIN timesheet_version_objects vo ON vo.version_id = l.id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(vo.payload->'employees', '[]'::jsonb)) AS emp
     LEFT JOIN LATERAL jsonb_array_elements(COALESCE(emp->'objects', '[]'::jsonb)) AS obj ON true
    WHERE (emp->>'employee_id')::int = ANY($2::int[])`,
  [monthStarts, employeeIds],
);

const loadContractorDepartments = async (rootId: string | null): Promise<Set<string>> => {
  if (!rootId) return new Set();
  const rows = await query<{ id: string }>(
    'SELECT id::text AS id FROM public.get_descendant_department_ids(ARRAY[$1::uuid])',
    [rootId],
  );
  return new Set(rows.map(row => row.id));
};

/**
 * Пары (сотрудник, месяц) «Свода» в охвате: без подрядчиков, отдел (текущий или подачи месяца) — в
 * охвате. Возвращает разбивку по паре — она нужна и дальше.
 */
const filterScope = async (
  paid: readonly IPaidRow[],
  scope: IPayrollSummaryScope,
): Promise<{
  allowed: Set<string>;
  employees: Map<number, IEmployeeRow>;
  breakdown: Map<string, ISummaryBreakdownRow[]>;
}> => {
  const employeeIds = [...new Set(paid.map(row => row.employee_id))];
  const monthStarts = [...new Set(paid.map(row => `${row.month}-01`))];
  const [employees, breakdownRows, contractors] = await Promise.all([
    query<IEmployeeRow>(
      `SELECT e.id, e.full_name, e.org_department_id::text AS org_department_id, p.name AS position
         FROM employees e
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE e.id = ANY($1::int[])`,
      [employeeIds],
    ),
    employeeIds.length > 0 ? loadBreakdown(monthStarts, employeeIds) : Promise.resolve([]),
    loadContractorDepartments(scope.contractorRootId),
  ]);

  const breakdown = new Map<string, ISummaryBreakdownRow[]>();
  for (const row of breakdownRows) {
    const key = pairKey(Number(row.employee_id), row.month);
    const list = breakdown.get(key);
    const item: ISummaryBreakdownRow = { ...row, version_id: Number(row.version_id), hours: Number(row.hours) };
    if (list) list.push(item);
    else breakdown.set(key, [item]);
  }

  const employeeById = new Map(employees.map(row => [Number(row.id), row]));
  const scopeDepartments = scope.departmentIds ? new Set(scope.departmentIds) : null;
  const allowed = new Set<string>();
  for (const key of new Set(paid.map(row => pairKey(row.employee_id, row.month)))) {
    const employeeId = Number(key.split('|')[0]);
    const employee = employeeById.get(employeeId);
    if (!employee) continue;
    const monthDepartments = (breakdown.get(key) ?? [])
      .map(row => row.department_id)
      .filter((id): id is string => id !== null);
    const departments = [employee.org_department_id, ...monthDepartments].filter((id): id is string => id !== null);
    if (departments.some(id => contractors.has(id))) continue;
    if (scopeDepartments && !departments.some(id => scopeDepartments.has(id))) continue;
    allowed.add(key);
  }
  return { allowed, employees: employeeById, breakdown };
};

/** Месяцы, за которые в охвате пользователя есть «Оплачено» (YYYY-MM, по возрастанию). */
export const listPayrollSummaryMonths = async (scope: IPayrollSummaryScope): Promise<string[]> => {
  if (scope.departmentIds?.length === 0) return [];
  const paid = await query<IPaidRow>(
    `SELECT DISTINCT employee_id, to_char(month, 'YYYY-MM') AS month, '' AS item, '0' AS amount
       FROM payroll_paid_amounts`,
  );
  if (paid.length === 0) return [];
  const { allowed } = await filterScope(paid, scope);
  return [...new Set([...allowed].map(key => key.split('|')[1]))].sort();
};

/** Категория из условий оплаты месяца: последняя версия, пересекающая месяц. */
const loadTermsCategories = async (employeeIds: number[], monthStarts: string[]): Promise<Map<string, StaffCategory>> => {
  const rows = await query<{ employee_id: number; month: string; staff_category: StaffCategory }>(
    `SELECT DISTINCT ON (t.employee_id, m.start)
            t.employee_id, to_char(m.start, 'YYYY-MM') AS month, t.staff_category
       FROM unnest($2::date[]) AS m(start)
       JOIN payroll_compensation_terms t
         ON t.employee_id = ANY($1::int[])
        AND t.effective_from < (m.start + INTERVAL '1 month')::date
        AND (t.effective_to IS NULL OR t.effective_to >= m.start)
      ORDER BY t.employee_id, m.start, t.effective_from DESC`,
    [employeeIds, monthStarts],
  );
  return new Map(rows.map(row => [pairKey(Number(row.employee_id), row.month), row.staff_category]));
};

const loadObjectMeta = async (ids: string[]): Promise<Map<string, ISummaryObjectMeta>> => {
  if (ids.length === 0) return new Map();
  const rows = await query<{ id: string; name: string; alt_name: string | null }>(
    'SELECT id::text AS id, name, alt_name FROM skud_objects WHERE id::text = ANY($1::text[])',
    [ids],
  );
  return new Map(rows.map(row => [row.id, { name: row.name, address: row.alt_name }]));
};

/** Режимы табелирования месяцев для пар без разбивки. */
const loadFallbackModes = async (pairs: ReadonlyArray<{ employeeId: number; month: string }>): Promise<Map<string, IResolvedExportMode>> => {
  const byMonth = new Map<string, number[]>();
  for (const pair of pairs) {
    const list = byMonth.get(pair.month);
    if (list) list.push(pair.employeeId);
    else byMonth.set(pair.month, [pair.employeeId]);
  }
  const result = new Map<string, IResolvedExportMode>();
  for (const [month, ids] of byMonth) {
    const modes = await resolveExportModes(ids, undefined, { month });
    for (const [employeeId, mode] of modes) result.set(pairKey(employeeId, month), mode);
  }
  return result;
};

/**
 * «Свод» за месяцы monthStarts (первые числа; null — все месяцы с суммами): строки по (сотрудник,
 * объект, категория), суммы статей сложены за месяцы — в копейках, без потерь на дробях.
 */
export const loadPayrollSummary = async (input: {
  scope: IPayrollSummaryScope;
  monthStarts: string[] | null;
}): Promise<IPayrollSummary> => {
  if (input.scope.departmentIds?.length === 0) return { months: [], rows: [] };
  const paidAll = await loadPaid(input.monthStarts);
  if (paidAll.length === 0) return { months: [], rows: [] };

  const { allowed, employees, breakdown } = await filterScope(paidAll, input.scope);
  const paid = paidAll.filter(row => allowed.has(pairKey(row.employee_id, row.month)));
  if (paid.length === 0) return { months: [], rows: [] };
  const months = [...new Set(paid.map(row => row.month))].sort();
  const employeeIds = [...new Set(paid.map(row => row.employee_id))];

  // Объект пары: основной из разбивки, иначе — режим табелирования месяца.
  const objectByPair = new Map<string, ISummaryObject>();
  const fallbackPairs: Array<{ employeeId: number; month: string }> = [];
  for (const key of allowed) {
    const main = pickMainObject(breakdown.get(key) ?? []);
    if (main) objectByPair.set(key, main);
    else {
      const [employeeId, month] = key.split('|');
      fallbackPairs.push({ employeeId: Number(employeeId), month });
    }
  }
  const [fallbackModes, termsCategories, categoryOf] = await Promise.all([
    loadFallbackModes(fallbackPairs),
    loadTermsCategories(employeeIds, months.map(month => `${month}-01`)),
    loadStaffCategoryResolver(),
  ]);
  const pinnedIds = [...new Set([...fallbackModes.values()]
    .map(mode => (mode.mode === 'object' ? mode.pinnedObjectId : null))
    .filter((id): id is string => id !== null))];
  const breakdownObjectIds = [...new Set([...objectByPair.values()].map(object => object.key))]
    .filter(key => key !== 'office' && key !== 'unknown');
  const objectMeta = await loadObjectMeta([...new Set([...pinnedIds, ...breakdownObjectIds])]);
  for (const pair of fallbackPairs) {
    const key = pairKey(pair.employeeId, pair.month);
    objectByPair.set(key, fallbackSummaryObject(fallbackModes.get(key), objectMeta));
  }

  // Отдел месяца — и для категории, и для подписи «Отдел» (уволенный — отдел, где работал).
  const departmentByPair = new Map<string, string | null>();
  for (const key of allowed) {
    const employee = employees.get(Number(key.split('|')[0]));
    departmentByPair.set(key, pickMonthDepartment(breakdown.get(key) ?? []) ?? employee?.org_department_id ?? null);
  }
  const departmentIds = [...new Set([...departmentByPair.values()].filter((id): id is string => id !== null))];
  const departmentNames = new Map((departmentIds.length > 0
    ? await query<{ id: string; name: string }>(
      'SELECT id::text AS id, name FROM org_departments WHERE id::text = ANY($1::text[])',
      [departmentIds],
    )
    : []).map(row => [row.id, row.name]));

  const rows = new Map<string, IPayrollSummaryRow & { cents: Map<string, number> }>();
  for (const row of paid) {
    const key = pairKey(row.employee_id, row.month);
    const object = objectByPair.get(key) ?? { key: 'unknown', name: 'Не определён' };
    // Имя объекта — текущее из справочника СКУД (в разбивке — имя на момент закрытия табеля).
    const objectName = objectMeta.get(object.key)?.name?.trim() || object.name;
    const departmentId = departmentByPair.get(key) ?? null;
    const category = termsCategories.get(key) ?? categoryOf(departmentId);
    const rowKey = `${row.employee_id}|${object.key}|${category}`;
    let target = rows.get(rowKey);
    if (!target) {
      const employee = employees.get(row.employee_id);
      target = {
        employee_id: row.employee_id,
        full_name: employee?.full_name ?? '—',
        department: departmentId ? departmentNames.get(departmentId) ?? null : null,
        position: employee?.position ?? null,
        category,
        object_key: object.key,
        object_name: objectName,
        amounts: {},
        cents: new Map(),
      };
      rows.set(rowKey, target);
    }
    target.cents.set(row.item, (target.cents.get(row.item) ?? 0) + toCents(row.amount));
  }

  return {
    months,
    rows: [...rows.values()]
      .map(({ cents, ...row }) => ({
        ...row,
        amounts: Object.fromEntries([...cents].map(([item, value]) => [item, centsToAmount(value)])),
      }))
      .sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru')
        || left.full_name.localeCompare(right.full_name, 'ru')
        || left.employee_id - right.employee_id),
  };
};
