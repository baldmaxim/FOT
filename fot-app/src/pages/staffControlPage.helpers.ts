/**
 * Utility-функции, типы и константы страницы управления кадрами.
 *
 * Извлечено из StaffControlPage.tsx (Волна 3 декомпозиции).
 * Pure-функции форматирования + type aliases + константы — без зависимости
 * от React state, легко тестируются и переиспользуются.
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { IWorkSchedule, IEmployeeScheduleAssignment, PatternType, ScheduleType } from '../types/schedule';
import type { IStaffCategoryCounts, StaffApiStatus, StaffCategory } from '../services/employeeService';
import type { Employee } from '../types';

// ─── Types ─────────────────────────────────────────────────────────────────

// Модалок оклада здесь нет: оклады ведутся в разделе «Зарплата» (/salary/terms).
export type ModalType = 'position' | 'department' | 'schedule';
/** Вкладка экрана: «Активные» | «Уволенные» | «Все» (excluded — прежний контракт, экран его не показывает). */
export type StaffStatusFilter = 'active' | 'fired' | 'all' | 'excluded';

/** Значение ?status= в адресе экрана; неизвестное — «Активные». */
export const parseStaffStatusFilter = (value: string | null): StaffStatusFilter =>
  value === 'fired' || value === 'all' ? value : 'active';

/**
 * Статус для сервера: вкладка «Активные» — working (без неактивных, миграция 381). Прежний active сервера
 * («не уволен») остаётся окнам выбора сотрудника.
 */
export const toApiStaffStatus = (filter: StaffStatusFilter): StaffApiStatus =>
  filter === 'active' ? 'working' : filter;

/** «Признак» на экране и в выгрузке — только во «Все»: на «Активных» и «Уволенных» он у всех одинаковый. */
export const staffSignVisible = (filter: StaffStatusFilter): boolean => filter === 'all';

/** Группы плашки в порядке экрана. */
export const STAFF_CATEGORY_OPTIONS: ReadonlyArray<{ key: StaffCategory; label: string }> = [
  { key: 'itr', label: 'ИТР' },
  { key: 'worker', label: 'Рабочие' },
  { key: 'other', label: 'Остальные' },
];

/** Значение ?category= в адресе экрана; неизвестное — без группы. */
export const parseStaffCategoryParam = (value: string | null): StaffCategory | null =>
  STAFF_CATEGORY_OPTIONS.find(option => option.key === value)?.key ?? null;

export interface IStaffCategoryDisplay {
  /** Числа плашки; null — в шапке только число таблицы. */
  counts: IStaffCategoryCounts | null;
  /**
   * Список устоялся, а число на кнопке с ним разошлось (кого-то приняли или уволили между запросами разбивки и
   * списка) — разбивку нужно перечитать.
   */
  stale: boolean;
}

/**
 * Что показать в плашке. counts — разбивка ровно текущих фильтров (ключ сверен) или null.
 *  - Список грузит новый набор (прежние строки на экране) — плашка уже по новым фильтрам: не схлопывается на каждом
 *    клике, числа в ней согласованы между собой.
 *  - Список устоялся: число на кнопке (выбранной группы или «все») должно совпасть с числом строк таблицы. Разошлось —
 *    перечитать разбивку; без группы до этого в шапке только число таблицы, а выбранная группа видна всегда —
 *    её должно быть можно снять.
 */
export const resolveStaffCategoryDisplay = ({ counts, total, category, listSettling }: {
  counts: IStaffCategoryCounts | null;
  total: number;
  category: StaffCategory | null;
  listSettling: boolean;
}): IStaffCategoryDisplay => {
  if (!counts) return { counts: null, stale: false };
  if (listSettling) return { counts, stale: false };
  const stale = (category ? counts[category] : counts.total) !== total;
  return { counts: stale && !category ? null : counts, stale };
};

