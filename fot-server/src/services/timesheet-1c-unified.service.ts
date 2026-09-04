import type ExcelJS from 'exceljs';
import { query } from '../config/postgres.js';
// Тестовых начальников в выгрузку не пускаем; правило общее со снимком руководителей.
import { isTestPersonName } from '../utils/person-name.utils.js';
import { resolveResponsibleEmployeeIdsByEmployee } from './approval-routing.service.js';
import {
  CURRENT_ACTIVITY_ADDRESS,
  DEFAULT_EXPORT_MODE,
  resolveExportModes,
  type IResolvedExportMode,
} from './timesheet-export-mode.service.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import {
  buildEmployeeRowsForOneC,
  buildObjectRowsForOneC,
  buildUnified1CWorkbookFromTemplate,
  listObjectExportTargets,
  writeTimesheetWorkbookBuffer,
  ONE_C_ABSENT_LABEL,
  type IOneCExportRow,
  type IUnifiedOneCRow,
} from './timesheet-excel.service.js';

export interface IUnifiedRow extends IUnifiedOneCRow {
  departmentNameSort: string;
  fullNameSort: string;
  objectNameSort: string;
}

/**
 * Что делать со строками агрегированных режимов (current_activity / object):
 *  - 'all' — единый файл по отделам: включаются все;
 *  - { pinnedObjectIds } — выгрузка по объектам: включаются только сотрудники режима
 *    object, чей закреплённый объект входит в набор запрошенных, — их часы принадлежат
 *    этому объекту независимо от проходов. current_activity и закреплённые за другими
 *    объектами исключаются: иначе человек, попавший в выборку по одному проходу,
 *    получил бы все месячные часы одной строкой.
 */
export type AggregatedModesPolicy = 'all' | { pinnedObjectIds: ReadonlySet<string> };

const isAggregatedRowIncluded = (policy: AggregatedModesPolicy, resolved: IResolvedExportMode): boolean =>
  policy === 'all'
  || (resolved.mode === 'object'
    && resolved.pinnedObjectId !== null
    && policy.pinnedObjectIds.has(resolved.pinnedObjectId));

// Пары «сотрудник → отдел» для адресной маршрутизации руководителя.
const collectEmployeeDeptPairs = (
  departmentsData: IDepartmentTimesheetData[],
): Array<{ employee_id: number; org_department_id: string | null }> => {
  const seen = new Set<number>();
  const pairs: Array<{ employee_id: number; org_department_id: string | null }> = [];
  for (const data of departmentsData) {
    for (const employee of data.employees) {
      if (seen.has(employee.id)) continue;
      seen.add(employee.id);
      pairs.push({ employee_id: employee.id, org_department_id: employee.org_department_id });
    }
  }
  return pairs;
};

// ФИО сотрудников по id (для раскрытия id руководителей).
const fetchEmployeeNames = async (ids: number[]): Promise<Map<number, string>> => {
  const map = new Map<number, string>();
  const uniqueIds = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return map;
  const rows = await query<{ id: number; full_name: string | null }>(
    'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
    [uniqueIds],
  );
  for (const row of rows) {
    map.set(Number(row.id), (row.full_name ?? '').trim());
  }
  return map;
};

// Список сотрудников выгрузки — для резолвинга режимов табелирования.
const collectEmployeeIds = (departmentsData: IDepartmentTimesheetData[]): number[] => {
  const ids = new Set<number>();
  for (const data of departmentsData) {
    for (const employee of data.employees) ids.add(employee.id);
  }
  return [...ids];
};

// Объекты, для которых нужен адрес: фактические (objectEntries) + закреплённые
// в режиме «object». Без второго слагаемого адрес закреплённого объекта у сотрудника
// без проходов не попал бы в карту и колонка осталась бы пустой.
const collectObjectIds = (
  departmentsData: IDepartmentTimesheetData[],
  pinnedObjectIds: Iterable<string>,
): string[] => {
  const ids = new Set<string>();
  for (const data of departmentsData) {
    for (const entry of data.objectEntries) {
      if (entry.object_id) ids.add(entry.object_id);
    }
  }
  for (const id of pinnedObjectIds) ids.add(id);
  return [...ids];
};

