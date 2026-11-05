/**
 * «Свод» на «Расчётах»: за выбранные месяцы — по объектам и категориям (ИТР / Офис / Рабочие). Суммы считаются
 * автоматически (расчёт ФОТ), загруженное из 1С их заменяет (payroll-summary-calc.rules.ts). Только чтение.
 *
 * Кто попадает: кто работал в месяце, как в «Расчётах», и все, кому за месяц что-то загружено — работающие, уволенные,
 * архивные (им платили); без подрядчиков (текущий отдел или отдел подачи месяца — в поддереве подрядных организаций).
 * Человек без сумм и без причины «Не посчитано» строки не даёт. Охват пользователя: сотрудник виден, если в охвате его
 * текущий отдел или отдел его подачи за месяц.
 *
 * Объект и отдел месяца — payroll-month-attribution.service.ts (объектная разбивка закрытого табеля, иначе
 * режим табелирования месяца); категория — по табелю месяца (payroll-staff-category.ts), не из условий оплаты.
 * Объект месяца «Не определён» — строке «Свода» объект по часам месяца (payroll-summary-object.service.ts);
 * категория при этом остаётся по базовому объекту.
 */
import { performance } from 'node:perf_hooks';

import { query } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { attributeMonths, loadMonthBreakdown, monthPairKey as pairKey } from './payroll-month-attribution.service.js';
import { calcSummaryMonths, loadSummaryExtras, loadSummaryRoster } from './payroll-summary-calc.service.js';
import {
  mergeSummaryMonth,
  needsSummaryCalc,
  SUMMARY_PAYROLL_ITEM,
  type ISummaryMonthAmounts,
  type SummaryIssue,
} from './payroll-summary-calc.rules.js';
import { resolveSummaryObjects, type ISummaryObjectsStats } from './payroll-summary-object.service.js';
import { resolveMonthStaffCategories } from './payroll-staff-category.js';
import type { StaffCategory } from './payroll-terms.service.js';
import { centsToAmount, type ISummaryBreakdownRow, type ISummaryObject } from './payroll-summary.attribution.js';

export interface IPayrollSummaryScope {
  contractorRootId: string | null;
  /** Отделы охвата; null — все. */
  departmentIds: string[] | null;
}

