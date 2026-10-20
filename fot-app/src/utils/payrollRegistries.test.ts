import { describe, expect, it } from 'vitest';

import type {
  ICompensationStop,
  IDeductionRegistryRow,
  IDormitoryAllowanceRow,
  IPayrollSupplementRow,
} from '../services/payrollRegistryService';
import {
  buildCompensationStopExport,
  buildDeductionExport,
  buildDormitoryAllowanceExport,
  dormitoryAllowanceInMonths,
  DEDUCTION_COLUMNS,
  HOUSING_COLUMNS,
  periodIntersectsMonths,
  registryMonthOptions,
  registryMonthsParam,
  registryRemoval,
  stopInMonths,
  SUPPLEMENT_COLUMNS,
  supplementInMonths,
  supplementPeriod,
  supplementRowKey,
} from './payrollRegistries';
import {
  oneTimeMonthOptions,
  parseDeductionForm,
  parseHousingForm,
  parseOneTimeForm,
  parsePeriodForm,
  parsePlannedForm,
} from './payrollRegistryForms';
import { applyTableView, columnFilterOptions, fitRegistryColumnWidths, matchesNameSearch } from './tableView';

const deduction = (employeeId: number, kinds: string[], amount: string | null = null): IDeductionRegistryRow => ({
  employee_id: employeeId, full_name: `Сотрудник ${employeeId}`, department: null, position: null, kinds,
  kind_ids: kinds.map((_, index) => index + 1), amount, can_edit: true,
});

const supplement = (over: Partial<IPayrollSupplementRow>): IPayrollSupplementRow => ({
  kind: 'planned', id: null, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null,
  amount: '5000.00', date_from: '2026-10-01', date_to: '2026-12-31', month: null, reason: null, can_edit: true,
  ...over,
});

describe('«Удержания»: фильтр по отдельным видам', () => {
  const rows = [deduction(1, ['ТМЦ', 'Питание']), deduction(2, ['ТМЦ']), deduction(3, [], '1500.00')];

  it('в списке фильтра — виды по отдельности, без склеек; без вида — «—»', () => {
    expect(columnFilterOptions(rows, DEDUCTION_COLUMNS, {}, 'kinds')).toEqual(expect.arrayContaining([
      { value: 'ТМЦ', count: 2 },
      { value: 'Питание', count: 1 },
      { value: '—', count: 1 },
    ]));
    expect(columnFilterOptions(rows, DEDUCTION_COLUMNS, {}, 'kinds')).toHaveLength(3);
  });

  it('«Питание» находит строку «ТМЦ, Питание»', () => {
    const visible = applyTableView(rows, DEDUCTION_COLUMNS, { sort: '', dir: 'asc', filters: { kinds: ['Питание'] } });
    expect(visible.map(row => row.employee_id)).toEqual([1]);
  });

  it('экспорт: виды текстом ячейки, сумма — числом-строкой с сервера, нет суммы — «—», как на экране', () => {
    const snapshot = buildDeductionExport(rows);
    expect(snapshot.columns.map(column => column.label)).toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Вид удержания', 'Сумма, ₽/мес']);
    expect(snapshot.rows[0].cells).toEqual([1, 'Сотрудник 1', '—', '—', 'ТМЦ, Питание', '—']);
    expect(snapshot.rows[2].cells[5]).toBe('1500.00');
  });
});

describe('«Доплата»', () => {
  it('период: плановая — даты, разовая — месяц', () => {
    expect(supplementPeriod(supplement({}))).toBe('01.10.2026 – 31.12.2026');
    expect(supplementPeriod(supplement({ kind: 'one_time', id: 5, month: '2026-10', date_from: null, date_to: null })))
      .toBe('октябрь 2026');
  });

  it('ключ строки: плановая — по версии журнала (старый бэкенд — по сотруднику), разовая — по id', () => {
    expect(supplementRowKey(supplement({}))).toBe('planned-1');
    expect(supplementRowKey(supplement({ id: 7 }))).toBe('planned-7');
    expect(supplementRowKey(supplement({ kind: 'one_time', id: 5 }))).toBe('once-5');
  });

  it('сортировка по периоду ставит разовую по первому числу месяца', () => {
    const rows = [
      supplement({ kind: 'one_time', id: 5, month: '2026-11', date_from: null, date_to: null }),
      supplement({ employee_id: 2, date_from: '2026-10-15' }),
    ];
    const sorted = applyTableView(rows, SUPPLEMENT_COLUMNS, { sort: 'period', dir: 'asc', filters: {} });
    expect(sorted.map(supplementRowKey)).toEqual(['planned-2', 'once-5']);
  });
});

