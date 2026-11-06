import { formatMonthsLabel } from './monthsSelection';
import { moscowTodayIso } from './moscowDate';
import { buildExportTable, type ITableColumn, type ITableExportSnapshot } from './tableView';

/** «Экспорт» вкладки «Выходные»: список людей и их дней без корректировки. Часы — те же, что в клетках сетки. */

export interface IStaffWeekendExportRow {
  full_name: string;
  department: string;
  position: string | null;
  /** Дни YYYY-MM-DD по возрастанию. */
  days: string[];
  hours: number;
}

const orDash = (value: string | null): string => value || '—';

/** «2026-10-04» → «04.10». */
const formatDayMonth = (isoDate: string): string => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}`;

/** 37.7 → «37,7». */
const formatHours = (hours: number): string => hours.toFixed(1).replace('.', ',');

export const STAFF_WEEKEND_COLUMNS: ReadonlyArray<ITableColumn<IStaffWeekendExportRow>> = [
  { key: 'full_name', label: 'ФИО', type: 'text', text: row => row.full_name, sortValue: row => row.full_name },
  { key: 'department', label: 'Отдел', type: 'text', text: row => row.department, sortValue: row => row.department },
  { key: 'position', label: 'Должность', type: 'text', text: row => orDash(row.position), sortValue: row => row.position },
  {
    key: 'days_count',
    label: 'Дней',
    type: 'int',
    text: row => String(row.days.length),
    sortValue: row => row.days.length,
    exportValue: row => row.days.length,
  },
  { key: 'hours', label: 'Часы', type: 'text', text: row => formatHours(row.hours), sortValue: row => row.hours },
  {
    key: 'dates',
    label: 'Даты',
    type: 'text',
    text: row => row.days.map(formatDayMonth).join(', '),
    sortValue: row => row.days[0] ?? null,
  },
];

export const buildStaffWeekendExport = (
  rows: ReadonlyArray<IStaffWeekendExportRow>,
  month: string,
): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: 'Выходные без корректировки',
    // ДД.ММ в столбце «Даты» без года: год — здесь.
    subtitle: `Месяц: ${formatMonthsLabel([month])}. Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `Выходные_${isoDate}.xlsx`,
    columns: STAFF_WEEKEND_COLUMNS,
    rows,
  });
};
