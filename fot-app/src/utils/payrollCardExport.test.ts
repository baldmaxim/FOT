import { describe, expect, it } from 'vitest';

import type { IPayrollPaidAmount, IPayrollTermsRow } from '../services/payrollService';
import {
  buildPaidHistorySheet,
  buildPayrollCardExport,
  buildPayrollTermsSheet,
  PAYROLL_CARD_NO_PAYOUTS,
} from './payrollCardExport';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';

const row = (patch: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => ({
  employee_id: 7,
  full_name: 'Абдукарими Сафарзодаи Исмон',
  tab_number: '0123',
  department_id: 'd-1',
  department_name: 'бр.Прозоров А.В.',
  position_name: 'Монтажник',
  schedule_name: null,
  terms_id: 11,
  category: 'office',
  calc_type: 'salary',
  monthly_salary: '100000.10',
  hourly_rate: null,
  bonus_amount: '50000.20',
  housing_compensation: '4160.00',
  travel_rate: '2730.00',
  travel_stopped: false,
  staff_units: '1',
  effective_from: '2026-09-01',
  effective_to: null,
  planned_supplement_amount: null,
  planned_supplement_from: null,
  planned_supplement_to: null,
  ...patch,
});

/** Строки листа «Условия» как { показатель: значение }. */
const termsValues = (r: IPayrollTermsRow): Record<string, string | number | null> => Object.fromEntries(
  buildPayrollTermsSheet(r, '2026-10-26').rows.map(({ cells }) => [cells[0], cells[1]]),
);

const amount = (month: string, item: IPayrollPaidAmount['item'], value: string): IPayrollPaidAmount => ({ month, item, amount: value });

describe('лист «Условия»', () => {
  it('действующие условия: суммы числом, «Итого» в копейках, дата текстом', () => {
    expect(termsValues(row())).toEqual({
      'Категория': 'Офис',
      'Вид оплаты': 'По графику (оклад)',
      'Оклад, ₽/мес': 100000.1,
      'Премиальная часть, ₽/мес': 50000.2,
      'Итого, ₽/мес': 150000.3,
      'Действует с': '01.09.2026',
      'Проживание, ₽/мес': 4160,
      'Проезд, ₽/мес': 2730,
      'Плановая доплата, ₽/мес': '—',
      'Плановая доплата с': '—',
      'Плановая доплата по': '—',
    });
  });

  it('шапка: ФИО, отдел, должность, таб. № и дата условий', () => {
    const sheet = buildPayrollTermsSheet(row(), '2026-10-26');
    expect(sheet.title).toBe('Абдукарими Сафарзодаи Исмон');
    expect(sheet.subtitle).toBe('бр.Прозоров А.В. · Монтажник · таб. № 0123 · Условия на 26.10.2026');
    expect(sheet.columns).toEqual([{ label: 'Показатель', type: 'text' }, { label: 'Значение', type: 'money' }]);
  });

  it('без условий — прочерки без умолчаний формы; категория, проживание и доплата остаются', () => {
    const values = termsValues(row({
      terms_id: null,
      calc_type: null,
      monthly_salary: null,
      bonus_amount: null,
      effective_from: null,
      category: 'worker',
      planned_supplement_amount: '5000.00',
      planned_supplement_from: '2026-10-01',
      planned_supplement_to: null,
    }));
    expect(values).toMatchObject({
      'Категория': 'Рабочие',
      'Вид оплаты': '—',
      'Оклад, ₽/мес': '—',
      'Премиальная часть, ₽/мес': '—',
      'Итого, ₽/мес': '—',
      'Действует с': '—',
      'Проживание, ₽/мес': 4160,
      // Рабочим проезд не положен.
      'Проезд, ₽/мес': '—',
      'Плановая доплата, ₽/мес': 5000,
      'Плановая доплата с': '01.10.2026',
      'Плановая доплата по': '—',
    });
  });

  it('почасовая: ставка вместо оклада, «Итого» — прочерк', () => {
    const values = termsValues(row({ calc_type: 'hourly', monthly_salary: null, hourly_rate: '312.1234' }));
    expect(values['Вид оплаты']).toBe('По часам');
    expect(values['Часовая ставка, ₽/час']).toBe(312.1234);
    expect(values['Оклад, ₽/мес']).toBeUndefined();
    expect(values['Итого, ₽/мес']).toBe('—');
  });
});

describe('лист «История выплат»', () => {
  const paid = [
    amount('2026-07', 'contract', '157617.70'),
    amount('2026-08', 'contract', '147240.33'),
    amount('2026-08', 'housing', '4160.00'),
    amount('2026-08', 'meals', '0.10'),
    amount('2026-08', 'fines', '0.20'),
  ];

  it('столбцы: месяц, три итога и статьи с суммами в порядке ведомости', () => {
    const sheet = buildPaidHistorySheet('Иванов', paid);
    expect(sheet.columns.map(column => column.label)).toEqual([
      'Месяц', 'Начислено', 'Удержано', 'К выплате', 'По трудовому договору', 'Компенсация проживания', 'Питание', 'Штрафы',
    ]);
    expect(sheet.columns.slice(1).every(column => column.type === 'money')).toBe(true);
  });

  it('месяцы новые сверху, «Итого» по каждому столбцу в копейках — и при одном годе', () => {
    const { rows } = buildPaidHistorySheet('Иванов', paid);
    expect(rows.map(r => r.cells)).toEqual([
      ['Август 2026', 151400.33, 0.3, 151400.03, 147240.33, 4160, 0.1, 0.2],
      ['Июль 2026', 157617.7, null, 157617.7, 157617.7, null, null, null],
      ['Итого', 309018.03, 0.3, 309017.73, 304858.03, 4160, 0.1, 0.2],
    ]);
  });

  it('выплат нет — четыре столбца и одна строка-подпись', () => {
    const sheet = buildPaidHistorySheet(null, []);
    expect(sheet.columns.map(column => column.label)).toEqual(['Месяц', 'Начислено', 'Удержано', 'К выплате']);
    expect(sheet.rows).toEqual([{ cells: [PAYROLL_CARD_NO_PAYOUTS, null, null, null] }]);
    expect(sheet.subtitle).toBe('Сотрудник');
  });

  it('все 40 статей — подписи столбцов уникальны и влезают в лимит сервера (50)', () => {
    const all = PAYROLL_PAID_GROUPS.flatMap(group => group.items).map(item => amount('2026-08', item.code, '1.00'));
    const { columns } = buildPaidHistorySheet('Иванов', all);
    expect(columns).toHaveLength(44);
    expect(new Set(columns.map(column => column.label)).size).toBe(columns.length);
  });
});

describe('снимок карточки', () => {
  it('имя файла — по дате выгрузки, без пробелов; листы — условия и история', () => {
    const snapshot = buildPayrollCardExport({ row: row(), paidRows: [], asOfDate: '2026-10-20', exportedAt: '2026-10-26' });
    expect(snapshot.file_name).toBe('Зарплата_Абдукарими_Сафарзодаи_Исмон_2026-10-26.xlsx');
    expect(snapshot.sheets.map(sheet => sheet.title)).toEqual(['Абдукарими Сафарзодаи Исмон', 'История выплат']);
    expect(snapshot.sheets[0].subtitle).toContain('Условия на 20.10.2026');
  });
});