const fetchObjectAddressMap = async (objectIds: string[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (objectIds.length === 0) return map;
  const rows = await query<{ id: string; alt_name: string | null; name: string }>(
    'SELECT id, alt_name, name FROM skud_objects WHERE id = ANY($1::uuid[])',
    [objectIds],
  );
  for (const row of rows) {
    const altName = row.alt_name?.trim();
    map.set(row.id, altName && altName.length > 0 ? altName : row.name);
  }
  return map;
};

const isOneCRowEmpty = (row: IOneCExportRow): boolean => {
  if (row.totalHours > 0) return false;
  // Нулевой УД/РБ часов и буквы не даёт, но идёт в колонку «Дни» — строку сохраняем.
  if (row.workedDays > 0) return false;
  for (const value of row.dayValues.values()) {
    if (value.label) return false;
    if (value.hours > 0) return false;
  }
  return true;
};

const buildRowsForDepartment = (
  data: IDepartmentTimesheetData,
  objectAddressMap: Map<string, string>,
  modeByEmployee: Map<number, IResolvedExportMode>,
  managerNameMap: Map<number, string>,
  policy: AggregatedModesPolicy = 'all',
): IUnifiedRow[] => {
  const rows: IUnifiedRow[] = [];

  // Уволенные ОСТАЮТСЯ в едином файле. Fetch передаёт cutoffByEmployeeId, а 1С-билдеры
  // (buildEmployeeRowsForOneC/buildObjectRowsForOneC) пропускают даты >= cutoff — день
  // увольнения сохраняется, последующие дни пустые. Паритет с ZIP «Как в 1С»
  // (build1CTimesheetWorkbook), которая fired не режет.
  const visibleData: IDepartmentTimesheetData = data;

  const modeFor = (empId: number): IResolvedExportMode =>
    modeByEmployee.get(empId) ?? DEFAULT_EXPORT_MODE;

  // Агрегированные режимы — одна строка на сотрудника, без дробления по объектам:
  //   current_activity → адрес «Текущая деятельность»;
  //   object           → адрес закреплённого объекта (независимо от фактических проходов).
  // Режим skud идёт обычной разбивкой ниже.
  const aggregatedAddressByEmpId = new Map<number, string>();
  for (const employee of visibleData.employees) {
    const resolved = modeFor(employee.id);
    if (resolved.mode === 'current_activity') {
      aggregatedAddressByEmpId.set(employee.id, CURRENT_ACTIVITY_ADDRESS);
      continue;
    }
    if (resolved.mode !== 'object') continue;
    // Инвариант БД (миграция 249) гарантирует объект у режима object. Если он всё же
    // пуст — падаем громко, а не подменяем режим на skud: тихая подмена изменила бы
    // число строк в файле и скрыла повреждённую настройку.
    if (!resolved.pinnedObjectId) {
      throw new Error(
        `Режим «объект» без закреплённого объекта: employee_id=${employee.id}. Проверьте настройку режима табелирования.`,
      );
    }
    const address = objectAddressMap.get(resolved.pinnedObjectId);
    if (!address) {
      throw new Error(
        `Не найден адрес закреплённого объекта ${resolved.pinnedObjectId} (employee_id=${employee.id}).`,
      );
    }
    aggregatedAddressByEmpId.set(employee.id, address);
  }

  // Данные для обычной разбивки по объектам — исключаем сотрудников агрегированных
  // режимов из объектных строк и из статус-fallback.
  const splitData: IDepartmentTimesheetData = aggregatedAddressByEmpId.size === 0
    ? visibleData
    : {
      ...visibleData,
      employees: visibleData.employees.filter(e => !aggregatedAddressByEmpId.has(e.id)),
      objectEntries: visibleData.objectEntries.filter(e => !aggregatedAddressByEmpId.has(e.employee_id)),
    };

  const positionByEmpId = new Map<number, string>(
    visibleData.employees.map(e => [e.id, e.position_id ? (data.posMap.get(e.position_id) ?? '') : '']),
  );
  const positionForEmpId = (empId: number | undefined): string =>
    empId != null ? (positionByEmpId.get(empId) ?? '') : '';
  const targets = listObjectExportTargets(splitData);
  // Только признак «у сотрудника уже есть хотя бы одна объектная строка» → общая
  // статус-строка ему не нужна. Дедуплицировать этим набором сами объектные строки
  // нельзя: несколько строк по разным объектам — законный случай.
  const seenEmployeeIds = new Set<number>();

  for (const target of targets) {
    const objectRows = buildObjectRowsForOneC(splitData, target);
    const objectAddress = target.object_id
      ? (objectAddressMap.get(target.object_id) ?? target.object_name)
      : '';
    for (const oneCRow of objectRows) {
      seenEmployeeIds.add(oneCRow.employeeId);
      const empId = oneCRow.employeeId;
      const managerName = managerNameMap.get(empId) ?? '';
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: oneCRow.fullName,
        objectNameSort: target.object_name,
        oneCRow,
        departmentName: data.departmentName,
        objectAddress,
        managerName,
        position: positionForEmpId(empId),
      });
    }
  }

  // Сотрудники без выходов на объекты — отпуск/больничный/прогул и пр.
  // Если у сотрудника есть строки по объектам, его «общая» статус-строка не нужна.
  for (const employeeRow of buildEmployeeRowsForOneC(splitData)) {
    if (seenEmployeeIds.has(employeeRow.employeeId)) continue;
    if (isOneCRowEmpty(employeeRow)) continue;
    const empId = employeeRow.employeeId;
    const managerName = managerNameMap.get(empId) ?? '';
    rows.push({
      departmentNameSort: data.departmentName,
      fullNameSort: employeeRow.fullName,
      objectNameSort: '',
      oneCRow: employeeRow,
      departmentName: data.departmentName,
      objectAddress: '',
      managerName,
      position: positionForEmpId(empId),
    });
  }

  // Агрегированные режимы: одна строка на сотрудника, часы за день суммированы по всем
  // объектам (buildEmployeeRowsForOneC уже агрегирует и учитывает статусы). Адрес — либо
  // «Текущая деятельность», либо закреплённый объект. Кого из них выводить, решает
  // policy: в выгрузке по объектам — только закреплённых за запрошенными объектами.
  const includedAggregatedIds = new Set<number>();
  for (const empId of aggregatedAddressByEmpId.keys()) {
    if (isAggregatedRowIncluded(policy, modeFor(empId))) includedAggregatedIds.add(empId);
  }
  if (includedAggregatedIds.size > 0) {
    const aggregatedData: IDepartmentTimesheetData = {
      ...visibleData,
      employees: visibleData.employees.filter(e => includedAggregatedIds.has(e.id)),
    };
    for (const employeeRow of buildEmployeeRowsForOneC(aggregatedData)) {
      if (isOneCRowEmpty(employeeRow)) continue;
      const empId = employeeRow.employeeId;
      const managerName = managerNameMap.get(empId) ?? '';
      const objectAddress = aggregatedAddressByEmpId.get(empId) ?? CURRENT_ACTIVITY_ADDRESS;
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: employeeRow.fullName,
        objectNameSort: objectAddress,
        oneCRow: employeeRow,
        departmentName: data.departmentName,
        objectAddress,
        managerName,
        position: positionForEmpId(empId),
      });
    }
  }

  return rows;
};

