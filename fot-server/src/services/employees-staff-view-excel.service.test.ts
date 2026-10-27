import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildStaffViewWorkbook,
  parseStaffViewColumns,
  STAFF_VIEW_DEFAULT_COLUMNS,
  STAFF_VIEW_OPTIONAL_COLUMNS,
  type IStaffViewExportRow,
} from './employees-staff-view-excel.service.js';

const ROW: IStaffViewExportRow = {
  fullName: 'Абаев А.',
  department: 'бр.Баротов З.Б.',
  site: '=Журавлев В. С.',
  position: 'Монтажник',
  hireDate: '2026-09-01',
  birthDate: '1990-05-17',
  schedule: '6+0 (10ч)',
  object: 'ЖК Альфа',
  comment: 'проверить',
  sign: 'Работает',
};

const headers = (ws: ExcelJS.Worksheet): unknown[] => (ws.getRow(1).values as unknown[]).slice(1);

describe('parseStaffViewColumns', () => {
  it('нет параметра — прежний набор без участка; пусто — ничего; порядок — экрана, повторы схлопнуты', () => {
    expect(parseStaffViewColumns(undefined)).toEqual({ ok: true, columns: [...STAFF_VIEW_DEFAULT_COLUMNS] });
    expect(STAFF_VIEW_DEFAULT_COLUMNS).not.toContain('site');
    expect(parseStaffViewColumns('')).toEqual({ ok: true, columns: [] });
    expect(parseStaffViewColumns('comment, site,department,site')).toEqual({ ok: true, columns: ['department', 'site', 'comment'] });
  });

  it('неизвестный ключ, массив, не строка, длина — ошибка', () => {
    for (const raw of ['sign', 'name', 'site;department', ['site'], 1, 'x'.repeat(201)]) {
      expect(parseStaffViewColumns(raw)).toEqual({ ok: false });
    }
  });
});

describe('buildStaffViewWorkbook', () => {
  it('прежние 10 колонок при наборе по умолчанию', () => {
    const ws = buildStaffViewWorkbook([ROW], STAFF_VIEW_DEFAULT_COLUMNS).worksheets[0];
    expect(headers(ws)).toEqual([
      '№', 'ФИО', 'Отдел', 'Должность', 'Дата трудоустройства', 'Дата рождения', 'График', 'Объект', 'Комментарий', 'Признак',
    ]);
    expect(ws.getColumn(3).width).toBe(36);
    expect(ws.getColumn(10).width).toBe(12);
  });

  it('участок — между отделом и должностью, защищён от формул, ширины по ключам', () => {
    const ws = buildStaffViewWorkbook([ROW], STAFF_VIEW_OPTIONAL_COLUMNS).worksheets[0];
    expect(headers(ws).slice(0, 5)).toEqual(['№', 'ФИО', 'Отдел', 'Участок', 'Должность']);
    expect(ws.getRow(2).getCell(4).value).toBe("'=Журавлев В. С.");
    expect(ws.getColumn(4).width).toBe(28);
    expect(ws.getColumn(5).width).toBe(32);
    expect(headers(ws)).toHaveLength(11);
  });

  it('только №, ФИО, Признак', () => {
    const ws = buildStaffViewWorkbook([ROW], []).worksheets[0];
    expect(headers(ws)).toEqual(['№', 'ФИО', 'Признак']);
    expect(ws.getRow(2).getCell(3).value).toBe('Работает');
  });

  it('после перестановки даты остаются датами, перенос — у комментария', () => {
    const ws = buildStaffViewWorkbook([ROW], ['birth_date', 'comment']).worksheets[0];
    expect(headers(ws)).toEqual(['№', 'ФИО', 'Дата рождения', 'Комментарий', 'Признак']);
    const row = ws.getRow(2);
    expect(row.getCell(3).value).toEqual(new Date(Date.UTC(1990, 4, 17)));
    expect(row.getCell(3).numFmt).toBe('dd.mm.yyyy');
    expect(row.getCell(4).alignment).toMatchObject({ wrapText: true });
    expect(row.getCell(5).alignment?.wrapText).toBeFalsy();
  });
});
