/**
 * Выгрузка «Управление кадрами → Экспорт сотрудников»: выборка людей по скоупу
 * пользователя и раскладка по разделам (СМ, СУ-10, Бригады, Подрядные, Прочие).
 *
 * Охват: все работающие + уволенные в периоде выгрузки, в пределах прав.
 * Фильтры экрана (отдел, поиск, график, статус) на выгрузку не влияют.
 */
import { query } from '../config/postgres.js';
import { CONTRACTOR_ROOT_NAME } from '../config/contractor.js';
import { isInMaternityDepartment, normalizeDepartmentName } from '../utils/employee-sign.js';
import type { IEmployeeScopeFilter } from './employee-scope-filter.service.js';

/** Предел строк: защита от случайной выгрузки на сотни тысяч человек. */
export const MAX_EXPORT_EMPLOYEES = 50000;

/** Корни компаний (те же id — employee-induction.service, patent-missing-receipts.service). */
const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const BRIGADES_ROOT_NAME = 'бригады';

export interface IExportPeriod {
  /** YYYY-MM-DD, включительно. */
  start: string;
  /** YYYY-MM-DD, включительно. */
  end: string;
}

export interface IExportEmployeeRow {
  id: number;
  full_name: string;
  employment_status: 'active' | 'fired';
  /** YYYY-MM-DD или null. */
  birth_date: string | null;
  /** YYYY-MM-DD или null. */
  hire_date: string | null;
  position_name: string | null;
  /** Уволенный — отдел до увольнения, иначе текущий. */
  effective_department_id: string | null;
  /**
   * Попал в выгрузку через отдел скоупа (а не только как прямой подчинённый).
   * Единственный источник истины — SQL; сборка разделов его не пересчитывает.
   */
  in_department_scope: boolean;
}

export interface IExportDepartmentRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind?: string | null;
}

export type ExportSectionKey = 'sm' | 'su10' | 'brigades' | 'contractors' | 'other';

export type ExportSign = 'Работает' | 'Уволен' | 'Декрет';

export interface IExportFlatRow {
  employeeId: number;
  fullName: string;
  departmentPath: string;
  positionName: string;
  birthDate: string | null;
  hireDate: string | null;
  objectName: string;
  sign: ExportSign;
  costItem: string;
}

export interface IExportSection {
  key: ExportSectionKey;
  title: string;
  tableName: string;
  rows: IExportFlatRow[];
}

const SECTION_DEFS: ReadonlyArray<{ key: ExportSectionKey; title: string; tableName: string }> = [
  { key: 'sm', title: 'СМ', tableName: 'Employees_SM' },
  { key: 'su10', title: 'СУ-10', tableName: 'Employees_SU10' },
  { key: 'brigades', title: 'Бригады', tableName: 'Employees_Brigades' },
  { key: 'contractors', title: 'Подрядные организации', tableName: 'Employees_Contractors' },
  { key: 'other', title: 'Прочие', tableName: 'Employees_Other' },
];

export class EmployeesExportError extends Error {
  constructor(public readonly code: 'NO_DATA' | 'EXPORT_TOO_LARGE', message: string) {
    super(message);
    this.name = 'EmployeesExportError';
  }
}

/**
 * Отдел сотрудника для раздела: уволенный — отдел из последнего неотменённого события
 * увольнения, где он заполнен, иначе текущий. employeeAlias — алиас таблицы employees.
 */
export const effectiveDepartmentSql = (employeeAlias: string): string =>
  `(CASE WHEN ${employeeAlias}.employment_status = 'fired'
         THEN COALESCE((
           SELECT d.from_department_id
             FROM employee_dismissal_events d
            WHERE d.employee_id = ${employeeAlias}.id
              AND d.from_department_id IS NOT NULL
              AND d.cancelled IS NOT TRUE
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT 1
         ), ${employeeAlias}.org_department_id)
         ELSE ${employeeAlias}.org_department_id
    END)`;

