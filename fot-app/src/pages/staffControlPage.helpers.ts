/**
 * Utility-функции, типы и константы страницы управления кадрами.
 *
 * Извлечено из StaffControlPage.tsx (Волна 3 декомпозиции).
 * Pure-функции форматирования + type aliases + константы — без зависимости
 * от React state, легко тестируются и переиспользуются.
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { IWorkSchedule, IEmployeeScheduleAssignment, PatternType, ScheduleType } from '../types/schedule';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ModalType = 'salary' | 'salary_actual' | 'position' | 'department' | 'schedule' | 'object_attribution' | 'object_assignment';
export type StaffStatusFilter = 'active' | 'fired' | 'excluded';
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
