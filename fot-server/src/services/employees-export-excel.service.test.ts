import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildEmployeesExportWorkbook } from './employees-export-excel.service.js';
import type { IExportNode, IExportEmployeeRow } from './employees-export.service.js';

const emp = (id: number, full_name: string): IExportEmployeeRow =>
  ({ id, full_name, org_department_id: null });

const node = (partial: Partial<IExportNode> & { name: string; depth: number }): IExportNode => ({
  id: partial.id ?? partial.name,
  name: partial.name,
  depth: partial.depth,
  ownCount: partial.employees?.length ?? 0,
  total: partial.total ?? partial.employees?.length ?? 0,
  employees: partial.employees ?? [],
  children: partial.children ?? [],
});

const META = { total: 3, generatedAt: new Date('2026-09-10T12:34:00') };

/** Компания → отдел → сотрудники. */
const sampleTree = (): IExportNode[] => [
  node({
    name: 'СУ-10',
    depth: 0,
    total: 2,
    children: [
      node({
        name: 'Отдел вентиляции',
        depth: 1,
        total: 2,
        employees: [emp(1, 'Петров П. П.'), emp(2, 'Сидоров С. С.')],
      }),
    ],
  }),
];

const loadBack = async (workbook: ExcelJS.Workbook): Promise<ExcelJS.Worksheet> => {
  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer as ArrayBuffer);
  const ws = reloaded.getWorksheet('Сотрудники');
  if (!ws) throw new Error('Лист «Сотрудники» не найден');
  return ws;
};

describe('buildEmployeesExportWorkbook', () => {
  it('пишет шапку из трёх строк, данные начинаются с четвёртой', () => {
    const ws = buildEmployeesExportWorkbook(sampleTree(), META).getWorksheet('Сотрудники')!;

    expect(String(ws.getRow(1).getCell(2).value)).toContain('Сотрудники по подразделениям');
    expect(String(ws.getRow(2).getCell(2).value)).toContain('Всего сотрудников: 3');
    expect(String(ws.getRow(2).getCell(2).value)).toContain('независимо от фильтров');
    expect(ws.getRow(3).getCell(2).value).toBe('Подразделение / ФИО');
    expect(ws.getRow(3).getCell(3).value).toBe('Сотрудников');
    expect(ws.getRow(4).getCell(2).value).toBe('СУ-10');
  });

  it('раскладывает уровни группировки и скрывает всё глубже компаний', () => {
    const ws = buildEmployeesExportWorkbook(sampleTree(), META).getWorksheet('Сотрудники')!;

    const company = ws.getRow(4);
    const department = ws.getRow(5);
    const employee = ws.getRow(6);

    expect(company.outlineLevel).toBe(0);
    expect(department.outlineLevel).toBe(1);
    expect(employee.outlineLevel).toBe(2);

    expect(company.hidden).toBeFalsy();
    expect(department.hidden).toBeFalsy();
    expect(employee.hidden).toBe(true);
  });

  it('счётчик в колонке C у групп, ФИО в колонке B у сотрудников', () => {
    const ws = buildEmployeesExportWorkbook(sampleTree(), META).getWorksheet('Сотрудники')!;

    expect(ws.getRow(4).getCell(3).value).toBe(2);
    expect(ws.getRow(5).getCell(3).value).toBe(2);
    expect(ws.getRow(6).getCell(2).value).toBe('Петров П. П.');
    expect(ws.getRow(6).getCell(3).value).toBeFalsy();
  });

  it('round-trip: outline, dyDescent и hidden переживают запись/чтение (баг ExcelJS 4.4.0)', async () => {
    const ws = await loadBack(buildEmployeesExportWorkbook(sampleTree(), META));

    expect(ws.properties.outlineProperties).toMatchObject({ summaryBelow: false, summaryRight: false });
    expect(ws.properties.dyDescent).toBe(0.25);
    expect(ws.getRow(4).outlineLevel).toBe(0);
    expect(ws.getRow(5).outlineLevel).toBe(1);
    expect(ws.getRow(6).outlineLevel).toBe(2);
    expect(ws.getRow(6).hidden).toBe(true);
  });

  it('ограничивает уровень 7 и не даёт сотруднику уровень его подразделения', () => {
    // Цепочка глубиной 10 — глубже, чем Excel умеет группировать.
    let deepest = node({ name: 'Уровень 9', depth: 9, total: 1, employees: [emp(1, 'Петров П. П.')] });
    for (let depth = 8; depth >= 0; depth -= 1) {
      deepest = node({ name: `Уровень ${depth}`, depth, total: 1, children: [deepest] });
    }

    const ws = buildEmployeesExportWorkbook([deepest], META).getWorksheet('Сотрудники')!;

    const groupLevels: number[] = [];
    let employeeLevel = -1;
    let deepestGroupLevel = -1;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= 3) return;
      const level = row.outlineLevel ?? 0;
      if (row.getCell(3).value === null || row.getCell(3).value === undefined) {
        employeeLevel = level; // строка сотрудника — без счётчика
      } else {
        groupLevels.push(level);
        deepestGroupLevel = level;
      }
    });

    expect(Math.max(...groupLevels)).toBeLessThanOrEqual(7);
    expect(employeeLevel).toBeLessThanOrEqual(7);
    expect(employeeLevel).toBeGreaterThan(deepestGroupLevel);
  });

  it('обезвреживает формулы в ФИО и названиях подразделений', () => {
    const tree = [
      node({
        name: '=cmd|calc',
        depth: 0,
        total: 1,
        employees: [emp(1, '+1+1')],
      }),
    ];

    const ws = buildEmployeesExportWorkbook(tree, META).getWorksheet('Сотрудники')!;

    expect(String(ws.getRow(4).getCell(2).value)).not.toMatch(/^=/);
    expect(String(ws.getRow(5).getCell(2).value)).not.toMatch(/^\+/);
  });

  it('пустое дерево даёт книгу с одной шапкой', () => {
    const ws = buildEmployeesExportWorkbook([], { total: 0, generatedAt: META.generatedAt })
      .getWorksheet('Сотрудники')!;

    expect(ws.rowCount).toBe(3);
  });
});
