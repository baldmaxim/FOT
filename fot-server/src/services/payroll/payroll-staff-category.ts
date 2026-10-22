/**
 * Категория персонала в «Зарплате» — та же, что ведёт табель (решение 22.10.2026), не выбирается.
 * Порядок:
 *   1. объект табелирования «Офис» («Текущая деятельность», офисный адрес, «Офис» отдела или из окна
 *      «Режим табелирования») — «Офис»;
 *   2. табель ведёт сотрудника как рабочего (разбивка по проходам, timesheet-object-worker-rule.ts) — «Рабочие»;
 *   3. отдел внутри «ЛИНИЯ» / «ЛИНИЯ-Общестрой» — «ИТР на объектах»;
 *   4. остальные — «Офис».
 *
 * Рабочий: с эпохи авторасчёта (месяц после baseline_month, 288) при личном режиме — режим skud/auto,
 * его пишет только правило рабочих, закреплённые в окне его не имеют. До неё или без личного режима
 * (новый сотрудник до первой ночи) — само правило (workerSql) по отделу месяца, кроме закреплённых в
 * окне. Роль учётки — текущая: истории ролей нет.
 *
 * Сохранённая в условиях оплаты staff_category — снимок на дату сохранения: её отдаёт история условий,
 * а категорию и «Проезд» она не решает.
 */
import { query, type DbExecutor } from '../../config/postgres.js';
import { normalizeDepartmentName } from '../../utils/employee-sign.js';
import {
  isOfficeAddress,
  isWorkerSkudMode,
  loadSkudObjects,
  readTimesheetObjectState,
} from '../employee-timesheet-object.service.js';
import { listSectionDepartmentIds, type IExportDepartmentRow } from '../employees-export.service.js';
import {
  currentMonthStartMsk,
  resolveExportModes,
  type IResolvedExportMode,
} from '../timesheet-export-mode.service.js';
import { workerSql } from '../timesheet-object-worker-rule.js';
import type { StaffCategory } from './payroll-terms.service.js';

const ITR_DEPARTMENT_NAMES: ReadonlySet<string> = new Set(['линия', 'линия-общестрой']);

