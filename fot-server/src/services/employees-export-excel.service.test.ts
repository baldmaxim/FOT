import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildEmployeesExportWorkbook,
  DATE_NUM_FMT,
  isoDateToExcelDate,
} from './employees-export-excel.service.js';
import type { IExportFlatRow, IExportSection } from './employees-export.service.js';

const HEADERS = [
  '№', 'ФИО', 'Подразделение', 'Должность', 'Дата рождения',
  'Дата трудоустройства', 'Объект', 'Признак', 'Статья затрат',
];

const row = (partial: Partial<IExportFlatRow> & { employeeId: number; fullName: string }): IExportFlatRow => ({
  departmentPath: '',
  positionName: '',
  birthDate: null,
  hireDate: null,
  objectName: '',
  sign: 'Работает',
  ...partial,
});

const SECTIONS: IExportSection[] = [
  {
    key: 'sm',
    title: 'СМ',
    tableName: 'Employees_SM',
    rows: [row({ employeeId: 1, fullName: 'Механиков М. М.', departmentPath: 'Отдел автотехники' })],
  },
  {
    key: 'su10',
    title: 'СУ-10',
    tableName: 'Employees_SU10',
    rows: [
      row({
        employeeId: 2,
        fullName: 'Петров П. П.',
        departmentPath: 'Отдел вентиляции',
        positionName: 'Монтажник',
        birthDate: '2026-03-05',
        hireDate: '2024-12-31',
        objectName: 'ЖК Север',
        sign: 'Уволен',
      }),
      row({ employeeId: 3, fullName: '=cmd|calc', departmentPath: '+1+1', objectName: '@SUM(A1)' }),
    ],
  },
  {
    key: 'contractors',
    title: 'Подрядные организации',
    tableName: 'Employees_Contractors',
    rows: [row({ employeeId: 4, fullName: 'Подрядчиков П. П.' })],
  },
];

const META = {
  period: { start: '2026-08-16', end: '2026-09-14' },
  generatedAt: new Date('2026-09-14T12:34:00'),
};

const loadBack = async (workbook: ExcelJS.Workbook): Promise<ExcelJS.Workbook> => {
  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer as ArrayBuffer);
  return reloaded;
};

interface ITableModelLike {
  name: string;
  tableRef?: string;
  ref?: string;
  columns: Array<{ name: string; filterButton?: boolean }>;
}

const tableOf = (ws: ExcelJS.Worksheet): ITableModelLike => {
  const tables = (ws as unknown as { tables: Record<string, { model?: ITableModelLike } & ITableModelLike> }).tables;
  const [first] = Object.values(tables);
  if (!first) throw new Error(`Нет таблицы на листе ${ws.name}`);
  return first.model ?? first;
};

describe('isoDateToExcelDate', () => {
  it('UTC-полночь без сдвига дня', () => {
    expect(isoDateToExcelDate('2026-03-05')?.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });

  it('null и мусор — null', () => {
    expect(isoDateToExcelDate(null)).toBeNull();
    expect(isoDateToExcelDate('05.03.2026')).toBeNull();
  });
});

describe('buildEmployeesExportWorkbook', () => {
  it('лист на раздел в переданном порядке', () => {
    const workbook = buildEmployeesExportWorkbook(SECTIONS, META);
    expect(workbook.worksheets.map(ws => ws.name)).toEqual(['СМ', 'СУ-10', 'Подрядные организации']);
  });

  it('заголовок и пояснение с периодом над таблицей', () => {
    const ws = buildEmployeesExportWorkbook(SECTIONS, META).getWorksheet('СУ-10')!;
    expect(ws.getCell(1, 1).value).toBe('Сотрудники: СУ-10');
    const meta = String(ws.getCell(2, 1).value);
    expect(meta).toContain('Всего: 2');
    expect(meta).toContain('16.08.2026–14.09.2026');
  });

  it('round-trip: умные таблицы с фиксированными именами, заголовками и кнопками фильтра', async () => {
    const workbook = await loadBack(buildEmployeesExportWorkbook(SECTIONS, META));

    const names = workbook.worksheets.map(ws => tableOf(ws).name);
    expect(names).toEqual(['Employees_SM', 'Employees_SU10', 'Employees_Contractors']);

    for (const ws of workbook.worksheets) {
      const table = tableOf(ws);
      expect(table.columns.map(column => column.name)).toEqual(HEADERS);
      expect(table.columns.every(column => column.filterButton === true)).toBe(true);
      expect(ws.getRow(3).values).toEqual([undefined, ...HEADERS]);
    }

    const su10 = tableOf(workbook.getWorksheet('СУ-10')!);
    expect(su10.tableRef ?? su10.ref).toMatch(/^A3:I5$/);
  });

  it('round-trip: строки данных, даты — конкретный день с форматом dd.mm.yyyy', async () => {
    const workbook = await loadBack(buildEmployeesExportWorkbook(SECTIONS, META));
    const ws = workbook.getWorksheet('СУ-10')!;
    const data = ws.getRow(4);

    expect(data.getCell(1).value).toBe(1);
    expect(data.getCell(2).value).toBe('Петров П. П.');
    expect(data.getCell(3).value).toBe('Отдел вентиляции');
    expect(data.getCell(4).value).toBe('Монтажник');
    expect(data.getCell(7).value).toBe('ЖК Север');
    expect(data.getCell(8).value).toBe('Уволен');

    const birth = data.getCell(5);
    expect(birth.value).toBeInstanceOf(Date);
    expect((birth.value as Date).toISOString().slice(0, 10)).toBe('2026-03-05');
    expect(birth.numFmt).toBe(DATE_NUM_FMT);

    const hire = data.getCell(6);
    expect((hire.value as Date).toISOString().slice(0, 10)).toBe('2024-12-31');
    expect(hire.numFmt).toBe(DATE_NUM_FMT);

    // Пустые даты остаются пустыми ячейками.
    expect(ws.getRow(5).getCell(5).value).toBeNull();
  });

  it('обезвреживает формулы в текстовых ячейках', async () => {
    const ws = (await loadBack(buildEmployeesExportWorkbook(SECTIONS, META))).getWorksheet('СУ-10')!;
    const suspicious = ws.getRow(5);

    expect(String(suspicious.getCell(2).value)).not.toMatch(/^=/);
    expect(String(suspicious.getCell(3).value)).not.toMatch(/^\+/);
    expect(String(suspicious.getCell(7).value)).not.toMatch(/^@/);
    expect(suspicious.getCell(2).formula).toBeUndefined();
  });

  it('без разделов — книга без листов', () => {
    expect(buildEmployeesExportWorkbook([], META).worksheets).toHaveLength(0);
  });
});
