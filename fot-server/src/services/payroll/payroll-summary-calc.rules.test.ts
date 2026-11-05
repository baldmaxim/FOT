import { describe, expect, it } from 'vitest';

import type { PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import { deductionKindItem, mergeSummaryMonth, needsSummaryCalc, oneTimeReasonItem } from './payroll-summary-calc.rules.js';

const closed = (
  lines: Array<{ code: string; amount: string | null }>,
  missing: string[] = [],
): PayrollCalcWithPreliminary => ({ state: 'closed', lines, missing, deductions: [] }) as unknown as PayrollCalcWithPreliminary;

const merge = (over: Partial<Parameters<typeof mergeSummaryMonth>[0]>) => {
  const result = mergeSummaryMonth({ paid: new Map(), calc: undefined, oneTime: [], deductions: [], ...over });
  return { ...result, cents: Object.fromEntries(result.cents) };
};

describe('«Свод»: сведение расчёта и 1С', () => {
  it('в 1С есть «Зарплата» — весь месяц из 1С, переработка расчёта не добавляется (Акчай Эмрах, август)', () => {
    const result = merge({
      paid: new Map([['contract', '402381.00']]),
      calc: closed([{ code: 'contract', amount: '402381.00' }, { code: 'overtime', amount: '34821.43' }]),
      oneTime: [{ reason: 'Премия', amount: '1000.00' }],
      deductions: [{ kind: 'Питание', amount: '500.00' }],
    });
    expect(result.cents).toEqual({ contract: 40238100 });
    expect(result.issues).toEqual([]);
    expect(result.visible).toBe(true);
    expect(needsSummaryCalc(new Map([['contract', '402381.00']]))).toBe(false);
  });

  it('в 1С ничего нет — только расчёт, разовые по основаниям и удержания по видам', () => {
    const result = merge({
      calc: closed([
        { code: 'contract', amount: '150000.50' },
        { code: 'overtime', amount: '1000.00' },
        { code: 'travel', amount: '2730.00' },
        { code: 'housing', amount: '18900.00' },
        { code: 'bonus', amount: '5000.00' },
        // Сумма разовых — из оснований ниже, а не этой строкой.
        { code: 'supplement', amount: '7000.00' },
      ]),
      oneTime: [{ reason: 'Премия', amount: '2000.00' }, { reason: 'Допработы', amount: '5000.00' }],
      deductions: [{ kind: 'Питание', amount: '700.00' }, { kind: 'Штраф за мусор', amount: '100.25' }],
    });
    expect(result.cents).toEqual({
      contract: 15000050,
      overtime: 100000,
      travel: 273000,
      housing: 1890000,
      bonus: 500000,
      premium: 200000,
      extra_work: 500000,
      meals: 70000,
      other_deductions: 10025,
    });
    expect(needsSummaryCalc(undefined)).toBe(true);
  });

  it('статья 1С заменяет расчёт только по себе: проживание из 1С, зарплата из расчёта', () => {
    const result = merge({
      paid: new Map([['housing', '18900.00']]),
      calc: closed([{ code: 'contract', amount: '100000.00' }, { code: 'housing', amount: '12600.00' }]),
    });
    expect(result.cents).toEqual({ contract: 10000000, housing: 1890000 });
  });

  it('разовая доплата и та же статья 1С не удваиваются (сентябрь: «Допработы» в обоих местах)', () => {
    const result = merge({
      paid: new Map([['extra_work', '50000.00']]),
      calc: closed([{ code: 'contract', amount: '100000.00' }, { code: 'supplement', amount: '50000.00' }]),
      oneTime: [{ reason: ' Допработы ', amount: '50000.00' }],
    });
    expect(result.cents).toEqual({ contract: 10000000, extra_work: 5000000 });
  });

  it('квартира из расчёта и разовая «Компенсация проживания» — одна статья; загруженная из 1С заменяет обе', () => {
    const calc = closed([{ code: 'housing', amount: '12600.00' }]);
    const oneTime = [{ reason: 'Компенсация проживания', amount: '1000.00' }];
    expect(merge({ calc, oneTime }).cents).toEqual({ housing: 1360000 });
    expect(merge({ calc, oneTime, paid: new Map([['housing', '500.00']]) }).cents).toEqual({ housing: 50000 });
  });

  it('удержание 1С заменяет вид «Справочника»; 0 из 1С — тоже загруженное значение', () => {
    const deductions = [{ kind: 'питание', amount: '700.00' }];
    expect(merge({ deductions, paid: new Map([['meals', '900.00']]) }).cents).toEqual({ meals: 90000 });
    expect(merge({ deductions, paid: new Map([['meals', '0.00']]) }).cents).toEqual({ meals: 0 });
  });

  it('доля бригады — статья «Зарплата»; вместе с окладом за часть месяца складывается', () => {
    const result = merge({ calc: closed([{ code: 'contract', amount: '10000.00' }, { code: 'brigade', amount: '50000.25' }]) });
    expect(result.cents).toEqual({ contract: 6000025 });
  });

  it('выработка не внесена — суммы нет, человек виден с причиной; неизвестная доля не становится нулём', () => {
    const result = merge({ calc: closed([{ code: 'brigade', amount: null }], ['brigade_output']) });
    expect(result.cents).toEqual({});
    expect(result.issues).toEqual(['brigade_output']);
    expect(result.visible).toBe(true);
  });

  it('нет условий, отпускные и больничные — в причинах; no_days — нет', () => {
    expect(merge({ calc: closed([], ['no_terms']) }).issues).toEqual(['no_terms']);
    expect(merge({
      calc: closed([{ code: 'contract', amount: '1000.00' }], ['vacation_pay', 'sick_pay', 'no_days']),
    }).issues).toEqual(['vacation_pay', 'sick_pay']);
  });

  it('строка без суммы и без причины — unknown_amount; отпускные строку не объясняют', () => {
    expect(merge({ calc: closed([{ code: 'contract', amount: null }]) }).issues).toEqual(['unknown_amount']);
    expect(merge({ calc: closed([{ code: 'contract', amount: null }], ['vacation_pay']) }).issues)
      .toEqual(['vacation_pay', 'unknown_amount']);
    expect(merge({ calc: closed([{ code: 'contract', amount: null }], ['hourly']) }).issues).toEqual(['hourly']);
  });

  it('не закрыт: не работал — ничего; бригада не посчитана и нет табеля — причины', () => {
    const notClosed = (reason: string) => ({ state: 'not_closed', reason }) as unknown as PayrollCalcWithPreliminary;
    const noPeriod = merge({ calc: notClosed('no_period') });
    expect(noPeriod.issues).toEqual([]);
    expect(noPeriod.visible).toBe(false);
    expect(merge({ calc: notClosed('brigade_open') }).issues).toEqual(['brigade_open']);
    expect(merge({ calc: notClosed('not_covered') }).issues).toEqual(['no_timesheet']);
  });

  it('разовая и удержание без расчёта учитываются: уволенный прошлым месяцем с выходным пособием', () => {
    const result = merge({
      calc: { state: 'not_closed', reason: 'no_period' },
      oneTime: [{ reason: 'Выходное пособие при увольнении', amount: '330000.00' }],
    });
    expect(result.cents).toEqual({ severance: 33000000 });
    expect(result.visible).toBe(true);
  });

  it('показывать ли: все суммы нулевые и нет причин — нет; любая сумма 1С — да', () => {
    expect(merge({ calc: closed([{ code: 'contract', amount: '0.00' }], ['no_days']) }).visible).toBe(false);
    expect(merge({ paid: new Map([['bonus', '0.00']]) }).visible).toBe(true);
  });

  it('копейки складываются без потерь на дробях', () => {
    const result = merge({ calc: closed([{ code: 'contract', amount: '0.10' }, { code: 'brigade', amount: '0.20' }]) });
    expect(result.cents).toEqual({ contract: 30 });
  });
});

describe('«Свод»: основания и виды → статьи', () => {
  it('все основания «Справочника» и загруженные за сентябрь–октябрь сопоставлены', () => {
    expect(Object.fromEntries([
      'Выходное пособие при увольнении', 'Доплата', 'Допработы', 'Замещение', 'Зарплата', 'Квартира',
      'Компенсация использования личного а/м', 'Компенсация проживания', 'Матпомощь', 'Перерасход п/о средств',
      'Перерасчет з/пл', 'Премия', 'Премия % по договору', 'Проезд', 'Резерв',
    ].map(reason => [reason, oneTimeReasonItem(reason)]))).toEqual({
      'Выходное пособие при увольнении': 'severance',
      'Доплата': 'supplement',
      'Допработы': 'extra_work',
      'Замещение': 'substitution',
      'Зарплата': 'salary_extra',
      'Квартира': 'housing',
      'Компенсация использования личного а/м': 'car_compensation',
      'Компенсация проживания': 'housing',
      'Матпомощь': 'material_aid',
      'Перерасход п/о средств': 'imprest_overspend',
      'Перерасчет з/пл': 'recalc_prev',
      'Премия': 'premium',
      'Премия % по договору': 'premium_contract',
      'Проезд': 'travel',
      'Резерв': 'reserve',
    });
  });

  it('новое основание — «Разовая доплата»; регистр и пробелы не важны', () => {
    expect(oneTimeReasonItem('Новое основание')).toBe('supplement');
    expect(oneTimeReasonItem('  ПРЕМИЯ  ')).toBe('premium');
  });

  it('виды со статьёй 1С — в свой столбец, остальные — «Прочие удержания»', () => {
    expect(deductionKindItem('Питание')).toBe('meals');
    expect(deductionKindItem('Займ')).toBe('loan_repayment');
    expect(deductionKindItem('% Займа')).toBe('loan_interest');
    expect(deductionKindItem('Банковские издержки по исп. листам')).toBe('bank_fees');
    for (const kind of ['Штраф за мусор', 'Акт нарушений из Витрины', 'Служебная квартира', 'Переплата за предыдущий период', 'Корректировка з/пл', 'Прочие']) {
      expect(deductionKindItem(kind)).toBe('other_deductions');
    }
  });
});