/**
 * Только признак «попал через отдел скоупа» (без условия отбора): режим departments —
 * отдел в скоупе, иначе TRUE, none — FALSE. Параметры — лишь те, что попали в SQL
 * (неиспользуемый $n PostgreSQL не принимает).
 */
export function buildInDepartmentScopeOnlySql(
  scope: IEmployeeScopeFilter,
  effectiveDepartmentExpr: string,
  params: unknown[],
): string {
  if (scope.mode === 'none') return 'FALSE';
  if (scope.mode !== 'departments') return 'TRUE';
  params.push(scope.departmentIds);
  return `(${effectiveDepartmentExpr} IS NOT NULL AND ${effectiveDepartmentExpr} = ANY($${params.length}::uuid[]))`;
}

/**
 * SQL скоупа выгрузки. scopeCondition — кто попадает в выборку; inDepartmentScope — попал
 * ли через отдел скоупа (иначе раздел «Прочие», см. buildExportSections). Режим departments:
 * отдел скоупа или прямой подчинённый; прочие режимы — все, кто прошёл скоуп, «в отделе».
 * Параметры дописываются в params.
 */
export function buildInDepartmentScopeSql(
  scope: IEmployeeScopeFilter,
  exprs: { effectiveDepartmentExpr: string; employeeIdExpr: string },
  params: unknown[],
): { scopeCondition: string; inDepartmentScope: string } {
  const { effectiveDepartmentExpr: dept, employeeIdExpr: empId } = exprs;
  if (scope.mode === 'none') return { scopeCondition: 'FALSE', inDepartmentScope: 'FALSE' };
  if (scope.mode === 'self') {
    params.push(scope.selfEmployeeId);
    return { scopeCondition: `(${empId} = $${params.length})`, inDepartmentScope: 'TRUE' };
  }
  if (scope.mode === 'departments') {
    const inDepartmentScope = buildInDepartmentScopeOnlySql(scope, dept, params);
    if (scope.directEmployeeIds.length > 0) {
      params.push(scope.directEmployeeIds);
      return {
        scopeCondition: `(${inDepartmentScope} OR ${empId} = ANY($${params.length}::int[]))`,
        inDepartmentScope,
      };
    }
    return { scopeCondition: `(${inDepartmentScope})`, inDepartmentScope };
  }
  if (scope.mode === 'employees') {
    params.push(scope.directEmployeeIds);
    return { scopeCondition: `(${empId} = ANY($${params.length}::int[]))`, inDepartmentScope: 'TRUE' };
  }
  return { scopeCondition: 'TRUE', inDepartmentScope: 'TRUE' };
}

/**
 * Сотрудники по скоупу за период. mode='none' — запрос не выполняется вовсе.
 * Условие скоупа целиком в скобках и стоит через AND после фильтра статуса,
 * поэтому уволенные вне периода не проходят ни через одну ветку скоупа.
 */
export async function loadExportEmployees(
  scope: IEmployeeScopeFilter,
  period: IExportPeriod,
): Promise<IExportEmployeeRow[]> {
  if (scope.mode === 'none') return [];

  const params: unknown[] = [period.start, period.end];
  const { scopeCondition, inDepartmentScope } = buildInDepartmentScopeSql(
    scope,
    { effectiveDepartmentExpr: 'b.effective_department_id', employeeIdExpr: 'b.id' },
    params,
  );

  params.push(MAX_EXPORT_EMPLOYEES + 1);
  const rows = await query<IExportEmployeeRow>(
    `WITH base AS (
       SELECT e.id,
              e.full_name,
              e.employment_status,
              to_char(e.birth_date, 'YYYY-MM-DD') AS birth_date,
              to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date,
              p.name AS position_name,
              ${effectiveDepartmentSql('e')} AS effective_department_id
         FROM employees e
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE e.is_archived = false
          AND (
            e.employment_status = 'active'
            OR (e.employment_status = 'fired' AND e.dismissal_date BETWEEN $1::date AND $2::date)
          )
     )
     SELECT b.id, b.full_name, b.employment_status, b.birth_date, b.hire_date,
            b.position_name, b.effective_department_id,
            ${inDepartmentScope} AS in_department_scope
       FROM base b
      WHERE ${scopeCondition}
      ORDER BY b.full_name, b.id
      LIMIT $${params.length}`,
    params,
  );

  if (rows.length > MAX_EXPORT_EMPLOYEES) {
    throw new EmployeesExportError(
      'EXPORT_TOO_LARGE',
      `Слишком много сотрудников для выгрузки (более ${MAX_EXPORT_EMPLOYEES}).`,
    );
  }
  return rows;
}

