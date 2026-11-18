import { describe, expect, it } from 'vitest';

import type { IEmployeePlannedSupplement, IPayrollPaidAmount, IPayrollTermsRow } from '../services/payrollService';
import {
  buildPaidHistorySheet,
  buildPayrollCardExport,
  buildPayrollTermsSheet,
  PAYROLL_CARD_NO_PAYOUTS,
} from './payrollCardExport';
import { PAYROLL_PAID_GROUPS, type IPaidMonthSums } from './payrollPaid';

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
  ...patch,
});

/** Строки листа «Условия» как { показатель: значение }. */
const termsValues = (
  r: IPayrollTermsRow,
  supplements: readonly IEmployeePlannedSupplement[] = [],
): Record<string, string | number | null> => Object.fromEntries(
  buildPayrollTermsSheet(r, '2026-10-26', supplements).rows.map(({ cells }) => [cells[0], cells[1]]),
);

/** Строки плановых доплат листа «Условия» по порядку — показатель и значение. */
const supplementCells = (supplements: readonly IEmployeePlannedSupplement[]) => (
  buildPayrollTermsSheet(row(), '2026-10-26', supplements).rows
    .map(({ cells }) => cells)
    .filter(cells => String(cells[0]).startsWith('Плановая доплата'))
);

const plannedSupplement = (patch: Partial<IEmployeePlannedSupplement> = {}): IEmployeePlannedSupplement => ({
  id: 1, amount: '5000.00', date_from: '2026-10-01', date_to: null, comment: null, ...patch,
});

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
    const sheet = buildPayrollTermsSheet(row(), '2026-10-26', []);
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
    }), [plannedSupplement()]);
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
      'Плановая доплата, комментарий': '—',
    });
  });

  it('плановые доплаты (миграция 369): нет — три прочерка, одна — с комментарием, несколько — блоки с номером', () => {
    expect(supplementCells([])).toEqual([
      ['Плановая доплата, ₽/мес', '—'],
      ['Плановая доплата с', '—'],
      ['Плановая доплата по', '—'],
    ]);
    expect(supplementCells([plannedSupplement({ comment: 'Совмещение', date_to: '2026-12-31' })])).toEqual([
      ['Плановая доплата, ₽/мес', 5000],
      ['Плановая доплата с', '01.10.2026'],
      ['Плановая доплата по', '31.12.2026'],
      ['Плановая доплата, комментарий', 'Совмещение'],
    ]);
    // Две доплаты на одни даты — по блоку на каждую, в порядке списка.
    expect(supplementCells([
      plannedSupplement({ id: 2, amount: '30000.00', date_to: '2027-01-31', comment: 'Руководство объектом' }),
      plannedSupplement({ id: 3, amount: '10000.50', date_to: '2027-01-31' }),
    ])).toEqual([
      ['Плановая доплата 1, ₽/мес', 30000],
      ['Плановая доплата 1 с', '01.10.2026'],
      ['Плановая доплата 1 по', '31.01.2027'],
      ['Плановая доплата 1, комментарий', 'Руководство объектом'],
      ['Плановая доплата 2, ₽/мес', 10000.5],
      ['Плановая доплата 2 с', '01.10.2026'],
      ['Плановая доплата 2 по', '31.01.2027'],
      ['Плановая доплата 2, комментарий', '—'],
    ]);
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

  it('столбцы: месяц, три итога, «Перечислено (1С)» и статьи с суммами в порядке ведомости', () => {
    const sheet = buildPaidHistorySheet('Иванов', paid);
    expect(sheet.columns.map(column => column.label)).toEqual([
      'Месяц', 'Начислено', 'Удержано', 'К выплате', 'Перечислено (1С)',
      'По трудовому договору', 'Компенсация проживания', 'Питание', 'Штрафы',
    ]);
    expect(sheet.columns.slice(1).every(column => column.type === 'money')).toBe(true);
  });

  it('месяцы новые сверху, «Итого» по каждому столбцу в копейках — и при одном годе', () => {
    const { rows } = buildPaidHistorySheet('Иванов', paid);
    expect(rows.map(r => r.cells)).toEqual([
      ['Август 2026', 151400.33, 0.3, 151400.03, null, 147240.33, 4160, 0.1, 0.2],
      ['Июль 2026', 157617.7, null, 157617.7, null, 157617.7, null, null, null],
      ['Итого', 309018.03, 0.3, 309017.73, null, 304858.03, 4160, 0.1, 0.2],
    ]);
  });

  it('«Перечислено (1С)»: месяц только с перечислением, несколько ведомостей за месяц — сумма в копейках', () => {
    const payout = (month: string, amountValue: string, documentId: number) => ({
      month, document_id: documentId, doc_number: `0000-00${documentId}`, zup2_number: null, doc_date: '2026-10-09',
      payment_method: 'Зарплата', amount: amountValue,
    });
    const { rows } = buildPaidHistorySheet('Иванов', paid, [
      payout('2026-09', '43500.00', 1),
      payout('2026-08', '100000.10', 2),
      payout('2026-08', '51400.20', 3),
    ]);
    expect(rows.map(r => r.cells.slice(0, 5))).toEqual([
      ['Сентябрь 2026', null, null, null, 43500],
      ['Август 2026', 151400.33, 0.3, 151400.03, 151400.3],
      ['Июль 2026', 157617.7, null, 157617.7, null],
      ['Итого', 309018.03, 0.3, 309017.73, 194900.3],
    ]);
  });

  it('выплат нет — пять столбцов и одна строка-подпись', () => {
    const sheet = buildPaidHistorySheet(null, []);
    expect(sheet.columns.map(column => column.label)).toEqual(['Месяц', 'Начислено', 'Удержано', 'К выплате', 'Перечислено (1С)']);
    expect(sheet.rows).toEqual([{ cells: [PAYROLL_CARD_NO_PAYOUTS, null, null, null, null] }]);
    expect(sheet.subtitle).toBe('Сотрудник');
  });

  it('все 47 статей — подписи столбцов уникальны и влезают в лимит сервера (60)', () => {
    const all = PAYROLL_PAID_GROUPS.flatMap(group => group.items).map(item => amount('2026-08', item.code, '1.00'));
    const { columns } = buildPaidHistorySheet('Иванов', all);
    expect(columns).toHaveLength(52);
    expect(new Set(columns.map(column => column.label)).size).toBe(columns.length);
  });
});

