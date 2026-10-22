import { describe, expect, it } from 'vitest';

import type { IDormitoryStay } from '../services/dormitoryService';
import type {
  ICompensationStop,
  IDormitoryAllowanceRow,
  IPayrollSupplementRow,
} from '../services/payrollRegistryService';
import {
  apartmentRemoval,
  buildCompensationStopExport,
  buildDormitoryRegistryExport,
  buildDormitoryRegistryRows,
  DORMITORY_REGISTRY_COLUMNS,
  dormitoryAllowanceInMonths,
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
  parseOneTimeForm,
  parsePeriodForm,
  parsePlannedForm,
} from './payrollRegistryForms';
import {
  applyTableView,
  fitRegistryColumnWidths,
  matchesNameSearch,
  type IRegistryColumn,
} from './tableView';

const supplement = (over: Partial<IPayrollSupplementRow>): IPayrollSupplementRow => ({
  kind: 'planned', id: null, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null,
  amount: '5000.00', date_from: '2026-10-01', date_to: '2026-12-31', month: null, reason: null, can_edit: true,
  ...over,
});

describe('«Доплата»', () => {
  it('период: плановая — даты, разовая — месяц', () => {
    expect(supplementPeriod(supplement({}))).toBe('01.10.2026 – 31.12.2026');
    expect(supplementPeriod(supplement({ date_to: null }))).toBe('с 01.10.2026');
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
  it('квартира (🗑): выезд — 1-е число месяца; не начавшаяся или прошедшая — удаляется', () => {
    // Живёт с июля — убрана с 01.10: выезд 01.10 (по 30.09 включительно).
    expect(apartmentRemoval({ check_in: '2026-07-01', check_out: null }, '2026-10-20'))
      .toEqual({ action: 'close', checkOut: '2026-10-01' });
    expect(apartmentRemoval({ check_in: '2026-07-01', check_out: '2026-12-01' }, '2026-10-20'))
      .toEqual({ action: 'close', checkOut: '2026-10-01' });
    // Выехала 01.10 — в октябре уже не жила: прошедшее проживание.
    expect(apartmentRemoval({ check_in: '2026-07-01', check_out: '2026-10-01' }, '2026-10-20')).toEqual({ action: 'delete' });
    expect(apartmentRemoval({ check_in: '2026-10-05', check_out: null }, '2026-10-20')).toEqual({ action: 'delete' });
  });

  it('плановая: окончание раньше начала; «по» пусто — бессрочно', () => {
    expect(parsePlannedForm({ selected: true, amount: '5000', dateFrom: '2026-10-01', dateTo: '2026-09-30' }))
      .toMatchObject({ ok: false, field: 'date_to' });
    expect(parsePlannedForm({ selected: true, amount: '5000', dateFrom: '2026-10-01', dateTo: '' }))
      .toEqual({ ok: true, payload: { amount: 5000, date_from: '2026-10-01', date_to: null } });
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

  it('месяцы разовой доплаты: следующий, текущий и 11 прошлых', () => {
    const options = oneTimeMonthOptions('2026-01');
    expect(options).toHaveLength(13);
    expect(options.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(options[12]).toBe('2025-02');
  });
});

describe('ширины столбцов: подпись в одну строку, когда хватает места', () => {
  // ФИО, Отдел 140, Должность 148, Сумма 128, Действует с 160; подпись — 8px на символ.
  const column = (label: string, width?: number): IRegistryColumn<object> => ({
    key: label, label, type: 'text', width, text: () => '', sortValue: () => null,
  });
  const COLUMNS = [
    column('ФИО'), column('Отдел', 140), column('Должность', 148), column('Сумма, ₽/мес', 128), column('Действует с', 160),
  ];
  const labelWidth = (label: string): number => label.length * 8;
  const fit = (containerWidth: number) => fitRegistryColumnWidths({
    columns: COLUMNS, containerWidth, labelWidth, actionsWidth: 84,
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

describe('ширины столбцов: запас — по тексту ячеек, а не весь у ФИО', () => {
  // Те же столбцы, сумма и дата — одной строкой; после подписей запас = контейнер − 48 − 170 − 84 − 602.
  const column = (label: string, width?: number, nowrap?: boolean): IRegistryColumn<object> => ({
    key: label, label, type: 'text', width, nowrap, text: () => '', sortValue: () => null,
  });
  const COLUMNS = [
    column('ФИО'), column('Отдел', 140), column('Должность', 148),
    column('Сумма, ₽/мес', 128, true), column('Действует с', 160, true),
  ];
  // ФИО 200 → 228, отдел 240 → 268, должность 250 → 278 (+ паддинги 28): нехватка 58 + 128 + 130 = 316.
  const fit = (containerWidth: number, contentWidths: number[] = [200, 240, 250, 999, 999]) => fitRegistryColumnWidths({
    columns: COLUMNS, containerWidth, labelWidth: label => label.length * 8, actionsWidth: 84, contentWidths,
  });

  it('места много — всем по тексту, остаток 80 пропорционально ширинам; ФИО без ширины', () => {
    // Запас 396: отдел 268 + ⌊80 × 268 / 774⌋ = 295, должность 278 + ⌊80 × 278 / 774⌋ = 306; ФИО — остаток 253.
    expect(fit(1300)).toEqual([undefined, 295, 306, 154, 160]);
  });

  it('места мало — запас пропорционально нехватке', () => {
    // Запас 296: отдел 140 + ⌊128 × 296 / 316⌋ = 259, должность 148 + ⌊130 × 296 / 316⌋ = 269; ФИО — 226.
    expect(fit(1200)).toEqual([undefined, 259, 269, 154, 160]);
  });

  it('длинный текст тянет не больше 360', () => {
    // Отдел 1000 → 360: нехватка 58 + 220 + 130 = 408; отдел 140 + ⌊220 × 296 / 408⌋ = 299, должность 148 + 94.
    expect(fit(1200, [200, 1000, 250, 0, 0])).toEqual([undefined, 299, 242, 154, 160]);
  });

  it('запаса нет — компактные ширины; переносится только ФИО — всё у него, как раньше', () => {
    expect(fit(878)).toEqual([undefined, 140, 148, 128, 160]);
    expect(fitRegistryColumnWidths({
      columns: [column('Объект'), column('Чел.', 84, true)],
      containerWidth: 1300, labelWidth: () => 0, actionsWidth: 0, contentWidths: [400, 0],
    })).toEqual([undefined, 84]);
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
  });

  it('«Общежитие»: в одной таблице живущие (адрес, без доплаты) и «Не назначено» с доплатой', () => {
    const stay: IDormitoryStay = {
      id: 7, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null, kind: 'dormitory',
      check_in: '2026-09-01', check_out: '2026-10-01', address: 'Общ. Мал.Почтовая 2\\2', amount: null,
    };
    // Выехал 01.10 — с октября доплата; id совпадает с проживанием, ключи разные.
    const allowance: IDormitoryAllowanceRow = {
      id: 7, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null,
      date_from: '2026-10-01', date_to: null, amount: '160.00', can_edit: true, dormitory_stays: [],
    };
    const text = (months: string[]) => buildDormitoryRegistryRows([stay], [allowance], months)
      .map(row => DORMITORY_REGISTRY_COLUMNS.slice(3).map(column => column.text(row)));

    expect(text(['2026-09'])).toEqual([['Общ. Мал.Почтовая 2\\2', '01.09.2026', '01.10.2026', '—']]);
    // В день выезда уже не живёт.
    expect(text(['2026-10'])).toEqual([['Не назначено', '01.10.2026', 'бессрочно', '160,00']]);
    const all = buildDormitoryRegistryRows([stay], [allowance], []);
    expect(all.map(row => row.key)).toEqual(['stay:7', 'allowance:7']);
    expect(all.map(row => row.allowance)).toEqual([null, allowance]);
    expect(buildDormitoryRegistryExport(all).columns.map(column => column.label))
      .toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Общежитие', 'С', 'По', 'Доплата, ₽/мес']);
  });

  it('сумма доплаты — ставка последнего выбранного месяца, в который доплата положена (миграция 324)', () => {
    // Ставка 160 «с начала», с ноября — 200; в ноябре сотрудник уже живёт в общежитии.
    const values = [{ effective_from: '2000-01', amount: '160.00' }, { effective_from: '2026-11', amount: '200.00' }];
    const allowance: IDormitoryAllowanceRow = {
      id: 8, employee_id: 2, full_name: 'Борисов А.А.', department: null, position: null,
      date_from: '2026-09-01', date_to: null, amount: '200.00', can_edit: true,
      dormitory_stays: [{ check_in: '2026-11-10', check_out: null }],
    };
    const amounts = (months: string[]) => buildDormitoryRegistryRows([], [allowance], months, values)
      .map(row => row.amount);

    expect(amounts(['2026-09'])).toEqual(['160.00']);
    // Сентябрь и октябрь — ставка октября; ноябрь исключён общежитием — строка по октябрю, не по ноябрю.
    expect(amounts(['2026-09', '2026-10'])).toEqual(['160.00']);
    expect(amounts(['2026-10', '2026-11'])).toEqual(['160.00']);
    expect(amounts(['2026-11'])).toEqual([]);
    // Ставка прошлого месяца не меняется будущей сменой; без истории ставки — сумма сервера.
    const moved = { ...allowance, dormitory_stays: [] };
    expect(buildDormitoryRegistryRows([], [moved], ['2026-10', '2026-12'], values).map(row => row.amount)).toEqual(['200.00']);
    expect(buildDormitoryRegistryRows([], [moved], ['2026-10']).map(row => row.amount)).toEqual(['200.00']);
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
