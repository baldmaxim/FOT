/**
 * «Экспорт сотрудников»: книга xlsx с иерархией подразделений.
 *
 * Уровни группировки Excel: подразделения по глубине дерева, сотрудники — на
 * уровень ниже своего подразделения. Раскрывается кнопкой «+» слева, как в
 * выгрузке «Сотрудники на объектах».
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import type { IExportNode } from './employees-export.service.js';

const HEADER_FILL = 'FF2563EB';

/** Excel не понимает уровень группировки больше 7. */
const MAX_OUTLINE_LEVEL = 7;

/** Свёрнуто всё, начиная с этого уровня: видны корни и компании. */
const COLLAPSE_FROM_LEVEL = 2;

/** Максимальный отступ ячейки в Excel. */
const MAX_INDENT = 15;

export interface IEmployeesExportMeta {
  total: number;
  generatedAt: Date;
}

function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildEmployeesExportWorkbook(
  roots: IExportNode[],
  meta: IEmployeesExportMeta,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Сотрудники');

  ws.columns = [
    { key: 'pad', width: 3 },
    { key: 'name', width: 52 },
    { key: 'count', width: 14 },
  ];

  // summaryBelow: false — строка-заголовок группы стоит НАД её содержимым.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  // Row.collapsed в ExcelJS — readonly-геттер (outlineLevel >= outlineLevelRow),
  // поэтому значение подобрано так, чтобы множества hidden и collapsed совпали.
  ws.properties.outlineLevelRow = COLLAPSE_FROM_LEVEL;
  // Без dyDescent ExcelJS 4.4.0 теряет свойства строк при записи.
  ws.properties.dyDescent = 0.25;
  ws.views = [{ state: 'frozen', ySplit: 3 }];
  // pageSetup НЕ задаём: вместе с outline ExcelJS пишет детей <sheetPr> в
  // порядке, который Excel считает битым XML (обход — writeTimesheetWorkbookBuffer).

  const titleRow = ws.addRow([null, 'Сотрудники по подразделениям']);
  titleRow.font = { bold: true, size: 13 };
  ws.mergeCells(titleRow.number, 2, titleRow.number, 3);

  const metaRow = ws.addRow([
    null,
    defangCsvCell(
      `Всего сотрудников: ${meta.total} · сформировано ${formatStamp(meta.generatedAt)}`
      + ' · выгружены все доступные вам сотрудники, независимо от фильтров на экране',
    ),
  ]);
  metaRow.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
  ws.mergeCells(metaRow.number, 2, metaRow.number, 3);

  const headerRow = ws.addRow([null, 'Подразделение / ФИО', 'Сотрудников']);
  for (const col of [2, 3]) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: col === 2 ? 'left' : 'center', vertical: 'middle' };
  }

  const writeNode = (node: IExportNode): void => {
    // Резерв в один уровень: иначе на предельной глубине сотрудник получил бы
    // уровень своего подразделения и группа развалилась бы.
    const groupLevel = Math.min(node.depth, MAX_OUTLINE_LEVEL - 1);
    const employeeLevel = Math.min(node.depth + 1, MAX_OUTLINE_LEVEL);

    const groupRow = ws.addRow([null, defangCsvCell(node.name), node.total]);
    groupRow.font = { bold: true, size: node.depth === 0 ? 12 : 11 };
    groupRow.getCell(2).alignment = { indent: Math.min(node.depth, MAX_INDENT) };
    groupRow.getCell(3).alignment = { horizontal: 'right' };
    groupRow.outlineLevel = groupLevel;
    groupRow.hidden = groupLevel >= COLLAPSE_FROM_LEVEL;

    for (const employee of node.employees) {
      const employeeRow = ws.addRow([null, defangCsvCell(employee.full_name)]);
      employeeRow.getCell(2).alignment = { indent: Math.min(node.depth + 1, MAX_INDENT) };
      employeeRow.outlineLevel = employeeLevel;
      employeeRow.hidden = true;
    }

    for (const child of node.children) writeNode(child);
  };

  for (const root of roots) writeNode(root);

  return workbook;
}
