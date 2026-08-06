import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildPresenceExportWorkbook } from './skud-presence-export-excel.service.js';
import type { IPresenceExportDay } from './skud-presence-export.service.js';

const meta = {
  dateFrom: '2026-08-03',
  dateTo: '2026-08-04',
  objectsLabel: 'все',
  groupsLabel: 'все',
};

const days: IPresenceExportDay[] = [
  {
    date: '2026-08-03',
    objects: [{
      object_key: 'obj-1',
      object_name: 'ЖК Alia',
      total: 1,
      groups: [{
        key: 'local:dept-a',
        name: 'бр.Тоштемиров',
        company_name: 'СУ-10',
        employees: [{ entry_time: '07:19:00', full_name: 'Первый Сотрудник' }],
      }],
    }],
  },
  {
    date: '2026-08-04',
    objects: [{
      object_key: 'obj-2',
      object_name: 'ЖК Инжой',
      total: 2,
      groups: [
        {
          key: 'local:dept-a',
          name: 'бр.Тоштемиров',
          company_name: 'СУ-10',
          employees: [{ entry_time: '07:53:22', full_name: 'Второй Сотрудник' }],
        },
        {
          key: 'local:dept-b',
          name: 'бр.Тоштемиров',
          company_name: 'ЛИНИЯ',
          employees: [{ entry_time: '08:05:00', full_name: 'Третий Сотрудник' }],
        },
      ],
    }],
  },
];

describe('buildPresenceExportWorkbook', () => {
  it('делает лист на каждый день в порядке возрастания даты', () => {
    const wb = buildPresenceExportWorkbook(days, meta);
    expect(wb.worksheets.map(ws => ws.name)).toEqual(['03.08.2026', '04.08.2026']);
  });

  it('шапка занимает строки 1–3, данные начинаются с 4-й', () => {
    const ws = buildPresenceExportWorkbook(days, meta).getWorksheet('03.08.2026')!;
    expect(ws.getRow(1).getCell(2).value).toBe('Сотрудники на объектах — 03.08.2026');
    expect(String(ws.getRow(2).getCell(2).value)).toContain('Период 03.08.2026–04.08.2026');
    expect(ws.getRow(3).getCell(2).value).toBe('Дата и время входа');
    expect(ws.getRow(3).getCell(3).value).toBe('ФИО');
    expect(ws.getRow(4).getCell(2).value).toBe('ЖК Alia');
    expect(ws.getRow(4).getCell(3).value).toBe(1);
  });

  it('уровни группировки 0/1/2, строки сотрудников свёрнуты', () => {
    const ws = buildPresenceExportWorkbook(days, meta).getWorksheet('03.08.2026')!;
    expect(ws.getRow(4).outlineLevel).toBe(0);           // объект
    expect(ws.getRow(5).outlineLevel).toBe(1);           // отдел
    expect(ws.getRow(6).outlineLevel).toBe(2);           // сотрудник
    expect(ws.getRow(6).hidden).toBe(true);
    expect(ws.getRow(5).hidden).toBeFalsy();
  });

  it('строка сотрудника — «дата время» и ФИО (час без ведущего нуля)', () => {
    const ws = buildPresenceExportWorkbook(days, meta).getWorksheet('04.08.2026')!;
    expect(ws.getRow(6).getCell(2).value).toBe('04.08.2026 7:53:22');
    expect(ws.getRow(6).getCell(3).value).toBe('Второй Сотрудник');
  });

  it('одноимённые отделы разных компаний подписаны через компанию', () => {
    const ws = buildPresenceExportWorkbook(days, meta).getWorksheet('04.08.2026')!;
    expect(ws.getRow(5).getCell(2).value).toBe('СУ-10 → бр.Тоштемиров');
    expect(ws.getRow(7).getCell(2).value).toBe('ЛИНИЯ → бр.Тоштемиров');
  });

  it('round-trip: outline и dyDescent переживают запись/чтение (баг ExcelJS 4.4.0)', async () => {
    const buffer = await buildPresenceExportWorkbook(days, meta).xlsx.writeBuffer();
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(buffer as ArrayBuffer);

    const ws = reopened.getWorksheet('03.08.2026')!;
    expect(ws.properties.outlineProperties).toMatchObject({ summaryBelow: false, summaryRight: false });
    expect(ws.properties.dyDescent).toBe(0.25);
    expect(ws.getRow(5).outlineLevel).toBe(1);
    expect(ws.getRow(6).outlineLevel).toBe(2);
    expect(ws.getRow(6).hidden).toBe(true);
  });
});
