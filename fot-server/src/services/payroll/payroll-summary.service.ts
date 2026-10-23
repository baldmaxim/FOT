/**
 * «Свод» на «Расчётах»: суммы «Оплачено» (ЗУП, payroll_paid_amounts) за выбранные месяцы — по объектам и
 * категориям (ИТР / Офис / Рабочие). Только чтение.
 *
 * Кто попадает: все, кому за месяц есть суммы — работающие, уволенные, архивные (им платили); без
 * подрядчиков (текущий отдел или отдел подачи месяца — в поддереве подрядных организаций). Охват
 * пользователя: сотрудник виден, если в охвате его текущий отдел или отдел его подачи за месяц.
 *
 * Объект и отдел месяца — payroll-month-attribution.service.ts (объектная разбивка закрытого табеля, иначе
 * режим табелирования месяца); категория — по табелю месяца (payroll-staff-category.ts), не из условий оплаты.
 * Объект месяца «Не определён» — строке «Свода» объект по часам месяца (payroll-summary-object.service.ts);
 * категория при этом остаётся по базовому объекту.
 */
import { query } from '../../config/postgres.js';
import { attributeMonths, loadMonthBreakdown, monthPairKey as pairKey } from './payroll-month-attribution.service.js';
import { resolveSummaryObjects } from './payroll-summary-object.service.js';
import { resolveMonthStaffCategories } from './payroll-staff-category.js';
import type { StaffCategory } from './payroll-terms.service.js';
import { centsToAmount, toCents, type ISummaryBreakdownRow, type ISummaryObject } from './payroll-summary.attribution.js';

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

interface IEmployeeRow {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  employment_status: string | null;
  position: string | null;
}

const loadPaid = (monthStarts: string[] | null): Promise<IPaidRow[]> => query<IPaidRow>(
  `SELECT p.employee_id, to_char(p.month, 'YYYY-MM') AS month, p.item_code AS item, p.amount::text AS amount
     FROM payroll_paid_amounts p
    WHERE $1::date[] IS NULL OR p.month = ANY($1::date[])
    ORDER BY p.employee_id, p.month, p.item_code`,
  [monthStarts],
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
  const [employees, breakdown, contractors] = await Promise.all([
    query<IEmployeeRow>(
      `SELECT e.id, e.full_name, e.org_department_id::text AS org_department_id, e.employment_status,
              p.name AS position
         FROM employees e
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE e.id = ANY($1::int[])`,
      [employeeIds],
    ),
    loadMonthBreakdown(monthStarts, employeeIds),
    loadContractorDepartments(scope.contractorRootId),
  ]);

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

  // Объект, отдел и режим месяца пары; категория — по табелю месяца.
  const pairs = [...allowed].map(key => {
    const [employeeId, month] = key.split('|');
    return { employeeId: Number(employeeId), month };
  });
  const attribution = await attributeMonths(pairs, breakdown, employees);
  const categories = await resolveMonthStaffCategories(pairs.map(pair => {
    const item = attribution.get(pairKey(pair.employeeId, pair.month));
    return {
      employeeId: pair.employeeId,
      monthStart: `${pair.month}-01`,
      officeObject: item?.object.key === 'office',
      departmentId: item?.departmentId ?? null,
      mode: item?.mode,
    };
  }));
  const categoryByPair = new Map(pairs.map((pair, index) => [pairKey(pair.employeeId, pair.month), categories[index]]));
  // Объект строки, где базовый «Не определён»: режим месяца, затем часы. Категорию не меняет.
  const summaryObjects = await resolveSummaryObjects(attribution);

  // Отдел месяца — и для категории, и для подписи «Отдел» (уволенный — отдел, где работал).
  const departmentIds = [...new Set([...attribution.values()]
    .map(item => item.departmentId)
    .filter((id): id is string => id !== null))];
  const departmentNames = new Map((departmentIds.length > 0
    ? await query<{ id: string; name: string }>(
      'SELECT id::text AS id, name FROM org_departments WHERE id::text = ANY($1::text[])',
      [departmentIds],
    )
    : []).map(row => [row.id, row.name]));

  const rows = new Map<string, IPayrollSummaryRow & { cents: Map<string, number> }>();
  for (const row of paid) {
    const key = pairKey(row.employee_id, row.month);
    const item = attribution.get(key);
    const object: ISummaryObject = summaryObjects.get(key) ?? item?.object ?? { key: 'unknown', name: 'Не определён' };
    const departmentId = item?.departmentId ?? null;
    const category: StaffCategory = categoryByPair.get(key) ?? 'office';
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
        object_name: object.name,
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
