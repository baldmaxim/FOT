import type { IEmployeeScheduleAssignment, IWorkSchedule } from '../types/schedule';
import { isActiveScheduleAssignment, type IEmployeeScheduleView } from '../pages/staffControlPage.helpers';

interface IBuildScheduleViewsInput {
  employeeIds: readonly number[];
  /** Назначения из загруженных порций (могут быть и неактивные на сегодня). */
  assignments: readonly IEmployeeScheduleAssignment[];
  templates: readonly IWorkSchedule[];
  /** Шаблоны загружены: без них default-график неизвестен, «—» было бы ложным. */
  templatesReady: boolean;
  /** Сотрудники, чья порция назначений успешно загружена. */
  readyIds: ReadonlySet<number>;
  today: string;
}

export interface IScheduleViewsResult {
  /** Действующий график: персональный или по умолчанию. Нет записи — графика нет (при ready) или ещё грузится. */
  scheduleViews: Map<number, IEmployeeScheduleView>;
  /** Базовый график (по умолчанию) — окно назначения показывает его рядом с персональным. */
  baseScheduleViews: Map<number, IEmployeeScheduleView>;
}

/**
 * Графики строк таблицы. Строятся только для сотрудников из загруженных порций и только после
 * загрузки шаблонов: иначе строка на время загрузки показала бы «5+0» по умолчанию вместо
 * фактического персонального графика. Готовность решает readyIds, а не наличие записи.
 */
export const buildScheduleViews = ({
  employeeIds,
  assignments,
  templates,
  templatesReady,
  readyIds,
  today,
}: IBuildScheduleViewsInput): IScheduleViewsResult => {
  const scheduleViews = new Map<number, IEmployeeScheduleView>();
  const baseScheduleViews = new Map<number, IEmployeeScheduleView>();
  if (!templatesReady) return { scheduleViews, baseScheduleViews };

  const activeByEmployee = new Map<number, IEmployeeScheduleAssignment>();
  for (const assignment of assignments) {
    if (!isActiveScheduleAssignment(assignment.effective_from, assignment.effective_to, today)) continue;
    if (!activeByEmployee.has(assignment.employee_id)) activeByEmployee.set(assignment.employee_id, assignment);
  }

  const defaultSchedule = templates.find(template => template.is_default) ?? null;

  for (const id of employeeIds) {
    if (!readyIds.has(id)) continue;
    const baseView: IEmployeeScheduleView | null = defaultSchedule
      ? {
          scheduleId: defaultSchedule.id,
          scheduleName: defaultSchedule.name,
          source: 'default',
          scheduleType: defaultSchedule.schedule_type ?? null,
          effectiveFrom: null,
        }
      : null;
    if (baseView) baseScheduleViews.set(id, baseView);

    const personal = activeByEmployee.get(id);
    if (personal?.work_schedules) {
      const isSameAsDefault = !!defaultSchedule && personal.work_schedules.id === defaultSchedule.id;
      scheduleViews.set(id, {
        scheduleId: personal.work_schedules.id,
        scheduleName: personal.work_schedules.name,
        source: isSameAsDefault ? 'default' : 'employee',
        scheduleType: personal.work_schedules.schedule_type ?? null,
        effectiveFrom: isSameAsDefault ? null : personal.effective_from,
        assignmentAnchorDate: personal.anchor_date,
        assignmentId: personal.id,
        templatePatternType: personal.work_schedules.pattern_type,
      });
      continue;
    }
    if (baseView) scheduleViews.set(id, baseView);
  }
  return { scheduleViews, baseScheduleViews };
};
