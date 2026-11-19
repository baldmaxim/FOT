import { describe, it, expect } from 'vitest';
import { FILL_FIELDS, planFill, sameValue, type ICurrentState } from './fill.js';
import type { IPerson1c } from './parse.js';
import type { IHrCitizenship } from '../hr-profile.service.js';

const UZ: IHrCitizenship = { id: 'c-uz', name: 'Узбекистан', iso_code: 'UZB', requires_patent: true, is_eaeu: false, is_active: true, sort_order: 30, synonyms: [] };

const person = (over: Partial<IPerson1c> = {}): IPerson1c => ({
  idAll: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fullName: 'Иванов Иван', departments: ['бр.Новая'], rowNumbers: [2], activeRows: 1,
  birthDate: '1990-01-01', snils: '11223344595', inn: '500100732259', citizenship: 'УЗБЕКИСТАН',
  passport: { type: 'foreign', number: 'FA0631284', date: '2021-02-08', issuer: 'МВД 10242', departmentCode: null, expiryDate: '2031-02-07' },
  patent: { number: '77№2400039966', issueDate: '2024-02-07' }, kig: 'ВС1234567', registrationAddress: null, phone: '+79251580775',
  rowConflicts: [], keyConflict: false, problems: [], ...over,
});

const empty = (): ICurrentState['values'] => Object.fromEntries(FILL_FIELDS.map(f => [f, null])) as ICurrentState['values'];
const state = (values: Partial<ICurrentState['values']> = {}, over: Partial<ICurrentState> = {}): ICurrentState => ({
  employeeId: 1, hasProfile: true, zupIsUploaded: false, passdeskIdAll: null, country: null, citizenshipName: null,
  values: { ...empty(), ...values }, ...over,
});

describe('planFill', () => {
  it('пустая карточка — заполняется всё, что есть в 1С', () => {
    const plan = planFill(person(), state(), UZ);
    expect(plan.fields.sort()).toEqual([
      'birth_date', 'citizenship_id', 'inn', 'kig', 'passport_date', 'passport_expiry_date', 'passport_issuer', 'passport_number',
      'passport_type', 'patent_issue_date', 'patent_number', 'phone', 'snils',
    ]);
    expect(plan.input.citizenship_id).toBe('c-uz');
    expect(plan.diffs).toEqual([]);
  });

  it('заполненное и равное с точностью до формата — не трогается и не расхождение', () => {
    const plan = planFill(person(), state({ snils: '11223344595', phone: '8 (925) 158-07-75', kig: 'BC1234567' }), UZ);
    expect(plan.fields).not.toContain('snils');
    expect(plan.fields).not.toContain('phone');
    expect(plan.fields).not.toContain('kig');
    expect(plan.diffs).toEqual([]);
  });

  it('другое значение в FOT — расхождение, FOT не меняется; у ИНН — пометка о контрольной сумме', () => {
    const plan = planFill(person(), state({ inn: '500100732258' }), UZ);
    expect(plan.fields).not.toContain('inn');
    expect(plan.diffs).toEqual([{ field: 'inn', value1c: '500100732259', valueFot: '500100732258', note: 'контрольная сумма: 1С — верна, FOT — неверна' }]);
  });

  it('расхождение в одном поле паспорта — блок паспорта не пишется целиком', () => {
    const plan = planFill(person(), state({ passport_type: 'russian' }), UZ);
    expect(plan.fields.filter(f => f.startsWith('passport_'))).toEqual([]);
    expect(plan.skippedBlocks).toEqual(['passport']);
    expect(plan.fields).toContain('inn');
  });

  it('патент: в FOT старая дата выдачи — номер тоже не пишется', () => {
    const plan = planFill(person(), state({ patent_issue_date: '2023-01-01' }), UZ);
    expect(plan.fields).not.toContain('patent_number');
    expect(plan.skippedBlocks).toEqual(['patent']);
  });

  it('гражданство: в карточке другое — не пишется (write-through перезаписал бы карточку)', () => {
    const plan = planFill(person(), state({}, { country: 'ТАДЖИКИСТАН' }), UZ);
    expect(plan.fields).not.toContain('citizenship_id');
    expect(plan.diffs.map(d => d.field)).toContain('citizenship_id');
    expect(planFill(person(), state({}, { country: 'УЗБЕКИСТАН' }), UZ).fields).toContain('citizenship_id');
  });

  it('гражданства нет в справочнике — заметка, поле не пишется', () => {
    const plan = planFill(person({ citizenship: 'НАМИБИЯ' }), state(), null);
    expect(plan.fields).not.toContain('citizenship_id');
    expect(plan.notes[0]).toMatch(/нет в справочнике/);
  });
});

describe('sameValue', () => {
  it('номера документов — без учёта пробелов и похожих кириллических букв', () => {
    expect(sameValue('passport_number', '4519 423266', '4519423266')).toBe(true);
    expect(sameValue('kig', 'ВС1234567', 'BC1234567')).toBe(true);
    expect(sameValue('patent_number', '77№2400039966', '77 № 2400039966')).toBe(true);
    expect(sameValue('passport_issuer', 'ГУ МВД России по г. Москве', 'гу мвд россии по г.москве')).toBe(true);
    expect(sameValue('birth_date', '1990-01-01', '1990-01-02')).toBe(false);
  });
});
