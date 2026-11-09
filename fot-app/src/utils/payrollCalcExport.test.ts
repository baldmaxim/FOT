import { describe, expect, it } from 'vitest';

import type { IPayrollCalcColumns, IPayrollTermsRow } from '../services/payrollService';
import {
  buildPayrollCalcExport,
  describePayrollColumnFilters,
  payrollCalcExportColumns,
  type IPayrollCalcExportParams,
} from './payrollCalcExport';
import { PAYROLL_CALC_TABLE_COLUMNS, type PayrollTableColumn } from './payrollColumns';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';
import type { PayrollExpandableColumn } from './payrollSubColumns';

const calc = (over: Partial<IPayrollCalcColumns> = {}): IPayrollCalcColumns => ({
  rate: null,
  timesheet: null,
  overtime: null,
  overtime_days: 0,
  overtime_hours: 0,
  travel: null,
  housing: null,
  housing_kinds: [],
  supplements: null,
  deductions: null,
  net: null,
  open_months: [],
  incomplete: [],
  ...over,
});

const row = (over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => ({
  employee_id: 1,
  full_name: 'Иванов И. И.',
  department_name: 'Бухгалтерия',
  position_name: 'Бухгалтер',
  schedule_name: 'Пятидневка',
  calc: calc(),
  ...over,
} as IPayrollTermsRow);

/** Строка со скриншота: Абдуллаев, сентябрь 2026. */
const abdullaev = (): IPayrollTermsRow => row({
  full_name: 'Абдуллаев Руслан Насурович',
  card_payouts_by_method: [
    { method: 'Отпуска', amount: '99140.26' },
    { method: 'Аванс', amount: '42708.91' },
    { method: 'Зарплата за месяц', amount: '42708.91' },
  ],
  calc: calc({
    rate: { amount: '195000.00', calc_type: 'salary', as_of: '2026-09-30' },
    timesheet: '106363.68',
    net: '221992.94',
  }),
});

const NO_COLUMNS: ReadonlySet<PayrollTableColumn> = new Set();
const NOT_EXPANDED: ReadonlySet<PayrollExpandableColumn> = new Set();

const params = (over: Partial<IPayrollCalcExportParams> = {}): IPayrollCalcExportParams => ({
  rows: [abdullaev()],
  columns: PAYROLL_CALC_TABLE_COLUMNS,
  hidden: NO_COLUMNS,
  expanded: NOT_EXPANDED,
  months: ['2026-09'],
  departmentName: null,
  search: '',
  filters: {},
  ...over,
});

/** Подписи столбцов снимка без «№». */
const labels = (over: Partial<IPayrollCalcExportParams> = {}): string[] => (
  buildPayrollCalcExport(params(over)).columns.slice(1).map(column => column.label)
);

/** Значение столбца в строке снимка по подписи. */
const cell = (over: Partial<IPayrollCalcExportParams>, label: string, rowIndex = 0): string | number | null => {
  const snapshot = buildPayrollCalcExport(params(over));
  const index = snapshot.columns.findIndex(column => column.label === label);
  expect(index, label).toBeGreaterThan(-1);
  return snapshot.rows[rowIndex].cells[index];
};

describe('столбцы файла «Расчётов»', () => {
  it('скрытый шестерёнкой столбец не выгружается', () => {
    expect(labels()).toContain('Подразделение');
    expect(labels({ hidden: new Set<PayrollTableColumn>(['department', 'calc_remainder']) }))
      .not.toEqual(expect.arrayContaining(['Подразделение']));
    expect(labels({ hidden: new Set<PayrollTableColumn>(['department', 'calc_remainder']) }))
      .not.toContain('Остаток к выплате');
  });

  it('пустой столбец определяется по всем строкам: отпускные только у последней не теряются', () => {
    expect(labels()).not.toContain('Отпускные');
    const rows = [
      ...Array.from({ length: 501 }, (_, index) => row({ employee_id: index + 1 })),
      row({ employee_id: 502, calc: calc({ vacation: '99140.26' }) }),
    ];
    expect(labels({ rows })).toContain('Отпускные');
    expect(cell({ rows }, 'Отпускные', 501)).toBe('99140.26');
    expect(cell({ rows }, 'Отпускные', 0)).toBe('—');
  });

  it('«+»: раскрытые выгружаются, нераскрытые нет', () => {
    const rows = [row({
      paid_deductions_total: '500.00',
      paid_deductions: [{ month: '2026-09', item: PAYROLL_PAID_GROUPS.find(group => group.kind === 'deducted')!.items[0].code, amount: '500.00' }],
      calc: calc({
        supplements: '3000.00',
        supplements_planned: '1000.00',
        supplements_one_time: '2000.00',
        travel: '2730.00',
        deductions: '700.00',
        deductions_by_kind: [{ kind_id: 7, kind: 'Питание', amount: '700.00' }],
      }),
    })];
    expect(labels({ rows })).not.toContain('Плановая');

    const expanded = labels({ rows, expanded: new Set<PayrollExpandableColumn>(['calc_supplements', 'deductions', 'calc_deductions']) });
    expect(expanded).toEqual(expect.arrayContaining(['Доплаты', 'Компенсация проезда', 'Плановая', 'Разовая', 'Удержания (ФОТ): Питание']));
    expect(expanded.indexOf('Плановая')).toBe(expanded.indexOf('Доплаты') + 2);
    expect(expanded.some(label => label.startsWith('Удержания (1С): '))).toBe(true);
    expect(cell({ rows, expanded: new Set<PayrollExpandableColumn>(['calc_supplements']) }, 'Плановая')).toBe('1000.00');
  });

  it('совпавшие подписи и длинные названия: уникальны и не длиннее 60 символов', () => {
    const longName = 'Удержание за утерю спецодежды и средств индивидуальной защиты работника на объекте';
    const rows = [row({
      calc: calc({
        deductions: '2.00',
        deductions_by_kind: [
          { kind_id: 1, kind: longName, amount: '1.00' },
          { kind_id: 2, kind: `${longName} (Москва)`, amount: '1.00' },
        ],
      }),
    })];
    const result = labels({ rows, expanded: new Set<PayrollExpandableColumn>(['calc_deductions']) });
    const kinds = result.filter(label => label.startsWith('Удержания (ФОТ): '));
    expect(kinds).toHaveLength(2);
    expect(new Set(kinds).size).toBe(2);
    expect(Math.max(...result.map(label => label.length))).toBeLessThanOrEqual(60);
  });

  it('все раскрытые «+»: 68 столбцов с «№» укладываются в лимит сервера', () => {
    const deducted = PAYROLL_PAID_GROUPS.filter(group => group.kind === 'deducted').flatMap(group => group.items);
    const rows = [row({
      paid_deductions_total: '1.00',
      paid_deductions: deducted.map(item => ({ month: '2026-09', item: item.code, amount: '1.00' })),
      paid_recalc_prev: '1.00',
      card_payouts_by_method: [
        'Аванс', 'Зарплата за месяц', 'Премии', 'Отпуска', 'Увольнения', 'Больничные листы',
        'Вознаграждение сотрудникам по договорам ГПХ', 'Материальная помощь', 'Разовые начисления',
      ].map(method => ({ method, amount: '1.00' })),
      calc: calc({
        rate: { amount: '1.00', calc_type: 'salary', as_of: '2026-09-30' },
        timesheet: '1.00', overtime: '1.00', travel: '1.00', vacation: '1.00', sick_leave: '1.00', housing: '1.00',
        supplements: '2.00', supplements_planned: '1.00', supplements_one_time: '1.00', deductions: '18.00', net: '1.00',
        deductions_by_kind: Array.from({ length: 18 }, (_, index) => ({ kind_id: index, kind: `Вид ${index}`, amount: '1.00' })),
        incomplete: [{ month: '2026-09', reasons: ['no_norm'] }],
      }),
    })];
    const snapshot = buildPayrollCalcExport(params({
      rows, expanded: new Set<PayrollExpandableColumn>(['calc_supplements', 'deductions', 'calc_deductions']),
    }));
    // 31 постоянный столбец, в том числе 9 способов выплаты и 5 подстолбцов «Доплат»; на ноябрь 2026 всего 68.
    expect(snapshot.columns.length).toBe(31 + deducted.length + 18);
    expect(snapshot.columns.length).toBeLessThanOrEqual(100);
    expect(new Set(snapshot.columns.map(column => column.label)).size).toBe(snapshot.columns.length);
    expect(snapshot.rows[0].cells).toHaveLength(snapshot.columns.length);
  });
});

describe('ячейки файла «Расчётов»', () => {
  it('суммы — NUMERIC-строками, без округления; ФИО и «№» на месте', () => {
    const snapshot = buildPayrollCalcExport(params());
    expect(snapshot.columns.slice(0, 2).map(column => column.label)).toEqual(['№', 'Сотрудник']);
    expect(snapshot.rows[0].cells.slice(0, 2)).toEqual([1, 'Абдуллаев Руслан Насурович']);
    expect(cell({}, 'Сумма')).toBe('221992.94');
    expect(cell({}, 'Начислено по табелю')).toBe('106363.68');
    expect(snapshot.columns.find(column => column.label === 'Сумма')?.type).toBe('money');
  });

  it('«Выплаты на карту»: итог и столбцы по видам в порядке ячейки; «Остаток» — как на экране', () => {
    const result = labels();
    const start = result.indexOf('Выплаты на карту (1С)');
    expect(result.slice(start, start + 4)).toEqual([
      'Выплаты на карту (1С)', 'На карту: Аванс', 'На карту: Зарплата', 'На карту: Отпуска',
    ]);
    expect(cell({}, 'Выплаты на карту (1С)')).toBe('184558.08');
    expect(cell({}, 'На карту: Отпуска')).toBe('99140.26');
    expect(cell({}, 'Остаток к выплате')).toBe('37434.86');
  });

  it('один вид выплаты: итог есть (в ячейке экрана «Итого» нет, в файле столбец нужен); нет вида — «—»', () => {
    const rows = [
      row({ card_payouts_by_method: [{ method: 'Аванс', amount: '100.10' }] }),
      row({ employee_id: 2, card_payouts_by_method: null }),
    ];
    expect(cell({ rows }, 'Выплаты на карту (1С)', 0)).toBe('100.10');
    expect(cell({ rows }, 'На карту: Аванс', 0)).toBe('100.10');
    expect(cell({ rows }, 'Выплаты на карту (1С)', 1)).toBe('—');
    expect(cell({ rows }, 'На карту: Аванс', 1)).toBe('—');
  });

  it('оклад — число, почасовая ставка — текст с «₽/ч», как на экране', () => {
    const rows = [
      abdullaev(),
      row({ employee_id: 2, calc: calc({ rate: { amount: '730.0000', calc_type: 'hourly', as_of: '2026-09-30' }, net: '133038.00' }) }),
    ];
    expect(cell({ rows }, 'Оклад', 0)).toBe('195000.00');
    expect(String(cell({ rows }, 'Оклад', 1))).toMatch(/^730,00 ₽\/ч$/);
  });

  it('выработка не внесена — подпись в «Начислено», «Сумме» и «Остатке», «Примечания» нет', () => {
    const rows = [row({ calc: calc({ incomplete: [{ month: '2026-09', reasons: ['brigade_output'] }] }) })];
    expect(cell({ rows }, 'Сумма')).toBe('выработка не внесена');
    expect(cell({ rows }, 'Остаток к выплате')).toBe('выработка не внесена');
    expect(cell({ rows }, 'Начислено по табелю')).toBe('выработка не внесена');
    expect(labels({ rows })).not.toContain('Примечание');
  });

  it('⚠: «—» в сумме, причина — в «Примечании» последним столбцом; у других строк пусто', () => {
    const rows = [
      row({ calc: calc({ incomplete: [{ month: '2026-09', reasons: ['brigade_no_hours'] }] }) }),
      abdullaev(),
    ];
    expect(cell({ rows }, 'Сумма', 0)).toBe('—');
    expect(labels({ rows }).at(-1)).toBe('Примечание');
    expect(cell({ rows }, 'Примечание', 0)).toBe('Неполный расчёт: сентябрь — нет учтённых часов бригады');
    expect(cell({ rows }, 'Примечание', 1)).toBe('');
    expect(labels()).not.toContain('Примечание');
  });

  it('частичная сумма без выработки помечается в «Примечании»: иначе выглядела бы окончательной', () => {
    const rows = [row({
      calc: calc({ timesheet: '100.00', incomplete: [{ month: '2026-08', reasons: ['brigade_output'] }] }),
    })];
    expect(cell({ rows }, 'Начислено по табелю')).toBe('100.00');
    expect(cell({ rows }, 'Примечание')).toBe('выработка не внесена');
  });

  it('только столбцы 1С — «Примечания» про ФОТ нет', () => {
    const hidden = new Set(PAYROLL_CALC_TABLE_COLUMNS.map(column => column.key).filter(key => key !== 'card_payouts'));
    const rows = [row({ calc: calc({ incomplete: [{ month: '2026-09', reasons: ['no_terms'] }] }) })];
    expect(labels({ rows, hidden })).toEqual(['Сотрудник', 'Выплаты на карту (1С)']);
  });

  it('ФОТ за период недоступен (нет поля calc): столбцов ФОТ нет, как на экране', () => {
    const rows = [{ employee_id: 1, full_name: 'Иванов И. И.', paid_recalc_prev: '10.00' } as IPayrollTermsRow];
    const result = payrollCalcExportColumns({
      rows, columns: PAYROLL_CALC_TABLE_COLUMNS, hidden: NO_COLUMNS, expanded: NOT_EXPANDED,
    }).map(column => column.label);
    expect(result).not.toContain('Сумма');
    expect(result).toContain('Перерасчёт за пред. месяц');
  });
});

describe('столбец «Договор»', () => {
  it('ГПХ — «ГПХ», как подпись под ФИО; трудовой — пусто; столбец сразу за «Сотрудником»', () => {
    const rows = [abdullaev(), row({ employee_id: 3, full_name: 'Озджан Э.', contract_type: 'gph' })];
    expect(labels({ rows }).slice(0, 2)).toEqual(['Сотрудник', 'Договор']);
    expect(cell({ rows }, 'Договор', 1)).toBe('ГПХ');
    expect(cell({ rows }, 'Сотрудник', 1)).toBe('Озджан Э.');
    expect(cell({ rows }, 'Договор', 0)).toBe('');
  });

  it('ГПХ в выборке нет, в том числе у старого бэкенда без поля, — столбца нет', () => {
    expect(labels()).not.toContain('Договор');
    expect(labels({ rows: [row({ contract_type: 'labor' })] })).not.toContain('Договор');
  });

  it('«Расчёты» — по is_gph за месяцы: ГПХ в сентябре при трудовом сейчас — «ГПХ», и наоборот — пусто', () => {
    const rows = [
      row({ employee_id: 3, contract_type: 'labor', is_gph: true }),
      row({ employee_id: 4, contract_type: 'gph', is_gph: false }),
    ];
    expect(cell({ rows }, 'Договор', 0)).toBe('ГПХ');
    expect(cell({ rows }, 'Договор', 1)).toBe('');
    expect(labels({ rows: [row({ contract_type: 'gph', is_gph: false })] })).not.toContain('Договор');
  });
});

describe('подзаголовок и имя файла', () => {
  it('фильтры столбцов текстом; пустое значение — «(пусто)»', () => {
    expect(describePayrollColumnFilters({})).toBe('');
    expect(describePayrollColumnFilters({
      text: { name: 'Абду' },
      values: { position: ['Монтажник', null], schedule: ['6+0 (10ч)'] },
    })).toBe('Сотрудник: Абду; Должность: Монтажник, (пусто); График работы: 6+0 (10ч)');
    expect(describePayrollColumnFilters({ text: { name: 'Абду' }, contract: 'gph', values: { position: ['Маляр'] } }))
      .toBe('Сотрудник: Абду; Договор: ГПХ; Должность: Маляр');
  });

  it('период, отдел, поиск и фильтры — в подзаголовке', () => {
    const { subtitle, title } = buildPayrollCalcExport(params({
      departmentName: 'Бухгалтерия',
      search: 'Абду',
      filters: { values: { position: ['Монтажник'] } },
    }));
    expect(title).toBe('Расчёты');
    expect(subtitle).toMatch(/^Период: .+ 2026\. Отдел: Бухгалтерия\. Поиск: «Абду»\. Фильтры: Должность: Монтажник\. Дата выгрузки: \d{2}\.\d{2}\.\d{4}$/);
    expect(buildPayrollCalcExport(params()).subtitle).toContain('Отдел: все отделы');
  });

  it('категория и объект месяца — после отдела; «Все» не пишутся', () => {
    const { subtitle } = buildPayrollCalcExport(params({
      departmentName: 'Бухгалтерия', categoryLabel: 'Рабочие', objectName: 'ЖК Химки', search: 'Абду',
    }));
    expect(subtitle).toMatch(/Отдел: Бухгалтерия\. Категория: Рабочие\. Объект: ЖК Химки\. Поиск: «Абду»\./);
    expect(buildPayrollCalcExport(params({ categoryLabel: null, objectName: null })).subtitle).not.toMatch(/Категория|Объект/);
  });

  it('лимиты сервера: подзаголовок ≤ 300 с датой в конце, имя файла ≤ 150 без служебных символов', () => {
    const months = ['01', '03', '05', '07', '09', '11'].flatMap(month => [`2025-${month}`, `2026-${month}`]);
    const { subtitle, file_name: fileName } = buildPayrollCalcExport(params({
      months,
      departmentName: 'Отдел '.repeat(30),
      search: 'поиск'.repeat(20),
      filters: { values: { position: Array.from({ length: 50 }, (_, index) => `Должность ${index}`) } },
    }));
    expect(subtitle.length).toBeLessThanOrEqual(300);
    expect(subtitle).toMatch(/…\. Дата выгрузки: \d{2}\.\d{2}\.\d{4}$/);
    expect(fileName.length).toBeLessThanOrEqual(150);
    expect(fileName).toMatch(/^Расчёты_.+\.xlsx$/);
    expect(fileName).not.toMatch(/[\s/\\:*?"<>|]/);
  });
});
