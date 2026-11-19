import { describe, it, expect } from 'vitest';
import { decidePerson, normalizeDepartmentName, resolveSharedCards, type IFotCard, type IPersonFacts, type IPersonKeys } from './match.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const card = (id: number, over: Partial<IFotCard> = {}): IFotCard => ({
  id, fullName: 'Иванов Иван', department: 'бр.Новая', working: true, birthDate: null, snilsDigits: null, hasProfile: false,
  passdeskIdAll: null, snilsHash: null, innHash: null, passportHash: null, kigHash: null, linkedIdAlls: [], ...over,
});

const keys = (over: Partial<IPersonKeys> = {}): IPersonKeys => ({
  idAll: ID, nameKey: 'иванов иван', birthDate: '1990-01-01', snils: '11223344595', departments: ['бр.Новая/закр'], keyConflict: false,
  hashes: { snils: 'hs', inn: 'hi', passport: 'hp', kig: 'hk' }, ...over,
});

const facts = (cards: IFotCard[], over: Partial<IPersonFacts> = {}): IPersonFacts => ({
  cards: new Map(cards.map(c => [c.id, c])),
  bySignal: { id_all: [], snils: [], inn: [], passport: [], kig: [], name_birth: [] },
  byName: [],
  claims: [],
  ...over,
});

describe('decidePerson', () => {
  it('код 1С → одна работающая карточка: заносим', () => {
    const d = decidePerson(keys(), facts([card(1, { linkedIdAlls: [ID] })], { bySignal: { ...facts([]).bySignal, id_all: [1] } }));
    expect(d).toMatchObject({ kind: 'apply', employeeId: 1, tier: 'id_all' });
  });

  it('уволенная карточка по коду 1С не участвует, работающая по СНИЛС — заносим её', () => {
    const f = facts([card(1, { working: false, linkedIdAlls: [ID] }), card(2, { snilsDigits: '11223344595' })],
      { bySignal: { ...facts([]).bySignal, id_all: [1], snils: [2] } });
    expect(decidePerson(keys(), f)).toMatchObject({ kind: 'apply', employeeId: 2, tier: 'strong', signals: ['snils'] });
  });

  it('СНИЛС ведёт к одной карточке, ИНН — к другой: ручная проверка', () => {
    const f = facts([card(1), card(2)], { bySignal: { ...facts([]).bySignal, snils: [1], inn: [2] } });
    const d = decidePerson(keys(), f);
    expect(d.kind).toBe('manual');
    expect(d.reasons[0]).toMatch(/разные карточки/);
  });

  it('вето: другая дата рождения, другой СНИЛС, другой код 1С, связь с другим физлицом', () => {
    const sig = { ...facts([]).bySignal, id_all: [1] };
    expect(decidePerson(keys(), facts([card(1, { birthDate: '1991-01-01' })], { bySignal: sig })).reasons).toContain('в FOT другая дата рождения');
    expect(decidePerson(keys(), facts([card(1, { snilsDigits: '12345678901' })], { bySignal: sig })).reasons).toContain('в FOT другой СНИЛС');
    expect(decidePerson(keys(), facts([card(1, { passdeskIdAll: OTHER_ID })], { bySignal: sig })).kind).toBe('manual');
    expect(decidePerson(keys(), facts([card(1, { linkedIdAlls: [ID, OTHER_ID] })], { bySignal: sig })).kind).toBe('manual');
  });

  it('паспорт в FOT другой при сильном признаке — не вето (смена документа)', () => {
    const f = facts([card(1, { passportHash: 'other' })], { bySignal: { ...facts([]).bySignal, id_all: [1] } });
    expect(decidePerson(keys(), f).kind).toBe('apply');
  });

  it('идентификатор закреплён за другим сотрудником — вето', () => {
    const f = facts([card(1)], { bySignal: { ...facts([]).bySignal, id_all: [1] }, claims: [{ claimType: 'inn', employeeId: 9, draftId: null }] });
    expect(decidePerson(keys(), f).reasons).toContain('ИНН закреплён за #9');
  });

  it('только ФИО: одна карточка, отдел совпал, работает — заносим', () => {
    const d = decidePerson(keys({ hashes: { snils: null, inn: null, passport: null, kig: null } }), facts([card(5, { department: 'бр. Новая' })], { byName: [5] }));
    expect(d).toMatchObject({ kind: 'apply', employeeId: 5, tier: 'name_dept' });
  });

  it('только ФИО: два однофамильца (один уволен) — вручную; отдел другой — вручную; паспорт другой — вето', () => {
    expect(decidePerson(keys(), facts([card(5), card(6, { working: false })], { byName: [5, 6] })).reasons).toEqual(['в FOT несколько карточек с таким ФИО']);
    expect(decidePerson(keys(), facts([card(5, { department: 'Офис' })], { byName: [5] })).reasons[0]).toMatch(/отдел в FOT другой/);
    expect(decidePerson(keys(), facts([card(5, { passportHash: 'other' })], { byName: [5] })).reasons).toContain('в FOT другой паспорт');
    expect(decidePerson(keys(), facts([], { byName: [] })).reasons).toEqual(['в FOT не найден']);
  });

  it('ручной выбор проходит те же вето и не обходит сильные признаки', () => {
    expect(decidePerson(keys(), facts([card(7)]), 7)).toMatchObject({ kind: 'apply', employeeId: 7, tier: 'manual' });
    expect(decidePerson(keys(), facts([card(7, { working: false })]), 7).kind).toBe('manual');
    expect(decidePerson(keys(), facts([card(7, { birthDate: '1980-01-01' })]), 7).kind).toBe('manual');
    const f = facts([card(7), card(8)], { bySignal: { ...facts([]).bySignal, snils: [8] } });
    expect(decidePerson(keys(), f, 7).reasons[0]).toMatch(/признаки указывают на #8/);
  });

  it('сильный признак, но ФИО в FOT другое — вручную; ручной выбор этой карточки принимается', () => {
    const f = facts([card(1, { fullName: 'Иванова Ивана' })], { bySignal: { ...facts([]).bySignal, id_all: [1] } });
    expect(decidePerson(keys(), f).reasons[0]).toMatch(/ФИО в FOT другое/);
    expect(decidePerson(keys(), f, 1)).toMatchObject({ kind: 'apply', employeeId: 1, tier: 'manual' });
    const same = facts([card(1, { fullName: 'Иванов  Иван' })], { bySignal: { ...facts([]).bySignal, id_all: [1] } });
    expect(decidePerson(keys(), same).kind).toBe('apply');
  });

  it('ключевой конфликт в 1С — только вручную', () => {
    expect(decidePerson(keys({ keyConflict: true }), facts([card(1)], { bySignal: { ...facts([]).bySignal, id_all: [1] } })).kind).toBe('manual');
  });
});

describe('общая карточка и отделы', () => {
  it('два физлица на одну карточку — оба вручную', () => {
    const apply = { kind: 'apply' as const, employeeId: 3, tier: 'strong' as const, signals: [], candidates: [3], reasons: [] };
    const items = [{ idAll: ID, decision: { ...apply } }, { idAll: OTHER_ID, decision: { ...apply } }];
    resolveSharedCards(items);
    expect(items.every(i => i.decision.kind === 'manual')).toBe(true);
  });

  it('«бр.Шерматов А.М./закр» = «бр. Шерматов А. М.»', () => {
    expect(normalizeDepartmentName('бр.Шерматов А.М./закр')).toBe(normalizeDepartmentName('бр. Шерматов А. М.'));
  });
});