/** Что показывает столбец действий строки: одно главное действие или обычный набор иконок. */
export type StaffRowActionKind = 'return' | 'rehire' | 'cancel-dismissal' | 'default';

/**
 * Действие строки решает её состояние, вкладка — только какие обработчики переданы. На «Все» строки разные:
 * увольнение ставит excluded_from_timesheet = true, поэтому «Вернуть в табель» — только неуволенному, а уволенному —
 * «Восстановить».
 */
export const staffRowActionKind = (
  emp: Pick<Employee, 'employment_status' | 'excluded_from_timesheet' | 'dismissal_date'>,
  handlers: { canReturn: boolean; canRehire: boolean; canCancelDismissal: boolean },
): StaffRowActionKind => {
  if (handlers.canReturn && emp.employment_status !== 'fired' && emp.excluded_from_timesheet) return 'return';
  if (handlers.canRehire && emp.employment_status === 'fired') return 'rehire';
  if (handlers.canCancelDismissal && emp.employment_status === 'active' && emp.dismissal_date) return 'cancel-dismissal';
  return 'default';
};
export type ScheduleSource = 'employee' | 'default';

export interface IEmployeeScheduleView {
  scheduleId: string | null;
  scheduleName: string;
  source: ScheduleSource;
  /** Режим работы графика — для условного показа привязки к объекту (только remote). */
  scheduleType?: ScheduleType | null;
  effectiveFrom?: string | null;
  /** anchor_date конкретного назначения (override якоря cycle-паттерна), если задан */
  assignmentAnchorDate?: string | null;
  /** id строки employee_schedule_assignments — для in-place правки дат */
  assignmentId?: string | null;
  /** pattern_type шаблона текущего назначения — якорь правим только для 'cycle' */
  templatePatternType?: PatternType | null;
}

export interface IAddEmployeeForm {
  full_name: string;
  hire_date: string;
  org_department_id: string;
  position_id: string;
  tab_number: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const SCHEDULE_SOURCE_LABELS: Record<ScheduleSource, string> = {
  employee: 'инд.',
  default: 'деф.',
};
export const EMPTY_SCHEDULE_TEMPLATES: IWorkSchedule[] = [];
export const EMPTY_EMPLOYEE_SCHEDULE_ASSIGNMENTS: IEmployeeScheduleAssignment[] = [];

// ─── Formatters ────────────────────────────────────────────────────────────

/** Форматирует число как сумму в рублях; null/undefined/0 — прочерк. */
export const fmt = (n: number | null | undefined): string =>
  n ? n.toLocaleString('ru-RU') + ' ₽' : '—';

/** Текущая дата в локальной TZ как ISO YYYY-MM-DD. */
export const getLocalISODate = (): string => {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
};

/**
 * Текущая дата в зоне Europe/Moscow как ISO YYYY-MM-DD.
 * Для увольнений: бэкенд классифицирует дату по МСК, TZ браузера не должна расходиться.
 */
export const getMoscowISODate = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);

/**
 * Сдвиг ISO-даты YYYY-MM-DD на N календарных дней. Считается в UTC-компонентах,
 * поэтому не зависит от TZ браузера и корректно проходит конец месяца/года и 29 февраля.
 */
export const addIsoDays = (iso: string, days: number): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/** true если назначение activeScheduleAssignment покрывает указанную дату. */
export const isActiveScheduleAssignment = (effectiveFrom: string, effectiveTo: string | null, date: string): boolean =>
  effectiveFrom <= date && (effectiveTo === null || effectiveTo >= date);

// ─── DOM helpers ───────────────────────────────────────────────────────────

export const openEmployeeInNewTab = (empId: number): void => {
  window.open(`/employees/${empId}`, '_blank', 'noopener,noreferrer');
};

export const handleMiddleClickMouseDown = (e: ReactMouseEvent): void => {
  // Отключаем авто-скролл в браузере на нажатии колеса, чтобы отработал onAuxClick.
  if (e.button === 1) e.preventDefault();
};
