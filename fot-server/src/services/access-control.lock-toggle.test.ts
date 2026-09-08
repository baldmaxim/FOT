import { describe, expect, it } from 'vitest';
import { canToggleTimesheetLock } from './access-control.service.js';

/**
 * Предикат «кто открывает и закрывает сданный табель». Вынесен из middleware, чтобы
 * матрицу прав можно было проверить без Express: сам middleware — тонкая обёртка.
 */
describe('canToggleTimesheetLock', () => {
  it('админ — да', () => {
    expect(canToggleTimesheetLock({ is_admin: true, role_code: 'admin' })).toBe(true);
  });

  it('кадровая служба — да', () => {
    expect(canToggleTimesheetLock({ is_admin: false, role_code: 'hr' })).toBe(true);
  });

  it('руководитель, начальник участка, табельщица — нет', () => {
    for (const role of ['manager', 'manager_obj', 'site_supervisor', 'timekeeper', 'worker']) {
      expect(canToggleTimesheetLock({ is_admin: false, role_code: role })).toBe(false);
    }
  });

  it('пустой пользователь — нет (не падает)', () => {
    expect(canToggleTimesheetLock(null)).toBe(false);
    expect(canToggleTimesheetLock(undefined)).toBe(false);
    expect(canToggleTimesheetLock({})).toBe(false);
  });

  it('is_admin проверяется строго по true, а не по truthy', () => {
    expect(canToggleTimesheetLock({ is_admin: null, role_code: 'manager' })).toBe(false);
  });
});

/**
 * Ключ /timesheet/lock-toggle (миграция 270) асинхронный, а предикат обязан остаться
 * синхронным: результат кладёт в req.user middleware resolveTimesheetLockToggle.
 */
describe('canToggleTimesheetLock: предвычисленный ключ /timesheet/lock-toggle', () => {
  it('роль с ключом получает право, хотя по коду его бы не было', () => {
    expect(canToggleTimesheetLock({
      is_admin: false,
      role_code: 'hr_admin',
      __can_toggle_timesheet_lock: true,
    })).toBe(true);
  });

  it('снятый ключ перекрывает legacy-хардкод: false побеждает', () => {
    expect(canToggleTimesheetLock({
      is_admin: false,
      role_code: 'hr',
      __can_toggle_timesheet_lock: false,
    })).toBe(false);
  });

  it('без предвычисленного значения работает прежняя логика', () => {
    expect(canToggleTimesheetLock({ is_admin: false, role_code: 'hr_admin' })).toBe(false);
    expect(canToggleTimesheetLock({ is_admin: false, role_code: 'hr' })).toBe(true);
  });
});
