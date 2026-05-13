export type ScheduleType = 'office' | 'remote' | 'hybrid' | 'shift';
export type PatternType = '5+0' | '5+2' | '6+0' | 'custom' | 'cycle';

export interface IDayOverride {
  work_start: string;
  work_end: string;
  work_hours: number;
  lunch_minutes?: number;
}

/**
 * Слот циклического графика. Для нерабочего дня (work_hours=0)
 * поля времени и обед опциональны.
 */
export interface ICycleDay {
  work_hours: number;
  work_start?: string;
  work_end?: string;
  lunch_minutes?: number;
}

export interface IWorkSchedule {
  id: string;
  name: string;
  schedule_type: ScheduleType;
  work_start: string;
  work_end: string;
  work_hours: number;
  work_days: number[];
  office_days: number[] | null;
  late_threshold_minutes: number;
  day_overrides: Record<string, IDayOverride> | null;
  is_default: boolean;
  lunch_minutes: number;
  respects_holidays: boolean;
  pattern_type: PatternType;
  expected_saturdays_per_month: number;
  full_day_threshold_minutes: number | null;
  weekend_full_day_threshold_minutes: number | null;
  cycle_length: number | null;
  cycle_days: ICycleDay[] | null;
  anchor_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface IEmployeeScheduleAssignment {
  id: string;
  employee_id: number;
  schedule_id: string;
  work_schedules?: IWorkSchedule;
  effective_from: string;
  effective_to: string | null;
  anchor_date: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface IObjectScheduleAssignment {
  id: string;
  object_id: string;
  schedule_id: string;
  work_schedules?: IWorkSchedule;
  effective_from: string;
  effective_to: string | null;
  anchor_date: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface IResolvedSchedule {
  schedule_id: string;
  schedule_type: ScheduleType;
  work_start: string;
  work_end: string;
  work_hours: number;
  work_days: number[];
  office_days: number[] | null;
  late_threshold_minutes: number;
  day_overrides: Record<string, IDayOverride> | null;
  lunch_minutes: number;
  respects_holidays: boolean;
  pattern_type: PatternType;
  expected_saturdays_per_month: number;
  full_day_threshold_minutes: number | null;
  weekend_full_day_threshold_minutes: number | null;
  cycle_length: number | null;
  cycle_days: ICycleDay[] | null;
  anchor_date: string | null;
  assignment_anchor_date: string | null;
  source: 'object' | 'employee' | 'default';
}

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  office: 'Офис',
  remote: 'Удалёнка',
  hybrid: 'Гибрид',
  shift: 'Сменный',
};

export const PATTERN_TYPE_LABELS: Record<PatternType, string> = {
  '5+0': '5 раб. + 0 суббот',
  '5+2': '5 раб. + 2 субботы',
  '6+0': '6 раб. дней',
  'custom': 'Произвольный',
  'cycle': 'Циклический (2/2, сутки/трое)',
};

export const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;
