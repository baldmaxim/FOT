/**
 * Столбец «Участок» в «Управлении кадрами»: начальники участка сотрудника по тем же связям,
 * что список «Табель → По участкам» (loadSiteSupervisorLinks).
 *
 * Индекс строится в TS одним запросом и передаётся в SQL параметрами (как «Признак» —
 * id отделов «Декрет»): коррелированный подзапрос по employee_department_access на всю
 * выборку сотрудников слишком медленный. Один индекс на HTTP-запрос (createStaffSqlContext) —
 * сортировка, фильтр и ячейка считаются по одному состоянию назначений.
 */
import { formatNameWithInitials } from '../utils/fio.utils.js';
import { loadSiteSupervisorLinks, type ISiteSupervisorLinks } from './site-supervisor-links.service.js';

export interface IStaffSiteSupervisor {
  id: number;
  /** «Фамилия И. О.» — как в списке «По участкам». */
  label: string;
}

export interface IStaffSiteIndex {
  /** Отдел → закреплённые за ним начальники участка. */
  byDepartment: Map<string, IStaffSiteSupervisor[]>;
  /** Лично назначенный сотрудник → его начальники вместе с начальниками его текущего отдела. */
  byDirectEmployee: Map<number, IStaffSiteSupervisor[]>;
  /** Лично назначенный → только личные начальники (без отдела): для фасетов. */
  directOnly: Map<number, IStaffSiteSupervisor[]>;
}

const compareSupervisors = (a: IStaffSiteSupervisor, b: IStaffSiteSupervisor): number =>
  a.label.localeCompare(b.label, 'ru') || a.id - b.id;

/** Добавляет начальника в список ключа: дубли — по id; пустое ФИО не показывается. */
function addSupervisor<K>(map: Map<K, IStaffSiteSupervisor[]>, key: K, id: number, fullName: string | null): void {
  if (!Number.isFinite(id)) return;
  const label = formatNameWithInitials(String(fullName ?? ''));
  if (!label) return;
  const list = map.get(key);
  if (!list) {
    map.set(key, [{ id, label }]);
  } else if (!list.some(item => item.id === id)) {
    list.push({ id, label });
  }
}

export function buildStaffSiteIndex(links: ISiteSupervisorLinks): IStaffSiteIndex {
  const byDepartment = new Map<string, IStaffSiteSupervisor[]>();
  for (const row of links.departmentLinks) {
    if (typeof row.department_id !== 'string' || !row.department_id) continue;
    addSupervisor(byDepartment, row.department_id, Number(row.employee_id), row.full_name);
  }

  const directOnly = new Map<number, IStaffSiteSupervisor[]>();
  const departmentOfDirect = new Map<number, string | null>();
  for (const row of links.directLinks) {
    const directId = Number(row.direct_employee_id);
    if (!Number.isFinite(directId)) continue;
    addSupervisor(directOnly, directId, Number(row.leader_employee_id), row.leader_full_name);
    departmentOfDirect.set(directId, row.direct_department_id ?? null);
  }

  const byDirectEmployee = new Map<number, IStaffSiteSupervisor[]>();
  for (const [employeeId, own] of directOnly) {
    const departmentId = departmentOfDirect.get(employeeId);
    const merged = [...(departmentId ? byDepartment.get(departmentId) ?? [] : [])];
    for (const supervisor of own) {
      if (!merged.some(item => item.id === supervisor.id)) merged.push(supervisor);
    }
    byDirectEmployee.set(employeeId, merged);
  }

  for (const list of [...byDepartment.values(), ...directOnly.values(), ...byDirectEmployee.values()]) {
    list.sort(compareSupervisors);
  }
  return { byDepartment, byDirectEmployee, directOnly };
}

export async function loadStaffSiteIndex(): Promise<IStaffSiteIndex> {
  return buildStaffSiteIndex(await loadSiteSupervisorLinks());
}

/** Контекст SQL «Текущих сотрудников» на один HTTP-запрос: индекс участков грузится не больше раза. */
export interface IStaffSqlContext {
  siteIndex: () => Promise<IStaffSiteIndex>;
}

export function createStaffSqlContext(): IStaffSqlContext {
  let pending: Promise<IStaffSiteIndex> | null = null;
  return {
    siteIndex: () => {
      pending ??= loadStaffSiteIndex();
      return pending;
    },
  };
}

