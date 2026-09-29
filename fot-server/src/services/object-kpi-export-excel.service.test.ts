/**
 * Экспорт «KPI объектов»: лист собирается из снимка таблицы экрана. Проверяем, что суммы
 * становятся числами с денежным форматом, процент — долей, подписи экрана в числовом
 * столбце («—», «нет шкалы») остаются текстом, прогноз серый, а формулы обезврежены.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';

import { buildObjectKpiExportWorkbook, toExcelCellValue } from './object-kpi-export-excel.service.js';

const readBack = async (workbook: ExcelJS.Workbook): Promise<ExcelJS.Worksheet> => {
  // Через буфер: так ловится и «Excel не откроет файл» (битая умная таблица).
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  return loaded.worksheets[0];
};

describe('toExcelCellValue', () => {
  it('деньги строкой numeric → число, процент → доля', () => {
    expect(toExcelCellValue('money', '5843093950.12')).toBe(5843093950.12);
    expect(toExcelCellValue('money', 184675122)).toBe(184675122);
    expect(toExcelCellValue('percent', '147.52')).toBeCloseTo(1.4752, 10);
    expect(toExcelCellValue('int', 8)).toBe(8);
  });

  it('подпись экрана в числовом столбце остаётся текстом', () => {
    expect(toExcelCellValue('money', 'нет шкалы')).toBe('нет шкалы');
    expect(toExcelCellValue('money', '—')).toBe('—');
    expect(toExcelCellValue('percent', null)).toBeNull();
  });

  it('текст обезвреживается от формул', () => {
    expect(toExcelCellValue('text', '=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    // Текстовый столбец не превращает цифры в число: «Мес.» и суммы идут своими типами.
    expect(toExcelCellValue('text', '123')).toBe('123');
  });
});

describe('buildObjectKpiExportWorkbook', () => {
  it('заголовок, период, шапка таблицы и строки в порядке снимка', async () => {
    const ws = await readBack(buildObjectKpiExportWorkbook({
      title: 'KPI объектов — Все объекты',
      subtitle: 'Период: август 2026. Все суммы — в рублях, с НДС.',
      columns: [
        { label: '№', type: 'int' },
        { label: 'Объект', type: 'text' },
        { label: 'КС-2', type: 'money' },
        { label: '%', type: 'percent' },
      ],
      rows: [
        { cells: [1, 'ЖК Сад 69', '924579186.00', '33.1'] },
        { cells: [2, 'База Химки', '708900000.00', null] },
      ],
    }));

    expect(ws.getCell('A1').value).toBe('KPI объектов — Все объекты');
    expect(ws.getCell('A2').value).toBe('Период: август 2026. Все суммы — в рублях, с НДС.');
    expect(ws.getRow(3).values).toEqual([undefined, '№', 'Объект', 'КС-2', '%']);
    expect(ws.getCell('B4').value).toBe('ЖК Сад 69');
    expect(ws.getCell('C4').value).toBe(924579186);
    expect(ws.getCell('C4').numFmt).toBe('#,##0.00');
    expect(ws.getCell('D4').value).toBeCloseTo(0.331, 10);
    expect(ws.getCell('D4').numFmt).toBe('0.0%');
    expect(ws.getCell('B5').value).toBe('База Химки');
    expect(ws.getCell('D5').value).toBeNull();
  });

  it('прогнозная строка — серым шрифтом, обычная — без цвета', async () => {
    const ws = await readBack(buildObjectKpiExportWorkbook({
      title: 'KPI объектов — ЖК Дом 56',
      subtitle: 'Период: июль 2026 — сентябрь 2026. Все суммы — в рублях, с НДС.',
      columns: [
        { label: 'Премия', type: 'money' },
        { label: 'Месяц', type: 'text' },
      ],
      rows: [
        { cells: ['300000.00', 'июль 2026'] },
        { cells: ['—', 'октябрь 2026'], muted: true },
      ],
    }));

    expect(ws.getCell('A4').value).toBe(300000);
    expect(ws.getCell('A4').font?.color?.argb).not.toBe('FF808080');
    expect(ws.getCell('A5').value).toBe('—');
    expect(ws.getCell('B5').font?.color?.argb).toBe('FF808080');
  });
});
