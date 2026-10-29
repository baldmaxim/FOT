import { describe, expect, it } from 'vitest';

import type { IPayrollTermsRow } from '../services/payrollService';
import {
  calcViewFilters,
  dropPayrollDetails,
  openPayrollDetails,
  paymentsViewOptions,
  resolvePaymentsView,
} from './payrollViews';

const row = (employeeId: number): IPayrollTermsRow => ({
  employee_id: employeeId, full_name: `Сотрудник ${employeeId}`, tab_number: null, department_id: null,
  department_name: null, position_name: null, schedule_name: null, terms_id: null, category: 'office',
  calc_type: null, monthly_salary: null, hourly_rate: null, bonus_amount: null, housing_compensation: null,
  staff_units: null, effective_from: null, effective_to: null, can_edit: true,
});

const keys = (canTerms: boolean, canCalc: boolean) => (
  paymentsViewOptions(canTerms, canCalc).map(option => option.key)
);

describe('экраны вкладки «Выплаты» по правам', () => {
  it('весь раздел: Условия оплаты · Подробно · Расчёты', () => {
    expect(keys(true, true)).toEqual(['terms', 'details', 'calc']);
    expect(paymentsViewOptions(true, true).map(option => option.label))
      .toEqual(['Условия оплаты', 'Подробно', 'Расчёты']);
  });

  it('только условия оплаты: список и «Подробно»', () => {
    expect(keys(true, false)).toEqual(['terms', 'details']);
  });

  it('только расчёт: без списка и карточки', () => {
    expect(keys(false, true)).toEqual(['calc']);
  });

  it('без прав экранов нет', () => {
    expect(keys(false, false)).toEqual([]);
  });
});

describe('экран из ?view=', () => {
  const all = paymentsViewOptions(true, true);

  it('доступный экран открывается, в том числе «Подробно» без выбранного сотрудника', () => {
    expect(resolvePaymentsView('details', all)).toBe('details');
    expect(resolvePaymentsView('calc', all)).toBe('calc');
  });

  it('пусто или неизвестное значение — первый экран', () => {
    expect(resolvePaymentsView(null, all)).toBe('terms');
    expect(resolvePaymentsView('payments', all)).toBe('terms');
  });

  it('старая ссылка на убранное «Администрирование» (?view=admin) — первый доступный экран', () => {
    expect(resolvePaymentsView('admin', all)).toBe('terms');
    expect(resolvePaymentsView('admin', paymentsViewOptions(false, true))).toBe('calc');
  });

  it('экран без права — первый доступный', () => {
    expect(resolvePaymentsView('calc', paymentsViewOptions(true, false))).toBe('terms');
    expect(resolvePaymentsView('details', paymentsViewOptions(false, true))).toBe('calc');
    expect(resolvePaymentsView('terms', paymentsViewOptions(false, true))).toBe('calc');
  });
});

describe('сотрудник вкладки «Подробно»', () => {
  it('повторный клик по тому же сотруднику — прежняя карточка, черновик цел', () => {
    const current = row(1);
    expect(openPayrollDetails(current, row(1))).toBe(current);
  });

  it('клик по другому сотруднику — новая карточка', () => {
    const next = row(2);
    expect(openPayrollDetails(row(1), next)).toBe(next);
    expect(openPayrollDetails(null, next)).toBe(next);
  });

  it('сохранение A закрывает карточку A', () => {
    expect(dropPayrollDetails(row(1), [1])).toBeNull();
    expect(dropPayrollDetails(null, [1])).toBeNull();
  });

  it('сохранение A, завершившееся после открытия B, карточку B не трогает', () => {
    const second = row(2);
    expect(dropPayrollDetails(second, [1])).toBe(second);
  });
});

describe('«Расчёты» после открытия карточки — только этот сотрудник', () => {
  it('фокус — его id, ФИО в поиске и «Все отделы»; общие поиск и отдел не трогаются', () => {
    expect(calcViewFilters({ employeeId: 42, fullName: 'Абдукаримов Элёр Камол Угли' }, 'Абдук', 'dept-1')).toEqual({
      employeeId: 42, search: 'Абдукаримов Элёр Камол Угли', departmentId: '',
    });
  });

  it('тёзки различаются по id; без ФИО — id и пустой поиск', () => {
    expect(calcViewFilters({ employeeId: 7, fullName: 'Тёзкин Иван' }, '', '').employeeId).toBe(7);
    expect(calcViewFilters({ employeeId: 8, fullName: 'Тёзкин Иван' }, '', '').employeeId).toBe(8);
    expect(calcViewFilters({ employeeId: 9, fullName: null }, 'Абдук', 'dept-1')).toEqual({
      employeeId: 9, search: '', departmentId: '',
    });
  });

  it('фокус снят — общие с «Условиями оплаты» поиск и отдел', () => {
    expect(calcViewFilters(null, 'Абдук', 'dept-1')).toEqual({ search: 'Абдук', departmentId: 'dept-1' });
  });
});
