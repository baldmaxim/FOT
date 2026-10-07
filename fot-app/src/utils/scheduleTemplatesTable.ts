import type { IWorkSchedule } from '../types/schedule';
import { formatDate } from './formatMoney';
import { formatRhythmSummary } from './scheduleRhythm';
import type { ITableColumn } from './tableView';

/**
 * Таблица «Графики работы → Шаблоны графиков»: столбцы для экрана, сортировки, фильтров и
 * выгрузки в xlsx (общие функции — в tableView.ts).
 */

/** Класс ширины колонки в ScheduleTemplatesTable.module.css. */
export type ScheduleColumnWidth =
  | 'colName'
  | 'colRhythm'
  | 'colAnchor'
  | 'colShift'
  | 'colLunch'
  | 'colHolidays'
  | 'colType';

export interface IScheduleColumn extends ITableColumn<IWorkSchedule> {
  width: ScheduleColumnWidth;
}

/** Десятичные часы → «8:00». */
export const formatHours = (decimalHours: number): string => {
  const total = Math.max(0, Math.round(decimalHours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

/** Якорь есть только у цикла: у legacy-шаблона он не используется резолвером. */
const anchorOf = (t: IWorkSchedule): string | null =>
  (t.pattern_type === 'cycle' && t.anchor_date ? t.anchor_date.slice(0, 10) : null);

const shiftText = (t: IWorkSchedule): string =>
  `${t.work_start.slice(0, 5)}–${t.work_end.slice(0, 5)} (${formatHours(Number(t.work_hours))})`;

/** Пометки, что на экране — бейджами рядом с названием. */
const nameMarks = (t: IWorkSchedule): string[] => [
  ...(t.is_default ? ['дефолт'] : []),
  ...(t.pattern_type !== 'cycle' ? ['legacy'] : []),
];

export const SCHEDULE_TEMPLATE_COLUMNS: ReadonlyArray<IScheduleColumn> = [
  {
    key: 'name',
    label: 'Название',
    type: 'text',
    width: 'colName',
    text: t => t.name,
    sortValue: t => t.name,
    exportValue: (t) => {
      const marks = nameMarks(t);
      return marks.length > 0 ? `${t.name} (${marks.join(', ')})` : t.name;
    },
  },
  {
    key: 'rhythm',
    label: 'Ритм',
    type: 'text',
    width: 'colRhythm',
    text: t => formatRhythmSummary(t),
    sortValue: t => formatRhythmSummary(t),
  },
  {
    key: 'anchor',
    label: 'Якорь',
    type: 'text',
    width: 'colAnchor',
    text: t => formatDate(anchorOf(t)),
    sortValue: anchorOf,
  },
  {
    key: 'shift',
    label: 'Смена',
    type: 'text',
    width: 'colShift',
    text: shiftText,
    sortValue: shiftText,
  },
  {
    key: 'lunch',
    label: 'Обед',
    type: 'text',
    width: 'colLunch',
    text: t => `${t.lunch_minutes} мин`,
    sortValue: t => t.lunch_minutes,
  },
  {
    key: 'holidays',
    label: 'Праздники',
    type: 'text',
    width: 'colHolidays',
    text: t => (t.respects_holidays ? 'учитывает' : 'игнорирует'),
    sortValue: t => (t.respects_holidays ? 'учитывает' : 'игнорирует'),
  },
  {
    key: 'type',
    label: 'Тип',
    type: 'text',
    width: 'colType',
    text: t => (t.schedule_type === 'remote' ? 'Удалённо' : 'Очно'),
    sortValue: t => (t.schedule_type === 'remote' ? 'Удалённо' : 'Очно'),
  },
];