/** Отдел → внутри «ЛИНИЯ» / «ЛИНИЯ-Общестрой» (по имени предков). Ответ кэшируется по отделу. */
export const createLiniaResolver = (
  departments: IExportDepartmentRow[],
): ((departmentId: string | null) => boolean) => {
  const byId = new Map(departments.map(dept => [dept.id, dept]));
  const cache = new Map<string, boolean>();
  return (departmentId) => {
    if (!departmentId) return false;
    const cached = cache.get(departmentId);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    let current = byId.get(departmentId);
    let linia = false;
    while (current && !seen.has(current.id)) {
      if (ITR_DEPARTMENT_NAMES.has(normalizeDepartmentName(current.name))) {
        linia = true;
        break;
      }
      seen.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    cache.set(departmentId, linia);
    return linia;
  };
};

/** Категория по признакам табеля — порядок в шапке файла. */
export const categoryByTimesheet = (input: {
  officeObject: boolean;
  timesheetWorker: boolean;
  linia: boolean;
}): StaffCategory => {
  if (input.officeObject) return 'office';
  if (input.timesheetWorker) return 'worker';
  return input.linia ? 'itr' : 'office';
};

/**
 * Ведёт ли табель сотрудника как рабочего. autoEra — месяц после baseline_month: личный режим
 * тогда пишет ночной расчёт, и skud/auto — след правила рабочих. workerRule — workerSql по отделу месяца.
 */
export const isTimesheetWorker = (input: {
  resolved: IResolvedExportMode | undefined;
  autoEra: boolean;
  workerRule: boolean;
}): boolean => {
  if (input.autoEra && input.resolved?.source === 'employee_explicit') return isWorkerSkudMode(input.resolved);
  return input.workerRule && input.resolved?.windowPin !== true;
};

/** Режим — «Офис»: «Текущая деятельность» или закреплённый объект с офисным адресом. */
const isOfficeMode = (
  resolved: IResolvedExportMode | undefined,
  altNameById: ReadonlyMap<string, string | null>,
): boolean => {
  if (resolved?.mode === 'current_activity') return true;
  return resolved?.mode === 'object' && resolved.pinnedObjectId !== null
    && isOfficeAddress(altNameById.get(resolved.pinnedObjectId));
};

/** Месяц (первое число) — эпоха авторасчёта: после базовой фиксации. Состояния нет — нет и эпохи. */
const isAutoEra = (monthStart: string, baselineMonth: string | null): boolean => (
  baselineMonth !== null && monthStart > baselineMonth.slice(0, 10)
);

interface IStructure {
  isLinia: (departmentId: string | null) => boolean;
  brigadeIds: string[];
  baselineMonth: string | null;
}

/** Структура (включая неактивные отделы) и базовая фиксация. exec — клиент транзакции. */
const loadStructure = async (exec?: DbExecutor): Promise<IStructure> => {
  const sql = 'SELECT id, parent_id, name, kind FROM org_departments';
  const [departments, state] = await Promise.all([
    exec ? exec.query<IExportDepartmentRow>(sql).then(result => result.rows) : query<IExportDepartmentRow>(sql),
    readTimesheetObjectState(exec),
  ]);
  return {
    isLinia: createLiniaResolver(departments),
    brigadeIds: listSectionDepartmentIds(departments, 'brigades'),
    baselineMonth: state?.baseline_month ?? null,
  };
};

const workerPairKey = (employeeId: number, departmentId: string | null): string => `${employeeId}|${departmentId ?? ''}`;

/** Правило рабочих (workerSql) по парам «сотрудник + отдел»: у уволенного — отдел месяца, а не «Уволенные». */
const loadWorkerRule = async (
  pairs: ReadonlyArray<{ employeeId: number; departmentId: string | null }>,
  brigadeIds: string[],
  exec?: DbExecutor,
): Promise<Set<string>> => {
  const unique = new Map(pairs.map(pair => [workerPairKey(pair.employeeId, pair.departmentId), pair]));
  if (unique.size === 0) return new Set();
  const list = [...unique.values()];
  const sql = `SELECT p.employee_id, p.department_id::text AS department_id
                 FROM unnest($1::int[], $2::uuid[]) AS p(employee_id, department_id)
                 JOIN employees e ON e.id = p.employee_id
                WHERE ${workerSql('e', '$3', 'p.department_id')}`;
  const params = [list.map(pair => pair.employeeId), list.map(pair => pair.departmentId), brigadeIds];
  const rows = exec
    ? (await exec.query<{ employee_id: number; department_id: string | null }>(sql, params)).rows
    : await query<{ employee_id: number; department_id: string | null }>(sql, params);
  return new Set(rows.map(row => workerPairKey(Number(row.employee_id), row.department_id)));
};

/**
 * Категория на сейчас — карточка, список «Расчётов», снимок при сохранении условий: живой режим
 * табелирования и текущий отдел. Сотрудника нет в БД — «Офис». exec — клиент транзакции.
 */
export const resolveCurrentStaffCategories = async (
  employeeIds: number[],
  exec?: DbExecutor,
): Promise<Map<number, StaffCategory>> => {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return new Map();
  const employeeSql = 'SELECT id, org_department_id::text AS org_department_id FROM employees WHERE id = ANY($1::int[])';
  const [structure, modes, objects, employees] = await Promise.all([
    loadStructure(exec),
    resolveExportModes(ids, exec),
    loadSkudObjects(exec),
    exec
      ? exec.query<{ id: number; org_department_id: string | null }>(employeeSql, [ids]).then(result => result.rows)
      : query<{ id: number; org_department_id: string | null }>(employeeSql, [ids]),
  ]);
  const departmentById = new Map(employees.map(row => [Number(row.id), row.org_department_id]));
  const workers = await loadWorkerRule(
    ids.map(id => ({ employeeId: id, departmentId: departmentById.get(id) ?? null })),
    structure.brigadeIds,
    exec,
  );
  const altNameById = new Map([...objects.values()].map(object => [object.id, object.alt_name]));
  const autoEra = isAutoEra(currentMonthStartMsk(), structure.baselineMonth);
  return new Map(ids.map(id => {
    const departmentId = departmentById.get(id) ?? null;
    const resolved = modes.get(id);
    return [id, categoryByTimesheet({
      officeObject: isOfficeMode(resolved, altNameById),
      timesheetWorker: isTimesheetWorker({
        resolved,
        autoEra,
        workerRule: workers.has(workerPairKey(id, departmentId)),
      }),
      linia: structure.isLinia(departmentId),
    })];
  }));
};

/** Пара месяца для категории: объект и отдел месяца — из payroll-month-attribution.service. */
export interface IMonthCategoryInput {
  employeeId: number;
  /** Первое число месяца (YYYY-MM-DD). */
  monthStart: string;
  /** Объект месяца — «Офис». */
  officeObject: boolean;
  /** Отдел месяца. */
  departmentId: string | null;
  /** Режим табелирования месяца (фиксация для прошедшего). */
  mode: IResolvedExportMode | undefined;
}

/** Категории месяцев — «Свод» и расчётный листок; порядок ответа — порядок входа. */
export const resolveMonthStaffCategories = async (
  items: readonly IMonthCategoryInput[],
): Promise<StaffCategory[]> => {
  if (items.length === 0) return [];
  const structure = await loadStructure();
  const workers = await loadWorkerRule(items, structure.brigadeIds);
  return items.map(item => categoryByTimesheet({
    officeObject: item.officeObject,
    timesheetWorker: isTimesheetWorker({
      resolved: item.mode,
      autoEra: isAutoEra(item.monthStart, structure.baselineMonth),
      workerRule: workers.has(workerPairKey(item.employeeId, item.departmentId)),
    }),
    linia: structure.isLinia(item.departmentId),
  }));
};
