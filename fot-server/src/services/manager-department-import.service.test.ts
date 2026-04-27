import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { message?: string } | null;
};

const mockedState = vi.hoisted(() => ({
  departments: [] as Array<{
    id: string;
    name: string;
    is_active: boolean;
  }>,
  employeeAliases: [] as Array<{
    source_type: string;
    section_name_normalized: string;
    manager_name_normalized: string;
    employee_id: number;
    is_active: boolean;
  }>,
  brigadeAliases: [] as Array<{
    source_type: string;
    section_name_normalized: string;
    brigade_name_normalized: string;
    department_id: string;
    is_active: boolean;
  }>,
}));

function matchesQueryRecord<T extends Record<string, unknown>>(row: T, query: QueryRecord): boolean {
  return query.operations.every((operation) => {
    if (operation.method === 'eq') {
      const [field, value] = operation.args;
      return row[String(field)] === value;
    }

    if (operation.method === 'in') {
      const [field, values] = operation.args;
      return Array.isArray(values) && values.includes(row[String(field)]);
    }

    return true;
  });
}

function resolveQuery(query: QueryRecord): QueryResponse {
  if (query.table === 'org_departments') {
    return {
      data: mockedState.departments.filter(row => matchesQueryRecord(row, query)),
      error: null,
    };
  }

  if (query.table === 'manager_department_import_employee_aliases') {
    return {
      data: mockedState.employeeAliases.filter(row => matchesQueryRecord(row, query)),
      error: null,
    };
  }

  if (query.table === 'manager_department_import_brigade_aliases') {
    return {
      data: mockedState.brigadeAliases.filter(row => matchesQueryRecord(row, query)),
      error: null,
    };
  }

  throw new Error(`Unexpected query for table ${query.table}`);
}

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveQuery(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

import { buildManagerDepartmentImportPreviewFromBuffer } from './manager-department-import.service.js';

async function buildWorkbookBuffer(): Promise<Buffer> {
  // Multi-column формат: B3='Тип' маркер; начиная с row 4 col B = тип, col C = имя.
  // Имя менеджера в скобках содержит «N. <название участка>», его выделяет
  // parseSectionFromManagerRow, см. manager-department-import.service.ts.
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');

  worksheet.getCell('B3').value = 'Тип';
  worksheet.getCell('C3').value = 'Имя';

  worksheet.getCell('B4').value = 'нач.уч.';
  worksheet.getCell('C4').value = 'Иванов И.И. (1. Участок 1)';

  worksheet.getCell('B5').value = 'бригада';
  worksheet.getCell('C5').value = 'Проблемная бригада';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('manager-department-import.service', () => {
  beforeEach(() => {
    mockedState.departments = [];
    mockedState.employeeAliases = [];
    mockedState.brigadeAliases = [];
  });

  it('reuses saved employee and brigade aliases on repeated preview', async () => {
    mockedState.departments = [
      { id: 'dept-1', name: 'Наше внутреннее название отдела', is_active: true },
    ];
    mockedState.employeeAliases = [
      {
        source_type: 'manager_excel_admin_ui',
        section_name_normalized: 'участок 1',
        manager_name_normalized: 'иванов и.и.',
        employee_id: 42,
        is_active: true,
      },
    ];
    mockedState.brigadeAliases = [
      {
        source_type: 'manager_excel_admin_ui',
        section_name_normalized: 'участок 1',
        brigade_name_normalized: 'проблемная бригада',
        department_id: 'dept-1',
        is_active: true,
      },
    ];

    const preview = await buildManagerDepartmentImportPreviewFromBuffer(await buildWorkbookBuffer());

    expect(preview.stats).toEqual({
      total_groups: 1,
      total_links: 1,
      resolved_links: 1,
      unresolved_links: 0,
    });
    expect(preview.groups[0]?.saved_employee_id).toBe(42);
    expect(preview.groups[0]?.resolved_department_ids).toEqual(['dept-1']);
    expect(preview.groups[0]?.brigades[0]).toMatchObject({
      brigade_name: 'Проблемная бригада',
      status: 'matched',
      department_id: 'dept-1',
      department_name: 'Наше внутреннее название отдела',
    });
  });
});
