import { describe, it, expect } from 'vitest';
import {
  PERSONS_1C_REQUIRED_COLUMNS, collapsePersons, isValidPersonInn, isValidSnils, normalizeInn1c, normalizePassport1c,
  normalizePatent1c, normalizePhone1c, normalizeSnils1c, parsePersons1cRows, parseRuDate,
} from './parse.js';

/** Достраивает контрольные разряды ИНН физлица к 10 цифрам. */
const makeInn = (ten: string): string => {
  const n = (d: string, w: number[]): number => w.reduce((s, x, i) => s + x * Number(d[i]), 0) % 11 % 10;
  const eleven = ten + n(ten, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return eleven + n(eleven, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
};

/** Достраивает контрольное число СНИЛС к 9 цифрам. */
const makeSnils = (nine: string): string => {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(nine[i]) * (9 - i);
  let c = sum < 100 ? sum : sum % 101;
  if (c === 100) c = 0;
  return nine + String(c).padStart(2, '0');
};

type Row = Partial<Record<typeof PERSONS_1C_REQUIRED_COLUMNS[number], string>>;
const sheet = (rows: Row[]): string[][] => [
  [...PERSONS_1C_REQUIRED_COLUMNS],
  ...rows.map(r => PERSONS_1C_REQUIRED_COLUMNS.map(c => r[c] ?? '')),
];
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('нормализация полей 1С', () => {
  it('даты: дд.мм.гггг и ISO, несуществующая — null', () => {
    expect(parseRuDate('07.10.2019')).toBe('2019-10-07');
    expect(parseRuDate('2019-10-07')).toBe('2019-10-07');
    expect(parseRuDate('31.02.2020')).toBeNull();
    expect(parseRuDate('')).toBeNull();
  });

  it('СНИЛС: контрольное число, потерянные нули восстанавливаются только при верной сумме', () => {
    expect(isValidSnils('11223344595')).toBe(true);
    expect(isValidSnils('11223344596')).toBe(false);
    expect(normalizeSnils1c('112-233-445 95')).toEqual({ value: '11223344595', problem: null });
    const lowSnils = makeSnils('012345678');
    expect(normalizeSnils1c(lowSnils.slice(1)).value).toBe(lowSnils);
    expect(normalizeSnils1c('112-233-445 96').value).toBeNull();
    expect(normalizeSnils1c('   -   -      ')).toEqual({ value: null, problem: null });
  });

  it('ИНН: 11 цифр — дополняется ведущим нулём, контрольные разряды проверяются', () => {
    const inn = makeInn('0772421103');
    expect(isValidPersonInn(inn)).toBe(true);
    expect(normalizeInn1c(inn.slice(1)).value).toBe(inn);
    expect(normalizeInn1c(inn).value).toBe(inn);
    expect(normalizeInn1c(`${inn.slice(0, 11)}${(Number(inn[11]) + 1) % 10}`).value).toBeNull();
    expect(normalizeInn1c('0').value).toBeNull();
  });

  it('паспорт РФ: «серия номер», номер дополняется до 6 цифр', () => {
    const p = normalizePassport1c({
      'Паспорт_Вид': 'Паспорт гражданина Российской Федерации', 'Паспорт_Серия': '45 19 ', 'Паспорт_Номер': '23266',
      'Паспорт_ДатаВыдачи': '07.10.2019', 'Паспорт_КемВыдан': 'ГУ МВД', 'Паспорт_КодПодразделения': '770-039',
    } as never);
    expect(p.value).toMatchObject({ type: 'russian', number: '4519 023266', date: '2019-10-07', departmentCode: '770-039' });
  });

  it('паспорт иностранца: Узбекистан — номер до 7 цифр, Украина — как есть, не паспорт — не заносится', () => {
    const uz = normalizePassport1c({ 'Паспорт_Вид': 'Паспорт иностранного гражданина', 'Паспорт_Серия': 'FA', 'Паспорт_Номер': '631284', 'Гражданство': 'УЗБЕКИСТАН' } as never);
    expect(uz.value?.number).toBe('FA0631284');
    const ua = normalizePassport1c({ 'Паспорт_Вид': 'Паспорт иностранного гражданина', 'Паспорт_Серия': 'FJ', 'Паспорт_Номер': '631284', 'Гражданство': 'УКРАИНА' } as never);
    expect(ua.value?.number).toBe('FJ631284');
    const tj = normalizePassport1c({ 'Паспорт_Вид': 'Паспорт иностранного гражданина', 'Паспорт_Серия': '', 'Паспорт_Номер': '400737392', 'Гражданство': 'ТАДЖИКИСТАН' } as never);
    expect(tj.value).toMatchObject({ type: 'foreign', number: '400737392' });
    const vnzh = normalizePassport1c({ 'Паспорт_Вид': 'Вид на жительство', 'Паспорт_Номер': '123' } as never);
    expect(vnzh.value).toBeNull();
    expect(vnzh.problem).toMatch(/не паспорт/);
  });

  it('патент — «серия№номер», служебные «*» отбрасываются; телефон — +7…', () => {
    expect(normalizePatent1c({ 'Патент_Серия': '77', 'Патент_Номер': '2400039966*', 'Патент_ДатаВыдачи': '07.02.2024' } as never))
      .toEqual({ number: '77№2400039966', issueDate: '2024-02-07' });
    expect(normalizePatent1c({ 'Патент_Серия': '', 'Патент_Номер': '' } as never)).toBeNull();
    expect(normalizePhone1c('89251580775')).toBe('+79251580775');
    expect(normalizePhone1c('9251580775')).toBe('+79251580775');
    expect(normalizePhone1c('+998901234567')).toBe('+998901234567');
    expect(normalizePhone1c('+')).toBeNull();
  });
});

describe('строки и физлица', () => {
  it('нет обязательного столбца — ошибка, id_all не UUID — ошибка', () => {
    expect(() => parsePersons1cRows([['ФизЛицо']])).toThrow(/нет столбцов/);
    expect(() => parsePersons1cRows(sheet([{ 'ФизЛицо': 'А', 'Физлицо_id_all': 'x' }]))).toThrow(/UUID/);
  });

  it('уволенный до среза — не работающий; уволенный после среза — работает', () => {
    const { rows } = parsePersons1cRows(sheet([
      { 'ФизЛицо': 'Первый', 'Физлицо_id_all': ID_A, 'ДатаУвольнения': '01.11.2026' },
      { 'ФизЛицо': 'Второй', 'Физлицо_id_all': ID_B, 'ДатаУвольнения': '30.11.2026' },
    ]));
    const { working, dismissed } = collapsePersons(rows, '2026-11-19');
    expect(dismissed).toBe(1);
    expect(working.map(p => p.idAll)).toEqual([ID_B]);
  });

  it('повторный приём: берётся только активная запись, КИГ разных активных записей не смешивается', () => {
    const { rows } = parsePersons1cRows(sheet([
      { 'ФизЛицо': 'Иванов Иван', 'Физлицо_id_all': ID_A, 'КИГ': 'ВС1111111', 'ДатаУвольнения': '01.01.2025', 'Отдел': 'Старый' },
      { 'ФизЛицо': 'Иванов Иван', 'Физлицо_id_all': ID_A, 'КИГ': 'ВС2222222', 'Отдел': 'бр.Новая' },
      { 'ФизЛицо': 'Иванов  Иван ', 'Физлицо_id_all': ID_A, 'КИГ': 'ВС3333333', 'Отдел': 'бр.Новая' },
    ]));
    const [p] = collapsePersons(rows, '2026-11-19').working;
    expect(p.activeRows).toBe(2);
    expect(p.kig).toBeNull();
    expect(p.rowConflicts).toEqual(['kig']);
    expect(p.keyConflict).toBe(false);
    expect(p.departments).toEqual(['бр.Новая']);
  });

  it('одна активная запись из двух — её значения без конфликта', () => {
    const { rows } = parsePersons1cRows(sheet([
      { 'ФизЛицо': 'Иванов Иван', 'Физлицо_id_all': ID_A, 'КИГ': 'ВС1111111', 'ДатаУвольнения': '01.01.2025' },
      { 'ФизЛицо': 'Иванов Иван', 'Физлицо_id_all': ID_A, 'КИГ': 'ВС2222222' },
    ]));
    const [p] = collapsePersons(rows, '2026-11-19').working;
    expect(p.kig).toBe('ВС2222222');
    expect(p.rowConflicts).toEqual([]);
  });

  it('разные ДР в активных записях — ключевой конфликт', () => {
    const { rows } = parsePersons1cRows(sheet([
      { 'ФизЛицо': 'Иванов Иван', 'Физлицо_id_all': ID_A, 'ДатаРождения': '01.01.1990' },
      { 'ФизЛицо': 'Иванов Иван', 'Физлицо_id_all': ID_A, 'ДатаРождения': '02.01.1990' },
    ]));
    expect(collapsePersons(rows, '2026-11-19').working[0].keyConflict).toBe(true);
  });
});
