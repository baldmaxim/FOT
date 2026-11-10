import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildContractorDocsWorkbook,
  formatSnils,
  type IContractorDocsExportRow,
} from './contractor-docs-export.service.js';

const row = (over: Partial<IContractorDocsExportRow> = {}): IContractorDocsExportRow => ({
  pass_number: '587',
  w26: '39,31800',
  holder_name: 'Шербеков Хайдарали Аскарджонович',
  is_active: false,
  expires_at: '2026-12-31',
  object_label: '',
  access_point_names: ['ЗилАрт-2'],
  citizenship: 'Таджикистан',
  passport_series_number: '403934253',
  passport_issue_date: '2022-05-04',
  birth_date: '1995-08-07',
  has_residence_permit: false,
  residence_permit_number: null,
  patent_number: '77 №2600177930',
  patent_issue_date: '2026-04-13',
  patent_blank_number: 'ПР7619622',
  snils: '01234567890',
  inn: '012345678901',
  kig: 'AB1234567',
  kig_end_date: '2027-03-01',
  ...over,
});

/** Книга → обратно через ExcelJS, как её прочтёт Excel. */
const roundTrip = async (rows: IContractorDocsExportRow[]): Promise<ExcelJS.Worksheet> => {
  const buf = await buildContractorDocsWorkbook(rows).xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  return wb.getWorksheet('Документы')!;
};

describe('contractor-docs-export', () => {
  it('порядок столбцов фиксирован', async () => {
    const ws = await roundTrip([row()]);
    const headers = (ws.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      '№ пропуска', 'W26', 'ФИО', 'Активен', 'Срок', 'Объекты', 'Точки', 'Гражданство',
      'Паспорт серия номер', 'Дата выдачи документа', 'Дата рождения', 'ВНЖ', 'Номер ВНЖ',
      'Номер патента', 'Дата выдачи патента', 'Номер бланка', 'СНИЛС', 'ИНН', 'Номер КиГ',
      'КиГ действует до',
    ]);
  });

  it('номера — текстом (ведущие нули целы), СНИЛС с маской', async () => {
    const ws = await roundTrip([row()]);
    const r = ws.getRow(2);
    expect(r.getCell(9).value).toBe('403934253');
    expect(r.getCell(17).value).toBe('012-345-678 90');
    expect(r.getCell(18).value).toBe('012345678901');
    expect(r.getCell(14).value).toBe('77 №2600177930');
  });

  it('даты — настоящие даты верного дня в формате дд.мм.гггг', async () => {
    const ws = await roundTrip([row()]);
    const cell = ws.getRow(2).getCell(10);
    expect(cell.value).toBeInstanceOf(Date);
    expect((cell.value as Date).toISOString().slice(0, 10)).toBe('2022-05-04');
    expect(cell.numFmt).toBe('dd.mm.yyyy');
    expect((ws.getRow(2).getCell(20).value as Date).toISOString().slice(0, 10)).toBe('2027-03-01');
  });

  it('пустые поля — пустые ячейки, ВНЖ «да» только при отметке, активен «да/нет»', async () => {
    const ws = await roundTrip([
      row({ snils: null, kig: null, kig_end_date: null }),
      row({ has_residence_permit: true, residence_permit_number: '82№1234567', is_active: true }),
    ]);
    expect(ws.getRow(2).getCell(17).value).toBeNull();
    expect(ws.getRow(2).getCell(12).value).toBeNull();
    expect(ws.getRow(2).getCell(4).value).toBe('нет');
    expect(ws.getRow(3).getCell(12).value).toBe('да');
    expect(ws.getRow(3).getCell(4).value).toBe('да');
  });

  it('шапка закреплена и есть автофильтр на все строки', async () => {
    const ws = await roundTrip([row(), row({ pass_number: '588' })]);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
  });

  it('formatSnils: 11 цифр → маска, иное как есть', () => {
    expect(formatSnils('12345678900')).toBe('123-456-789 00');
    expect(formatSnils('123')).toBe('123');
    expect(formatSnils(null)).toBeNull();
  });
});
