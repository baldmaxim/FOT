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
