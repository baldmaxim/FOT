/**
 * Выгрузка документов держателей пропусков подрядчика в Excel («Подрядчики → Мониторинг»).
 * Чистая функция: строки «Мониторинга» → книга ExcelJS. Номера (паспорт, ИНН, СНИЛС, патент)
 * пишутся текстом — иначе Excel превращает их в число (4,04E+08) и теряет ведущие нули;
 * даты — настоящими датами Excel в формате дд.мм.гггг.
 */
import ExcelJS from 'exceljs';

/** Строка «Мониторинга», нужная для выгрузки (подмножество MONITOR_BASE_SELECT + w26). */
export interface IContractorDocsExportRow {
  pass_number: string;
  w26: string | null;
  holder_name: string | null;
  is_active: boolean;
  expires_at: string | null;
  object_label: string | null;
  access_point_names: string[] | null;
  citizenship: string | null;
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  has_residence_permit: boolean;
  residence_permit_number: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  snils: string | null;
  inn: string | null;
  kig: string | null;
  kig_end_date: string | null;
}

type CellValue = string | Date | null;

interface IColumn {
  header: string;
  width: number;
  value: (r: IContractorDocsExportRow) => CellValue;
  date?: boolean;
}

/** 'YYYY-MM-DD' → Date в полночь UTC: ExcelJS пишет дату по UTC, день не сдвинется ни в МСК, ни в UTC. */
const toExcelDate = (iso: string | null): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
};

/** СНИЛС из 11 цифр → 123-456-789 00; иное — как есть. */
export const formatSnils = (v: string | null): string | null => {
  if (!v) return null;
  return /^\d{11}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3, 6)}-${v.slice(6, 9)} ${v.slice(9)}` : v;
};

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
};

/** Столбцы выгрузки — порядок фиксирован (тест сверяет). Ширины ≠ 9: ExcelJS 9 не пишет. */
export const CONTRACTOR_DOCS_EXPORT_COLUMNS: readonly IColumn[] = [
  { header: '№ пропуска', width: 11, value: r => text(r.pass_number) },
  { header: 'W26', width: 12, value: r => text(r.w26) },
  { header: 'ФИО', width: 36, value: r => text(r.holder_name) },
  { header: 'Активен', width: 10, value: r => (r.is_active ? 'да' : 'нет') },
  { header: 'Срок', width: 12, value: r => toExcelDate(r.expires_at), date: true },
  { header: 'Объекты', width: 24, value: r => text(r.object_label) },
  { header: 'Точки', width: 36, value: r => text((r.access_point_names ?? []).join(', ')) },
  { header: 'Гражданство', width: 16, value: r => text(r.citizenship) },
  { header: 'Паспорт серия номер', width: 20, value: r => text(r.passport_series_number) },
  { header: 'Дата выдачи документа', width: 14, value: r => toExcelDate(r.passport_issue_date), date: true },
  { header: 'Дата рождения', width: 14, value: r => toExcelDate(r.birth_date), date: true },
  { header: 'ВНЖ', width: 7, value: r => (r.has_residence_permit ? 'да' : null) },
  { header: 'Номер ВНЖ', width: 16, value: r => text(r.residence_permit_number) },
  { header: 'Номер патента', width: 18, value: r => text(r.patent_number) },
  { header: 'Дата выдачи патента', width: 14, value: r => toExcelDate(r.patent_issue_date), date: true },
  { header: 'Номер бланка', width: 14, value: r => text(r.patent_blank_number) },
  { header: 'СНИЛС', width: 16, value: r => formatSnils(text(r.snils)) },
  { header: 'ИНН', width: 15, value: r => text(r.inn) },
  { header: 'Номер КиГ', width: 14, value: r => text(r.kig) },
  { header: 'КиГ действует до', width: 14, value: r => toExcelDate(r.kig_end_date), date: true },
];

/** Книга «Документы»: шапка закреплена, автофильтр, одна строка на держателя пропуска. */
export const buildContractorDocsWorkbook = (rows: readonly IContractorDocsExportRow[]): ExcelJS.Workbook => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Документы', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = CONTRACTOR_DOCS_EXPORT_COLUMNS.map(c => ({ header: c.header, width: c.width }));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };

  for (const r of rows) {
    ws.addRow(CONTRACTOR_DOCS_EXPORT_COLUMNS.map(c => c.value(r)));
  }
  CONTRACTOR_DOCS_EXPORT_COLUMNS.forEach((c, i) => {
    if (c.date) ws.getColumn(i + 1).numFmt = 'dd.mm.yyyy';
  });
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: CONTRACTOR_DOCS_EXPORT_COLUMNS.length },
  };
  return wb;
};
