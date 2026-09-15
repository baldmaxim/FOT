import { describe, it, expect } from 'vitest';
import type { IEmployeeScheduleAssignment, IWorkSchedule } from '../types/schedule';
import { buildScheduleViews } from './staffScheduleViews';

const template = (id: string, name: string, isDefault = false): IWorkSchedule => ({
  id, name, is_default: isDefault, schedule_type: 'office', pattern_type: 'cycle',
} as unknown as IWorkSchedule);

const DEFAULT = template('tpl-default', '5+0', true);
const ITR = template('tpl-itr', 'ИТР 5дн+2сб');
const TODAY = '2026-09-15';

const assignment = (employeeId: number, schedule: IWorkSchedule, effectiveFrom = '2026-01-01', effectiveTo: string | null = null): IEmployeeScheduleAssignment => ({
  id: `as-${employeeId}-${effectiveFrom}`,
  employee_id: employeeId,
  schedule_id: schedule.id,
  work_schedules: schedule,
  effective_from: effectiveFrom,
  effective_to: effectiveTo,
  anchor_date: null,
  created_by: null,
  created_at: effectiveFrom,
  updated_at: effectiveFrom,
});

describe('buildScheduleViews', () => {
  it('готовая порция: персональный график, иначе график по умолчанию', () => {
    const { scheduleViews, baseScheduleViews } = buildScheduleViews({
      employeeIds: [1, 2],
      assignments: [assignment(1, ITR)],
      templates: [DEFAULT, ITR],
      templatesReady: true,
      readyIds: new Set([1, 2]),
      today: TODAY,
    });

    expect(scheduleViews.get(1)).toMatchObject({ scheduleName: 'ИТР 5дн+2сб', source: 'employee' });
    expect(scheduleViews.get(2)).toMatchObject({ scheduleName: '5+0', source: 'default' });
    expect(baseScheduleViews.get(1)).toMatchObject({ scheduleName: '5+0' });
  });

  it('порция ещё не загружена — записи нет (скелетон), а не ложный график по умолчанию', () => {
    const { scheduleViews } = buildScheduleViews({
      employeeIds: [1],
      assignments: [],
      templates: [DEFAULT],
      templatesReady: true,
      readyIds: new Set(),
      today: TODAY,
    });

    expect(scheduleViews.has(1)).toBe(false);
  });

  it('готовая порция без персонального и без графика по умолчанию — записи нет, строка покажет «—»', () => {
    const { scheduleViews } = buildScheduleViews({
      employeeIds: [1],
      assignments: [],
      templates: [ITR],
      templatesReady: true,
      readyIds: new Set([1]),
      today: TODAY,
    });

    expect(scheduleViews.has(1)).toBe(false);
  });

  it('шаблоны не загружены — ничего не строится', () => {
    const { scheduleViews } = buildScheduleViews({
      employeeIds: [1],
      assignments: [assignment(1, ITR)],
      templates: [],
      templatesReady: false,
      readyIds: new Set([1]),
      today: TODAY,
    });

    expect(scheduleViews.size).toBe(0);
  });

  it('закрытое и будущее назначения не действуют сегодня', () => {
    const { scheduleViews } = buildScheduleViews({
      employeeIds: [1, 2],
      assignments: [assignment(1, ITR, '2026-01-01', '2026-08-31'), assignment(2, ITR, '2026-10-01')],
      templates: [DEFAULT, ITR],
      templatesReady: true,
      readyIds: new Set([1, 2]),
      today: TODAY,
    });

    expect(scheduleViews.get(1)).toMatchObject({ source: 'default' });
    expect(scheduleViews.get(2)).toMatchObject({ source: 'default' });
  });

  it('персональное назначение на шаблон по умолчанию помечается как default', () => {
    const { scheduleViews } = buildScheduleViews({
      employeeIds: [1],
      assignments: [assignment(1, DEFAULT)],
      templates: [DEFAULT],
      templatesReady: true,
      readyIds: new Set([1]),
      today: TODAY,
    });

    expect(scheduleViews.get(1)).toMatchObject({ source: 'default', effectiveFrom: null, assignmentId: 'as-1-2026-01-01' });
  });
});