/**
 * Строки единого файла 1С до рендера в шаблон. Вынесено из buildUnified1CWorkbook,
 * чтобы вызывающий мог связывать строки по oneCRow.employeeId — в самом листе id
 * не остаётся, а ФИО не уникально (однофамильцы).
 */
export async function buildUnified1CRows(
  departmentsData: IDepartmentTimesheetData[],
  policy: AggregatedModesPolicy = 'all',
): Promise<IUnifiedRow[]> {
  // Режимы резолвим первыми: закреплённые объекты нужны до сборки карты адресов.
  const [modeByEmployee, responsibleIdsMap] = await Promise.all([
    resolveExportModes(collectEmployeeIds(departmentsData)),
    // Приоритет: назначенный ответственный (employee_direct_reports) → иначе
    // начальник(и) отдела/участка с full-доступом по org_department_id.
    resolveResponsibleEmployeeIdsByEmployee(collectEmployeeDeptPairs(departmentsData)),
  ]);

  const pinnedObjectIds = new Set<string>();
  for (const resolved of modeByEmployee.values()) {
    if (resolved.mode === 'object' && resolved.pinnedObjectId) pinnedObjectIds.add(resolved.pinnedObjectId);
  }
  const objectAddressMap = await fetchObjectAddressMap(collectObjectIds(departmentsData, pinnedObjectIds));

  // Раскрываем id руководителей в ФИО, отбрасываем тестовых, объединяем через запятую.
  const managerNames = await fetchEmployeeNames(
    [...new Set([...responsibleIdsMap.values()].flat())],
  );
  const managerNameMap = new Map<number, string>();
  for (const [empId, managerIds] of responsibleIdsMap) {
    const names = managerIds
      .map(id => managerNames.get(id) ?? '')
      .filter(name => name.length > 0 && !isTestPersonName(name))
      .sort((a, b) => a.localeCompare(b, 'ru'));
    if (names.length > 0) managerNameMap.set(empId, names.join(', '));
  }

  const rows: IUnifiedRow[] = [];
  for (const data of departmentsData) {
    rows.push(...buildRowsForDepartment(data, objectAddressMap, modeByEmployee, managerNameMap, policy));
  }
  rows.sort((a, b) => {
    const byDept = a.departmentNameSort.localeCompare(b.departmentNameSort, 'ru');
    if (byDept !== 0) return byDept;
    const byFio = a.fullNameSort.localeCompare(b.fullNameSort, 'ru');
    if (byFio !== 0) return byFio;
    return a.objectNameSort.localeCompare(b.objectNameSort, 'ru');
  });

  // «Н» (прогул) в единый файл не выводим: клетка остаётся пустой. Чистим ПОСЛЕ
  // проверок isOneCRowEmpty — сотрудник с одними «Н» сохраняет пустую строку.
  for (const row of rows) {
    for (const [day, value] of row.oneCRow.dayValues) {
      if (value.label === ONE_C_ABSENT_LABEL) row.oneCRow.dayValues.delete(day);
    }
  }

  return rows;
}

export async function buildUnified1CWorkbook(
  _month: number,
  _year: number,
  departmentsData: IDepartmentTimesheetData[],
  policy: AggregatedModesPolicy = 'all',
): Promise<ExcelJS.Workbook> {
  const rows = await buildUnified1CRows(departmentsData, policy);
  return buildUnified1CWorkbookFromTemplate('Табель 1С', rows);
}

export { writeTimesheetWorkbookBuffer };
