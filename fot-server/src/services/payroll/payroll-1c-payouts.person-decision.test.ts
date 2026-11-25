import { describe, expect, it } from 'vitest';

import type { IPayoutCandidate } from './payroll-1c-payouts.matching.js';
import {
  applyManualRules,
  decide,
  decideByIdAll,
  parseManualRules,
  type IDecision,
  type IManualRulePerson,
} from './payroll-1c-payouts.person-decision.js';

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

describe('«ЗП к выплате»: сотрудник только по коду физлица 1С', () => {
  const byName: IPayoutCandidate = {
    employee_id: 5, full_name: 'Петров Пётр', department: 'Отдел', worked_in_month: true, by_id_all: false, brigade_match: false,
  };

  it('ФИО однозначно нашлось, а по id_all — нет (кода нет, код чужой или ведёт к двум карточкам): без сотрудника', () => {
    // Общая автоматика взяла бы единственного кандидата по ФИО — здесь нет.
    expect(decide([byName], null, new Set(), new Set())).toEqual({ employeeId: 5, kind: 'single' });
    expect(decideByIdAll(null)).toEqual({ employeeId: null, kind: 'id_all_none' });
  });

  it('ровно один допустимый сотрудник по id_all (auto из matchPayoutLines) — он', () => {
    expect(decideByIdAll(7)).toEqual({ employeeId: 7, kind: 'id_all' });
  });
});