/** Все подразделения, включая неактивные: у уволенных отдел мог уже закрыться. */
export async function loadExportDepartments(): Promise<IExportDepartmentRow[]> {
  return query<IExportDepartmentRow>('SELECT id, parent_id, name, kind FROM org_departments');
}

const collator = new Intl.Collator('ru');

const normalizeName = normalizeDepartmentName;

/** Синтетический корень структуры («Объект»), под которым лежат компании. */
const isTechnicalRoot = (dept: IExportDepartmentRow): boolean =>
  dept.parent_id === null && dept.kind === 'object';

function sectionKeyForTopNode(dept: IExportDepartmentRow): ExportSectionKey {
  if (dept.id === SM_ROOT_ID) return 'sm';
  if (dept.id === SU10_ROOT_ID) return 'su10';
  const name = normalizeName(dept.name);
  if (name === BRIGADES_ROOT_NAME) return 'brigades';
  if (name === CONTRACTOR_ROOT_NAME) return 'contractors';
  return 'other';
}

export interface IBuildSectionsParams {
  employees: IExportEmployeeRow[];
  departments: IExportDepartmentRow[];
  /** employee_id → название основного объекта за период. */
  mainObjectByEmployee: Map<number, string>;
  /** employee_id → статья затрат. */
  costItemByEmployee?: Map<number, string>;
}

export interface IDeptPlacement {
  section: ExportSectionKey;
  path: string;
  isMaternity: boolean;
}

/** Разделы, которые можно выбрать фильтром «Управления кадрами» («Прочие» — только во «Все»). */
export const FILTERABLE_SECTION_KEYS: readonly ExportSectionKey[] = ['sm', 'su10', 'brigades', 'contractors'];

export const isFilterableSectionKey = (value: unknown): value is ExportSectionKey =>
  typeof value === 'string' && (FILTERABLE_SECTION_KEYS as readonly string[]).includes(value);

/**
 * Раздел и путь отдела. Раздел — по верхнему узлу цепочки предков (ребёнок корня «Объект»),
 * бригады внутри СМ/СУ-10 — отдельный раздел. Результат кэшируется по отделу.
 */
export function createDepartmentPlacer(departments: IExportDepartmentRow[]): {
  byId: Map<string, IExportDepartmentRow>;
  place: (deptId: string) => IDeptPlacement;
} {
  const byId = new Map<string, IExportDepartmentRow>();
  for (const dept of departments) byId.set(dept.id, dept);

  const placementCache = new Map<string, IDeptPlacement>();

  const placeDepartment = (deptId: string): IDeptPlacement => {
    const cached = placementCache.get(deptId);
    if (cached) return cached;

    // Цепочка от отдела вверх до компании, без технического корня.
    const chain: IExportDepartmentRow[] = [];
    const seen = new Set<string>();
    let current = byId.get(deptId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (isTechnicalRoot(current)) break;
      chain.push(current);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }

    const top = chain[chain.length - 1];
    const topSection = top ? sectionKeyForTopNode(top) : 'other';

    // Бригады в структуре лежат внутри компаний (СУ-10 → Строительный участок →
    // Бригады → бр.…), поэтому раздел определяется по бригаде в цепочке, а не по корню.
    const brigadeFolderIndex = chain.findIndex(dept => normalizeName(dept.name) === BRIGADES_ROOT_NAME);
    const isBrigade = (topSection === 'sm' || topSection === 'su10')
      && (brigadeFolderIndex >= 0 || chain.some(dept => dept.kind === 'brigade'));
    const section: ExportSectionKey = isBrigade ? 'brigades' : topSection;

    // В известных разделах название компании — это имя листа, в пути не дублируем.
    // У бригад путь начинается под папкой «Бригады», если она есть.
    const pathNodes = section === 'other'
      ? chain
      : isBrigade && brigadeFolderIndex >= 0
        ? chain.slice(0, brigadeFolderIndex)
        : chain.slice(0, -1);
    const path = pathNodes
      .reverse()
      .map(dept => dept.name || '(без названия)')
      .join(' / ');
    const isMaternity = isInMaternityDepartment(deptId, byId);

    const placement = { section, path, isMaternity };
    placementCache.set(deptId, placement);
    return placement;
  };

  return { byId, place: placeDepartment };
}

