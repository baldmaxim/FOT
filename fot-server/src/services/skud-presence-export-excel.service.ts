/**
 * СКУД: сборка книги xlsx для выгрузки «Сотрудники на объектах» за период.
 *
 * Лист = дата (по возрастанию). Внутри листа три уровня группировки Excel:
 * объект (0) → отдел (1) → сотрудник (2, свёрнут). Раскрывается кнопкой «+»
 * слева, как в статистике пропусков подрядчиков.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import type { IPresenceExportDay } from './skud-presence-export.service.js';

const HEADER_FILL = 'FF2563EB';

export interface IPresenceExportMeta {
  dateFrom: string;
  dateTo: string;
  objectsLabel: string;
  groupsLabel: string;
}

function formatDateShort(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

/** «04.08.2026 7:53:22» — как в привычном пользователю файле (час без ведущего нуля). */
function formatEntryStamp(date: string, time: string): string {
  const [hours = '00', minutes = '00', seconds = '00'] = time.split(':');
  return `${formatDateShort(date)} ${Number(hours)}:${minutes}:${seconds}`;
}

/** Подписи групп: одноимённые отделы из разных компаний различаем по компании. */
function buildGroupLabels(days: IPresenceExportDay[]): Map<string, string> {
  const keysByName = new Map<string, Set<string>>();
  const groupInfo = new Map<string, { name: string; company: string | null }>();

  for (const day of days) {
    for (const object of day.objects) {
      for (const group of object.groups) {
        if (!groupInfo.has(group.key)) {
          groupInfo.set(group.key, { name: group.name, company: group.company_name });
        }
        if (!keysByName.has(group.name)) keysByName.set(group.name, new Set());
        keysByName.get(group.name)!.add(group.key);
      }
    }
  }

  const labels = new Map<string, string>();
  for (const [key, info] of groupInfo) {
    const ambiguous = (keysByName.get(info.name)?.size ?? 0) > 1;
    labels.set(key, ambiguous && info.company && info.company !== info.name
      ? `${info.company} → ${info.name}`
      : info.name);
  }
  return labels;
}

export function buildPresenceExportWorkbook(
  days: IPresenceExportDay[],
  meta: IPresenceExportMeta,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const labels = buildGroupLabels(days);

  for (const day of days) {
    const ws = workbook.addWorksheet(formatDateShort(day.date));
    ws.columns = [
      { key: 'pad', width: 3 },
      { key: 'left', width: 34 },
      { key: 'right', width: 42 },
    ];
    // summaryBelow: false — строка-заголовок группы стоит НАД её содержимым.
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
    ws.properties.outlineLevelRow = 2;
    // Без dyDescent ExcelJS 4.4.0 теряет свойства строк при записи.
    ws.properties.dyDescent = 0.25;

    const titleRow = ws.addRow([null, `Сотрудники на объектах — ${formatDateShort(day.date)}`]);
    titleRow.font = { bold: true, size: 13 };
    ws.mergeCells(titleRow.number, 2, titleRow.number, 3);

    const metaRow = ws.addRow([
      null,
      defangCsvCell(
        `Период ${formatDateShort(meta.dateFrom)}–${formatDateShort(meta.dateTo)}`
        + ` · объекты: ${meta.objectsLabel} · отделы: ${meta.groupsLabel}`,
      ),
    ]);
    metaRow.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
    ws.mergeCells(metaRow.number, 2, metaRow.number, 3);

    const headerRow = ws.addRow([null, 'Дата и время входа', 'ФИО']);
    for (const col of [2, 3]) {
      const cell = headerRow.getCell(col);
      cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.alignment = { horizontal: col === 3 ? 'left' : 'center', vertical: 'middle' };
    }

    for (const object of day.objects) {
      const objectRow = ws.addRow([null, defangCsvCell(object.object_name), object.total]);
      objectRow.font = { bold: true, size: 12 };
      objectRow.getCell(3).alignment = { horizontal: 'right' };
      objectRow.outlineLevel = 0;

      for (const group of object.groups) {
        const groupRow = ws.addRow([
          null,
          defangCsvCell(labels.get(group.key) ?? group.name),
          group.employees.length,
        ]);
        groupRow.font = { bold: true };
        groupRow.getCell(3).alignment = { horizontal: 'right' };
        groupRow.outlineLevel = 1;

        for (const employee of group.employees) {
          const employeeRow = ws.addRow([
            null,
            formatEntryStamp(day.date, employee.entry_time),
            defangCsvCell(employee.full_name),
          ]);
          employeeRow.outlineLevel = 2;
          employeeRow.hidden = true;
        }
      }
    }
  }

  return workbook;
}