describe('лист «История выплат»: те же суммы, что на вкладке «Зарплата»', () => {
  const paid = [amount('2026-08', 'contract', '710497.00'), amount('2026-09', 'housing', '18900.00')];
  const sums = (accrued: number): IPaidMonthSums => ({ accrued, deducted: 0, payout: accrued });
  const recentMonths = ['2026-10', '2026-09', '2026-08'];

  it('Абдурахмонов: начислено, удержано, к выплате и «Итого» — расчёт ФОТ, статьи 1С на месте', () => {
    const { rows } = buildPaidHistorySheet('Абдурахмонов', paid, [], {
      recentMonths,
      byMonth: new Map([['2026-10', sums(204260)], ['2026-09', sums(211213)], ['2026-08', sums(176698)]]),
    });
    expect(rows.map(r => r.cells)).toEqual([
      ['Октябрь 2026', 204260, 0, 204260, null, null, null],
      ['Сентябрь 2026', 211213, 0, 211213, null, null, 18900],
      ['Август 2026', 176698, 0, 176698, null, 710497, null],
      ['Итого', 592171, 0, 592171, null, 710497, 18900],
    ]);
  });

  it('расчёт месяца не загрузился или итога нет — суммы 1С этого месяца', () => {
    const { rows } = buildPaidHistorySheet('Абдурахмонов', paid, [], {
      recentMonths,
      byMonth: new Map([['2026-10', sums(204260)], ['2026-09', null]]),
    });
    expect(rows.map(r => r.cells.slice(0, 4))).toEqual([
      ['Октябрь 2026', 204260, 0, 204260],
      ['Сентябрь 2026', 18900, null, 18900],
      ['Август 2026', 710497, null, 710497],
      ['Итого', 933657, 0, 933657],
    ]);
  });

  it('предварительный ноябрь (табель по 16.11) — подписан в строке месяца и в «Итого», как на экране', () => {
    const { rows } = buildPaidHistorySheet('Абдурахманов', paid, [], {
      recentMonths: ['2026-11', ...recentMonths],
      byMonth: new Map([
        ['2026-11', { ...sums(97568), asOf: '2026-11-16' }],
        ['2026-10', sums(204260)], ['2026-09', sums(211213)], ['2026-08', sums(176698)],
      ]),
    });
    expect(rows.map(r => r.cells.slice(0, 4))).toEqual([
      ['Ноябрь 2026 — предварительно, табель по 16.11', 97568, 0, 97568],
      ['Октябрь 2026', 204260, 0, 204260],
      ['Сентябрь 2026', 211213, 0, 211213],
      ['Август 2026', 176698, 0, 176698],
      ['Итого (вкл. предварительный ноябрь)', 689739, 0, 689739],
    ]);
  });

  it('месяцы есть, а сумм нет ни в расчёте, ни в 1С — прежняя строка', () => {
    const { rows } = buildPaidHistorySheet('Вайцишук', [], [], { recentMonths, byMonth: new Map() });
    expect(rows).toEqual([{ cells: ['Выплат из 1С пока нет', null, null, null, null] }]);
  });
});

describe('снимок карточки', () => {
  it('имя файла — по дате выгрузки, без пробелов; листы — условия и история', () => {
    const snapshot = buildPayrollCardExport({
      row: row(), supplements: [], paidRows: [], asOfDate: '2026-10-20', exportedAt: '2026-10-26',
    });
    expect(snapshot.file_name).toBe('Зарплата_Абдукарими_Сафарзодаи_Исмон_2026-10-26.xlsx');
    expect(snapshot.sheets.map(sheet => sheet.title)).toEqual(['Абдукарими Сафарзодаи Исмон', 'История выплат']);
    expect(snapshot.sheets[0].subtitle).toContain('Условия на 20.10.2026');
  });
});
