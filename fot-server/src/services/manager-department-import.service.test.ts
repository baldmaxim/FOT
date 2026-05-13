import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx, mockedState } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
  mockedState: {
    departments: [] as Array<{
      id: string;
      name: string;
      is_active: boolean;
    }>,
    employees: [] as Array<{
      id: number;
      full_name: string;
      org_department_id: string | null;
      is_archived: boolean;
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
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
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
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.departments = [];
    mockedState.employees = [];
    mockedState.employeeAliases = [];
    mockedState.brigadeAliases = [];

    // Dispatch by SQL fragment. Source service uses query<>() for all SELECTs.
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/FROM org_departments/i.test(sql)) {
        return mockedState.departments.filter(row => row.is_active);
      }
      if (/FROM employees\b/i.test(sql)) {
        return mockedState.employees;
      }
      if (/FROM manager_department_import_employee_aliases/i.test(sql)) {
        const sourceType = params?.[0];
        return mockedState.employeeAliases.filter(
          row => row.source_type === sourceType && row.is_active,
        );
      }
      if (/FROM manager_department_import_brigade_aliases/i.test(sql)) {
        const sourceType = params?.[0];
        return mockedState.brigadeAliases.filter(
          row => row.source_type === sourceType && row.is_active,
        );
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
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

    // Sanity: validate that service hit the new pg.Pool helpers (not legacy supabase).
    const sqls = pgQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /FROM org_departments/i.test(s))).toBe(true);
    expect(sqls.some(s => /FROM manager_department_import_employee_aliases/i.test(s))).toBe(true);
    expect(sqls.some(s => /FROM manager_department_import_brigade_aliases/i.test(s))).toBe(true);
  });
});
