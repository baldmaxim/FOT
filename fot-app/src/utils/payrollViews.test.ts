import { describe, expect, it } from 'vitest';

import type { IPayrollTermsRow } from '../services/payrollService';
import { dropPayrollDetails, openPayrollDetails, paymentsViewOptions, resolvePaymentsView } from './payrollViews';

const row = (employeeId: number): IPayrollTermsRow => ({
  employee_id: employeeId, full_name: `Сотрудник ${employeeId}`, tab_number: null, department_id: null,
  department_name: null, position_name: null, schedule_name: null, terms_id: null, staff_category: null,
  calc_type: null, monthly_salary: null, hourly_rate: null, bonus_amount: null, housing_compensation: null,
  staff_units: null, effective_from: null, effective_to: null, can_edit: true,
});

const keys = (canTerms: boolean, canCalc: boolean, canAdmin: boolean) => (
  paymentsViewOptions(canTerms, canCalc, canAdmin).map(option => option.key)
);

describe('экраны вкладки «Выплаты» по правам', () => {
  it('весь раздел: Условия оплаты · Подробно · Расчёт и выплаты · Администрирование', () => {
    expect(keys(true, true, true)).toEqual(['terms', 'details', 'calc', 'admin']);
  });

  it('условия оплаты и расчёт без администрирования', () => {
    expect(keys(true, true, false)).toEqual(['terms', 'details', 'calc']);
  });

  it('только условия оплаты: список и «Подробно»', () => {
    expect(keys(true, false, false)).toEqual(['terms', 'details']);
  });

  it('только расчёт: без списка и карточки', () => {
    expect(keys(false, true, false)).toEqual(['calc']);
  });

  it('только администрирование', () => {
    expect(keys(false, false, true)).toEqual(['admin']);
  });
});

describe('экран из ?view=', () => {
  const all = paymentsViewOptions(true, true, true);

  it('доступный экран открывается, в том числе «Подробно» без выбранного сотрудника', () => {
    expect(resolvePaymentsView('details', all)).toBe('details');
    expect(resolvePaymentsView('calc', all)).toBe('calc');
    expect(resolvePaymentsView('admin', all)).toBe('admin');
  });

  it('пусто или неизвестное значение — первый экран', () => {
    expect(resolvePaymentsView(null, all)).toBe('terms');
    expect(resolvePaymentsView('payments', all)).toBe('terms');
  });

  it('экран без права — первый доступный', () => {
    expect(resolvePaymentsView('calc', paymentsViewOptions(true, false, false))).toBe('terms');
    expect(resolvePaymentsView('details', paymentsViewOptions(false, true, false))).toBe('calc');
    expect(resolvePaymentsView('terms', paymentsViewOptions(false, true, false))).toBe('calc');
    expect(resolvePaymentsView('admin', paymentsViewOptions(true, true, false))).toBe('terms');
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

  it('частичное массовое назначение: закрывается только карточка применённого', () => {
    // applied — 1 и 3; сотрудник 2 отклонён (skipped), его условия не менялись.
    const skipped = row(2);
    expect(dropPayrollDetails(skipped, [1, 3])).toBe(skipped);
    expect(dropPayrollDetails(row(3), [1, 3])).toBeNull();
  });
});