const joinLabels = (list: readonly IStaffSiteSupervisor[]): string => list.map(item => item.label).join(', ');

/** Текст ячейки «Участок»; null — сотрудник ни к одному участку не относится. */
export function staffSiteLabel(index: IStaffSiteIndex, employeeId: number, departmentId: string | null): string | null {
  const list = index.byDirectEmployee.get(employeeId)
    ?? (departmentId ? index.byDepartment.get(departmentId) : undefined);
  return list && list.length > 0 ? joinLabels(list) : null;
}

/**
 * Ключ сортировки — ровно текст ячейки (staffSiteLabel): сначала личное назначение,
 * иначе по текущему отделу сотрудника. Таблица employees без алиаса.
 */
export function buildStaffSiteKeySql(index: IStaffSiteIndex, params: unknown[]): string {
  const directIds: number[] = [];
  const directLabels: string[] = [];
  for (const [employeeId, list] of index.byDirectEmployee) {
    directIds.push(employeeId);
    directLabels.push(joinLabels(list));
  }
  const departmentIds: string[] = [];
  const departmentLabels: string[] = [];
  for (const [departmentId, list] of index.byDepartment) {
    departmentIds.push(departmentId);
    departmentLabels.push(joinLabels(list));
  }
  params.push(directIds, directLabels, departmentIds, departmentLabels);
  const base = params.length - 3;
  return `COALESCE(
    (SELECT s.label FROM unnest($${base}::int[], $${base + 1}::text[]) AS s(id, label) WHERE s.id = employees.id),
    (SELECT s.label FROM unnest($${base + 2}::uuid[], $${base + 3}::text[]) AS s(id, label) WHERE s.id = employees.org_department_id)
  )`;
}

/**
 * Фильтр по отдельным начальникам: сотрудник подходит, если среди его начальников есть выбранное
 * имя (у отдела двух начальников человек попадает под каждого). null — «Без участка».
 */
export function buildStaffSiteFilterSql(
  index: IStaffSiteIndex,
  values: ReadonlyArray<string | null>,
  params: unknown[],
): string {
  const names = new Set(values.filter((value): value is string => value !== null));
  const parts: string[] = [];
  if (names.size > 0) {
    const matches = (list: readonly IStaffSiteSupervisor[]): boolean => list.some(item => names.has(item.label));
    const departmentIds = [...index.byDepartment].filter(([, list]) => matches(list)).map(([id]) => id);
    const employeeIds = [...index.byDirectEmployee].filter(([, list]) => matches(list)).map(([id]) => id);
    params.push(departmentIds, employeeIds);
    parts.push(`(employees.org_department_id = ANY($${params.length - 1}::uuid[]) OR employees.id = ANY($${params.length}::int[]))`);
  }
  if (values.includes(null)) parts.push(`${buildStaffSiteKeySql(index, params)} IS NULL`);
  return `(${parts.join(' OR ')})`;
}

/**
 * LATERAL-подзапрос «имена начальников строки» для вариантов фильтра: по строке на начальника,
 * без строк — сотрудник без участка (LEFT JOIN даёт NULL). Колонка — site.label.
 */
export function buildStaffSiteFacetJoinSql(index: IStaffSiteIndex, params: unknown[]): string {
  const departmentIds: string[] = [];
  const departmentLabels: string[] = [];
  for (const [departmentId, list] of index.byDepartment) {
    for (const item of list) {
      departmentIds.push(departmentId);
      departmentLabels.push(item.label);
    }
  }
  const directIds: number[] = [];
  const directLabels: string[] = [];
  for (const [employeeId, list] of index.directOnly) {
    for (const item of list) {
      directIds.push(employeeId);
      directLabels.push(item.label);
    }
  }
  params.push(departmentIds, departmentLabels, directIds, directLabels);
  const base = params.length - 3;
  return `LEFT JOIN LATERAL (
      SELECT p.label FROM unnest($${base}::uuid[], $${base + 1}::text[]) AS p(id, label) WHERE p.id = employees.org_department_id
      UNION
      SELECT p.label FROM unnest($${base + 2}::int[], $${base + 3}::text[]) AS p(id, label) WHERE p.id = employees.id
    ) site ON true`;
}
