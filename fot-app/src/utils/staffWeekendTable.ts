import type { IStaffWeekendRow } from '../services/staffWeekendService';
import { formatMonthsLabel } from './monthsSelection';
import { moscowTodayIso, shiftMonth } from './moscowDate';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/** Таблица вкладки «Выходные» «Управления кадрами»: столбцы для экрана, сортировки, фильтров и выгрузки в xlsx. */

/** Текущий месяц и 11 прошлых. Сервер больше не примет; один и тот же месяц дважды не встретится, поэтому ДД.ММ однозначен. */
const WEEKEND_MONTHS = 12;

export const staffWeekendMonthOptions = (currentMonth: string): string[] => (
  Array.from({ length: WEEKEND_MONTHS }, (_, index) => shiftMonth(currentMonth, index - WEEKEND_MONTHS + 1))
);

const orDash = (value: string | null): string => value || '—';

/** «2026-10-04» → «04.10». */
const formatDayMonth = (isoDate: string): string => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}`;

/** 2682 минуты → «44,7». */
const formatHours = (minutes: number): string => (minutes / 60).toFixed(1).replace('.', ',');

export const STAFF_WEEKEND_COLUMNS: ReadonlyArray<IRegistryColumn<IStaffWeekendRow>> = [
  {
    key: 'full_name',
    label: 'ФИО',
    type: 'text',
    text: row => row.full_name,
    sortValue: row => row.full_name,
  },
  {
    key: 'department',
    label: 'Отдел',
    type: 'text',
    width: 150,
    text: row => orDash(row.department),
    sortValue: row => row.department,
  },
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 180,
    text: row => orDash(row.position),
    sortValue: row => row.position,
  },
  {
    key: 'days_count',
    label: 'Дней',
    type: 'int',
    width: 80,
    nowrap: true,
    numeric: true,
    text: row => String(row.days.length),
    sortValue: row => row.days.length,
    exportValue: row => row.days.length,
  },
  {
    key: 'hours',
    label: 'Часы',
    type: 'text',
    width: 80,
    nowrap: true,
    numeric: true,
    text: row => formatHours(row.total_minutes),
    sortValue: row => row.total_minutes,
  },
  {
    key: 'dates',
    label: 'Даты',
    type: 'text',
    width: 260,
    wrap: true,
    text: row => row.days.map(formatDayMonth).join(', '),
    sortValue: row => row.days[0] ?? null,
    filterValues: row => row.days.map(formatDayMonth),
  },
];

export const buildStaffWeekendExport = (
  rows: ReadonlyArray<IStaffWeekendRow>,
  months: ReadonlyArray<string>,
): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: 'Выходные без корректировки',
    // ДД.ММ в столбце «Даты» без года: год — здесь.
    subtitle: `Месяцы: ${formatMonthsLabel(months)}. Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `Выходные_${isoDate}.xlsx`,
    columns: STAFF_WEEKEND_COLUMNS,
    rows,
  });
};
