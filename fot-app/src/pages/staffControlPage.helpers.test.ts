import { describe, expect, it } from 'vitest';
import { addIsoDays, parseStaffStatusFilter, staffRowActionKind, toApiStaffStatus } from './staffControlPage.helpers';

describe('addIsoDays', () => {
  it('переходит через конец месяца', () => {
    expect(addIsoDays('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('переходит через конец года', () => {
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('учитывает високосный февраль', () => {
    expect(addIsoDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addIsoDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addIsoDays('2027-02-28', 1)).toBe('2027-03-01');
  });
});

describe('вкладки «Активные | Уволенные | Все» (миграция 381)', () => {
  it('?status= из адреса: fired и all — как есть, остальное — «Активные»', () => {
    expect(parseStaffStatusFilter('fired')).toBe('fired');
    expect(parseStaffStatusFilter('all')).toBe('all');
    expect(parseStaffStatusFilter('excluded')).toBe('active');
    expect(parseStaffStatusFilter(null)).toBe('active');
  });

  it('«Активные» уходят на сервер как working (без неактивных), прочие — как есть', () => {
    expect(toApiStaffStatus('active')).toBe('working');
    expect(toApiStaffStatus('fired')).toBe('fired');
    expect(toApiStaffStatus('all')).toBe('all');
  });
});

describe('staffRowActionKind: действия строки на «Все»', () => {
  const all = { canReturn: true, canRehire: true, canCancelDismissal: true };

  it('уволенный исключён из табеля, но получает «Восстановить», а не «Вернуть в табель»', () => {
    expect(staffRowActionKind({ employment_status: 'fired', excluded_from_timesheet: true, dismissal_date: '2026-11-01' }, all))
      .toBe('rehire');
  });

  it('неуволенный, исключённый из табеля, — «Вернуть в табель»', () => {
    expect(staffRowActionKind({ employment_status: 'active', excluded_from_timesheet: true, dismissal_date: null }, all))
      .toBe('return');
  });

  it('запланированное увольнение — отмена; обычная строка — набор иконок', () => {
    expect(staffRowActionKind({ employment_status: 'active', excluded_from_timesheet: false, dismissal_date: '2026-12-01' }, all))
      .toBe('cancel-dismissal');
    expect(staffRowActionKind({ employment_status: 'active', excluded_from_timesheet: false, dismissal_date: null }, all))
      .toBe('default');
  });

  it('вкладка без обработчика действие не даёт: на «Активных» нет «Восстановить», на «Уволенных» — «Вернуть в табель»', () => {
    const activeTab = { canReturn: true, canRehire: false, canCancelDismissal: true };
    const firedTab = { canReturn: false, canRehire: true, canCancelDismissal: false };
    expect(staffRowActionKind({ employment_status: 'fired', excluded_from_timesheet: true, dismissal_date: null }, activeTab))
      .toBe('default');
    expect(staffRowActionKind({ employment_status: 'active', excluded_from_timesheet: true, dismissal_date: null }, firedTab))
      .toBe('default');
  });
});
