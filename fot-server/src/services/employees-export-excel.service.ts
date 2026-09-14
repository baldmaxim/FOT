/**
 * «Экспорт сотрудников»: книга xlsx, лист на раздел (СМ, СУ-10, Бригады,
 * Подрядные организации, Прочие), на каждом — умная таблица Excel.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import type { IExportPeriod, IExportSection } from './employees-export.service.js';

export const DATE_NUM_FMT = 'dd.mm.yyyy';

/** Строка шапки таблицы: над ней заголовок листа и строка с пояснением. */
const TABLE_HEADER_ROW = 3;

const COLUMNS: ReadonlyArray<{ name: string; width: number }> = [
  { name: '№', width: 7 },
  { name: 'ФИО', width: 38 },
  { name: 'Подразделение', width: 48 },
  { name: 'Должность', width: 32 },
  { name: 'Дата рождения', width: 15 },
  { name: 'Дата трудоустройства', width: 15 },
  { name: 'Объект', width: 32 },
  { name: 'Признак', width: 12 },
  { name: 'Статья затрат', width: 22 },
];

const BIRTH_DATE_COL = 5;
const HIRE_DATE_COL = 6;

export interface IEmployeesExportMeta {
  /** Период отбора уволенных. */
  period: IExportPeriod;
  /** Период расчёта объекта (ночной снимок — по вчерашний день). По умолчанию = period. */
  objectPeriod?: IExportPeriod;
  generatedAt: Date;
}

const pad = (value: number): string => String(value).padStart(2, '0');

function formatStamp(date: Date): string {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const formatIsoDay = (iso: string): string => {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
};

/**
 * YYYY-MM-DD → Date в UTC-полночь. ExcelJS пишет серийный номер по UTC,
 * поэтому день в файле не зависит от часового пояса процесса.
 */
export function isoDateToExcelDate(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildEmployeesExportWorkbook(
  sections: IExportSection[],
  meta: IEmployeesExportMeta,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();

  for (const section of sections) {
    const ws = workbook.addWorksheet(section.title);
    COLUMNS.forEach((column, index) => {
      ws.getColumn(index + 1).width = column.width;
    });
    ws.views = [{ state: 'frozen', ySplit: TABLE_HEADER_ROW }];

    const titleCell = ws.getCell(1, 1);
    titleCell.value = `Сотрудники: ${section.title}`;
    titleCell.font = { bold: true, size: 13 };

    const metaCell = ws.getCell(2, 1);
    const objectPeriod = meta.objectPeriod ?? meta.period;
    metaCell.value = defangCsvCell(
      `Всего: ${section.rows.length} · сформировано ${formatStamp(meta.generatedAt)}`
      + ` · уволенные — за ${formatIsoDay(meta.period.start)}–${formatIsoDay(meta.period.end)}`
      + ` · объект — где больше всего часов за ${formatIsoDay(objectPeriod.start)}–${formatIsoDay(objectPeriod.end)}`,
    );
    metaCell.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };

    const rows = section.rows.map((row, index) => [
      index + 1,
      defangCsvCell(row.fullName),
      defangCsvCell(row.departmentPath),
      defangCsvCell(row.positionName),
      isoDateToExcelDate(row.birthDate),
      isoDateToExcelDate(row.hireDate),
      defangCsvCell(row.objectName),
      row.sign,
      '',
    ]);

    ws.addTable({
      name: section.tableName,
      ref: `A${TABLE_HEADER_ROW}`,
      headerRow: true,
      totalsRow: false,
      style: { theme: 'TableStyleMedium2', showRowStripes: true },
      columns: COLUMNS.map(column => ({ name: column.name, filterButton: true })),
      rows,
    });

    const firstDataRow = TABLE_HEADER_ROW + 1;
    const lastDataRow = TABLE_HEADER_ROW + rows.length;
    for (let rowNumber = firstDataRow; rowNumber <= lastDataRow; rowNumber += 1) {
      const row = ws.getRow(rowNumber);
      row.getCell(BIRTH_DATE_COL).numFmt = DATE_NUM_FMT;
      row.getCell(HIRE_DATE_COL).numFmt = DATE_NUM_FMT;
    }
  }

  return workbook;
}
