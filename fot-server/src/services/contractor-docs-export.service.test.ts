import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildContractorDocsWorkbook,
  citizenshipOksm,
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
  position: 'бетонщик',
  ...over,
});

/** Книга → обратно через ExcelJS, как её прочтёт Excel. */
const loadBook = async (rows: IContractorDocsExportRow[]): Promise<ExcelJS.Workbook> => {
  const buf = await buildContractorDocsWorkbook(rows, 'АЛЬЯНС ООО').xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  return wb;
};

const roundTrip = async (rows: IContractorDocsExportRow[]): Promise<ExcelJS.Worksheet> =>
  (await loadBook(rows)).getWorksheet('Документы')!;

const biometry = async (rows: IContractorDocsExportRow[]): Promise<ExcelJS.Worksheet> =>
  (await loadBook(rows)).getWorksheet('Биометрия')!;

describe('contractor-docs-export', () => {
  it('порядок столбцов фиксирован', async () => {
    const ws = await roundTrip([row()]);
    const headers = (ws.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      '№ пропуска', 'W26', 'ФИО', 'Активен', 'Срок', 'Объекты', 'Точки', 'Гражданство',
      'Паспорт серия номер', 'Дата выдачи документа', 'Дата рождения', 'ВНЖ', 'Номер ВНЖ',
      'Номер патента', 'Дата выдачи патента', 'Номер бланка', 'СНИЛС', 'ИНН', 'Номер КиГ',
      'Должность',
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
    expect(ws.getRow(2).getCell(20).value).toBe('бетонщик');
  });

  it('пустые поля — пустые ячейки, ВНЖ «да» только при отметке, активен «да/нет»', async () => {
    const ws = await roundTrip([
      row({ snils: null, kig: null, position: null }),
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

  it('второй лист «Биометрия»: заголовки дословно как в образце', async () => {
    const wb = await loadBook([row()]);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Документы', 'Биометрия']);
    const headers = (wb.getWorksheet('Биометрия')!.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      'ФИО', 'Отдел', 'Должность', 'Табельный номер', 'Номер пропуска', 'КИГ', 'СНИЛС', 'Дата рождения',
      'Наименование организации', 'ИНН организации', 'КПП организации', 'Функциональные обязанности',
      'УИН объекта строительства', 'Гражданство', 'ИНН сотрудника', 'Биометрия',
    ]);
  });

  it('«Биометрия»: данные из «Документов», всё текстом, пустые столбцы без значений', async () => {
    const ws = await biometry([row({ kig: 'АВ1234567', pass_number: '098' })]);
    const r = ws.getRow(2);
    const v = (i: number) => r.getCell(i).value;
    expect(v(1)).toBe('Шербеков Хайдарали Аскарджонович');
    expect(v(2)).toBe('АЛЬЯНС ООО');
    expect(v(3)).toBe('бетонщик');
    expect(v(4)).toBeNull();
    expect(v(5)).toBe('098');
    expect(v(6)).toBe('AB1234567');
    expect(v(7)).toBe('012-345-678 90');
    expect(v(8)).toBe('07.08.1995');
    expect(v(9)).toBe('АЛЬЯНС ООО');
    for (const i of [10, 11, 12, 13]) expect(v(i)).toBeNull();
    expect(v(14)).toBe('762');
    expect(v(15)).toBe('012345678901');
    expect(v(16)).toBe('Да');
    for (let i = 1; i <= 16; i++) expect(r.getCell(i).numFmt).toBe('@');
  });

  it('«Биометрия»: строки те же, что на «Документах»; оформление шапки как в образце', async () => {
    const ws = await biometry([row(), row({ pass_number: '588', is_active: false })]);
    expect(ws.rowCount).toBe(3);
    const h = ws.getRow(1).getCell(1);
    expect(h.font).toMatchObject({ name: 'Calibri', size: 16, bold: true });
    expect(h.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDADADA' } });
    expect(ws.getRow(2).getCell(1).font).toMatchObject({ name: 'Times New Roman', size: 12 });
    expect(ws.getRow(3).getCell(16).border).toMatchObject({ top: { style: 'thin' }, right: { style: 'thin' } });
  });

  it('citizenshipOksm: код ОКСМ текстом с ведущим нулём; «Другое» и пусто → null', () => {
    expect(citizenshipOksm('Россия')).toBe('643');
    expect(citizenshipOksm(' армения ')).toBe('051');
    expect(citizenshipOksm('Азербайджан')).toBe('031');
    expect(citizenshipOksm('Узбекистан')).toBe('860');
    expect(citizenshipOksm('Другое')).toBeNull();
    expect(citizenshipOksm(null)).toBeNull();
  });

  it('formatSnils: 11 цифр → маска, иное как есть', () => {
    expect(formatSnils('12345678900')).toBe('123-456-789 00');
    expect(formatSnils('123')).toBe('123');
    expect(formatSnils(null)).toBeNull();
  });
});
