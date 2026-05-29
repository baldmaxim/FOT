import type ExcelJS from 'exceljs';
import { query } from '../config/postgres.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import {
  buildEmployeeRowsForOneC,
  buildObjectRowsForOneC,
  buildUnified1CWorkbookFromTemplate,
  listObjectExportTargets,
  writeTimesheetWorkbookBuffer,
  type IOneCExportRow,
  type IUnifiedOneCRow,
} from './timesheet-excel.service.js';

interface IUnifiedRow extends IUnifiedOneCRow {
  departmentNameSort: string;
  fullNameSort: string;
  objectNameSort: string;
}

// Адрес для отделов в режиме «текущая деятельность»: их сотрудники не дробятся
// по объектам — одна строка на сотрудника с этой меткой вместо адреса объекта.
const CURRENT_ACTIVITY_ADDRESS = 'Текущая деятельность';

const fetchCurrentActivityDeptIds = async (): Promise<Set<string>> => {
  const rows = await query<{ id: string }>(
    'SELECT id FROM org_departments WHERE is_current_activity = true',
  );
  return new Set(rows.map(row => row.id));
};

const collectObjectIds = (departmentsData: IDepartmentTimesheetData[]): string[] => {
  const ids = new Set<string>();
  for (const data of departmentsData) {
    for (const entry of data.objectEntries) {
      if (entry.object_id) ids.add(entry.object_id);
    }
  }
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
  for (const value of row.dayValues.values()) {
    if (value.label) return false;
    if (value.hours > 0) return false;
  }
  return true;
};

const buildRowsForDepartment = (
  data: IDepartmentTimesheetData,
  objectAddressMap: Map<string, string>,
  currentActivityDeptIds: Set<string>,
): IUnifiedRow[] => {
  const rows: IUnifiedRow[] = [];

  // Сотрудники из отделов в режиме «текущая деятельность» (без наследования на
  // подотделы). Их строки не дробятся по объектам — одна строка с суммой часов
  // за день и фиксированным адресом «Текущая деятельность».
  const currentActivityEmpIds = new Set<number>(
    currentActivityDeptIds.size === 0
      ? []
      : data.employees
        .filter(e => e.org_department_id && currentActivityDeptIds.has(e.org_department_id))
        .map(e => e.id),
  );

  // Данные для обычной разбивки по объектам — исключаем сотрудников «текущей
  // деятельности» из объектных строк и из статус-fallback.
  const splitData: IDepartmentTimesheetData = currentActivityEmpIds.size === 0
    ? data
    : {
      ...data,
      employees: data.employees.filter(e => !currentActivityEmpIds.has(e.id)),
      objectEntries: data.objectEntries.filter(e => !currentActivityEmpIds.has(e.employee_id)),
    };

  const targets = listObjectExportTargets(splitData);
  const seenFullNames = new Set<string>();

  for (const target of targets) {
    const objectRows = buildObjectRowsForOneC(splitData, target);
    const objectAddress = target.object_id
      ? (objectAddressMap.get(target.object_id) ?? target.object_name)
      : '';
    for (const oneCRow of objectRows) {
      seenFullNames.add(oneCRow.fullName);
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: oneCRow.fullName,
        objectNameSort: target.object_name,
        oneCRow,
        departmentName: data.departmentName,
        objectAddress,
      });
    }
  }

  // Сотрудники без выходов на объекты — отпуск/больничный/прогул и пр.
  // Если у сотрудника есть строки по объектам, его «общая» статус-строка не нужна.
  for (const employeeRow of buildEmployeeRowsForOneC(splitData)) {
    if (seenFullNames.has(employeeRow.fullName)) continue;
    if (isOneCRowEmpty(employeeRow)) continue;
    rows.push({
      departmentNameSort: data.departmentName,
      fullNameSort: employeeRow.fullName,
      objectNameSort: '',
      oneCRow: employeeRow,
      departmentName: data.departmentName,
      objectAddress: '',
    });
  }

  // «Текущая деятельность»: одна строка на сотрудника, часы за день суммированы
  // по всем объектам (buildEmployeeRowsForOneC уже агрегирует и учитывает статусы).
  if (currentActivityEmpIds.size > 0) {
    const currentActivityData: IDepartmentTimesheetData = {
      ...data,
      employees: data.employees.filter(e => currentActivityEmpIds.has(e.id)),
    };
    for (const employeeRow of buildEmployeeRowsForOneC(currentActivityData)) {
      if (isOneCRowEmpty(employeeRow)) continue;
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: employeeRow.fullName,
        objectNameSort: CURRENT_ACTIVITY_ADDRESS,
        oneCRow: employeeRow,
        departmentName: data.departmentName,
        objectAddress: CURRENT_ACTIVITY_ADDRESS,
      });
    }
  }

  return rows;
};

export async function buildUnified1CWorkbook(
  _month: number,
  _year: number,
  departmentsData: IDepartmentTimesheetData[],
): Promise<ExcelJS.Workbook> {
  const [objectAddressMap, currentActivityDeptIds] = await Promise.all([
    fetchObjectAddressMap(collectObjectIds(departmentsData)),
    fetchCurrentActivityDeptIds(),
  ]);

  const rows: IUnifiedRow[] = [];
  for (const data of departmentsData) {
    rows.push(...buildRowsForDepartment(data, objectAddressMap, currentActivityDeptIds));
  }
  rows.sort((a, b) => {
    const byDept = a.departmentNameSort.localeCompare(b.departmentNameSort, 'ru');
    if (byDept !== 0) return byDept;
    const byFio = a.fullNameSort.localeCompare(b.fullNameSort, 'ru');
    if (byFio !== 0) return byFio;
    return a.objectNameSort.localeCompare(b.objectNameSort, 'ru');
  });

  return buildUnified1CWorkbookFromTemplate('Табель 1С', rows);
}

export { writeTimesheetWorkbookBuffer };
