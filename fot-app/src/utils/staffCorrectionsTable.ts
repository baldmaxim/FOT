import type { IStaffCorrectionRow, IStaffCorrectionSkud } from '../services/staffCorrectionsService';
import type { TimesheetStatus } from '../types';
import { getMonthLabel } from './calendarUtils';
import { getStatusLabel } from './correctionStatus';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблица вкладки «Корректировки»: столбцы экрана — они же фильтры и xlsx (файл повторяет экран).
 * Часы «по СКУД» приходят отдельно (по отделу); пока не пришли — «…».
 */

export interface IStaffCorrectionTableRow extends IStaffCorrectionRow {
  /** null — часы по СКУД ещё считаются. */
  skud: IStaffCorrectionSkud | null;
}

export const SKUD_PENDING_TEXT = '…';
export const NO_OBJECT_PASSES_TEXT = 'Нет проходов на объекте';

/** 7.5 → «7:30», 10 → «10». */
export const formatCorrectionHours = (hours: number | null): string => {
  if (hours === null || !Number.isFinite(hours)) return '—';
  const totalMinutes = Math.round(Math.abs(hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const sign = hours < 0 && totalMinutes > 0 ? '−' : '';
  return m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2, '0')}`;
};

/** «2026-11-06» → «06.11». */
const formatDayMonth = (isoDate: string): string => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}`;

/** «08:12:00» → «08:12». */
const formatTime = (value: string | null): string => (value ? value.slice(0, 5) : '');

/** Время правки по МСК: «07.11 10:15». */
export const formatChangedAt = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')} ${part('hour')}:${part('minute')}`;
};

/** «По СКУД» строки: часы и вход–выход; объект без проходов — словами. */
export const skudText = (row: IStaffCorrectionTableRow): string => {
  if (!row.skud) return SKUD_PENDING_TEXT;
  if (row.window === 'object' && row.skud.skud_hours <= 0) return NO_OBJECT_PASSES_TEXT;
  const range = row.skud.first_entry || row.skud.last_exit
    ? ` (${formatTime(row.skud.first_entry) || '—'}–${formatTime(row.skud.last_exit) || '—'})`
    : '';
  return `${formatCorrectionHours(row.skud.skud_hours)}${range}`;
};

/** Разница «правка − СКУД»: «+4», «−1:30»; СКУД ещё считается — «…». */
export const differenceHours = (row: IStaffCorrectionTableRow): number | null => (
  row.skud && row.hours !== null ? Math.round((row.hours - row.skud.skud_hours) * 100) / 100 : null
);

const differenceText = (row: IStaffCorrectionTableRow): string => {
  if (!row.skud) return SKUD_PENDING_TEXT;
  const diff = differenceHours(row);
  if (diff === null) return '—';
  return diff > 0 ? `+${formatCorrectionHours(diff)}` : formatCorrectionHours(diff);
};

const sourceText = (row: IStaffCorrectionTableRow): string => (row.source === 'request' ? 'Заявление' : 'Табель');

/** Кто: в «Табеле» — кто поставил, у «Заявления» — кто согласовал и кто подал. */
export const authorText = (row: IStaffCorrectionTableRow): string => (
  row.source === 'request'
    ? `${row.author_name ?? '—'} (согласовал), подал ${row.applicant_name ?? '—'}`
    : row.author_name ?? '—'
);

/** Ширина задана у всех столбцов, кроме ФИО (остаток): иначе текстовые делили бы остаток и сжимались. */
export const STAFF_CORRECTION_COLUMNS: ReadonlyArray<IRegistryColumn<IStaffCorrectionTableRow>> = [
  { key: 'full_name', label: 'Сотрудник', type: 'text', text: row => row.full_name, sortValue: row => row.full_name },
  {
    key: 'work_date', label: 'Дата', type: 'text', width: 72, nowrap: true,
    text: row => formatDayMonth(row.work_date), sortValue: row => row.work_date,
  },
  {
    key: 'object', label: 'Объект', type: 'text', width: 110,
    text: row => row.object_name ?? (row.window === 'object' ? 'Объект' : '—'), sortValue: row => row.object_name,
  },
  {
    key: 'norm', label: 'График', type: 'text', width: 76, nowrap: true, numeric: true,
    text: row => (row.skud ? formatCorrectionHours(row.skud.norm_hours) : SKUD_PENDING_TEXT),
    sortValue: row => row.skud?.norm_hours ?? null,
  },
  {
    key: 'skud', label: 'По СКУД', type: 'text', width: 150,
    title: 'Часы, как посчитал бы табель без правки; у правки по объекту — часы на этом объекте',
    text: skudText, sortValue: row => row.skud?.skud_hours ?? null,
  },
  {
    key: 'hours', label: 'Корректировка', type: 'text', width: 136, nowrap: true, numeric: true,
    text: row => formatCorrectionHours(row.hours), sortValue: row => row.hours,
  },
  {
    key: 'difference', label: 'Разница', type: 'text', width: 84, nowrap: true, numeric: true,
    text: differenceText, sortValue: differenceHours,
  },
  {
    key: 'status', label: 'Тип', type: 'text', width: 110,
    text: row => getStatusLabel(row.status as TimesheetStatus), sortValue: row => getStatusLabel(row.status as TimesheetStatus),
  },
  { key: 'source', label: 'Источник', type: 'text', width: 96, nowrap: true, text: sourceText, sortValue: sourceText },
  { key: 'author', label: 'Кто', type: 'text', width: 150, text: authorText, sortValue: authorText },
  {
    key: 'changed_at', label: 'Когда', type: 'text', width: 112, nowrap: true,
    text: row => formatChangedAt(row.changed_at), sortValue: row => row.changed_at,
  },
  { key: 'reason', label: 'Комментарий', type: 'text', width: 160, text: row => row.reason ?? '', sortValue: row => row.reason },
  {
    key: 'files', label: 'Файлы', type: 'int', width: 64, nowrap: true, numeric: true,
    text: row => (row.attachments_count > 0 ? String(row.attachments_count) : ''),
    sortValue: row => row.attachments_count,
    exportValue: row => row.attachments_count,
  },
];

/** Снимок экрана для xlsx: видимые строки выбранного отдела после поиска и фильтров столбцов. */
export const buildStaffCorrectionsExport = (
  rows: ReadonlyArray<IStaffCorrectionTableRow>,
  month: string,
  branchName: string,
): ITableExportSnapshot => {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const monthLabel = getMonthLabel(year, monthNumber);
  return buildExportTable({
    title: `Корректировки руководителей — ${branchName}`,
    subtitle: monthLabel,
    fileName: `Корректировки ${branchName} ${month}.xlsx`,
    columns: STAFF_CORRECTION_COLUMNS,
    rows,
  });
};
