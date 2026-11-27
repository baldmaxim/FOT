import { describe, expect, it } from 'vitest';
import {
  addIsoDays,
  parseStaffCategoryParam,
  parseStaffStatusFilter,
  resolveStaffCategoryDisplay,
  staffRowActionKind,
  staffSignVisible,
  toApiStaffStatus,
  toggleStaffPeriod,
  type IStaffPeriodState,
} from './staffControlPage.helpers';

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

describe('«Признак» только во «Все» (27.11.2026)', () => {
  it('на «Активных» и «Уволенных» он у всех одинаковый — столбца нет', () => {
    expect(staffSignVisible('all')).toBe(true);
    expect(staffSignVisible('active')).toBe(false);
    expect(staffSignVisible('fired')).toBe(false);
    expect(staffSignVisible('excluded')).toBe(false);
  });
});

describe('группа плашки: ?category= и что показать', () => {
  const COUNTS = { total: 1151, itr: 569, worker: 582 };

  it('?category=: две группы; «other» из старой ссылки и прочее — без группы', () => {
    expect(parseStaffCategoryParam('itr')).toBe('itr');
    expect(parseStaffCategoryParam('worker')).toBe('worker');
    for (const value of [null, '', 'other', 'ITR', 'all', 'workers']) expect(parseStaffCategoryParam(value)).toBeNull();
  });

  it('без группы: число вкладки = строкам таблицы — кнопки; разошлось — только число и перечитать разбивку', () => {
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 1151, category: null, listSettling: false }))
      .toEqual({ counts: COUNTS, stale: false });
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 1153, category: null, listSettling: false }))
      .toEqual({ counts: null, stale: true });
  });

  it('с группой: сверяется число группы, первое число остаётся всей вкладкой', () => {
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 569, category: 'itr', listSettling: false }))
      .toEqual({ counts: COUNTS, stale: false });
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 582, category: 'worker', listSettling: false }))
      .toEqual({ counts: COUNTS, stale: false });
    // 1151 строк при выбранной ИТР — разошлось: перечитать, но кнопки не прятать — группу должно быть можно снять.
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 1151, category: 'itr', listSettling: false }))
      .toEqual({ counts: COUNTS, stale: true });
  });

  it('список грузит новый набор (на экране прежние строки) — плашка уже по новым фильтрам, без перечитывания', () => {
    // Клик по «ИТР»: таблица ещё держит 1151 строку.
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 1151, category: 'itr', listSettling: true }))
      .toEqual({ counts: COUNTS, stale: false });
    // Сброс на «Все 1151»: таблица ещё держит 569 строк ИТР — плашка не схлопывается.
    expect(resolveStaffCategoryDisplay({ counts: COUNTS, total: 569, category: null, listSettling: true }))
      .toEqual({ counts: COUNTS, stale: false });
  });

  it('разбивки ровно этих фильтров нет — только число таблицы', () => {
    expect(resolveStaffCategoryDisplay({ counts: null, total: 569, category: 'itr', listSettling: false }))
      .toEqual({ counts: null, stale: false });
  });
});

describe('чипы «Устроены / Уволены»: отжатие возвращает на прежнюю вкладку (27.11.2026)', () => {
  const state = (status: IStaffPeriodState['status'], period: IStaffPeriodState['period'] = null, returnStatus: IStaffPeriodState['returnStatus'] = null): IStaffPeriodState =>
    ({ status, period, returnStatus });

  it('«Активные» → «Уволены» → отжали: снова «Активные»', () => {
    const pressed = toggleStaffPeriod(state('active'), 'fired_month');
    expect(pressed).toEqual({ status: 'fired', period: 'fired_month', returnStatus: 'active' });
    expect(toggleStaffPeriod(pressed, 'fired_month')).toEqual({ status: 'active', period: null, returnStatus: null });
  });

  it('«Все» → «Уволены» → отжали: снова «Все»; «Уволенные» → «Устроены» → отжали: снова «Уволенные»', () => {
    const fromAll = toggleStaffPeriod(state('all'), 'fired_month');
    expect(toggleStaffPeriod(fromAll, 'fired_month')).toEqual({ status: 'all', period: null, returnStatus: null });
    const fromFired = toggleStaffPeriod(state('fired'), 'hired_month');
    expect(fromFired).toEqual({ status: 'active', period: 'hired_month', returnStatus: 'fired' });
    expect(toggleStaffPeriod(fromFired, 'hired_month').status).toBe('fired');
  });

  it('«Активные» → «Устроены» → отжали: остаётся «Активные»', () => {
    const pressed = toggleStaffPeriod(state('active'), 'hired_month');
    expect(pressed).toEqual({ status: 'active', period: 'hired_month', returnStatus: 'active' });
    expect(toggleStaffPeriod(pressed, 'hired_month')).toEqual({ status: 'active', period: null, returnStatus: null });
  });

  it('переход между чипами не меняет вкладку возврата', () => {
    const fired = toggleStaffPeriod(state('all'), 'fired_month');
    const hired = toggleStaffPeriod(fired, 'hired_month');
    expect(hired).toEqual({ status: 'active', period: 'hired_month', returnStatus: 'all' });
    expect(toggleStaffPeriod(hired, 'hired_month')).toEqual({ status: 'all', period: null, returnStatus: null });
  });

  it('чип из ссылки (вкладка возврата не запомнена) → отжали: «Активные»', () => {
    expect(toggleStaffPeriod(state('fired', 'fired_month'), 'fired_month')).toEqual({ status: 'active', period: null, returnStatus: null });
    // Переход на другой чип из такой ссылки тоже ничего не запоминает.
    expect(toggleStaffPeriod(state('fired', 'fired_month'), 'hired_month').returnStatus).toBeNull();
  });
});
