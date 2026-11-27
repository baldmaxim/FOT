import { describe, expect, it } from 'vitest';
import {
  buildStaffCategorySources,
  isStaffCategory,
  staffCategoryCaseSql,
  staffCategoryConditionSql,
  staffCategoryRowSql,
} from './staff-category.service.js';
import { payrollDepartmentGroupIds } from './payroll/payroll-department-groups.js';

// Корни компаний — как в employees-export.service.ts (раздел определяется по id корня).
const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';

const dept = (id: string, name: string, parent_id: string | null, kind: string | null = null) => ({ id, name, parent_id, kind });

const DEPARTMENTS = [
  dept('root', 'Объект', null, 'object'),
  dept(SU10_ROOT_ID, '(СУ-10) ООО СУ-10', 'root'),
  dept('su-pto', 'ПТО', SU10_ROOT_ID),
  dept('su-couriers', 'Курьерская служба', SU10_ROOT_ID),
  dept('su-brigades', 'Бригады', SU10_ROOT_ID),
  dept('br-ortikov', 'бр.Ортиков Шавкат А.', 'su-brigades'),
  dept(SM_ROOT_ID, '(СМ) Служба Механизации', 'root'),
  dept('sm-oat', 'ОАТ', SM_ROOT_ID),
  dept('linia', 'ЛИНИЯ-Общестрой', 'root'),
  dept('linia-site', 'Участок 1', 'linia'),
  dept('contractors', 'Подрядные организации', 'root'),
  dept('ctr-alfa', 'ООО Альфа', 'contractors'),
];

const POSITIONS = [
  { id: 'p-eng', name: 'инженер' },
  { id: 'p-prorab', name: 'Производитель работ (прораб) (в строительстве)' },
  { id: 'p-painter', name: 'Маляр' },
  { id: 'p-commandant', name: 'Комендант объекта' },
  { id: 'p-driver', name: 'Водитель' },
  { id: 'p-none', name: null },
];

describe('buildStaffCategorySources', () => {
  it('отделы — ровно группы «Расчётов»: бригады → Рабочие, ЛИНИЯ и СУ-10 вне бригад → ИТР; ИТР-должности по списку', () => {
    const sources = buildStaffCategorySources(DEPARTMENTS, POSITIONS);
    const payroll = payrollDepartmentGroupIds(DEPARTMENTS);
    expect(sources.workerDepartmentIds).toEqual(payroll.worker);
    expect(sources.itrDepartmentIds).toEqual(payroll.itr);
    expect([...sources.workerDepartmentIds].sort()).toEqual(['br-ortikov', 'su-brigades']);
    expect([...sources.itrDepartmentIds].sort()).toEqual(['linia', 'linia-site', 'su-couriers', 'su-pto', SU10_ROOT_ID].sort());
    // СМ вне бригад и подрядные — ни в одной группе отделов: решает должность.
    for (const id of [SM_ROOT_ID, 'sm-oat', 'contractors', 'ctr-alfa']) {
      expect(sources.workerDepartmentIds, id).not.toContain(id);
      expect(sources.itrDepartmentIds, id).not.toContain(id);
    }
    expect([...sources.itrPositionIds].sort()).toEqual(['p-eng', 'p-prorab']);
  });
});

describe('группы', () => {
  it('только itr и worker; «Остальных» больше нет', () => {
    expect(isStaffCategory('itr')).toBe(true);
    expect(isStaffCategory('worker')).toBe(true);
    for (const value of ['other', 'ITR', '', null, ['itr']]) expect(isStaffCategory(value)).toBe(false);
  });
});

describe('staffCategoryCaseSql', () => {
  it('порядок: бригада → Рабочие, отдел ИТР → ИТР, ИТР-должность → ИТР, иначе Рабочие', () => {
    const params: unknown[] = [false];
    const sql = staffCategoryCaseSql('employees', 'dep.department_id', params, {
      workerDepartmentIds: ['w'], itrDepartmentIds: ['i'], itrPositionIds: ['p'],
    });
    const brigade = sql.indexOf("dep.department_id = ANY($2::uuid[]) THEN 'worker'");
    const itrDept = sql.indexOf("dep.department_id = ANY($3::uuid[]) THEN 'itr'");
    const itrPos = sql.indexOf("employees.position_id = ANY($4::uuid[]) THEN 'itr'");
    expect(brigade).toBeGreaterThan(-1);
    expect(brigade).toBeLessThan(itrDept);
    expect(itrDept).toBeLessThan(itrPos);
    expect(sql).toContain("ELSE 'worker'");
    expect(sql).not.toContain('other');
    expect(params).toEqual([false, ['w'], ['i'], ['p']]);
  });
});

describe('staffCategoryRowSql / staffCategoryConditionSql', () => {
  const SOURCES = { workerDepartmentIds: ['w'], itrDepartmentIds: ['i'], itrPositionIds: ['p'] };

  it('отдел (у уволенного — до увольнения) считается один раз во вложенном SELECT', () => {
    const params: unknown[] = [];
    const sql = staffCategoryRowSql('employees', params, SOURCES);
    expect(sql.match(/employee_dismissal_events/g)).toHaveLength(1);
    expect(sql).toContain("category_dep.department_id = ANY($1::uuid[]) THEN 'worker'");
    expect(sql).toMatch(/\) category_dep\)$/);
    expect(params).toEqual([['w'], ['i'], ['p']]);
  });

  it('условие группы — то же выражение строки и параметр группы последним', () => {
    const params: unknown[] = [false];
    const condition = staffCategoryConditionSql('employees', params, SOURCES, 'itr');
    const rowParams: unknown[] = [false];
    expect(condition).toBe(`${staffCategoryRowSql('employees', rowParams, SOURCES)} = $5`);
    expect(params).toEqual([false, ['w'], ['i'], ['p'], 'itr']);
  });
});
