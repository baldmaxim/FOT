import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  averageOfActiveDays,
  buildPresenceMonthStatsWorkbook,
} from './skud-presence-month-stats-excel.service.js';
import type { IPresenceMonthStats } from './skud-presence-month-stats.service.js';

/**
 * Эталон книги «Статистика за месяц»: листы, шапка, закрепление, свёрнутые компании,
 * «Среднее», «Всего», лист «Список». И регресс: <sheetPr> без pageSetUpPr — иначе
 * Excel пишет «Ошибка в части содержимого» и чинит книгу.
 */

const stats: IPresenceMonthStats = {
  // 05.09.2026 — суббота.
  dates: ['2026-09-04', '2026-09-05', '2026-09-06'],
  objects: [
    {
      key: 'obj-1',
      name: 'ЖК Alia',
      counts: [3, 0, 2],
      companies: [
        { key: 'local:c-podr', name: 'Подрядные организации', counts: [2, 0, 1] },
        { key: 'local:c-su10', name: '(СУ-10) ООО СУ-10', counts: [1, 0, 1] },
      ],
    },
    {
      key: 'obj-2',
      name: '=ЖК Инжой',
      counts: [1, 1, 0],
      companies: [{ key: 'local:c-su10', name: '(СУ-10) ООО СУ-10', counts: [1, 1, 0] }],
    },
  ],
  total: [3, 1, 2],
};

const meta = { monthLabel: 'Сентябрь 2026', objectsLabel: 'все' };

const roundTrip = async () => {
  const buffer = Buffer.from(await buildPresenceMonthStatsWorkbook(stats, meta).xlsx.writeBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { buffer, workbook };
};

describe('averageOfActiveDays', () => {
  it('знаменатель — дни, когда кто-то был; без таких дней — null', () => {
    expect(averageOfActiveDays([3, 0, 2])).toBe(2.5);
    expect(averageOfActiveDays([0, 0])).toBeNull();
  });
});

describe('buildPresenceMonthStatsWorkbook', () => {
  it('лист месяца: заголовок, шапка, закрепление, строки и итог', async () => {
    const { workbook } = await roundTrip();
    expect(workbook.worksheets.map(ws => ws.name)).toEqual(['Сентябрь 2026', 'Список']);

    const ws = workbook.getWorksheet('Сентябрь 2026')!;
    expect(ws.getCell('A1').value).toBe('Сотрудники на объектах — сентябрь 2026');
    expect(ws.getCell('A3').value).toBe('Объекты: все');
    expect(ws.getRow(4).values).toEqual([
      undefined, 'Объект / компания', '04.09\nпт', '05.09\nсб', '06.09\nвс', 'Среднее\nв день', 'Макси-\nмум',
    ]);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 4 });

    const rows = [5, 6, 7, 8, 9, 10].map(n => ws.getRow(n));
    expect(rows.map(r => r.getCell(1).value)).toEqual([
      'ЖК Alia', 'Подрядные организации', '(СУ-10) ООО СУ-10',
      "'=ЖК Инжой", '(СУ-10) ООО СУ-10',
      'Всего на объектах (уникальных людей)',
    ]);
    expect(rows.map(r => r.outlineLevel ?? 0)).toEqual([0, 1, 1, 0, 1, 0]);
    expect(rows.map(r => !!r.hidden)).toEqual([false, true, true, false, true, false]);

    // ЖК Alia: 3, 0, 2 → среднее по дням с людьми 2.5, максимум 3.
    expect([2, 3, 4, 5, 6].map(c => rows[0].getCell(c).value)).toEqual([3, 0, 2, 2.5, 3]);
    // «Всего» — из stats.total, а не сумма объектов (4, 1, 2).
    expect([2, 3, 4].map(c => rows[5].getCell(c).value)).toEqual([3, 1, 2]);
  });

  it('лист «Список»: строка на дату/объект/компанию с числом > 0, дата — датой', async () => {
    const { workbook } = await roundTrip();
    const ws = workbook.getWorksheet('Список')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Дата', 'День недели', 'Объект', 'Компания', 'Сотрудников']);
    const body = ws.getSheetValues().slice(2).map(row => (row as unknown[]).slice(2));
    expect(body).toEqual([
      ['пт', 'ЖК Alia', 'Подрядные организации', 2],
      ['пт', 'ЖК Alia', '(СУ-10) ООО СУ-10', 1],
      ['пт', "'=ЖК Инжой", '(СУ-10) ООО СУ-10', 1],
      ['сб', "'=ЖК Инжой", '(СУ-10) ООО СУ-10', 1],
      ['вс', 'ЖК Alia', 'Подрядные организации', 1],
      ['вс', 'ЖК Alia', '(СУ-10) ООО СУ-10', 1],
    ]);
    const dateCell = ws.getCell('A2');
    expect(dateCell.value).toEqual(new Date('2026-09-04T00:00:00Z'));
    expect(dateCell.numFmt).toBe('dd.mm.yyyy');
    expect(ws.autoFilter).toBeDefined();
  });

  it('XML: <sheetPr> только с outlinePr — Excel не предлагает восстановить книгу', async () => {
    const { buffer } = await roundTrip();
    const zip = await JSZip.loadAsync(buffer);
    const sheet1 = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet1).toMatch(/<sheetPr><outlinePr summaryBelow="0" summaryRight="0"\/><\/sheetPr>/);
    expect(sheet1).not.toContain('pageSetUpPr');
    // Ширина последнего столбца записана (ровно 9 ExcelJS пропускает).
    expect(sheet1).toContain('<col min="6" max="6" width="9.5" customWidth="1"/>');
  });
});
