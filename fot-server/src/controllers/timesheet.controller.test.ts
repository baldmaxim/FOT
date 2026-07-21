import { describe, expect, it } from 'vitest';
import {
  isMandatoryWeekendSlotAvailable,
  guardsRestriction,
  resolveWriteHours,
  resolveGuardHours,
  resolveTimesheetScope,
  resolveEmployeeTimesheetSource,
} from './timesheet.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

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

  it('remote/manual: поведение не изменилось', () => {
    expect(resolveWriteHours('remote', null, 11)).toBe(11);
    expect(resolveWriteHours('remote', 4, 11)).toBe(4);
    expect(resolveWriteHours('remote', null, 0)).toBe(8); // выходной: work_hours=0 → полный день
    expect(resolveWriteHours('manual', 5, 8)).toBe(5);
    expect(resolveWriteHours('manual', undefined, 8)).toBeUndefined();
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
});
