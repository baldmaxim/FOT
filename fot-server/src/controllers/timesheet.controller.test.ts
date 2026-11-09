import { describe, expect, it } from 'vitest';
import {
  isMandatoryWeekendSlotAvailable,
  guardsRestriction,
  resolveWriteHours,
  resolveRemoteScheduleHours,
  resolveGuardHours,
  resolveCapHoursToCheck,
  resolveTimesheetScope,
  resolveEmployeeTimesheetSource,
} from './timesheet.controller.js';
import type { AuthenticatedRequest, IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

const baseSchedule = {
  pattern_type: '5+2',
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  respects_holidays: true,
};

const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00`);

describe('isMandatoryWeekendSlotAvailable — субботы', () => {
  it('допускает 1-ю субботу при норме 2 (used=0)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-02', dateOf('2026-05-02'), null, 0, 6),
    ).toBe(true);
  });

  it('допускает 2-ю субботу при норме 2 (used=1)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-09', dateOf('2026-05-09'), null, 1, 6),
    ).toBe(true);
  });

  it('блокирует 3-ю субботу при норме 2 (used=2)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-16', dateOf('2026-05-16'), null, 2, 6),
    ).toBe(false);
  });

  it('не зачитывает воскресенье при dow=6', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-03', dateOf('2026-05-03'), null, 0, 6),
    ).toBe(false);
  });

  it('не зачитывает субботу-обязательный праздник (mandatory_holidays)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        baseSchedule,
        '2026-03-07',
        dateOf('2026-03-07'),
        { mandatory_holidays: ['2026-03-07'], holidays: [] },
        0,
        6,
      ),
    ).toBe(false);
  });

  it('не зачитывает субботу-праздник (holidays) при respects_holidays=true', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        baseSchedule,
        '2026-05-09',
        dateOf('2026-05-09'),
        { mandatory_holidays: [], holidays: ['2026-05-09'] },
        0,
        6,
      ),
    ).toBe(false);
  });

  it('зачитывает субботу-праздник при respects_holidays=false (для holidays)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, respects_holidays: false },
        '2026-05-09',
        dateOf('2026-05-09'),
        { mandatory_holidays: [], holidays: ['2026-05-09'] },
        0,
        6,
      ),
    ).toBe(true);
  });

  it('mandatory_holidays блокируют независимо от respects_holidays', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, respects_holidays: false },
        '2026-03-07',
        dateOf('2026-03-07'),
        { mandatory_holidays: ['2026-03-07'], holidays: [] },
        0,
        6,
      ),
    ).toBe(false);
  });

  it('работает для любого pattern_type при expected_saturdays_per_month>0 (5+0)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, pattern_type: '5+0' },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
        6,
      ),
    ).toBe(true);
  });

  it('не работает при expected_saturdays_per_month=0', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, expected_saturdays_per_month: 0 },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
        6,
      ),
    ).toBe(false);
  });

  it('работает для cycle-графика с обязательными субботами (used<норма)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, pattern_type: 'cycle' },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
        6,
      ),
    ).toBe(true);
  });

  it('cycle-график: блокирует субботу сверх нормы (used>=норма)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, pattern_type: 'cycle' },
        '2026-05-16',
        dateOf('2026-05-16'),
        null,
        2,
        6,
      ),
    ).toBe(false);
  });
});

describe('isMandatoryWeekendSlotAvailable — воскресенья', () => {
  const sundaySchedule = {
    pattern_type: '5+2',
    expected_saturdays_per_month: 0,
    expected_sundays_per_month: 2,
    respects_holidays: true,
  };

  it('допускает 1-е воскресенье при норме 2 (used=0)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-03', dateOf('2026-05-03'), null, 0, 0),
    ).toBe(true);
  });

  it('допускает 2-е воскресенье при норме 2 (used=1)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-10', dateOf('2026-05-10'), null, 1, 0),
    ).toBe(true);
  });

  it('блокирует 3-е воскресенье при норме 2 (used=2)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-17', dateOf('2026-05-17'), null, 2, 0),
    ).toBe(false);
  });

  it('не зачитывает субботу при dow=0', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-02', dateOf('2026-05-02'), null, 0, 0),
    ).toBe(false);
  });

  it('не работает при expected_sundays_per_month=0', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...sundaySchedule, expected_sundays_per_month: 0 },
        '2026-05-03',
        dateOf('2026-05-03'),
        null,
        0,
        0,
      ),
    ).toBe(false);
  });

  it('не зачитывает праздничное воскресенье (mandatory_holidays)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        sundaySchedule,
        '2026-03-08',
        dateOf('2026-03-08'),
        { mandatory_holidays: ['2026-03-08'], holidays: [] },
        0,
        0,
      ),
    ).toBe(false);
  });

  it('счётчик норм субботы и воскресенья независимы (Сб=2, Вс=1 — Вс блок-н после 1)', () => {
    const both = { ...sundaySchedule, expected_saturdays_per_month: 2, expected_sundays_per_month: 1 };
    expect(
      isMandatoryWeekendSlotAvailable(both, '2026-05-10', dateOf('2026-05-10'), null, 1, 0),
    ).toBe(false);
    expect(
      isMandatoryWeekendSlotAvailable(both, '2026-05-09', dateOf('2026-05-09'), null, 1, 6),
    ).toBe(true);
  });
});

describe('guardsRestriction — какие правки проходят гард ограничений роли', () => {
  it('manual с явными часами > 0 → гард нужен', () => {
    expect(guardsRestriction('manual', 5)).toBe(true);
  });

  it('manual с явным 0 (обнуление) → гард не нужен', () => {
    expect(guardsRestriction('manual', 0)).toBe(false);
  });

  it('manual без часов (null/undefined) → гард не нужен (не правка времени)', () => {
    expect(guardsRestriction('manual', null)).toBe(false);
    expect(guardsRestriction('manual', undefined)).toBe(false);
  });

  it('work без явных часов → гард нужен (часы доначислятся из СКУД)', () => {
    expect(guardsRestriction('work', null)).toBe(true);
    expect(guardsRestriction('work', undefined)).toBe(true);
  });

  it('work с явным 0 → гард не нужен (обнуление)', () => {
    expect(guardsRestriction('work', 0)).toBe(false);
  });

  it('sick_worked («работа на больничном») без часов → гард нужен (часы по графику)', () => {
    expect(guardsRestriction('sick_worked', null)).toBe(true);
    expect(guardsRestriction('sick_worked', 8)).toBe(true);
  });

  // SCHEDULE_NORM_STATUSES: часы клиента игнорируются, включая явный 0 — иначе
  // hours_worked=0 обошёл бы гард, хотя фактически начислится норма графика.
  it('study_day («учебный день») → гард нужен при любых присланных часах, в т.ч. 0', () => {
    expect(guardsRestriction('study_day', null)).toBe(true);
    expect(guardsRestriction('study_day', undefined)).toBe(true);
    expect(guardsRestriction('study_day', 12)).toBe(true);
    expect(guardsRestriction('study_day', 0)).toBe(true);
    expect(guardsRestriction('sick_worked', 0)).toBe(true);
  });

  it('remote без часов → гард нужен', () => {
    expect(guardsRestriction('remote', null)).toBe(true);
  });

  it('статусы-отсутствия (vacation/sick/unpaid/absent/educational_leave) → гард не нужен', () => {
    expect(guardsRestriction('vacation', null)).toBe(false);
    expect(guardsRestriction('sick', 8)).toBe(false);
    expect(guardsRestriction('unpaid', 5)).toBe(false);
    expect(guardsRestriction('absent', null)).toBe(false);
    expect(guardsRestriction('educational_leave', 8)).toBe(false);
  });
});

/**
 * Единая нормализация часов для статусов «часы из нормы графика» (sick_worked/study_day).
 * Через resolveWriteHours/resolveGuardHours идут все три маршрута записи (POST, PATCH, bulk),
 * поэтому правило проверяется здесь один раз.
 */
describe('resolveWriteHours — что реально пишется в hours_override', () => {
  it('study_day: любые присланные часы игнорируются → null', () => {
    expect(resolveWriteHours('study_day', 12, 8)).toBeNull();
    expect(resolveWriteHours('study_day', 0, 8)).toBeNull();
    expect(resolveWriteHours('study_day', null, 8)).toBeNull();
    // PATCH без hours_worked (undefined) тоже даёт null — старые ручные часы
    // не должны пережить смену статуса на «учебный день».
    expect(resolveWriteHours('study_day', undefined, 8)).toBeNull();
  });

  it('sick_worked: то же правило (контракт закреплён на бэке, а не только на фронте)', () => {
    expect(resolveWriteHours('sick_worked', 5, 8)).toBeNull();
    expect(resolveWriteHours('sick_worked', undefined, 8)).toBeNull();
  });

  // Неявка рабочего времени не даёт (attendance.service считает её как 0), поэтому часам
  // в записи взяться неоткуда. Проверка отдельная от SCHEDULE_NORM_STATUSES: там смысл
  // «часы из нормы графика», у неявки норма ни при чём. Ключевой сценарий — PATCH со
  // сменой manual (5 ч) → absent: старые часы обязаны быть вычищены.
  it('absent: часы не пишутся никогда → null', () => {
    expect(resolveWriteHours('absent', 5, 8)).toBeNull();
    expect(resolveWriteHours('absent', undefined, 8)).toBeNull();
    expect(resolveWriteHours('absent', null, 8)).toBeNull();
    expect(resolveWriteHours('absent', 0, 8)).toBeNull();
  });

  it('remote/manual: поведение не изменилось', () => {
    expect(resolveWriteHours('remote', null, 11)).toBe(11);
    expect(resolveWriteHours('remote', 4, 11)).toBe(4);
    expect(resolveWriteHours('remote', null, 0)).toBe(8); // выходной: work_hours=0 → полный день
    expect(resolveWriteHours('manual', 5, 8)).toBe(5);
    expect(resolveWriteHours('manual', undefined, 8)).toBeUndefined();
  });
});

describe('resolveRemoteScheduleHours — удалёнка без часов = график дня', () => {
  // Пн 2026-11-02 — якорь: пн–чт 8 ч, пт 7 ч, сб–вс выходные; 13.11 — предпраздничный.
  const schedule = {
    schedule_id: 's-1',
    schedule_type: 'office',
    work_start: '09:00:00',
    work_end: '18:00:00',
    work_hours: 8,
    work_days: [1, 2, 3, 4, 5],
    office_days: null,
    late_threshold_minutes: 0,
    day_overrides: null,
    lunch_minutes: 60,
    respects_holidays: true,
    pattern_type: 'cycle',
    expected_saturdays_per_month: 0,
    expected_sundays_per_month: 0,
    full_day_threshold_minutes: null,
    weekend_full_day_threshold_minutes: null,
    cycle_length: 7,
    cycle_days: [
      { work_hours: 8 }, { work_hours: 8 }, { work_hours: 8 }, { work_hours: 8 },
      { work_hours: 7 }, { work_hours: 0 }, { work_hours: 0 },
    ],
    anchor_date: '2026-11-02',
    assignment_anchor_date: null,
    source: 'default',
  } as IResolvedSchedule;
  const november: IProductionCalendarMonth = {
    year: 2026,
    month: 11,
    norm_days: 20,
    norm_hours: 159,
    holidays: [],
    mandatory_holidays: [],
    pre_holidays: ['2026-11-13'],
  };

  it('чт 8 ч, пт 7 ч — у каждого дня свой график (массовая удалёнка чт+пт)', () => {
    expect(resolveRemoteScheduleHours(schedule, dateOf('2026-11-05'), november)).toBe(8);
    expect(resolveRemoteScheduleHours(schedule, dateOf('2026-11-06'), november)).toBe(7);
  });

  it('предпраздничный день — норма с −1 ч, независимо от галочки роли', () => {
    expect(resolveRemoteScheduleHours(schedule, dateOf('2026-11-13'), november)).toBe(6);
  });

  it('выходной графика — длина смены, без графика — 8', () => {
    expect(resolveRemoteScheduleHours(schedule, dateOf('2026-11-07'), november)).toBe(8);
    expect(resolveRemoteScheduleHours(undefined, dateOf('2026-11-05'), november)).toBe(8);
  });
});

describe('resolveWriteHours — удалёнка и предел дня', () => {
  it('часы не переданы: подстановка не больше предела (предпраздничный день, график 8, норма 7)', () => {
    expect(resolveWriteHours('remote', null, 8, 7)).toBe(7);
    expect(resolveWriteHours('remote', undefined, 8, 7)).toBe(7);
  });

  it('выходной при смене 6 ч: вместо 8 — длина смены', () => {
    expect(resolveWriteHours('remote', null, 0, 6)).toBe(6);
  });

  it('часы переданы: пишем присланное, отказ — дело гарда, а не тихая срезка', () => {
    expect(resolveWriteHours('remote', 12, 8, 7)).toBe(12);
    expect(resolveWriteHours('manual', 14, 12, 12)).toBe(14);
  });

  it('галочка снята (предел null): как раньше', () => {
    expect(resolveWriteHours('remote', null, 8, null)).toBe(8);
    expect(resolveWriteHours('remote', null, 0, null)).toBe(8);
  });
});

describe('resolveCapHoursToCheck — какие часы сверять с пределом дня', () => {
  it('новая правка: сверяем записываемые часы', () => {
    expect(resolveCapHoursToCheck('manual', 13, null)).toBe(13);
    expect(resolveCapHoursToCheck('manual', 13, undefined)).toBe(13);
  });

  it('те же статус и часы: заметка к старой правке 14 ч сохраняется', () => {
    expect(resolveCapHoursToCheck('manual', 14, { status: 'manual', hours_override: '14.00' })).toBeNull();
  });

  it('сравнение в сотых: форма шлёт 7:40 как 7,6667 при записанных 7,67', () => {
    expect(resolveCapHoursToCheck('manual', 46 / 6, { status: 'manual', hours_override: 7.67 })).toBeNull();
  });

  it('снижение 14 → 13 — изменение, сверяем', () => {
    expect(resolveCapHoursToCheck('manual', 13, { status: 'manual', hours_override: 14 })).toBe(13);
  });

  it('смена статуса при тех же часах — изменение, сверяем', () => {
    expect(resolveCapHoursToCheck('remote', 14, { status: 'manual', hours_override: 14 })).toBe(14);
  });

  it('часов нет: work из СКУД, норма графика, обнуление — не сверяем', () => {
    expect(resolveCapHoursToCheck('work', undefined, null)).toBeNull();
    expect(resolveCapHoursToCheck('sick_worked', null, null)).toBeNull();
    expect(resolveCapHoursToCheck('manual', 0, null)).toBeNull();
  });
});

describe('resolveGuardHours — часы, уходящие в assertCorrectionAllowed', () => {
  it('study_day в рабочий день → норма графика (а не присланные 12)', () => {
    expect(resolveGuardHours('study_day', 12, 11)).toBe(11);
  });

  it('study_day в выходной → 0 без fallback 8 (иначе ложный 422 hours_exceed_norm)', () => {
    expect(resolveGuardHours('study_day', null, 0)).toBe(0);
    expect(resolveGuardHours('sick_worked', 8, 0)).toBe(0);
  });

  it('work без часов в выходной → fallback 8: часы ещё могут прийти из СКУД', () => {
    expect(resolveGuardHours('work', null, 0)).toBe(8);
    expect(resolveGuardHours('work', null, 11)).toBe(11);
  });

  it('manual с явными часами → они и уходят в гард', () => {
    expect(resolveGuardHours('manual', 5, 8)).toBe(5);
  });
});

describe('resolveTimesheetScope — hr (кадровая служба)', () => {
  it("hr (role_code='hr', не админ) → 'department' (просмотр всех, но не wide-edit 'all')", async () => {
    const req = { user: { role_code: 'hr', is_admin: false, employee_id: 2520 } } as unknown as AuthenticatedRequest;
    expect(await resolveTimesheetScope(req)).toBe('department');
  });
});

describe('resolveEmployeeTimesheetSource — приоритет секции строки', () => {
  const emptySets = () => ({
    supervisorSet: new Set<number>(),
    departmentMembershipSet: new Set<number>(),
    liPresenceSet: new Set<number>(),
    directReportSet: new Set<number>(),
  });

  it('department побеждает skud_presence, если сотрудник и реальный член бригады, и в ЛИНИЯ-presence', () => {
    const sets = emptySets();
    sets.departmentMembershipSet.add(10);
    sets.liPresenceSet.add(10);
    expect(resolveEmployeeTimesheetSource({ empId: 10, isSelf: false, ...sets })).toBe('department');
  });

  it('skud_presence — когда сотрудник НЕ член бригады, но присутствует по СКУД на объекте табельщицы', () => {
    const sets = emptySets();
    sets.liPresenceSet.add(11);
    expect(resolveEmployeeTimesheetSource({ empId: 11, isSelf: false, ...sets })).toBe('skud_presence');
  });

  it('supervisor побеждает и department, и skud_presence', () => {
    const sets = emptySets();
    sets.supervisorSet.add(12);
    sets.departmentMembershipSet.add(12);
    sets.liPresenceSet.add(12);
    expect(resolveEmployeeTimesheetSource({ empId: 12, isSelf: false, ...sets })).toBe('supervisor');
  });

  it('self побеждает всё остальное', () => {
    const sets = emptySets();
    sets.supervisorSet.add(13);
    sets.liPresenceSet.add(13);
    expect(resolveEmployeeTimesheetSource({ empId: 13, isSelf: true, ...sets })).toBe('self');
  });

  it('skud_presence побеждает direct_report', () => {
    const sets = emptySets();
    sets.liPresenceSet.add(14);
    sets.directReportSet.add(14);
    expect(resolveEmployeeTimesheetSource({ empId: 14, isSelf: false, ...sets })).toBe('skud_presence');
  });

  it('view_only («Просмотр табеля») — когда больше ни в одном наборе', () => {
    const sets = emptySets();
    expect(resolveEmployeeTimesheetSource({
      empId: 15, isSelf: false, ...sets, viewOnlySet: new Set([15]),
    })).toBe('view_only');
  });

  it('view_only самый младший: отдел и прямой подчинённый его побеждают', () => {
    const sets = emptySets();
    sets.departmentMembershipSet.add(16);
    sets.directReportSet.add(17);
    const viewOnlySet = new Set([16, 17]);
    expect(resolveEmployeeTimesheetSource({ empId: 16, isSelf: false, ...sets, viewOnlySet })).toBe('department');
    expect(resolveEmployeeTimesheetSource({ empId: 17, isSelf: false, ...sets, viewOnlySet })).toBe('direct_report');
  });
});
