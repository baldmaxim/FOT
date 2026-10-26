/**
 * Лист снимка в книге: несколько таблиц — несколько листов (карточка сотрудника «Зарплаты»),
 * деньги — числом с форматом, подпись в денежном столбце — текстом, как на экране.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import { addTableSnapshotSheet, buildTableSnapshotWorkbook } from './table-snapshot-excel.service.js';

const termsTable = {
  title: 'Иванов Иван',
  subtitle: 'Отдел · Монтажник · Условия на 26.10.2026',
  columns: [
    { label: 'Показатель', type: 'text' as const },
    { label: 'Значение', type: 'money' as const },
  ],
  rows: [
    { cells: ['Категория', 'Рабочие'] },
    { cells: ['Оклад, ₽/мес', 147240.33] },
    { cells: ['Действует с', '01.09.2026'] },
  ],
};

const historyTable = {
  title: 'История выплат',
  subtitle: 'Иванов Иван',
  columns: [
    { label: 'Месяц', type: 'text' as const },
    { label: 'Начислено', type: 'money' as const },
  ],
  rows: [{ cells: ['Август 2026', '151400.33'] }, { cells: ['Итого', 151400.33] }],
};

describe('addTableSnapshotSheet', () => {
  it('две таблицы — два листа в порядке вызова, у каждого своя умная таблица', () => {
    const workbook = new ExcelJS.Workbook();
    addTableSnapshotSheet(workbook, termsTable, { sheetName: 'Условия', tableName: 'PayrollTerms' });
    addTableSnapshotSheet(workbook, historyTable, { sheetName: 'История выплат', tableName: 'PaidHistory' });

    expect(workbook.worksheets.map(ws => ws.name)).toEqual(['Условия', 'История выплат']);
    expect(workbook.getWorksheet('Условия')?.getTable('PayrollTerms')).toBeDefined();
    expect(workbook.getWorksheet('История выплат')?.getTable('PaidHistory')).toBeDefined();
  });

  it('денежный столбец: число — с форматом копеек, подпись и дата — текстом', () => {
    const workbook = new ExcelJS.Workbook();
    addTableSnapshotSheet(workbook, termsTable, { sheetName: 'Условия', tableName: 'PayrollTerms' });
    const ws = workbook.getWorksheet('Условия')!;

    // Шапка таблицы — 3-я строка, данные с 4-й.
    expect(ws.getCell('B4').value).toBe('Рабочие');
    expect(ws.getCell('B5').value).toBe(147240.33);
    expect(ws.getCell('B5').numFmt).toBe('#,##0.00');
    expect(ws.getCell('B6').value).toBe('01.09.2026');
    expect(ws.getCell('A1').value).toBe('Иванов Иван');
  });

  it('numeric строкой из PostgreSQL — число', () => {
    const workbook = new ExcelJS.Workbook();
    addTableSnapshotSheet(workbook, historyTable, { sheetName: 'История выплат', tableName: 'PaidHistory' });
    expect(workbook.getWorksheet('История выплат')!.getCell('B4').value).toBe(151400.33);
  });
});

describe('buildTableSnapshotWorkbook', () => {
  it('одна таблица — книга из одного листа, как раньше', () => {
    const workbook = buildTableSnapshotWorkbook(historyTable, { sheetName: 'Свод', tableName: 'PayrollSummary' });
    expect(workbook.worksheets.map(ws => ws.name)).toEqual(['Свод']);
  });
});