/**
 * Итоговое размещение сотрудника: неизвестный/пустой отдел — «Прочие»; прямой подчинённый
 * из отдела вне скоупа — «Прочие» без пути (ветку его отдела не раскрываем).
 */
export function placeEmployee(
  placer: ReturnType<typeof createDepartmentPlacer>,
  effectiveDepartmentId: string | null,
  inDepartmentScope: boolean,
): IDeptPlacement {
  const known = effectiveDepartmentId !== null && placer.byId.has(effectiveDepartmentId);
  const placement: IDeptPlacement = known
    ? placer.place(effectiveDepartmentId)
    : { section: 'other', path: '', isMaternity: false };
  return inDepartmentScope
    ? placement
    : { section: 'other', path: '', isMaternity: placement.isMaternity };
}

/** Отделы (включая неактивные), чей раздел — section. */
export function listSectionDepartmentIds(
  departments: IExportDepartmentRow[],
  section: ExportSectionKey,
): string[] {
  const placer = createDepartmentPlacer(departments);
  return departments.filter(dept => placer.place(dept.id).section === section).map(dept => dept.id);
}

/**
 * Раскладывает сотрудников по разделам (createDepartmentPlacer + placeEmployee).
 * Пустые разделы не возвращаются.
 */
export function buildExportSections({
  employees,
  departments,
  mainObjectByEmployee,
  costItemByEmployee,
}: IBuildSectionsParams): IExportSection[] {
  const placer = createDepartmentPlacer(departments);
  const rowsBySection = new Map<ExportSectionKey, IExportFlatRow[]>();

  for (const employee of employees) {
    const visible = placeEmployee(placer, employee.effective_department_id, employee.in_department_scope);

    const sign: ExportSign = employee.employment_status === 'fired'
      ? 'Уволен'
      : visible.isMaternity ? 'Декрет' : 'Работает';

    const row: IExportFlatRow = {
      employeeId: employee.id,
      fullName: employee.full_name,
      departmentPath: visible.path,
      positionName: employee.position_name ?? '',
      birthDate: employee.birth_date,
      hireDate: employee.hire_date,
      objectName: mainObjectByEmployee.get(employee.id) ?? '',
      sign,
      costItem: costItemByEmployee?.get(employee.id) ?? '',
    };

    const bucket = rowsBySection.get(visible.section);
    if (bucket) bucket.push(row);
    else rowsBySection.set(visible.section, [row]);
  }

  const sections: IExportSection[] = [];
  for (const def of SECTION_DEFS) {
    const rows = rowsBySection.get(def.key);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) =>
      collator.compare(a.departmentPath, b.departmentPath)
      || collator.compare(a.fullName, b.fullName)
      || a.employeeId - b.employeeId);
    sections.push({ ...def, rows });
  }
  return sections;
}

/** Суммарное число строк во всех разделах. */
export function countSectionRows(sections: IExportSection[]): number {
  return sections.reduce((sum, section) => sum + section.rows.length, 0);
}
