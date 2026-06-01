import type ExcelJS from 'exceljs';
import { query } from '../config/postgres.js';
import { getActiveDirectManagersFor } from './employee-direct-reports.service.js';
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

const collectAllEmployeeIds = (departmentsData: IDepartmentTimesheetData[]): number[] => {
  const ids = new Set<number>();
  for (const data of departmentsData) {
    for (const employee of data.employees) {
      ids.add(employee.id);
    }
  }
  return [...ids];
};

// Адрес для отделов/сотрудников в режиме «текущая деятельность»: их строки не
// дробятся по объектам — одна строка на сотрудника с этой меткой вместо адреса
// объекта. Режим определяется назначением объекта с этим адресом (alt_name).
const CURRENT_ACTIVITY_ADDRESS = 'Текущая деятельность';

// Условие «объект-адрес = текущая деятельность» (по alt_name, регистр/пробелы — норм.).
const CURRENT_ACTIVITY_OBJECT_PREDICATE =
  `lower(btrim(coalesce(o.alt_name, ''))) = lower($CA$${CURRENT_ACTIVITY_ADDRESS}$CA$)`;

// Отделы/бригады, которым назначен объект с адресом «Текущая деятельность».
const fetchCurrentActivityDeptIds = async (): Promise<Set<string>> => {
  const rows = await query<{ org_department_id: string }>(
    `SELECT DISTINCT doa.org_department_id
       FROM department_object_assignment doa
       JOIN skud_objects o ON o.id = doa.skud_object_id
      WHERE doa.is_active = true AND ${CURRENT_ACTIVITY_OBJECT_PREDICATE}`,
  );
  return new Set(rows.map(row => row.org_department_id));
};

// Персональные назначения объектов сотрудникам:
//   hasPersonal     — сотрудник имеет любое активное назначение (переопределяет отдел);
//   personalCurrent — среди его объектов есть «Текущая деятельность».
const fetchCurrentActivityEmployeeSets = async (): Promise<{
  hasPersonal: Set<number>;
  personalCurrent: Set<number>;
}> => {
  const rows = await query<{ employee_id: number | string; is_current: boolean }>(
    `SELECT eoa.employee_id,
            bool_or(${CURRENT_ACTIVITY_OBJECT_PREDICATE}) AS is_current
       FROM employee_object_assignment eoa
       JOIN skud_objects o ON o.id = eoa.skud_object_id
      WHERE eoa.is_active = true
      GROUP BY eoa.employee_id`,
  );
  const hasPersonal = new Set<number>();
  const personalCurrent = new Set<number>();
  for (const row of rows) {
    const id = Number(row.employee_id);
    if (!Number.isInteger(id)) continue;
    hasPersonal.add(id);
    if (row.is_current) personalCurrent.add(id);
  }
  return { hasPersonal, personalCurrent };
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
  empSets: { hasPersonal: Set<number>; personalCurrent: Set<number> },
  managerNameMap: Map<number, string>,
  excludeCurrentActivity: boolean = false,
): IUnifiedRow[] => {
  const rows: IUnifiedRow[] = [];

  // Сотрудники в режиме «текущая деятельность». Персональное назначение объекта
  // полностью переопределяет отдел: есть персональные объекты → смотрим только их;
  // иначе — назначение его отдела/бригады. Их строки не дробятся по объектам —
  // одна строка с суммой часов за день и адресом «Текущая деятельность».
  const isCurrentActivityEmp = (e: { id: number; org_department_id: string | null }): boolean =>
    empSets.hasPersonal.has(e.id)
      ? empSets.personalCurrent.has(e.id)
      : Boolean(e.org_department_id && currentActivityDeptIds.has(e.org_department_id));

  const currentActivityEmpIds = new Set<number>(
    data.employees.filter(isCurrentActivityEmp).map(e => e.id),
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

  const nameToId = new Map<string, number>(data.employees.map(e => [e.full_name, e.id]));
  const targets = listObjectExportTargets(splitData);
  const seenFullNames = new Set<string>();

  for (const target of targets) {
    const objectRows = buildObjectRowsForOneC(splitData, target);
    const objectAddress = target.object_id
      ? (objectAddressMap.get(target.object_id) ?? target.object_name)
      : '';
    for (const oneCRow of objectRows) {
      seenFullNames.add(oneCRow.fullName);
      const empId = nameToId.get(oneCRow.fullName);
      const managerName = empId != null ? (managerNameMap.get(empId) ?? '') : '';
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: oneCRow.fullName,
        objectNameSort: target.object_name,
        oneCRow,
        departmentName: data.departmentName,
        objectAddress,
        managerName,
      });
    }
  }

  // Сотрудники без выходов на объекты — отпуск/больничный/прогул и пр.
  // Если у сотрудника есть строки по объектам, его «общая» статус-строка не нужна.
  for (const employeeRow of buildEmployeeRowsForOneC(splitData)) {
    if (seenFullNames.has(employeeRow.fullName)) continue;
    if (isOneCRowEmpty(employeeRow)) continue;
    const empId = nameToId.get(employeeRow.fullName);
    const managerName = empId != null ? (managerNameMap.get(empId) ?? '') : '';
    rows.push({
      departmentNameSort: data.departmentName,
      fullNameSort: employeeRow.fullName,
      objectNameSort: '',
      oneCRow: employeeRow,
      departmentName: data.departmentName,
      objectAddress: '',
      managerName,
    });
  }

  // «Текущая деятельность»: одна строка на сотрудника, часы за день суммированы
  // по всем объектам (buildEmployeeRowsForOneC уже агрегирует и учитывает статусы).
  // Исключаем при экспорте по конкретным объектам — там должны быть только реальные события.
  if (!excludeCurrentActivity && currentActivityEmpIds.size > 0) {
    const currentActivityData: IDepartmentTimesheetData = {
      ...data,
      employees: data.employees.filter(e => currentActivityEmpIds.has(e.id)),
    };
    for (const employeeRow of buildEmployeeRowsForOneC(currentActivityData)) {
      if (isOneCRowEmpty(employeeRow)) continue;
      const empId = nameToId.get(employeeRow.fullName);
      const managerName = empId != null ? (managerNameMap.get(empId) ?? '') : '';
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: employeeRow.fullName,
        objectNameSort: CURRENT_ACTIVITY_ADDRESS,
        oneCRow: employeeRow,
        departmentName: data.departmentName,
        objectAddress: CURRENT_ACTIVITY_ADDRESS,
        managerName,
      });
    }
  }

  return rows;
};

export async function buildUnified1CWorkbook(
  _month: number,
  _year: number,
  departmentsData: IDepartmentTimesheetData[],
  excludeCurrentActivity: boolean = false,
): Promise<ExcelJS.Workbook> {
  const [objectAddressMap, currentActivityDeptIds, currentActivityEmpSets, managerInfoMap] = await Promise.all([
    fetchObjectAddressMap(collectObjectIds(departmentsData)),
    fetchCurrentActivityDeptIds(),
    fetchCurrentActivityEmployeeSets(),
    getActiveDirectManagersFor(collectAllEmployeeIds(departmentsData)),
  ]);

  const managerNameMap = new Map<number, string>(
    [...managerInfoMap.entries()]
      .filter(([, v]) => v.managerFullName)
      .map(([k, v]) => [k, v.managerFullName!]),
  );

  const rows: IUnifiedRow[] = [];
  for (const data of departmentsData) {
    rows.push(...buildRowsForDepartment(data, objectAddressMap, currentActivityDeptIds, currentActivityEmpSets, managerNameMap, excludeCurrentActivity));
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
