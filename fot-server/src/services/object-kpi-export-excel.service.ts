/**
 * «KPI объектов → Экспорт»: xlsx ровно той таблицы, что на экране.
 *
 * Сортировка, фильтры столбцов и выбор месяцев живут на клиенте (строк не больше пары
 * десятков), поэтому сервер получает готовый снимок — видимые строки в порядке экрана — и
 * только оформляет лист. Дублировать фильтры и сортировку на сервере значило бы рано или
 * поздно выгрузить не то, что видит пользователь. Данные в снимке — те же, что уже отданы
 * ему отчётом, так что выгрузка ничего сверх доступного не раскрывает.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';

export type ObjectKpiExportColumnType = 'text' | 'money' | 'percent' | 'int';
export type ObjectKpiExportCell = string | number | null;

export interface IObjectKpiExportTable {
  title: string;
  subtitle: string;
  columns: ReadonlyArray<{ label: string; type: ObjectKpiExportColumnType }>;
  rows: ReadonlyArray<{ cells: ReadonlyArray<ObjectKpiExportCell>; muted?: boolean }>;
}

/** Строка шапки таблицы: над ней заголовок и строка с периодом. */
const TABLE_HEADER_ROW = 3;

const NUM_FMT: Record<Exclude<ObjectKpiExportColumnType, 'text'>, string> = {
  money: '#,##0.00',
  percent: '0.0%',
  int: '0',
};

const COLUMN_WIDTH: Record<ObjectKpiExportColumnType, number> = {
  text: 32,
  money: 20,
  percent: 12,
  int: 8,
};

/** Прогнозные строки — серым, как на экране. */
const MUTED_FONT_COLOR = 'FF808080';

/**
 * Число из ячейки снимка. Деньги приходят строкой numeric из PostgreSQL («5843093950.00») —
 * превращаем в число только здесь, для ячейки Excel.
 */
const toNumber = (value: ObjectKpiExportCell): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : null;
};

/**
 * Значение ячейки по типу столбца. В числовом столбце нечисловое значение — это подпись
 * экрана («—», «нет шкалы» у премии), она пишется текстом, как видна пользователю.
 */
export const toExcelCellValue = (
  type: ObjectKpiExportColumnType,
  value: ObjectKpiExportCell,
): string | number | null => {
  if (value === null) return null;
  if (type !== 'text') {
    const numeric = toNumber(value);
    // Процент в отчёте — «147.52», Excel хранит долю и сам рисует «147.5%».
    if (numeric !== null) return type === 'percent' ? numeric / 100 : numeric;
  }
  return defangCsvCell(String(value));
};

export function buildObjectKpiExportWorkbook(table: IObjectKpiExportTable): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('KPI объектов');

  table.columns.forEach((column, index) => {
    ws.getColumn(index + 1).width = COLUMN_WIDTH[column.type];
  });

  const titleCell = ws.getCell(1, 1);
  titleCell.value = defangCsvCell(table.title);
  titleCell.font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = defangCsvCell(table.subtitle);
  ws.views = [{ state: 'frozen', ySplit: TABLE_HEADER_ROW }];

  ws.addTable({
    name: 'KPI_Objects',
    ref: `A${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: table.columns.map(column => ({ name: column.label, filterButton: true })),
    rows: table.rows.map(row => table.columns.map((column, index) => (
      toExcelCellValue(column.type, row.cells[index] ?? null)
    ))),
  });

  table.rows.forEach((row, rowIndex) => {
    const excelRow = ws.getRow(TABLE_HEADER_ROW + 1 + rowIndex);
    table.columns.forEach((column, columnIndex) => {
      const cell = excelRow.getCell(columnIndex + 1);
      if (column.type !== 'text' && typeof cell.value === 'number') cell.numFmt = NUM_FMT[column.type];
      if (row.muted) cell.font = { color: { argb: MUTED_FONT_COLOR } };
    });
  });

  return workbook;
}