describe('поиск по ФИО', () => {
  it('без учёта регистра и «ё»', () => {
    expect(matchesNameSearch('Карасёв Пётр', 'карасев')).toBe(true);
    expect(matchesNameSearch('Карасёв Пётр', '  ')).toBe(true);
    expect(matchesNameSearch(null, 'кар')).toBe(false);
  });
});

describe('формы', () => {
  it('проживание: без оклада и без суммы — ошибки, сумма с запятой и пробелами', () => {
    expect(parseHousingForm({ selected: true, hasTerms: false, amount: '630', effectiveFrom: '2026-10-19' }))
      .toMatchObject({ ok: false, field: 'employee', message: 'Сначала внесите оклад в окне сотрудника' });
    expect(parseHousingForm({ selected: true, hasTerms: true, amount: '0', effectiveFrom: '2026-10-19' }))
      .toMatchObject({ ok: false, field: 'amount' });
    expect(parseHousingForm({ selected: true, hasTerms: true, amount: '1 250,5', effectiveFrom: '2026-10-19' }))
      .toEqual({ ok: true, payload: { amount: 1250.5, effective_from: '2026-10-19' } });
  });

  it('плановая: окончание раньше начала', () => {
    expect(parsePlannedForm({ selected: true, amount: '5000', dateFrom: '2026-10-01', dateTo: '2026-09-30' }))
      .toMatchObject({ ok: false, field: 'date_to' });
  });

  it('разовая: основание обязательно и без лишних пробелов', () => {
    expect(parseOneTimeForm({ selected: true, month: '2026-10', amount: '100', reason: '   ' }))
      .toMatchObject({ ok: false, field: 'reason' });
    expect(parseOneTimeForm({ selected: true, month: '2026-10', amount: '100', reason: ' Премия  за объект ' }))
      .toEqual({ ok: true, payload: { month: '2026-10', amount: 100, reason: 'Премия за объект' } });
  });

  it('период «с — по»: «по» пусто — бессрочно, один день — можно; подпись «с» — в сообщении', () => {
    const period = (dateFrom: string, dateTo: string) =>
      parsePeriodForm({ selected: true, dateFrom, dateTo, fromLabel: 'Без проезда с' });
    expect(period('2026-08-01', '')).toEqual({ ok: true, payload: { date_from: '2026-08-01', date_to: null } });
    expect(period('2026-08-01', '2026-08-01')).toMatchObject({ ok: true });
    expect(period('2026-08-01', '2026-07-31')).toMatchObject({ ok: false, field: 'date_to' });
    expect(parsePeriodForm({ selected: true, dateFrom: '', dateTo: '', fromLabel: 'Доплата с' }))
      .toEqual({ ok: false, field: 'date_from', message: 'Укажите дату «Доплата с»' });
  });

  it('удержание: нужен вид или сумма; сумма без оклада — нельзя; при правке пусто — снять', () => {
    const base = { selected: true, isEdit: false, hasTerms: true, kindIds: [] as number[], amount: '', effectiveFrom: '2026-10-19' };
    expect(parseDeductionForm(base)).toMatchObject({ ok: false, field: 'kinds' });
    expect(parseDeductionForm({ ...base, kindIds: [2, 2, 5] }))
      .toEqual({ ok: true, payload: { kind_ids: [2, 5], amount: null, effective_from: '2026-10-19' } });
    expect(parseDeductionForm({ ...base, amount: '1 500,5' }))
      .toEqual({ ok: true, payload: { kind_ids: [], amount: 1500.5, effective_from: '2026-10-19' } });
    expect(parseDeductionForm({ ...base, amount: '1500', hasTerms: false }))
      .toMatchObject({ ok: false, field: 'amount', message: 'Сначала внесите оклад в окне сотрудника' });
    // Без оклада виды — можно: сумма не задана.
    expect(parseDeductionForm({ ...base, hasTerms: false, kindIds: [1] })).toMatchObject({ ok: true });
    expect(parseDeductionForm({ ...base, amount: '0', kindIds: [1] })).toMatchObject({ ok: false, field: 'amount' });
    expect(parseDeductionForm({ ...base, kindIds: [1], effectiveFrom: '2026-02-31' })).toMatchObject({ ok: false, field: 'date_from' });
    expect(parseDeductionForm({ ...base, isEdit: true }))
      .toEqual({ ok: true, payload: { kind_ids: [], amount: null, effective_from: '2026-10-19' } });
  });

  it('месяцы разовой доплаты: следующий, текущий и 11 прошлых', () => {
    const options = oneTimeMonthOptions('2026-01');
    expect(options).toHaveLength(13);
    expect(options.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(options[12]).toBe('2025-02');
  });
});

describe('ширины столбцов: подпись в одну строку, когда хватает места', () => {
  // ФИО, Отдел 140, Должность 148, Сумма 128, Действует с 160; подпись — 8px на символ.
  const labelWidth = (label: string): number => label.length * 8;
  const fit = (containerWidth: number) => fitRegistryColumnWidths({
    columns: HOUSING_COLUMNS, containerWidth, labelWidth, actionsWidth: 84,
  });

  it('места много — «Сумма, ₽/мес» расширяется (12 × 8 + 58 = 154), остальные уже влезают', () => {
    expect(fit(1700)).toEqual([undefined, 140, 148, 154, 160]);
  });

  it('места нет (как на 1280 с семью столбцами) — компактные ширины', () => {
    // 48 + 170 + 84 + 576 = 878 — запаса нет.
    expect(fit(878)).toEqual([undefined, 140, 148, 128, 160]);
    expect(fit(900)).toEqual([undefined, 140, 148, 128, 160]);
  });

  it('запаса ровно на расширение — расширяется', () => {
    expect(fit(878 + 26)).toEqual([undefined, 140, 148, 154, 160]);
  });
});

describe('выбор месяца в таблицах «Справочника»', () => {
  it('варианты: 24 месяца назад и 12 вперёд по возрастанию', () => {
    const options = registryMonthOptions('2026-10');
    expect(options).toHaveLength(37);
    expect(options[0]).toBe('2024-10');
    expect(options[24]).toBe('2026-10');
    expect(options.at(-1)).toBe('2027-10');
  });

  it('параметр сервера: «Весь период» — all, иначе месяцы по порядку', () => {
    expect(registryMonthsParam([])).toBe('all');
    expect(registryMonthsParam(['2026-10', '2026-09'])).toBe('2026-09,2026-10');
  });

  it('период задевает месяц: границы включительно, пусто — без границы, «Весь период» — любой', () => {
    expect(periodIntersectsMonths('2026-10-31', null, ['2026-10'])).toBe(true);
    expect(periodIntersectsMonths('2026-11-01', null, ['2026-10'])).toBe(false);
    expect(periodIntersectsMonths('2026-08-01', '2026-09-01', ['2026-09'])).toBe(true);
    expect(periodIntersectsMonths('2026-08-01', '2026-08-31', ['2026-09'])).toBe(false);
    expect(periodIntersectsMonths('2024-02-29', '2024-02-29', ['2024-02'])).toBe(true);
    expect(periodIntersectsMonths('2026-08-01', '2026-08-31', ['2026-07', '2026-08'])).toBe(true);
    expect(periodIntersectsMonths('2030-01-01', null, [])).toBe(true);
  });

  it('«Доплата»: разовая — по своему месяцу, плановая — по периоду', () => {
    const once = supplement({ kind: 'one_time', id: 5, month: '2026-11', date_from: null, date_to: null });
    expect(supplementInMonths(once, ['2026-11'])).toBe(true);
    expect(supplementInMonths(once, ['2026-10'])).toBe(false);
    expect(supplementInMonths(once, [])).toBe(true);
    expect(supplementInMonths(supplement({}), ['2026-12'])).toBe(true);
    expect(supplementInMonths(supplement({}), ['2027-01'])).toBe(false);
  });

  it('«Без проезда»: бессрочный период — во всех следующих месяцах', () => {
    const stop: ICompensationStop = {
      id: 1, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null,
      date_from: '2026-08-15', date_to: null, can_edit: true,
    };
    expect(stopInMonths(stop, ['2026-07'])).toBe(false);
    expect(stopInMonths(stop, ['2026-08'])).toBe(true);
    expect(stopInMonths(stop, ['2027-05'])).toBe(true);
    expect(buildCompensationStopExport([stop]).columns.map(column => column.label))
      .toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Без проезда с', 'По']);
  });

  it('«Доплата за общежитие»: месяцы проживания скрыты, в день выезда уже не живёт; «Весь период» — все', () => {
    const row: IDormitoryAllowanceRow = {
      id: 1, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null,
      date_from: '2026-11-01', date_to: null, amount: '500.00', can_edit: true,
      // Заселили позже: живёт с 10.12 по 31.01 (выезд 01.02).
      dormitory_stays: [{ check_in: '2026-12-10', check_out: '2027-02-01' }],
    };
    expect(dormitoryAllowanceInMonths(row, ['2026-10'])).toBe(false);
    expect(dormitoryAllowanceInMonths(row, ['2026-11'])).toBe(true);
    expect(dormitoryAllowanceInMonths(row, ['2026-12'])).toBe(false);
    expect(dormitoryAllowanceInMonths(row, ['2027-01'])).toBe(false);
    expect(dormitoryAllowanceInMonths(row, ['2027-02'])).toBe(true);
    expect(dormitoryAllowanceInMonths(row, ['2026-12', '2027-02'])).toBe(true);
    expect(dormitoryAllowanceInMonths(row, [])).toBe(true);
    // Живёт и сейчас (выезда нет) — дальше не показывается.
    const living = { ...row, dormitory_stays: [{ check_in: '2026-12-10', check_out: null }] };
    expect(dormitoryAllowanceInMonths(living, ['2030-01'])).toBe(false);
    expect(buildDormitoryAllowanceExport([{ ...row, amount: null }]).columns.map(column => column.label))
      .toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Доплата с', 'По', 'Сумма, ₽/мес']);
  });
});

describe('🗑 в таблицах периодов: убрать с 1-го числа или удалить ошибочную', () => {
  const TODAY = '2026-10-20';

  it('идёт через 1-е число — закрыть последним днём прошлого месяца', () => {
    expect(registryRemoval({ date_from: '2026-07-01', date_to: null }, TODAY))
      .toEqual({ action: 'close', cutoff: '2026-10-01', dateTo: '2026-09-30' });
    expect(registryRemoval({ date_from: '2026-07-15', date_to: '2026-12-31' }, TODAY))
      .toEqual({ action: 'close', cutoff: '2026-10-01', dateTo: '2026-09-30' });
    expect(registryRemoval({ date_from: '2026-02-10', date_to: '2026-03-01' }, '2026-03-05'))
      .toEqual({ action: 'close', cutoff: '2026-03-01', dateTo: '2026-02-28' });
  });

  it('начинается в этом месяце или позже — удалить', () => {
    expect(registryRemoval({ date_from: '2026-10-01', date_to: null }, TODAY)).toEqual({ action: 'delete' });
    expect(registryRemoval({ date_from: '2026-12-01', date_to: '2026-12-31' }, TODAY)).toEqual({ action: 'delete' });
  });

  it('целиком в прошлом — удалить', () => {
    expect(registryRemoval({ date_from: '2026-07-01', date_to: '2026-09-30' }, TODAY)).toEqual({ action: 'delete' });
  });

  it('январь: прошлый месяц — декабрь прошлого года', () => {
    expect(registryRemoval({ date_from: '2026-11-01', date_to: null }, '2027-01-10'))
      .toEqual({ action: 'close', cutoff: '2027-01-01', dateTo: '2026-12-31' });
  });
});