/** Строка «Свода»: сотрудник на объекте в категории и отделе, суммы статей сложены за выбранные месяцы. */
export interface IPayrollSummaryRow {
  employee_id: number;
  full_name: string;
  /** Отдел месяца: по нему фильтр «Свода». */
  department_id: string | null;
  department: string | null;
  position: string | null;
  category: StaffCategory;
  object_key: string;
  object_name: string;
  /** Статья → сумма (NUMERIC строкой, может быть 0 или отрицательной). Статьи без сумм нет. */
  amounts: Record<string, string>;
  /** Что не посчитано хотя бы за один из месяцев строки; пусто — всё посчитано. */
  issues: SummaryIssue[];
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
  candidates: ReadonlyArray<{ employee_id: number; month: string }>,
  scope: IPayrollSummaryScope,
): Promise<{
  allowed: Set<string>;
  employees: Map<number, IEmployeeRow>;
  breakdown: Map<string, ISummaryBreakdownRow[]>;
}> => {
  const employeeIds = [...new Set(candidates.map(row => row.employee_id))];
  const monthStarts = [...new Set(candidates.map(row => `${row.month}-01`))];
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
  for (const key of new Set(candidates.map(row => pairKey(row.employee_id, row.month)))) {
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
 * Время шагов «Свода», мс (монотонный таймер), и счётчики — для Server-Timing и лога: по ним видно, какой шаг
 * медленный. Логику не меняет.
 */
export interface IPayrollSummaryTiming extends ISummaryObjectsStats {
  paidMs: number;
  paidRows: number;
  rosterMs: number;
  scopeMs: number;
  pairs: number;
  /** Расчёт ФОТ: время и скольким считали (пар сотрудник + месяц). */
  calcMs: number;
  calcEmployees: number;
  attributionMs: number;
  categoriesMs: number;
  objectsMs: number;
  buildMs: number;
  totalMs: number;
}

export const emptySummaryTiming = (): IPayrollSummaryTiming => ({
  paidMs: 0, paidRows: 0, rosterMs: 0, scopeMs: 0, pairs: 0, calcMs: 0, calcEmployees: 0, attributionMs: 0, categoriesMs: 0,
  objectsMs: 0, unknown: 0, byMode: 0, hoursEmployees: 0, hoursMs: 0, buildMs: 0, totalMs: 0,
});

/** «Свод» дольше — строка в лог. */
const SUMMARY_LOG_THRESHOLD_MS = 2000;

const ms = (value: number): string => `${Math.round(value)} мс`;

export const formatSummaryTiming = (monthStarts: string[] | null, timing: IPayrollSummaryTiming): string => (
  `${monthStarts ? monthStarts.map(month => month.slice(0, 7)).join(',') : 'все месяцы'}: `
  + `суммы 1С ${ms(timing.paidMs)} (${timing.paidRows} строк), состав ${ms(timing.rosterMs)}, `
  + `охват ${ms(timing.scopeMs)} (${timing.pairs} пар), расчёт ФОТ ${ms(timing.calcMs)} (${timing.calcEmployees} чел.), `
  + `объект месяца ${ms(timing.attributionMs)}, категории ${ms(timing.categoriesMs)}, `
  + `объект по часам ${ms(timing.objectsMs)} (не определён ${timing.unknown}, по режиму ${timing.byMode}, `
  + `по часам ${timing.hoursEmployees} чел. за ${ms(timing.hoursMs)}), сборка ${ms(timing.buildMs)}; всего ${ms(timing.totalMs)}`
);

/** Server-Timing «Свода»: шаги по порядку, в desc — счётчики. */
export const summaryServerTiming = (timing: IPayrollSummaryTiming): string => [
  `summary_paid;dur=${timing.paidMs.toFixed(1)};desc="${timing.paidRows}"`,
  `summary_roster;dur=${timing.rosterMs.toFixed(1)}`,
  `summary_scope;dur=${timing.scopeMs.toFixed(1)};desc="${timing.pairs}"`,
  `summary_calc;dur=${timing.calcMs.toFixed(1)};desc="${timing.calcEmployees}"`,
  `summary_attribution;dur=${timing.attributionMs.toFixed(1)}`,
  `summary_categories;dur=${timing.categoriesMs.toFixed(1)}`,
  `summary_objects;dur=${timing.objectsMs.toFixed(1)};desc="${timing.unknown}/${timing.byMode}/${timing.hoursEmployees}"`,
  `summary_hours;dur=${timing.hoursMs.toFixed(1)}`,
  `summary_build;dur=${timing.buildMs.toFixed(1)}`,
  `summary_total;dur=${timing.totalMs.toFixed(1)}`,
].join(', ');

/**
 * «Свод» за месяцы monthStarts (первые числа; null — все месяцы с суммами 1С): строки по (сотрудник, объект, категория,
 * отдел), суммы статей сложены за месяцы — в копейках, без потерь на дробях. req — расчёту ФОТ (доли бригад). timing —
 * время шагов (Server-Timing); всего дольше SUMMARY_LOG_THRESHOLD_MS — строка в лог.
 */
export const loadPayrollSummary = async (input: {
  scope: IPayrollSummaryScope;
  monthStarts: string[] | null;
  req: AuthenticatedRequest;
  timing?: IPayrollSummaryTiming;
}): Promise<IPayrollSummary> => {
  const timing = input.timing ?? emptySummaryTiming();
  const started = performance.now();
  try {
    return await buildSummary(input.scope, input.monthStarts, input.req, timing);
  } finally {
    timing.totalMs = performance.now() - started;
    if (timing.totalMs > SUMMARY_LOG_THRESHOLD_MS) {
      console.log(`[payroll-summary] ${formatSummaryTiming(input.monthStarts, timing)}`);
    }
  }
};

const buildSummary = async (
  scope: IPayrollSummaryScope,
  monthStarts: string[] | null,
  req: AuthenticatedRequest,
  timing: IPayrollSummaryTiming,
): Promise<IPayrollSummary> => {
  let mark = performance.now();
  const lap = (key: 'paidMs' | 'rosterMs' | 'scopeMs' | 'calcMs' | 'attributionMs' | 'categoriesMs' | 'objectsMs' | 'buildMs'): void => {
    const now = performance.now();
    timing[key] += now - mark;
    mark = now;
  };
  if (scope.departmentIds?.length === 0) return { months: [], rows: [] };
  const paidAll = await loadPaid(monthStarts);
  timing.paidRows = paidAll.length;
  lap('paidMs');
  // Без выбора («весь период») — месяцы, за которые есть суммы 1С: считать все прошлые месяцы незачем.
  const selectedMonths = monthStarts
    ? monthStarts.map(month => month.slice(0, 7))
    : [...new Set(paidAll.map(row => row.month))].sort();
  if (selectedMonths.length === 0) return { months: [], rows: [] };

  const [roster, extras] = await Promise.all([
    loadSummaryRoster(selectedMonths, scope.contractorRootId),
    loadSummaryExtras(selectedMonths),
  ]);
  lap('rosterMs');

  const candidates = [
    ...paidAll.map(row => ({ employee_id: row.employee_id, month: row.month })),
    ...[...roster].flatMap(([month, ids]) => ids.map(id => ({ employee_id: id, month }))),
    ...[...extras.oneTime.keys(), ...extras.deductions.keys()].map(key => {
      const [employeeId, month] = key.split('|');
      return { employee_id: Number(employeeId), month };
    }),
  ];
  if (candidates.length === 0) return { months: [], rows: [] };
  const { allowed, employees, breakdown } = await filterScope(candidates, scope);
  timing.pairs = allowed.size;
  lap('scopeMs');
  if (allowed.size === 0) return { months: [], rows: [] };

  // Суммы 1С пары: статья → сумма. Строки одной статьи за месяц одна (ключ таблицы).
  const paidByPair = new Map<string, Map<string, string>>();
  for (const row of paidAll) {
    const key = pairKey(row.employee_id, row.month);
    if (!allowed.has(key)) continue;
    const items = paidByPair.get(key);
    if (items) items.set(row.item, row.amount);
    else paidByPair.set(key, new Map([[row.item, row.amount]]));
  }

  // Расчёт — только у кого нет зарплаты 1С.
  const calcCandidates = new Map<string, number[]>();
  for (const key of allowed) {
    if (!needsSummaryCalc(paidByPair.get(key))) continue;
    const [employeeId, month] = key.split('|');
    const list = calcCandidates.get(month);
    if (list) list.push(Number(employeeId));
    else calcCandidates.set(month, [Number(employeeId)]);
  }
  const payrollLoadedMonths = new Set(paidAll.filter(row => row.item === SUMMARY_PAYROLL_ITEM).map(row => row.month));
  const { calcs, employees: calcEmployees } = await calcSummaryMonths(calcCandidates, payrollLoadedMonths, req);
  timing.calcEmployees = calcEmployees;
  lap('calcMs');

  const amountsByPair = new Map<string, ISummaryMonthAmounts>();
  for (const key of allowed) {
    const amounts = mergeSummaryMonth({
      paid: paidByPair.get(key) ?? new Map(),
      calc: calcs.get(key),
      oneTime: extras.oneTime.get(key) ?? [],
      deductions: extras.deductions.get(key) ?? [],
    });
    if (amounts.visible) amountsByPair.set(key, amounts);
  }
  if (amountsByPair.size === 0) return { months: [], rows: [] };

  // Объект, отдел и режим месяца пары; категория — по табелю месяца.
  const pairs = [...amountsByPair.keys()].map(key => {
    const [employeeId, month] = key.split('|');
    return { employeeId: Number(employeeId), month };
  });
  const months = [...new Set(pairs.map(pair => pair.month))].sort();
  const attribution = await attributeMonths(pairs, breakdown, employees);
  lap('attributionMs');
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
  lap('categoriesMs');
  // Объект строки, где базовый «Не определён»: режим месяца, затем часы. Категорию не меняет.
  const summaryObjects = await resolveSummaryObjects(attribution, undefined, timing);
  lap('objectsMs');

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

  const rows = new Map<string, Omit<IPayrollSummaryRow, 'issues'> & { cents: Map<string, number>; issueSet: Set<SummaryIssue> }>();
  for (const pair of pairs) {
    const key = pairKey(pair.employeeId, pair.month);
    const item = attribution.get(key);
    const object: ISummaryObject = summaryObjects.get(key) ?? item?.object ?? { key: 'unknown', name: 'Не определён' };
    const departmentId = item?.departmentId ?? null;
    const category: StaffCategory = categoryByPair.get(key) ?? 'office';
    // Отдел в ключе: сменивший отдел за выбранные месяцы — по строке на отдел, иначе фильтр потерял бы второй.
    const rowKey = `${pair.employeeId}|${object.key}|${category}|${departmentId ?? ''}`;
    let target = rows.get(rowKey);
    if (!target) {
      const employee = employees.get(pair.employeeId);
      target = {
        employee_id: pair.employeeId,
        full_name: employee?.full_name ?? '—',
        department_id: departmentId,
        department: departmentId ? departmentNames.get(departmentId) ?? null : null,
        position: employee?.position ?? null,
        category,
        object_key: object.key,
        object_name: object.name,
        amounts: {},
        cents: new Map(),
        issueSet: new Set(),
      };
      rows.set(rowKey, target);
    }
    const amounts = amountsByPair.get(key)!;
    for (const [itemCode, value] of amounts.cents) target.cents.set(itemCode, (target.cents.get(itemCode) ?? 0) + value);
    for (const issue of amounts.issues) target.issueSet.add(issue);
  }

  lap('buildMs');
  return {
    months,
    rows: [...rows.values()]
      .map(({ cents, issueSet, ...row }) => ({
        ...row,
        amounts: Object.fromEntries([...cents].map(([item, value]) => [item, centsToAmount(value)])),
        issues: [...issueSet],
      }))
      .sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru')
        || left.full_name.localeCompare(right.full_name, 'ru')
        || left.employee_id - right.employee_id),
  };
};
