/**
 * Сотрудники ФОТ для строк ведомости выплаты из 1С (миграция 328). ФИО — не ключ интеграции (docs/openapi-1c.yaml):
 *  - автоматически — только по коду физлица 1С (id_all): ровно один DISTINCT допустимый сотрудник
 *    (employee_hr_profiles.passdesk_id_all и ранее подтверждённые строки ведомостей);
 *  - по ФИО — только кандидаты: оператор подтверждает.
 * Допустим тот, кто в месяце начисления не в подрядной организации: отдел месяца — по табелю (как «Свод»), без табеля —
 * отдел до увольнения у уволенного, иначе текущий. «Работал в месяце» и бригада — только порядок и подсказка.
 */
import { getContractorRootId } from '../../config/contractor.js';
import { query } from '../../config/postgres.js';
import { loadMonthBreakdown, monthPairKey } from './payroll-month-attribution.service.js';
import { pickMonthDepartment } from './payroll-summary.attribution.js';
import { normalizePayoutName, type IPayout1cDocument } from './payroll-1c-payouts.parser.js';

export interface IPayoutCandidate {
  employee_id: number;
  full_name: string;
  /** Отдел месяца начисления (по табелю), иначе отдел до увольнения или текущий. */
  department: string | null;
  worked_in_month: boolean;
  by_id_all: boolean;
  brigade_match: boolean;
}

export interface IPayoutLineMatch {
  /** Сотрудник по id_all — без подтверждения; null — нужен выбор оператора. */
  auto_employee_id: number | null;
  /** Допустимые кандидаты (в том числе auto) — из них оператор выбирает. */
  candidates: IPayoutCandidate[];
}

/** То же, что normalizePayoutName, в SQL. */
const SQL_NAME = (column: string): string => (
  `btrim(regexp_replace(regexp_replace(replace(lower(normalize(${column}, NFKC)), 'ё', 'е'), '\\s*-\\s*', '-', 'g'), '\\s+', ' ', 'g'))`
);

/** Ключ бригады без падежа и пометки «/закр»: «бр.Асланова А.Т.» и «бр.Асланов А.Т.» → «асла». */
export const brigadeKey = (name: string | null): string | null => {
  if (!name) return null;
  const match = /бр\.\s*([а-яa-z]+)/.exec(name.toLowerCase().replace(/ё/g, 'е'));
  return match ? match[1].slice(0, 5) : null;
};

interface IEmployeeRow {
  id: number;
  full_name: string;
  employment_status: string | null;
  hire_date: string | null;
  dismissal_date: string | null;
  org_department_id: string | null;
}

interface IEligibility {
  eligible: boolean;
  department: string | null;
  departmentNames: string[];
  workedInMonth: boolean;
}

