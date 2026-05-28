/**
 * Utility-функции и типы страницы табеля.
 *
 * Извлечено из TimesheetPage.tsx (Волна 3 декомпозиции). Pure-функции и
 * типы без зависимости от React state — изолируются здесь чтобы основная
 * страница содержала только композицию state/handlers/JSX.
 *
 * Дальнейший шаг плана gentle-pondering-leaf — извлечь TimesheetToolbar,
 * TimesheetExportPanel, useTimesheetState — потребует декомпозиции inline JSX
 * с прокидыванием state через props (отдельный PR с ручной регрессией).
 */
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetObjectEntry,
} from '../../types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface IObjectModalTarget {
  object_key: string;
  object_id: string | null;
  object_name: string;
}

export interface IBulkCorrectionTarget {
  employee: TimesheetEmployee;
  day: number;
  workDate: string;
  entry: TimesheetEntry | null;
}

export interface IBulkObjectCorrectionTarget {
  employee: TimesheetEmployee;
  day: number;
  workDate: string;
  objectTarget: IObjectModalTarget;
  objectEntry: TimesheetObjectEntry | null;
}

export type TimesheetViewMode = 'employees' | 'objects' | 'corrections' | 'transfers';

// ─── Constants ─────────────────────────────────────────────────────────────

export const MONTH_NAMES_RU = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// ─── Date helpers ──────────────────────────────────────────────────────────

export const getTodayDateInputValue = (): string => new Date().toISOString().slice(0, 10);

export const parseMonthParam = (value: string | null): { year: number; month: number } | null => {
  if (!/^\d{4}-\d{2}$/.test(value || '')) return null;

  const year = Number.parseInt((value as string).slice(0, 4), 10);
  const month = Number.parseInt((value as string).slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

  return { year, month };
};

export const toMonthIndex = (year: number, month: number): number => year * 12 + month - 1;

export const fromMonthIndex = (index: number): { year: number; month: number } => ({
  year: Math.floor(index / 12),
  month: (index % 12) + 1,
});

// ─── Formatting helpers ────────────────────────────────────────────────────

/**
 * Сокращает ФИО до "Фамилия И. О." (используется для имени файла экспорта,
 * заголовка модалки выбранного сотрудника). При пустом/одинарном вводе —
 * fallback к фамилии или пустой строке.
 */
export const formatFioWithInitials = (fullName?: string | null): string => {
  if (!fullName) return '';
  const [last, first, middle] = fullName.trim().split(/\s+/);
  if (!last) return '';
  const initials = [first, middle]
    .filter(Boolean)
    .map(part => `${part!.charAt(0).toUpperCase()}.`)
    .join('');
  return initials ? `${last} ${initials}` : last;
};

/** Замена символов, недопустимых в Windows/macOS путях файлов экспорта. */
export const sanitizeDownloadName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_');

// ─── Object bulk-edit cell key helpers ─────────────────────────────────────

export const buildObjectBulkMetaKey = (employeeId: number, objectKey: string): string => `${employeeId}:${objectKey}`;

/**
 * Парсит ключ ячейки для bulk-edit режима табеля.
 * Формат:
 *   - "employee:<empId>:<day>" — обычная ячейка сотрудника
 *   - "object:<empId>:<objectKey>:<day>" — ячейка по объекту
 */
export const parseBulkCellKey = (
  key: string,
): { kind: 'employee'; employeeId: number; day: number } | { kind: 'object'; employeeId: number; objectKey: string; day: number } | null => {
  const parts = key.split(':');
  if (parts[0] === 'employee' && parts.length === 3) {
    const employeeId = Number.parseInt(parts[1] || '', 10);
    const day = Number.parseInt(parts[2] || '', 10);
    if (!Number.isFinite(employeeId) || !Number.isFinite(day)) return null;
    return { kind: 'employee', employeeId, day };
  }

  if (parts[0] === 'object' && parts.length === 4) {
    const employeeId = Number.parseInt(parts[1] || '', 10);
    const objectKey = decodeURIComponent(parts[2] || '');
    const day = Number.parseInt(parts[3] || '', 10);
    if (!Number.isFinite(employeeId) || !Number.isFinite(day) || !objectKey) return null;
    return { kind: 'object', employeeId, objectKey, day };
  }

  return null;
};
