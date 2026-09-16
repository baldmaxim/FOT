import type ExcelJS from 'exceljs';
import { query } from '../config/postgres.js';
// Тестовых начальников в выгрузку не пускаем; правило общее со снимком руководителей.
import { isTestPersonName } from '../utils/person-name.utils.js';
import { resolveResponsibleEmployeeIdsByEmployeeDept, responsiblePairKey } from './approval-routing.service.js';
import {
  CURRENT_ACTIVITY_ADDRESS,
  DEFAULT_EXPORT_MODE,
  exportModePairKey,
  resolveExportModesForPairs,
  type IResolvedExportMode,
} from './timesheet-export-mode.service.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import { isDateInEmployeeWindows } from './timesheet-day-windows.service.js';
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
  departmentIdSort: string;
  fullNameSort: string;
  employeeIdSort: number;
  objectNameSort: string;
  objectKeySort: string;
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

// Отдел, по которому строке резолвятся руководитель и режим: отдел набора данных (при
// переводе внутри периода сотрудник есть в нескольких наборах), иначе — текущий отдел
// сотрудника (выгрузка по объектам, где набор отдела не несёт).
const rowDepartmentId = (
  data: IDepartmentTimesheetData,
  employee: { org_department_id: string | null },
): string | null => data.departmentId ?? employee.org_department_id;

// Пары «сотрудник → отдел строки» для руководителя и режима.
const collectEmployeeDeptPairs = (
  departmentsData: IDepartmentTimesheetData[],
): Array<{ employee_id: number; org_department_id: string | null }> => {
  const seen = new Set<string>();
  const pairs: Array<{ employee_id: number; org_department_id: string | null }> = [];
  for (const data of departmentsData) {
    for (const employee of data.employees) {
      const deptId = rowDepartmentId(data, employee);
      const key = exportModePairKey(employee.id, deptId);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ employee_id: employee.id, org_department_id: deptId });
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
  modeByPair: Map<string, IResolvedExportMode>,
  managerNameByPair: Map<string, string>,
  policy: AggregatedModesPolicy = 'all',
): IUnifiedRow[] => {
  const rows: IUnifiedRow[] = [];

  // Уволенные ОСТАЮТСЯ в едином файле. Fetch передаёт cutoffByEmployeeId, а 1С-билдеры
  // (buildEmployeeRowsForOneC/buildObjectRowsForOneC) пропускают даты >= cutoff — день
  // увольнения сохраняется, последующие дни пустые. Паритет с ZIP «Как в 1С»
  // (build1CTimesheetWorkbook), которая fired не режет.
  // Перевод внутри периода: объектные записи вне окон дней не должны порождать объектные
  // строки (цели разбивки) — иначе в файле старого отдела появится пустая строка по объекту
  // нового. Срез уже режет их, но билдер не полагается на вызывающего.
  const visibleData: IDepartmentTimesheetData = data.dayWindowsByEmployeeId
    ? {
      ...data,
      objectEntries: data.objectEntries.filter(e => isDateInEmployeeWindows(data, e.employee_id, e.work_date)),
    }
    : data;

  // Руководитель и режим — по отделу ЭТОГО набора (см. rowDepartmentId).
  const deptIdByEmpId = new Map<number, string | null>(
    visibleData.employees.map(e => [e.id, rowDepartmentId(data, e)]),
  );
  const modeFor = (empId: number): IResolvedExportMode =>
    modeByPair.get(exportModePairKey(empId, deptIdByEmpId.get(empId) ?? null)) ?? DEFAULT_EXPORT_MODE;
  const managerFor = (empId: number): string =>
    managerNameByPair.get(responsiblePairKey(empId, deptIdByEmpId.get(empId) ?? null)) ?? '';
  const sortKeysFor = (empId: number, fullName: string, objectName: string, objectKey: string) => ({
    departmentNameSort: data.departmentName,
    departmentIdSort: data.departmentId ?? '',
    fullNameSort: fullName,
    employeeIdSort: empId,
    objectNameSort: objectName,
    objectKeySort: objectKey,
  });

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
      const managerName = managerFor(empId);
      rows.push({
        ...sortKeysFor(empId, oneCRow.fullName, target.object_name, target.object_id ?? ''),
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
    const managerName = managerFor(empId);
    rows.push({
      ...sortKeysFor(empId, employeeRow.fullName, '', ''),
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
      const managerName = managerFor(empId);
      const objectAddress = aggregatedAddressByEmpId.get(empId) ?? CURRENT_ACTIVITY_ADDRESS;
      rows.push({
        ...sortKeysFor(empId, employeeRow.fullName, objectAddress, modeFor(empId).pinnedObjectId ?? ''),
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

const compareText = (a: string, b: string): number => a.localeCompare(b, 'ru');
// Порядок кодовых точек, а не localeCompare: для ключей нужна строгая упорядоченность
// без «равных» разных значений — иначе порядок решали бы входные данные.
const compareCode = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * Полный ключ сортировки: при однофамильцах, одинаковых названиях отделов и объектов
 * порядок строк всё равно однозначен — повторный экспорт даёт тот же порядок.
 */
export const compareUnifiedRows = (a: IUnifiedRow, b: IUnifiedRow): number => (
  compareText(a.departmentNameSort, b.departmentNameSort)
  || compareCode(a.departmentIdSort, b.departmentIdSort)
  || compareText(a.fullNameSort, b.fullNameSort)
  || a.employeeIdSort - b.employeeIdSort
  || compareText(a.objectNameSort, b.objectNameSort)
  || compareCode(a.objectKeySort, b.objectKeySort)
);

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
  // И режим, и руководитель — по паре «сотрудник + отдел строки»: переведённый внутри
  // периода сотрудник в старом отделе получает режим и руководителя старого отдела.
  const pairs = collectEmployeeDeptPairs(departmentsData);
  const [modeByPair, responsibleIdsByPair] = await Promise.all([
    resolveExportModesForPairs(pairs),
    // Приоритет: начальник(и) отдела/участка с full-доступом → иначе непосредственный
    // руководитель (employee_direct_reports).
    resolveResponsibleEmployeeIdsByEmployeeDept(pairs),
  ]);

  const pinnedObjectIds = new Set<string>();
  for (const resolved of modeByPair.values()) {
    if (resolved.mode === 'object' && resolved.pinnedObjectId) pinnedObjectIds.add(resolved.pinnedObjectId);
  }
  const objectAddressMap = await fetchObjectAddressMap(collectObjectIds(departmentsData, pinnedObjectIds));

  // Раскрываем id руководителей в ФИО, отбрасываем тестовых, объединяем через запятую.
  const managerNames = await fetchEmployeeNames(
    [...new Set([...responsibleIdsByPair.values()].flat())],
  );
  const managerNameByPair = new Map<string, string>();
  for (const [pairKey, managerIds] of responsibleIdsByPair) {
    const names = managerIds
      .map(id => managerNames.get(id) ?? '')
      .filter(name => name.length > 0 && !isTestPersonName(name))
      .sort((a, b) => a.localeCompare(b, 'ru'));
    if (names.length > 0) managerNameByPair.set(pairKey, names.join(', '));
  }

  const rows: IUnifiedRow[] = [];
  for (const data of departmentsData) {
    rows.push(...buildRowsForDepartment(data, objectAddressMap, modeByPair, managerNameByPair, policy));
  }
  rows.sort(compareUnifiedRows);

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