const monthEnd = (monthStart: string): string => {
  const [year, month] = monthStart.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthStart.slice(0, 7)}-${String(last).padStart(2, '0')}`;
};

const loadContractorDepartments = async (): Promise<Set<string>> => {
  const rootId = await getContractorRootId();
  if (!rootId) return new Set();
  const rows = await query<{ id: string }>(
    'SELECT id::text AS id FROM public.get_descendant_department_ids(ARRAY[$1::uuid])',
    [rootId],
  );
  return new Set(rows.map(row => row.id));
};

/** Допустимость и отдел месяца начисления для сотрудников ids. */
export const loadPayoutEligibility = async (
  employeeIds: number[],
  periodMonth: string,
): Promise<Map<number, IEligibility & IEmployeeRow>> => {
  const result = new Map<number, IEligibility & IEmployeeRow>();
  if (employeeIds.length === 0) return result;
  const month = periodMonth.slice(0, 7);
  const [employees, breakdown, contractors, dismissals] = await Promise.all([
    query<IEmployeeRow>(
      `SELECT e.id, e.full_name, e.employment_status, e.hire_date::text AS hire_date,
              e.dismissal_date::text AS dismissal_date, e.org_department_id::text AS org_department_id
         FROM employees e WHERE e.id = ANY($1::int[])`,
      [employeeIds],
    ),
    loadMonthBreakdown([periodMonth], employeeIds),
    loadContractorDepartments(),
    query<{ employee_id: number; department_id: string | null }>(
      `SELECT DISTINCT ON (de.employee_id) de.employee_id, de.from_department_id::text AS department_id
         FROM employee_dismissal_events de
        WHERE de.cancelled = false AND de.employee_id = ANY($1::int[])
        ORDER BY de.employee_id, de.created_at DESC`,
      [employeeIds],
    ),
  ]);
  const dismissalDepartment = new Map(dismissals.map(row => [Number(row.employee_id), row.department_id]));

  const departmentIds = new Set<string>();
  const monthDepartments = new Map<number, { all: string[]; main: string | null }>();
  for (const employee of employees) {
    const id = Number(employee.id);
    const rows = breakdown.get(monthPairKey(id, month)) ?? [];
    const fromTimesheet = [...new Set(rows.map(row => row.department_id).filter((dep): dep is string => dep !== null))];
    let all = fromTimesheet;
    let main = fromTimesheet.length > 0 ? pickMonthDepartment(rows) : null;
    if (fromTimesheet.length === 0) {
      const fallback = employee.employment_status === 'fired'
        ? (dismissalDepartment.get(id) ?? employee.org_department_id)
        : employee.org_department_id;
      all = fallback ? [fallback] : [];
      main = fallback;
    }
    monthDepartments.set(id, { all, main });
    for (const dep of all) departmentIds.add(dep);
    if (employee.org_department_id) departmentIds.add(employee.org_department_id);
  }
  const names = departmentIds.size === 0 ? [] : await query<{ id: string; name: string }>(
    'SELECT id::text AS id, name FROM org_departments WHERE id = ANY($1::uuid[])',
    [[...departmentIds]],
  );
  const nameById = new Map(names.map(row => [row.id, row.name]));

  const start = periodMonth;
  const end = monthEnd(periodMonth);
  for (const employee of employees) {
    const id = Number(employee.id);
    const deps = monthDepartments.get(id) ?? { all: [], main: null };
    result.set(id, {
      ...employee,
      id,
      eligible: !deps.all.some(dep => contractors.has(dep)),
      department: deps.main ? (nameById.get(deps.main) ?? null) : null,
      departmentNames: [...deps.all, employee.org_department_id]
        .filter((dep): dep is string => dep !== null)
        .map(dep => nameById.get(dep))
        .filter((name): name is string => !!name),
      workedInMonth: (employee.hire_date === null || employee.hire_date <= end)
        && (employee.dismissal_date === null || employee.dismissal_date >= start),
    });
  }
  return result;
};

/** Сопоставление строк документа: по ключу строки — авто по id_all и допустимые кандидаты. */
export const matchPayoutLines = async (doc: IPayout1cDocument): Promise<Map<string, IPayoutLineMatch>> => {
  const idAlls = [...new Set(doc.lines.map(line => line.personIdAll).filter((id): id is string => id !== null))];
  const names = [...new Set(doc.lines.map(line => normalizePayoutName(line.fullName)))];
  const [profiles, confirmed, byName] = await Promise.all([
    idAlls.length === 0 ? [] : query<{ employee_id: number; id_all: string }>(
      `SELECT employee_id, passdesk_id_all::text AS id_all FROM employee_hr_profiles
        WHERE passdesk_id_all = ANY($1::uuid[])`,
      [idAlls],
    ),
    idAlls.length === 0 ? [] : query<{ employee_id: number; id_all: string }>(
      `SELECT DISTINCT employee_id, person_id_all::text AS id_all FROM payroll_1c_payout_lines
        WHERE person_id_all = ANY($1::uuid[]) AND employee_id IS NOT NULL AND resolution IN ('auto_id_all', 'confirmed')`,
      [idAlls],
    ),
    query<{ id: number; name_key: string }>(
      `SELECT id, ${SQL_NAME('full_name')} AS name_key FROM employees WHERE ${SQL_NAME('full_name')} = ANY($1::text[])`,
      [names],
    ),
  ]);

  const byIdAll = new Map<string, Set<number>>();
  for (const row of [...profiles, ...confirmed]) {
    const set = byIdAll.get(row.id_all) ?? new Set<number>();
    set.add(Number(row.employee_id));
    byIdAll.set(row.id_all, set);
  }
  const byNameKey = new Map<string, Set<number>>();
  for (const row of byName) {
    const set = byNameKey.get(row.name_key) ?? new Set<number>();
    set.add(Number(row.id));
    byNameKey.set(row.name_key, set);
  }
  const allIds = new Set<number>([...[...byIdAll.values()].flatMap(set => [...set]), ...byName.map(row => Number(row.id))]);
  const eligibility = await loadPayoutEligibility([...allIds], doc.periodMonth);

  const result = new Map<string, IPayoutLineMatch>();
  for (const line of doc.lines) {
    const idMatches = line.personIdAll ? (byIdAll.get(line.personIdAll) ?? new Set<number>()) : new Set<number>();
    const nameMatches = byNameKey.get(normalizePayoutName(line.fullName)) ?? new Set<number>();
    const lineBrigade = brigadeKey(line.brigade);
    const candidates: IPayoutCandidate[] = [];
    for (const id of new Set([...idMatches, ...nameMatches])) {
      const info = eligibility.get(id);
      if (!info || !info.eligible) continue;
      candidates.push({
        employee_id: id,
        full_name: info.full_name,
        department: info.department,
        worked_in_month: info.workedInMonth,
        by_id_all: idMatches.has(id),
        brigade_match: lineBrigade !== null && info.departmentNames.some(name => brigadeKey(name) === lineBrigade),
      });
    }
    candidates.sort((a, b) => (
      Number(b.by_id_all) - Number(a.by_id_all)
      || Number(b.brigade_match) - Number(a.brigade_match)
      || Number(b.worked_in_month) - Number(a.worked_in_month)
      || a.full_name.localeCompare(b.full_name, 'ru')
      || a.employee_id - b.employee_id
    ));
    const onlyId = idMatches.size === 1 ? [...idMatches][0] : null;
    const auto = onlyId !== null && eligibility.get(onlyId)?.eligible ? onlyId : null;
    result.set(line.lineKey, { auto_employee_id: auto, candidates });
  }
  return result;
};
