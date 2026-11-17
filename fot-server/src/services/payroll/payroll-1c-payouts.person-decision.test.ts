import { describe, expect, it } from 'vitest';

import {
  applyManualRules,
  parseManualRules,
  type IDecision,
  type IManualRulePerson,
} from '../../../scripts/lib/payouts-person-decision.js';

// Ручные решения пользователя генератора build-payouts-xml-sql.ts (--link «ФИО=id», --unmatched «ФИО»): применяются
// только однозначно, иначе — стоп со списком причин. Вымышленные ФИО и коды.

const person = (key: string, fullName: string, idAll: string | null = null, autoEmployeeId: number | null = null): IManualRulePerson => (
  { key, fullName, idAll, autoEmployeeId });

const NONE: IDecision = { employeeId: null, kind: 'none' };

describe('ручные решения по физлицу: разбор флагов', () => {
  it('ФИО нормализуется (ё, регистр, пробелы); id — целое > 0', () => {
    const rules = parseManualRules(['  Гриневич  николай =481'], ['Товбин Михаил Самуилович']);
    expect([...rules.links.entries()]).toEqual([['гриневич николай', { fullName: 'Гриневич  николай', employeeId: 481 }]]);
    expect([...rules.unmatched.keys()]).toEqual(['товбин михаил самуилович']);
  });

  it('стоп: нет «=id», id не число, одно ФИО в двух правилах', () => {
    expect(() => parseManualRules(['Гриневич Николай'], [])).toThrow(/нужно «ФИО=id сотрудника»/);
    expect(() => parseManualRules(['Гриневич Николай=abc'], [])).toThrow(/нужно «ФИО=id сотрудника»/);
    expect(() => parseManualRules(['Гриневич Николай=481'], ['гриневич  николай'])).toThrow(/уже есть в другом правиле/);
    expect(() => parseManualRules(['Ёлкин=1', 'Елкин=2'], [])).toThrow(/уже есть в другом правиле/);
  });
});

describe('ручные решения по физлицу: применение', () => {
  const persons = [
    person('k1', 'Гриневич Николай', 'id-1'),
    person('k2', 'Товбин Михаил Самуилович', 'id-2'),
    person('k3', 'Иванов Иван', 'id-3', 7),
  ];
  const auto = new Map<string, IDecision>([['k1', NONE], ['k2', NONE], ['k3', { employeeId: 7, kind: 'id_all' }]]);

  it('link → сотрудник «указан при загрузке», unmatched → «без сотрудника по решению»; прочие и исходные не меняются', () => {
    const result = applyManualRules(persons, parseManualRules(['гриневич николай=481'], ['Товбин Михаил Самуилович']), auto);
    expect(result.get('k1')).toEqual({ employeeId: 481, kind: 'manual' });
    expect(result.get('k2')).toEqual({ employeeId: null, kind: 'manual_none' });
    expect(result.get('k3')).toEqual({ employeeId: 7, kind: 'id_all' });
    expect(auto.get('k1')).toEqual(NONE);
  });

  it('link на ту же карточку, что код физлица 1С, — допустим', () => {
    expect(applyManualRules(persons, parseManualRules(['Иванов Иван=7'], []), auto).get('k3')).toEqual({ employeeId: 7, kind: 'manual' });
  });

  it('стоп: правило не использовано, два физлица под одним ФИО, код 1С ведёт к другой карточке', () => {
    expect(() => applyManualRules(persons, parseManualRules(['Петров Пётр=5'], []), auto)).toThrow(/правило не использовано/);
    const twins = [...persons, person('k4', 'Гриневич  Николай', 'id-4')];
    expect(() => applyManualRules(twins, parseManualRules(['Гриневич Николай=481'], []), auto))
      .toThrow(/под этим ФИО 2 физлица \(id_all id-1, id-4\)/);
    expect(() => applyManualRules(persons, parseManualRules(['Иванов Иван=8'], []), auto))
      .toThrow(/код физлица 1С ведёт к сотруднику 7, а не 8/);
    expect(() => applyManualRules(persons, parseManualRules([], ['Иванов Иван']), auto))
      .toThrow(/--unmatched «Иванов Иван»: код физлица 1С ведёт к сотруднику 7/);
  });
});
